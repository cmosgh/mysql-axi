import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HookSettings } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configDir } from "../packages/core/src/config.js";
import { findHooks, installHooks, ourHook, removeHooks } from "../packages/core/src/hooks.js";
import { findInvocations, lastSession, recordSession, sessionText, shellSegments, summarizeTranscript } from "../packages/core/src/sessionlog.js";
import { setTool } from "../packages/core/src/tool.js";
import { TOOL } from "../packages/mysql-axi/src/cli.js";
import { fake, resetFake, type Reply } from "./fake-mysql.js";
import { ro, rw, useTestEnv } from "./helpers.js";

vi.mock("mysql2", async () => ({ default: (await import("./fake-mysql.js")).default }));

const lookup = (word: string): string | undefined =>
  ({ query: "query", tables: "tables", describe: "describe", desc: "describe" })[word] ?? (/^select\s/i.test(word) ? "query" : undefined);

const answer = (map: Record<string, Reply>) => (sql: string) => Object.entries(map).find(([prefix]) => sql.startsWith(prefix))?.[1];

/** A profile next to the *_URL connection of the test env; -p picks it. */
function saveProfiles(profiles: Record<string, object>, active?: string): void {
  for (const prefix of ["MYSQL_AXI", "MYSQL_RW_AXI"]) {
    writeFileSync(join(process.env[`${prefix}_CONFIG_DIR`]!, "config.json"), JSON.stringify({ ...(active ? { active } : {}), profiles }));
  }
}

describe("session capture", () => {
  it("splits shell lines on operators and resolves quotes", () => {
    expect(shellSegments(`a 'b c' "d\\"e" && f|g; h\nI=1 j`)).toEqual([["a", "b c", 'd"e'], ["f"], ["g"], ["h"], ["I=1", "j"]]);
  });

  it("records command names and -p/-d values, never arguments", () => {
    const line = `cd /x && MYSQL_AXI_PROFILE=dev npx -y mysql-axi describe orders -d shop | head; mysql-axi -p dev "SELECT email FROM customers"; mysql-rw-axi exec "DELETE FROM orders"`;
    expect(findInvocations(line, "mysql-axi", lookup)).toEqual([
      { command: "describe", database: "shop" },
      { command: "query", profile: "dev" },
    ]);
    expect(findInvocations("/opt/bin/mysql-axi frobnicate secret", "mysql-axi", lookup)).toEqual([{ command: "other" }]);
    expect(findInvocations("mysql-axi --help", "mysql-axi", lookup)).toEqual([{ command: "help" }]);
    expect(findInvocations("mysql-axi -d shop", "mysql-axi", lookup)).toEqual([{ command: "home", database: "shop" }]);
    expect(findInvocations("mysql-axi --limit 5 --database=shop tables", "mysql-axi", lookup)).toEqual([{ command: "tables", database: "shop" }]);
    expect(findInvocations("echo mysql-axi; grep mysql-axi x", "mysql-axi", lookup)).toEqual([]);
  });

  it("summarizes a transcript and keeps the latest session per directory", async () => {
    useTestEnv();
    setTool(TOOL);
    const dir = mkdtempSync(join(tmpdir(), "mysql-axi-transcript-"));
    const transcript = join(dir, "session.jsonl");
    const bash = (command: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
    writeFileSync(
      transcript,
      [
        bash("mysql-axi tables -p dev -d shop"),
        bash("mysql-axi describe orders -p dev -d shop"),
        bash(`mysql-axi query "SELECT * FROM customers WHERE email = 'a@example.test'" -p dev -d shop`),
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "mysql-axi query orders" }] } }),
        "not json mysql-axi",
      ].join("\n"),
    );
    const summary = await summarizeTranscript(transcript, lookup);
    expect(summary).toMatchObject({ commands: { tables: 1, describe: 1, query: 1 }, profile: "dev", database: "shop" });
    expect(JSON.stringify(summary)).not.toMatch(/orders|customers|example|email/);
    recordSession("/work/a", summary!);
    recordSession("/work/b", { ended: "2026-10-01", commands: { query: 2 } });
    expect(lastSession("/work/a")).toEqual(summary);
    expect(sessionText(lastSession("/work/b")!)).toBe("2026-10-01 - query 2");
    expect(lastSession("/work/c")).toBeUndefined();
    expect(statSync(join(process.env["MYSQL_AXI_CONFIG_DIR"]!, "sessions.json")).mode & 0o777).toBe(0o600);
    expect(await summarizeTranscript(transcript, () => undefined)).toMatchObject({ commands: { other: 3 } });
  });
  it("starts a new log when sessions.json has the wrong shape and skips malformed entries", () => {
    useTestEnv();
    setTool(TOOL);
    mkdirSync(configDir(), { recursive: true });
    for (const content of ['{"directories": null}', '{"directories": [1]}', "null", "not json"]) {
      writeFileSync(join(configDir(), "sessions.json"), content);
      expect(lastSession("/work/a")).toBeUndefined();
      recordSession("/work/a", { ended: "2026-10-01", commands: { query: 1 } });
      expect(lastSession("/work/a")).toMatchObject({ commands: { query: 1 } });
    }
    for (const entry of ["5", '{"commands": null}', '{"ended": "2026-10-01"}', "[]", '{"ended": "2026-10-01", "commands": {"query": "x"}}', '{"ended": "2026-10-01", "commands": {}, "profile": {}}', '{"ended": "2026-10-01", "commands": {}, "database": {}}']) {
      writeFileSync(join(configDir(), "sessions.json"), `{"directories": {"/work/a": ${entry}}}`);
      expect(lastSession("/work/a")).toBeUndefined();
    }
  });
});

describe("hook entries", () => {
  const start = (command: string, extra: object = {}) => ({ matcher: "", hooks: [{ type: "command", command, timeout: 10, ...extra }] });

  it("knows its own hooks by binary name, not by substring", () => {
    expect(ourHook("mysql-axi context", "mysql-axi")).toBe("start");
    expect(ourHook("'/Users/a b/bin/mysql-axi' context end", "mysql-axi")).toBe("end");
    expect(ourHook("/usr/local/lib/node_modules/mysql-axi/dist/mysql-axi.js", "mysql-axi")).toBe("start");
    expect(ourHook("mysql-rw-axi context", "mysql-axi")).toBeUndefined();
    expect(ourHook("/src/mysql-axi/run.sh", "mysql-axi")).toBeUndefined();
    expect(ourHook("mysql-axi databases -p prod", "mysql-axi")).toBeUndefined();
    expect(ourHook("mysql-axi context && echo hi", "mysql-axi")).toBeUndefined();
  });

  it("adds start and end hooks, repairs the binary in place and is a no-op when current", () => {
    const settings = { model: "x", hooks: { SessionStart: [start("other-tool")] } } as HookSettings;
    const [first, added] = installHooks(settings, "mysql-axi", "/old/mysql-axi", ["start", "end"]);
    expect(added).toBe(true);
    expect(findHooks(first, "mysql-axi")).toEqual({ start: "/old/mysql-axi context", end: "/old/mysql-axi context end" });
    const [moved, repaired] = installHooks(first, "mysql-axi", "mysql-axi", ["start", "end"]);
    expect(repaired).toBe(true);
    expect(moved.hooks!.SessionStart).toHaveLength(2);
    expect(findHooks(moved, "mysql-axi")).toEqual({ start: "mysql-axi context", end: "mysql-axi context end" });
    expect(installHooks(moved, "mysql-axi", "mysql-axi", ["start", "end"])).toEqual([moved, false]);
    expect(JSON.stringify(moved)).toContain("other-tool");
  });

  it("upgrades the bare 0.1.x hook, drops duplicates and leaves hand-written ones", () => {
    const old = {
      hooks: { SessionStart: [start("/usr/local/bin/mysql-axi"), start("mysql-axi"), { hooks: [{ type: "command", command: "mysql-axi databases -p prod" }] }] },
    } as HookSettings;
    const [next] = installHooks(old, "mysql-axi", "mysql-axi", ["start"]);
    expect(next.hooks!.SessionStart).toEqual([start("mysql-axi context"), { hooks: [{ type: "command", command: "mysql-axi databases -p prod" }] }]);
  });

  it("removes only its own hooks and empty containers it emptied", () => {
    const settings = { hooks: { SessionStart: [start("mysql-axi context"), start("other-tool")], SessionEnd: [start("mysql-axi context end")] } } as HookSettings;
    const [removed, changed] = removeHooks(settings, "mysql-axi");
    expect(changed).toBe(true);
    expect(removed).toEqual({ hooks: { SessionStart: [start("other-tool")] } });
    expect(removeHooks({ hooks: { SessionStart: [] } }, "mysql-axi")[1]).toBe(false);
    expect(removeHooks({ hooks: { SessionStart: [start("mysql-axi context")] } }, "mysql-axi")[0]).toEqual({});
  });
});

describe("setup", () => {
  const saved = { home: process.env["HOME"], path: process.env["PATH"], argv1: process.argv[1], cwd: process.cwd() };
  const agentVars = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"];
  const savedVars = Object.fromEntries(agentVars.map((v) => [v, process.env[v]]));
  let home = "";
  let bin = "";

  const install = (at: string): string => {
    const path = join(home, at, "node_modules", "mysql-axi", "dist", "mysql-axi.js");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    process.argv[1] = path;
    return path;
  };
  const claude = () => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8")) as HookSettings;

  beforeEach(() => {
    useTestEnv();
    // Never the real agent config: a fresh HOME, and none of the agents' own config-dir overrides.
    home = realpathSync(mkdtempSync(join(tmpdir(), "mysql-axi-home-")));
    process.env["HOME"] = home;
    for (const v of agentVars) delete process.env[v];
    expect(homedir()).toBe(home);
    bin = install("lib");
  });

  afterEach(() => {
    process.env["HOME"] = saved.home;
    process.env["PATH"] = saved.path;
    process.argv[1] = saved.argv1!;
    process.chdir(saved.cwd);
    for (const v of agentVars) {
      if (savedVars[v] === undefined) delete process.env[v];
      else process.env[v] = savedVars[v];
    }
  });

  it("installs Claude Code start and end, Codex start with its feature flag and the OpenCode plugin; a rerun is a no-op", async () => {
    const first = await ro("setup", "hooks");
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("claude_code: installed (session start + end)");
    expect(first.stdout).toContain("codex: installed (session start)");
    expect(first.stdout).toContain("opencode: installed (session start)");
    expect(findHooks(claude(), "mysql-axi")).toEqual({ start: `${bin} context`, end: `${bin} context end` });
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf-8")).toBe("[features]\nhooks = true\n");
    expect(readFileSync(join(home, ".config", "opencode", "plugins", "axi-mysql-axi.js"), "utf-8")).toContain('const args = ["context"];');

    const again = await ro("setup", "hooks");
    expect(again.stdout.match(/already up to date \(no-op\)/g)).toHaveLength(3);
    const status = await ro("setup", "status");
    expect(status.stdout).toMatch(/claude_code: session start \+ end\n {2}codex: session start\n {2}opencode: session start/);

    const removed = await ro("setup", "uninstall");
    expect(removed.stdout.match(/: removed/g)).toHaveLength(3);
    expect(claude()).toEqual({});
    expect((await ro("setup", "uninstall")).stdout.match(/not installed \(no-op\)/g)).toHaveLength(3);
  });

  it("uses the bare name when PATH finds this install", async () => {
    const binDir = join(home, "bin");
    mkdirSync(binDir);
    symlinkSync(bin, join(binDir, "mysql-axi"));
    process.env["PATH"] = `${binDir}${delimiter}${saved.path}`;
    expect((await ro("setup", "hooks")).stdout).toContain("runs: mysql-axi context");
    expect(findHooks(claude(), "mysql-axi").end).toBe("mysql-axi context end");
  });

  it("reports a moved binary and repairs the path", async () => {
    await ro("setup", "hooks");
    const moved = install("lib2");
    renameSync(join(home, "lib"), join(home, "old-lib"));
    expect((await ro("setup", "status")).stdout).toContain("claude_code: broken -");
    expect((await ro("setup", "hooks")).stdout).toContain("claude_code: installed (session start + end)");
    expect(findHooks(claude(), "mysql-axi").start).toBe(`${moved} context`);
    expect((await ro("setup", "status")).stdout).toContain("claude_code: session start + end");
  });

  it("upgrades the hook an older setup wrote", async () => {
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: bin, timeout: 10 }] }] } }));
    expect((await ro("setup", "status")).stdout).toContain("claude_code: session start - outdated; rerun setup hooks");
    await ro("setup", "hooks");
    expect(claude().hooks!.SessionStart).toHaveLength(1);
    expect(findHooks(claude(), "mysql-axi")).toEqual({ start: `${bin} context`, end: `${bin} context end` });
  });

  it("fails with SETUP_FAILED on a partial install and keeps what worked", async () => {
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "hooks.json"), "{not json");
    const { stdout, exitCode } = await ro("setup", "hooks");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: SETUP_FAILED");
    expect(stdout).toContain("hooks.json is not valid JSON");
    expect(findHooks(claude(), "mysql-axi").start).toBe(`${bin} context`);
  });

  it("fails with SETUP_FAILED when an uninstall step fails, after removing the rest", async () => {
    await ro("setup", "hooks");
    writeFileSync(join(home, ".codex", "hooks.json"), "{not json");
    const plugin = join(home, ".config", "opencode", "plugins", "axi-mysql-axi.js");
    const { stdout, exitCode } = await ro("setup", "uninstall");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: SETUP_FAILED");
    expect(stdout).toContain("Codex failed - ");
    expect(stdout).toContain("(Claude Code and OpenCode done)");
    expect(stdout).toContain("rerun `mysql-axi setup uninstall`");
    expect(claude()).toEqual({});
    expect(existsSync(plugin)).toBe(false);
    mkdirSync(plugin);
    expect((await ro("setup", "status")).stdout).toMatch(/opencode: "?unreadable - EISDIR/);
    expect((await ro("setup", "uninstall")).stdout).toContain("OpenCode failed - ");
  });

  it("reports a Codex config it cannot read", async () => {
    await ro("setup", "hooks");
    const config = join(home, ".codex", "config.toml");
    rmSync(config);
    mkdirSync(config);
    const { stdout, exitCode } = await ro("setup", "status");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/codex: "?session start - but ~\/\.codex\/config\.toml is unreadable - EISDIR/);
  });

  it("writes project and local scopes under the working directory only", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "mysql-axi-project-")));
    process.chdir(project);
    expect((await ro("setup", "hooks", "--local")).stdout).toContain("claude_code: installed (session start + end)");
    expect(findHooks(JSON.parse(readFileSync(join(project, ".claude", "settings.local.json"), "utf-8")) as HookSettings, "mysql-axi").end).toBe(`${bin} context end`);
    expect((await ro("setup", "hooks", "--project")).stdout).toContain("teammates need mysql-axi on PATH");
    expect(existsSync(join(project, ".opencode", "plugins", "axi-mysql-axi.js"))).toBe(true);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect((await ro("setup", "hooks", "--local", "--project")).stdout).toContain("pass --project or --local, not both");
  });

  it("refuses an npx copy, whose cache later sessions do not have on PATH", async () => {
    install(join(".npm", "_npx", "3f2a"));
    const { stdout, exitCode } = await ro("setup", "hooks", "--project");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("runs from the npx cache");
    expect(stdout).toContain("then `mysql-axi setup hooks --project`");
    expect(stdout).toContain("npx skills add cmosgh/mysql-axi --skill mysql-axi");
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it("refuses a pnpm dlx copy behind a symlink", async () => {
    const binDir = join(home, "dlx-bin");
    mkdirSync(binDir);
    symlinkSync(install(join("Library", "Caches", "pnpm", "dlx", "9c1e")), join(binDir, "mysql-axi"));
    process.argv[1] = join(binDir, "mysql-axi");
    const project = realpathSync(mkdtempSync(join(tmpdir(), "mysql-axi-project-")));
    process.chdir(project);
    const { stdout, exitCode } = await ro("setup", "hooks", "--local");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("runs from the pnpm dlx cache");
    expect(stdout).toContain("then `mysql-axi setup hooks --local`");
    expect(existsSync(join(project, ".claude"))).toBe(false);
  });

  it("refuses a source checkout", async () => {
    process.argv[1] = join(saved.cwd, "packages", "mysql-axi", "bin", "mysql-axi.ts");
    const { stdout, exitCode } = await ro("setup", "hooks");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("not from a source checkout");
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });
});

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const roBin = fileURLToPath(new URL("../packages/mysql-axi/bin/mysql-axi.ts", import.meta.url));

describe("context", () => {
  const savedHome = process.env["HOME"];

  beforeEach(() => {
    useTestEnv();
    resetFake();
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "mysql-axi-home-"));
  });

  afterEach(() => {
    process.env["HOME"] = savedHome;
  });

  it("never connects and shows the last session in this directory", async () => {
    process.env["MYSQL_AXI_URL"] = "mysql://agent:hunter2@127.0.0.1:1/shop";
    const before = await ro("context");
    expect(before.exitCode).toBe(0);
    expect(before.stdout).toMatch(/^bin: /);
    expect(before.stdout).toContain("mode: READ-ONLY - one SELECT");
    expect(before.stdout).toContain('connection: "agent@127.0.0.1:1/shop (MYSQL_AXI_URL)"');
    expect(before.stdout).toContain("Run `mysql-axi` for live server state");
    expect(before.stdout).not.toContain("last_session");
    expect(before.stdout).not.toContain("hunter2");
    expect(fake.connections).toHaveLength(0);

    const transcript = join(mkdtempSync(join(tmpdir(), "mysql-axi-transcript-")), "t.jsonl");
    const command = `mysql-axi tables -d shop && mysql-axi "SELECT email FROM customers" -d shop`;
    writeFileSync(transcript, JSON.stringify({ message: { content: [{ type: "tool_use", input: { command } }] } }));
    const payload = JSON.stringify({ hook_event_name: "SessionEnd", transcript_path: transcript, cwd: process.cwd() });
    const end = spawnSync(process.execPath, [tsxCli, roBin, "context", "end"], { input: payload, encoding: "utf-8", env: process.env });
    expect(end.status).toBe(0);
    expect(end.stdout).toMatch(/recorded: "?\d{4}-\d\d-\d\d - tables 1; query 1 - database shop/);
    expect(readFileSync(join(process.env["MYSQL_AXI_CONFIG_DIR"]!, "sessions.json"), "utf-8")).not.toMatch(/email|customers/);

    const after = await ro("context");
    expect(after.stdout).toMatch(/last_session: "?\d{4}-\d\d-\d\d - tables 1; query 1 - database shop/);
    expect(fake.connections).toHaveLength(0);
  }, 30_000);

  it("records nothing, with exit 0, for a payload it cannot use", () => {
    for (const input of ["", "{}", JSON.stringify({ transcript_path: "/nonexistent/t.jsonl" })]) {
      const r = spawnSync(process.execPath, [tsxCli, roBin, "context", "end"], { input, encoding: "utf-8", env: process.env });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/recorded: "?nothing - /);
    }
  }, 30_000);

  it("leads the write tool with the warning and where writes go", async () => {
    const { stdout } = await rw("context");
    expect(stdout.split("\n").find((l) => !l.startsWith("bin:") && !l.startsWith("description:"))).toMatch(/^warning: WRITE-CAPABLE/);
    expect(stdout).toContain("SSH tunnel to 127.0.0.1 also counts as loopback");
    expect(stdout).toContain('Writes go through `mysql-rw-axi exec "<sql>"`');
  });
});

describe("home", () => {
  beforeEach(() => {
    useTestEnv();
    resetFake();
  });

  const names = (count: number) => Array.from({ length: count }, (_, i) => [`t${String(i + 1).padStart(2, "0")}`]);

  it("says not configured without connecting", async () => {
    delete process.env["MYSQL_AXI_URL"];
    const { stdout, exitCode } = await ro();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("mode: READ-ONLY - one SELECT");
    expect(stdout).toContain("not a grant check");
    expect(stdout).toContain("status: not configured");
    expect(fake.connections).toHaveLength(0);
  });

  it("shows the server and the default database's tables from a read-only session", async () => {
    fake.responder = answer({
      "SELECT VERSION()": { columns: ["version", "read_only"], rows: [["8.0.46", 0]] },
      "SELECT COUNT(*) AS n": { columns: ["n", "views", "bytes"], rows: [["23", "1", "1572864"]] },
      "SELECT TABLE_NAME AS name": { columns: ["name"], rows: names(20) },
    });
    const { stdout, exitCode } = await ro();
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^bin: /);
    expect(stdout).toContain('connection: "agent@127.0.0.1:3306/shop (MYSQL_AXI_URL)"\nserver: MySQL 8.0.46\ndatabase: shop - 22 tables; 1 views; 1.5 MB\n');
    expect(stdout).toContain(`tables[21]: ${names(20).join(",")},+3 more`);
    expect(stdout).toContain("Run `mysql-axi tables` for row estimates and sizes; `mysql-axi describe <table>` for columns and indexes");
    expect(stdout).not.toContain("s3cret");
    const [conn] = fake.connections;
    expect(conn!.options).toMatchObject({ connectTimeout: 3000, multipleStatements: false });
    expect(conn!.options["database"]).toBeUndefined();
    expect(conn!.ended).toBe(true);
    expect(fake.calls.slice(0, 2)).toEqual([
      { sql: "SET SESSION transaction_read_only = ON, SESSION max_execution_time = ?", values: [5000] },
      { sql: "START TRANSACTION READ ONLY", values: [] },
    ]);
    expect(fake.calls.find((c) => c.sql.startsWith("SELECT TABLE_NAME"))!.values).toEqual(["shop"]);
  });

  it("refuses a hand-edited profile instead of connecting to a default host", async () => {
    delete process.env["MYSQL_AXI_URL"];
    const cases: Array<[unknown, string]> = [
      [5, "is not an object"],
      [null, "is not an object"],
      [{ password: false }, "has no user"],
      [{ user: "agent", password: false }, "has no host or socket"],
      [{ user: "agent", host: "127.0.0.1", port: "3306", password: false }, "has a port outside 1-65535"],
    ];
    for (const [profile, problem] of cases) {
      saveProfiles({ dev: profile as object }, "dev");
      const home = await ro();
      expect(home.exitCode).toBe(0);
      expect(home.stdout).toContain(`live: unavailable - profile 'dev' in config.json ${problem}`);
      expect((await ro("context")).stdout).toContain(`invalid - ${problem}`);
      expect((await ro("auth", "status")).stdout).toContain(`invalid - ${problem}`);
      expect((await ro("tables")).stdout).toContain("code: AUTH_REQUIRED");
    }
    expect(fake.connections).toHaveLength(0);
    saveProfiles({ dev: null as unknown as object }, "dev");
    expect((await ro("auth", "logout", "--profile", "dev")).stdout).toContain("status: removed");
    expect((await ro("auth", "status")).stdout).toContain("profiles: none");
  });

  it("lists the largest databases without a default, and hints keep -p", async () => {
    saveProfiles({ staging: { host: "127.0.0.1", port: 3306, user: "agent", password: false } });
    fake.responder = answer({
      "SELECT VERSION()": { columns: ["version", "read_only"], rows: [["8.0.46", 1]] },
      "SELECT s.SCHEMA_NAME": { columns: ["name", "tables", "bytes"], rows: Array.from({ length: 10 }, (_, i) => [`db${i}`, "3", String(2048 * (10 - i))]) },
      "SELECT COUNT(*) AS n": { columns: ["n"], rows: [["12"]] },
    });
    const { stdout, exitCode } = await ro("-p", "staging");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^bin: /);
    expect(stdout).toContain("server: MySQL 8.0.46 - read_only is on\ndatabases[10]{name,tables,size}:\n  db0,3,20 KB\n");
    expect(stdout).toContain("Largest 10 of 12 shown - `mysql-axi databases -p staging` lists all");
    expect(stdout).toContain("Run `mysql-axi tables -d <database> -p staging` to list a database's tables");
    expect(stdout).toContain('Run `mysql-axi query "<sql>" -p staging` or `mysql-axi explain "<select>" -p staging`');
    expect(fake.calls.find((c) => c.sql.startsWith("SELECT s.SCHEMA_NAME"))!.values).toEqual(["mysql", "sys", "information_schema", "performance_schema"]);
  });

  it("reports a database that is not there inline", async () => {
    fake.responder = answer({
      "SELECT VERSION()": { columns: ["version", "read_only"], rows: [["8.0.46", 0]] },
      "SELECT COUNT(*) AS n": { columns: ["n", "views", "bytes"], rows: [["0", "0", "0"]] },
      "SELECT 1 FROM information_schema.SCHEMATA": { columns: ["1"], rows: [] },
    });
    const { stdout, exitCode } = await ro("-d", "nowhere");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("database: nowhere - not found or not visible to this account");
    expect(stdout).toContain("Run `mysql-axi databases` to list databases");
  });

  it("reports an unreachable server as unavailable with exit 0", async () => {
    fake.connectError = { code: "ECONNREFUSED" };
    const { stdout, exitCode } = await ro();
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^bin: /);
    expect(stdout).toContain('live: "unavailable - cannot reach agent@127.0.0.1:3306 - connection refused"');
    expect(stdout).toContain("Run `mysql-axi doctor` to diagnose");
    expect(stdout).not.toContain("s3cret");
    const other = await ro("-d", "other");
    expect(other.exitCode).toBe(0);
    expect(other.stdout).toContain('connection: "agent@127.0.0.1:3306/other (MYSQL_AXI_URL)"');
    expect(other.stdout).toContain("Run `mysql-axi doctor -d other` to diagnose");
  });

  it("reports a missing password as unavailable without connecting", async () => {
    delete process.env["MYSQL_AXI_URL"];
    saveProfiles({ dev: { host: "127.0.0.1", port: 3306, user: "app", password: true } }, "dev");
    const { stdout, exitCode } = await ro();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("profiles[1]{name,target,active}:");
    expect(stdout).toContain("live: unavailable - the OS keychain is disabled (MYSQL_AXI_NO_KEYCHAIN=1)\nhelp[2]:\n  Set MYSQL_AXI_URL instead\n");
    expect(fake.connections).toHaveLength(0);
  });

  it("gives up after 10 s and drops the connection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fake.responder = answer({ "SELECT VERSION()": { hang: true } });
      const run = ro();
      await vi.waitFor(() => expect(fake.calls.some((c) => c.sql.startsWith("SELECT VERSION()"))).toBe(true));
      await vi.advanceTimersByTimeAsync(10_000);
      const { stdout, exitCode } = await run;
      expect(exitCode).toBe(0);
      expect(stdout).toContain("live: unavailable - no answer within 10 s\nhelp[1]:\n  Run `mysql-axi doctor` to diagnose\n");
      expect(fake.connections[0]!.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a write-tool target outside loopback as unavailable without connecting", async () => {
    process.env["MYSQL_RW_AXI_URL"] = "mysql://agent:hunter2@10.1.2.3:3306/shop";
    const { stdout, exitCode } = await rw();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("live: unavailable - refusing host '10.1.2.3'");
    expect(stdout).toContain("Use mysql-axi (read-only) for any database that is not local");
    expect(stdout).not.toContain("hunter2");
    expect(fake.connections).toHaveLength(0);
  });

  it("fails on flags it cannot use", async () => {
    const profile = await ro("-p", "nope");
    expect(profile.exitCode).toBe(2);
    expect(profile.stdout).toContain("no profile 'nope'");
    expect((await ro("--limit", "5")).exitCode).toBe(2);
    expect((await ro("-d", "shop", "extra")).stdout).toContain("unexpected argument 'extra'");
    expect(fake.connections).toHaveLength(0);
  });
});
