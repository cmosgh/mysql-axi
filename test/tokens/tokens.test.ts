// Local-only token benchmark: the same model, tasks and database, with the plain `mysql` client, with
// mysql-axi and with a read-only MySQL MCP server. TOKENS_MODEL picks the model (default sonnet), TOKENS_SUITE the task set
// (efficiency; accuracy: traps where the output format can cause a wrong answer; large: a 1M-row table, a
// 66-column table and 60 small tables, where output caps matter). Each run gets its own
// container and writes test/tokens/results/<suite>/<model>.json. `pnpm run tokens:readme` publishes them.
// TOKENS_ARMS=mcp runs only those arms and replaces their runs in an existing results file.
// Needs Docker, a logged-in `claude` CLI and a `mysql` client on PATH. Never runs in CI.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scalar, serverPort, sql } from "../integration/db.js";
import { SHOP_FIXTURE } from "../integration/fixtures.js";
import { LARGE_FIXTURE, PROFILE_COLUMN_NAMES } from "./large.js";
import { renderTable, type Arm, type Call, type Results, type Run, type Suite } from "./report.js";

const RUNS = Number(process.env["TOKENS_RUNS"] ?? 3);
const MODEL = process.env["TOKENS_MODEL"] ?? "sonnet";
const CONCURRENCY = Number(process.env["TOKENS_CONCURRENCY"] ?? 4);
const MAX_TURNS = 25;

const root = fileURLToPath(new URL("../..", import.meta.url));
const slug = MODEL.replace(/[^\w.-]+/g, "-");
const SUITES: Suite[] = ["efficiency", "accuracy", "large"];
const SUITE = (process.env["TOKENS_SUITE"] ?? "efficiency") as Suite;
if (!SUITES.includes(SUITE)) throw new Error(`TOKENS_SUITE must be one of ${SUITES.join(", ")}, not ${SUITE}`);
const runsDir = join(root, "test/tokens/.runs", SUITE, slug);
const DB = "shop";
const USER = "bench";
const PASSWORD = randomBytes(9).toString("hex");

interface Task {
  id: string;
  prompt: string;
  /** Checks the `ANSWER:` line. */
  check: (answer: string) => boolean;
}

const expected: Record<string, string> = {};

const EFFICIENCY_TASKS: Task[] = [
  {
    id: "orders per status",
    prompt: "How many orders are there per status?",
    check: (a) => a.includes("3334") && a.includes("3333"),
  },
  {
    id: "FK delete rule",
    prompt: "Which foreign keys does the orders table have, and what happens to a customer's orders when that customer is deleted?",
    check: (a) => /cascade/i.test(a),
  },
  {
    id: "index use",
    prompt: "Does this query use an index? SELECT id, total FROM orders WHERE status = 'paid' AND created_at >= '2026-10-01'. Answer yes or no first.",
    check: (a) => /^\W*no\b/i.test(a),
  },
  {
    id: "orphan rows",
    prompt: "Which reviews point at an order that does not exist? Give the review ids.",
    check: (a) => /\b7\b/.test(a) && /\b13\b/.test(a),
  },
  {
    id: "largest table",
    prompt: "Which table uses the most disk space?",
    check: (a) => /\borders\b/i.test(a),
  },
  {
    id: "duplicate emails",
    prompt: "Which subscriber emails appear more than once, ignoring letter case?",
    check: (a) => /a@x\.test/i.test(a) && /b@x\.test/i.test(a) && !/c@x\.test/i.test(a),
  },
  {
    id: "top country revenue",
    prompt: "Which shipping country (orders.meta, key ship.country) has the highest total revenue from paid orders?",
    check: (a) => a.toUpperCase().includes(expected["country"]!),
  },
  {
    id: "long text article",
    prompt: "What is article 2 in the articles table about? A few words are enough.",
    check: (a) => /rotat|credential|password/i.test(a),
  },
  {
    id: "schema overview",
    prompt: "Give an overview of every table in the database: its approximate row count and which tables it references. The ANSWER line lists the table names, comma-separated.",
    check: (a) => ["articles", "customers", "orders", "reviews", "subscribers"].every((t) => a.toLowerCase().includes(t)),
  },
  {
    id: "customers without orders",
    prompt: "How many customers have never placed an order?",
    check: (a) => /^\W*0\b/.test(a),
  },
];

/** First number in an answer, thousands separators already removed. */
const firstNumber = (a: string): number | undefined => {
  const m = /-?\d+(\.\d+)?/.exec(a);
  return m ? Number(m[0]) : undefined;
};

const ACCURACY_TASKS: Task[] = [
  {
    id: "all out-of-stock SKUs",
    prompt: "List the SKU of every product that is out of stock (stock = 0). The ANSWER line must list all of them, comma-separated.",
    check: (a) => {
      const got = [...new Set(a.match(/SKU-\d{4}/g) ?? [])].sort();
      return got.join(",") === expected["skus"];
    },
  },
  {
    id: "root cause at the end of a report",
    prompt: "What does the final finding of incident 1 name as the root cause?",
    check: (a) => /certificate|tls/i.test(a),
  },
  {
    id: "literal 'NULL' text vs SQL NULL",
    prompt: "Some contacts have the text 'NULL' stored as their phone (a data-entry bug), which is different from a missing phone (SQL NULL) or an empty string. How many contacts have that literal text?",
    check: (a) => firstNumber(a) === Number(expected["nullText"]),
  },
  {
    id: "exact BIGINT id",
    prompt: "What is the id of the most recent event? Give the exact id.",
    check: (a) => a.includes(expected["latestEvent"]!),
  },
  {
    id: "top spender in March",
    prompt: "Which customer spent the most on paid orders created in March 2026, and what is that exact total?",
    check: (a) => new RegExp(`\\b${expected["spenderName"]}\\b`).test(a) && (a.match(/\d+(\.\d+)?/g) ?? []).some((n) => Number(n).toFixed(2) === expected["spenderTotal"]),
  },
];

/** Identifiers in an answer line: `a, b and c` or a markdown list. */
const idents = (a: string): Set<string> => new Set(a.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);

const WIDE_ROW_HANDLE = "member_02718";

const LARGE_TASKS: Task[] = [
  {
    id: "wide table columns",
    prompt: "How many columns does the profiles table have, and which of them are TEXT or JSON columns? The ANSWER line gives the count and those column names.",
    check: (a) => new RegExp(`\\b${expected["profileColumns"]}\\b`).test(a) && expected["textColumns"]!.split(",").every((c) => idents(a).has(c)),
  },
  {
    id: "one wide row",
    prompt: `Which plan is the profile with handle ${WIDE_ROW_HANDLE} on, which country is it in, and what does its bio say it writes about?`,
    check: (a) => [expected["rowPlan"]!, expected["rowCountry"]!, expected["rowTopic"]!].every((v) => a.toLowerCase().includes(v.toLowerCase())),
  },
  {
    id: "always-NULL columns",
    prompt: "Which columns of the profiles table are NULL in every row? The ANSWER line lists only those column names, comma-separated.",
    check: (a) => {
      const got = idents(a);
      const want = expected["nullColumns"]!.split(",");
      // Other column names with an underscore cannot be ordinary words, so none of them may appear.
      const others = PROFILE_COLUMN_NAMES.filter((c) => c.includes("_") && !want.includes(c));
      return want.every((c) => got.has(c)) && !others.some((c) => got.has(c));
    },
  },
  {
    id: "largest tables",
    prompt: "Which three tables in the database have the most rows? The ANSWER line names them, largest first.",
    check: (a) => {
      const positions = expected["largestTables"]!.split(",").map((t) => a.toLowerCase().indexOf(t));
      return positions.every((p, i) => p !== -1 && (i === 0 || p > positions[i - 1]!));
    },
  },
  {
    id: "events per kind",
    prompt: "How many events are there per kind in the events table? The ANSWER line lists each kind with its count.",
    check: (a) => expected["eventCounts"]!.split(",").every((n) => new RegExp(`\\b${n}\\b`).test(a)),
  },
  {
    id: "all enterprise handles in Norway",
    prompt: "List the handle of every profile on the enterprise plan located in Norway. The ANSWER line must list all of them, comma-separated.",
    check: (a) => [...new Set(a.match(/member_\d{5}/g) ?? [])].sort().join(",") === expected["handles"],
  },
];

const EFFICIENCY_FIXTURE = [
  "CREATE TABLE reviews (id INT PRIMARY KEY, order_id BIGINT UNSIGNED NOT NULL, stars TINYINT)",
  "INSERT INTO reviews SELECT d + 1, IF(d + 1 IN (7, 13), 990000 + d, (d + 1) * 10), 1 + d % 5 FROM (SELECT a.d * 10 + b.d AS d FROM digits a, digits b) s WHERE d < 20",
  "CREATE TABLE subscribers (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(100), created_at DATETIME)",
  "INSERT INTO subscribers (email, created_at) VALUES ('a@x.test', '2026-01-01'), ('A@x.test', '2026-01-02'), ('b@x.test', '2026-01-03'), ('b@x.test', '2026-01-04'), ('c@x.test', '2026-01-05')",
  "CREATE TABLE articles (id INT PRIMARY KEY, title VARCHAR(100), body TEXT, published_at DATE)",
  `INSERT INTO articles VALUES
     (1, 'Release notes 4.2', CONCAT('Version 4.2 adds dark mode and faster search. ', REPEAT('More release details follow here. ', 180)), '2026-03-01'),
     (2, 'Operations handbook', CONCAT('This guide explains how to rotate database credentials without downtime. ', REPEAT('Background details and examples follow. ', 160)), '2026-04-01'),
     (3, 'Hiring update', CONCAT('We are hiring two backend engineers in Berlin. ', REPEAT('Role details and benefits are listed. ', 170)), '2026-05-01'),
     (4, 'Incident review', CONCAT('A cache stampede caused the outage on May 3rd. ', REPEAT('Timeline entries and follow-ups. ', 190)), '2026-06-01')`,
];

/** Traps: more rows than a default cap, a fact at the end of a long text, 'NULL' text, ids above 2^53. */
const ACCURACY_FIXTURE = [
  "CREATE TABLE products (id INT PRIMARY KEY, sku VARCHAR(12), name VARCHAR(40), stock INT)",
  `INSERT INTO products SELECT n + 1, CONCAT('SKU-', LPAD(n + 1, 4, '0')), CONCAT('Product ', n + 1), IF(n % 11 IN (3, 7), 0, 1 + n % 37)
     FROM (SELECT a.d * 100 + b.d * 10 + c.d AS n FROM digits a, digits b, digits c) s WHERE n < 400`,
  "CREATE TABLE incidents (id INT PRIMARY KEY, title VARCHAR(60), report TEXT)",
  `INSERT INTO incidents VALUES
     (1, 'Checkout outage', CONCAT('First responders suspected a cache stampede. ', REPEAT('Timeline entry: metrics were reviewed and alerts were triaged. ', 60),
        'Final finding: the root cause was an expired TLS certificate on the internal message broker.')),
     (2, 'Slow search', CONCAT('Search latency rose after a deploy. ', REPEAT('Investigation notes. ', 50), 'Final finding: a missing index on search_terms.'))`,
  "CREATE TABLE contacts (id INT PRIMARY KEY, name VARCHAR(30), phone VARCHAR(20))",
  `INSERT INTO contacts SELECT n + 1, CONCAT('Contact ', n + 1),
       CASE WHEN n % 9 = 0 THEN NULL WHEN n % 9 = 4 THEN 'NULL' WHEN n % 9 = 6 THEN '' ELSE CONCAT('+49 30 ', 100000 + n) END
     FROM (SELECT a.d * 100 + b.d * 10 + c.d AS n FROM digits a, digits b, digits c) s WHERE n < 120`,
  "CREATE TABLE events (id BIGINT UNSIGNED PRIMARY KEY, kind VARCHAR(20), at DATETIME)",
  "INSERT INTO events VALUES (18446744073709551557, 'login', '2026-09-01 10:00:00'), (18446744073709551558, 'logout', '2026-09-30 23:59:59'), (9007199254740993, 'signup', '2026-08-01 08:00:00')",
  // March top spender with traps: a refund, an order late on 31 March (lost by BETWEEN dates), one on 1 April.
  `INSERT INTO orders (customer_id, status, total, meta, created_at) VALUES
     (500, 'paid', 612.40, NULL, '2026-03-03 09:00:00'), (500, 'paid', 387.59, NULL, '2026-03-31 23:30:00'),
     (500, 'refunded', 1500.00, NULL, '2026-03-10 12:00:00'), (77, 'paid', 990.00, NULL, '2026-03-20 15:00:00'),
     (77, 'paid', 500.00, NULL, '2026-04-01 00:00:00')`,
];

// TOKENS_ONLY="orders per status" runs a subset as a smoke test; it never touches the README.
const ONLY = process.env["TOKENS_ONLY"]?.split(",").map((t) => t.trim());
const SUITE_TASKS = { efficiency: EFFICIENCY_TASKS, accuracy: ACCURACY_TASKS, large: LARGE_TASKS }[SUITE];
const SUITE_FIXTURE = { efficiency: EFFICIENCY_FIXTURE, accuracy: ACCURACY_FIXTURE, large: LARGE_FIXTURE }[SUITE];
const TASKS = ONLY ? SUITE_TASKS.filter((t) => ONLY.includes(t.id)) : SUITE_TASKS;
const ALL_ARMS: Arm[] = ["plain", "axi", "axi_home", "axi_skill", "mcp"];
const ARMS = (process.env["TOKENS_ARMS"]?.split(",").map((a) => a.trim()) ?? ALL_ARMS) as Arm[];
for (const arm of ARMS) if (!ALL_ARMS.includes(arm)) throw new Error(`TOKENS_ARMS: unknown arm ${arm} (${ALL_ARMS.join(", ")})`);
/** The MCP server the mcp arm talks to, pinned so runs stay comparable. */
const MCP_PACKAGE = "mysql-mcp-server@0.1.4";
/** The home view, as `mysql-axi setup hooks` injects it at session start (axi_home arm). */
let homeView = "";
let setup: Record<string, unknown> = {};
let binPath = "";

function prompt(arm: Arm, task: Task): string {
  const how =
    arm === "plain"
      ? `Use the \`mysql\` command-line client through Bash: \`mysql -h 127.0.0.1 -P ${serverPort()} -u ${USER} ${DB}\` (the password is already in MYSQL_PWD).`
      : arm === "mcp"
        ? "Use the tools of the `mysql` MCP server; the connection is already configured."
        : "Use the `mysql-axi` CLI through Bash; the connection is already configured.";
  return `You have a local MySQL 8 database named ${DB}. ${how}\nTask: ${task.prompt}\nEnd your reply with one line: ANSWER: <short answer>`;
}

function envFor(arm: Arm, bin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Nothing from this test run, pnpm (npm_config_* makes npx warn) or an outer Claude Code session leaks into the agent.
    if (!/^(CLAUDECODE|CLAUDE_CODE_|MYSQL_|VITEST|NODE_ENV|npm_|PNPM_)/i.test(key)) env[key] = value;
  }
  if (arm === "plain") return { ...env, MYSQL_PWD: PASSWORD };
  if (arm === "mcp") return env;
  return {
    ...env,
    PATH: `${bin}:${env["PATH"]}`,
    MYSQL_AXI_URL: `mysql://${USER}:${PASSWORD}@127.0.0.1:${serverPort()}/${DB}`,
    MYSQL_AXI_NO_KEYCHAIN: "1",
    MYSQL_AXI_CONFIG_DIR: mkdtempSync(join(tmpdir(), "mysql-axi-tokens-")),
  };
}

/** An MCP config for the mcp arm, the way such servers are usually registered: npx plus MYSQL_* env. */
function mcpConfig(): string {
  const env = { MYSQL_HOST: "127.0.0.1", MYSQL_PORT: String(serverPort()), MYSQL_USER: USER, MYSQL_PASSWORD: PASSWORD, MYSQL_DATABASE: DB };
  return JSON.stringify({ mcpServers: { mysql: { command: "npx", args: ["-y", MCP_PACKAGE], env } } });
}

function toolArgs(arm: Arm): string[] {
  if (arm === "mcp") return ["--tools", "", "--allowedTools", "mcp__mysql", "--mcp-config", mcpConfig()];
  if (arm === "axi_skill") {
    // The skill tells agents to run `npx -y mysql-axi`; the cwd's node_modules makes npx resolve the local build.
    return ["--tools", "Bash,Skill", "--allowedTools", `Skill Bash(npx -y mysql-axi:*) Bash(npx mysql-axi:*) Bash(mysql-axi:*) Bash(${binPath}:*)`];
  }
  return ["--tools", "Bash", "--allowedTools", arm === "plain" ? "Bash(mysql:*)" : `Bash(mysql-axi:*) Bash(${binPath}:*)`];
}

/** An empty project, or for axi_skill one with the skill and mysql-axi installed, as `npm i -D mysql-axi` plus the skill would leave it. */
function projectDir(arm: Arm): string {
  const cwd = mkdtempSync(join(tmpdir(), "mysql-axi-tokens-cwd-"));
  if (arm !== "axi_skill") return cwd;
  const pkg = join(root, "packages/mysql-axi");
  mkdirSync(join(cwd, ".claude/skills/mysql-axi"), { recursive: true });
  writeFileSync(join(cwd, ".claude/skills/mysql-axi/SKILL.md"), readFileSync(join(pkg, "skills/mysql-axi/SKILL.md")));
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "app", private: true, devDependencies: { "mysql-axi": "*" } })}\n`);
  mkdirSync(join(cwd, "node_modules/.bin"), { recursive: true });
  symlinkSync(pkg, join(cwd, "node_modules/mysql-axi"));
  symlinkSync(join(pkg, "dist/mysql-axi.js"), join(cwd, "node_modules/.bin/mysql-axi"));
  return cwd;
}

function runAgent(arm: Arm, task: Task, bin: string, index: number): Promise<Run> {
  const args = [
    "-p", prompt(arm, task),
    "--model", MODEL,
    "--output-format", "stream-json", "--verbose",
    ...toolArgs(arm),
    ...(arm === "axi_home" ? ["--append-system-prompt", homeView] : []),
    "--strict-mcp-config",
    // Project settings only for axi_skill, whose project holds nothing but the skill.
    "--setting-sources", arm === "axi_skill" ? "project,local" : "local",
    "--no-session-persistence",
    "--max-turns", String(MAX_TURNS),
  ];
  const cwd = projectDir(arm);
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, env: envFor(arm, bin), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", () => {
      writeFileSync(join(runsDir, `${task.id.replace(/\W+/g, "-")}.${arm}.${index}.jsonl`), stdout);
      const events = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
      const result = events.find((e) => e["type"] === "result");
      if (!result) return reject(new Error(`no result from claude (${arm}, ${task.id}): ${stderr.slice(0, 500)}`));
      const init = events.find((e) => e["type"] === "system" && e["subtype"] === "init");
      const mcp = (init?.["mcp_servers"] ?? []) as Array<{ name: string; status: string }>;
      if (arm === "mcp" && mcp.find((s) => s.name === "mysql")?.status !== "connected") {
        return reject(new Error(`the mysql MCP server did not connect (${task.id}): ${JSON.stringify(mcp)}`));
      }
      const calls: Call[] = [];
      const byId = new Map<string, Call>();
      for (const event of events) {
        const content = event["message"]?.["content"];
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (part?.type === "tool_use") {
            const command = part.name === "Bash" ? String(part.input?.command ?? "") : `${String(part.name).replace(/^mcp__mysql__/, "")} ${JSON.stringify(part.input ?? {})}`;
            const call: Call = { command: scrub(command).slice(0, 400), outputChars: 0, isError: false, preview: "" };
            calls.push(call);
            byId.set(String(part.id), call);
          }
          if (part?.type !== "tool_result") continue;
          const output = typeof part.content === "string" ? part.content : (part.content ?? []).map((c: any) => String(c?.text ?? "")).join("");
          const call = byId.get(String(part.tool_use_id));
          if (call) Object.assign(call, { outputChars: output.length, isError: Boolean(part.is_error), preview: scrub(output).slice(0, 200) });
        }
      }
      const toolOutputChars = calls.reduce((n, c) => n + c.outputChars, 0);
      const toolCalls = calls.length;
      const text = String(result["result"] ?? "");
      // "3,334" and "3334" are the same answer.
      const answer = ([...text.matchAll(/ANSWER:\s*(.*)/g)].pop()?.[1]?.trim() ?? "").replace(/(\d),(?=\d{3}\b)/g, "$1");
      const usage = result["usage"] ?? {};
      resolve({
        arm,
        task: task.id,
        correct: answer !== "" && task.check(answer),
        answer,
        turns: Number(result["num_turns"] ?? 0),
        toolCalls,
        toolOutputChars,
        inputTokens: Number(usage["input_tokens"] ?? 0),
        cacheCreationTokens: Number(usage["cache_creation_input_tokens"] ?? 0),
        cacheReadTokens: Number(usage["cache_read_input_tokens"] ?? 0),
        outputTokens: Number(usage["output_tokens"] ?? 0),
        costUsd: Number(result["total_cost_usd"] ?? 0),
        durationMs: Number(result["duration_ms"] ?? 0),
        model: Object.keys(result["modelUsage"] ?? {}).join("; ") || MODEL,
        calls,
      });
    });
  });
}

/** Machine-specific paths stay out of the committed results. */
function scrub(text: string): string {
  let out = text;
  if (binPath) for (const dir of new Set([realpathSync(dirname(binPath)), dirname(binPath)])) out = out.replaceAll(dir, "<bin>");
  for (const dir of new Set([tmpdir(), realpathSync(tmpdir())])) out = out.replaceAll(dir, "$TMPDIR");
  return out;
}

/** Runs jobs with at most `limit` in flight. */
async function pool<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, async () => {
      while (next < jobs.length) {
        const index = next++;
        results[index] = await jobs[index]!();
      }
    }),
  );
  return results;
}

const runs: Run[] = [];

beforeAll(async () => {
  for (const tool of ["claude", "mysql"]) {
    if (spawnSync(tool, ["--version"]).status !== 0) throw new Error(`the token suite needs \`${tool}\` on PATH`);
  }
  await sql(`DROP DATABASE IF EXISTS ${DB}`);
  await sql(`CREATE DATABASE ${DB}`);
  for (const statement of [...SHOP_FIXTURE, ...SUITE_FIXTURE]) await sql(statement, DB);
  // The 5.7 clients still common on dev machines cannot speak caching_sha2_password.
  await sql(`CREATE USER ${USER} IDENTIFIED WITH mysql_native_password BY '${PASSWORD}'`);
  await sql(`GRANT ALL ON ${DB}.* TO ${USER}`);
  if (SUITE === "accuracy") {
    expected["skus"] = (await sql<{ sku: string }>("SELECT sku FROM products WHERE stock = 0 ORDER BY sku", DB)).map((r) => r.sku).join(",");
    expected["nullText"] = String(await scalar("SELECT COUNT(*) FROM contacts WHERE phone = 'NULL'", DB));
    expected["latestEvent"] = String(await scalar("SELECT CAST(id AS CHAR) FROM events ORDER BY at DESC LIMIT 1", DB));
    const [top, second] = await sql<{ name: string; total: string }>(
      "SELECT c.name, CAST(SUM(o.total) AS CHAR) AS total FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'paid' AND o.created_at >= '2026-03-01' AND o.created_at < '2026-04-01' GROUP BY c.id ORDER BY SUM(o.total) DESC LIMIT 2",
      DB,
    );
    if (!top || top.total === second?.total) throw new Error("the March top spender must be unique");
    expected["spenderName"] = top.name;
    expected["spenderTotal"] = Number(top.total).toFixed(2);
  } else if (SUITE === "large") {
    const columns = await sql<{ name: string; type: string }>(
      "SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'profiles' ORDER BY ORDINAL_POSITION",
      undefined,
      [DB],
    );
    expected["profileColumns"] = String(columns.length);
    expected["textColumns"] = columns.filter((c) => ["text", "json"].includes(c.type)).map((c) => c.name).join(",");
    const [counts] = await sql<Record<string, number>>(`SELECT ${columns.map((c) => `COUNT(\`${c.name}\`) AS \`${c.name}\``).join(", ")} FROM profiles`, DB);
    expected["nullColumns"] = columns.filter((c) => Number(counts![c.name]) === 0).map((c) => c.name).join(",");
    const [row] = await sql<{ plan: string; country: string; bio: string }>("SELECT plan, country, bio FROM profiles WHERE handle = ?", DB, [WIDE_ROW_HANDLE]);
    Object.assign(expected, { rowPlan: row!.plan, rowCountry: row!.country, rowTopic: /writes about (\w+)/.exec(row!.bio)![1]! });
    const tables = await sql<{ name: string }>("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", undefined, [DB]);
    const exact = await Promise.all(tables.map(async (t) => ({ name: t.name, rows: Number(await scalar(`SELECT COUNT(*) FROM \`${t.name}\``, DB)) })));
    expected["largestTables"] = exact.sort((a, b) => b.rows - a.rows).slice(0, 3).map((t) => t.name).join(",");
    expected["eventCounts"] = (await sql<{ n: number }>("SELECT COUNT(*) AS n FROM events GROUP BY kind", DB)).map((r) => String(r.n)).join(",");
    expected["handles"] = (await sql<{ handle: string }>("SELECT handle FROM profiles WHERE plan = 'enterprise' AND country = 'Norway' ORDER BY handle", DB)).map((r) => r.handle).join(",");
  } else {
    expected["country"] = String(
      await scalar("SELECT meta->>'$.ship.country' FROM orders WHERE status = 'paid' GROUP BY 1 ORDER BY SUM(total) DESC LIMIT 1", DB),
    );
  }

  const bin = mkdtempSync(join(tmpdir(), "mysql-axi-tokens-bin-"));
  // A symlink, like an npm global install, so the home view's `bin:` names this path.
  const entry = join(root, "packages/mysql-axi/dist/mysql-axi.js");
  chmodSync(entry, 0o755);
  symlinkSync(entry, join(bin, "mysql-axi"));
  binPath = join(bin, "mysql-axi");
  mkdirSync(runsDir, { recursive: true });

  // Both connections must work before any tokens are spent.
  const plain = spawnSync("mysql", ["-h", "127.0.0.1", "-P", String(serverPort()), "-u", USER, DB, "-e", "SELECT COUNT(*) FROM orders"], { env: envFor("plain", bin), encoding: "utf-8" });
  if (plain.status !== 0) throw new Error(`plain mysql client cannot connect: ${plain.stderr}`);
  const axi = spawnSync("mysql-axi", ["query", "SELECT COUNT(*) AS n FROM orders"], { env: envFor("axi", bin), encoding: "utf-8" });
  if (axi.status !== 0) throw new Error(`mysql-axi cannot connect (run pnpm run build first): ${axi.stdout}${axi.stderr}`);
  homeView = spawnSync("mysql-axi", [], { env: envFor("axi", bin), encoding: "utf-8" }).stdout;
  if (ARMS.includes("mcp")) {
    // Fills the npx cache so the first agent does not wait on a download; the server exits when stdin closes.
    const warm = spawnSync("npx", ["-y", MCP_PACKAGE], { input: "", encoding: "utf-8", timeout: 180_000, env: { ...process.env, MYSQL_HOST: "127.0.0.1", MYSQL_USER: USER } });
    if (warm.error) throw new Error(`cannot start ${MCP_PACKAGE}: ${warm.error.message}`);
  }
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf-8" }).stdout.trim();
  setup = {
    claude: spawnSync("claude", ["--version"], { encoding: "utf-8" }).stdout.trim(),
    mysqlServer: String(await scalar("SELECT VERSION()")),
    mysqlClient: spawnSync("mysql", ["--version"], { encoding: "utf-8" }).stdout.trim(),
    mysqlAxi: `${JSON.parse(readFileSync(join(root, "packages/mysql-axi/package.json"), "utf-8")).version} (${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain") ? " + local changes" : ""})`,
    maxTurns: MAX_TURNS,
    concurrency: CONCURRENCY,
    prompts: Object.fromEntries(ARMS.map((arm) => [arm, prompt(arm, { id: "<task>", prompt: "<task prompt>", check: () => true })])),
    homeView: scrub(homeView),
    mcpServer: MCP_PACKAGE,
    tasks: Object.fromEntries(TASKS.map((t) => [t.id, t.prompt])),
  };

  const jobs = TASKS.flatMap((task) => Array.from({ length: RUNS }, (_, i) => ARMS.map((arm) => () => runAgent(arm, task, bin, i))).flat());
  runs.push(...(await pool(jobs, CONCURRENCY)));
});

// The README is only rewritten on request: `pnpm run tokens:readme` reads the results files.
afterAll(() => {
  if (runs.length === 0) return;
  if (ONLY) {
    writeFileSync(join(runsDir, "smoke.json"), `${JSON.stringify(runs, null, 2)}\n`);
    return;
  }
  const file = join(root, `test/tokens/results/${SUITE}/${slug}.json`);
  const date = new Date().toISOString();
  let results: Results = { suite: SUITE, model: MODEL, runs: RUNS, date, setup, results: runs };
  if (ARMS.length < ALL_ARMS.length && existsSync(file)) {
    // Adds or replaces only these arms; the file records which arms ran later and with what.
    const previous = JSON.parse(readFileSync(file, "utf-8")) as Results;
    if (JSON.stringify(previous.setup["tasks"]) !== JSON.stringify(setup["tasks"]) || previous.runs !== RUNS) {
      throw new Error(`${file} has other tasks or run counts; rerun every arm instead of TOKENS_ARMS`);
    }
    const later = { ...(previous.setup["laterArms"] as Record<string, unknown>) };
    for (const arm of ARMS) later[arm] = { date, claude: setup["claude"], mysqlServer: setup["mysqlServer"], mysqlAxi: setup["mysqlAxi"] };
    results = {
      ...previous,
      setup: { ...previous.setup, mcpServer: MCP_PACKAGE, prompts: { ...(previous.setup["prompts"] as object), ...(setup["prompts"] as object) }, laterArms: later },
      results: [...previous.results.filter((r) => !ARMS.includes(r.arm)), ...runs],
    };
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(runsDir, "table.md"), `${renderTable(results)}\n`);
});

// Accuracy results are measurements, not pass/fail; efficiency tasks must be solvable with mysql-axi.
// This test always runs: with every test skipped vitest would skip beforeAll too.
describe("runs", () => {
  it("recorded a result for every task, arm and run", () => {
    expect(runs).toHaveLength(TASKS.length * ARMS.length * RUNS);
  });
});

describe.runIf(SUITE === "efficiency" && ARMS.some((arm) => arm === "axi" || arm === "axi_home"))("token usage: plain mysql client vs mysql-axi", () => {
  it.each(TASKS.flatMap((t) => (["axi", "axi_home"] as const).filter((arm) => ARMS.includes(arm)).map((arm) => [t.id, arm] as const)))("%s: the %s arm answers correctly in most runs", (id, arm) => {
    const rs = runs.filter((r) => r.task === id && r.arm === arm);
    expect(rs.filter((r) => r.correct).length, JSON.stringify(rs.map((r) => r.answer))).toBeGreaterThan(RUNS / 2);
  });
});
