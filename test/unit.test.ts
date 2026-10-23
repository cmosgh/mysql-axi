import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../packages/core/src/args.js";
import { cell, uniqueNames } from "../packages/core/src/cells.js";
import { hoistLeadingFlags, READ_COMMANDS } from "../packages/core/src/cli.js";
import { CONNECTION_FLAGS, followUp, rerunHint, shellQuote } from "../packages/core/src/commands/common.js";
import { summarizeGrants } from "../packages/core/src/grants.js";
import { parseUrl } from "../packages/core/src/target.js";
import { setTool } from "../packages/core/src/tool.js";
import { classify, singleStatement } from "../packages/mysql-rw-axi/src/classify.js";
import { isLoopback, loopbackOnly } from "../packages/mysql-rw-axi/src/loopback.js";
import { ScriptSplitter, splitScript } from "../packages/mysql-rw-axi/src/script.js";
import { TOOL } from "../packages/mysql-rw-axi/src/cli.js";

beforeAll(() => setTool(TOOL));

// Scripted DNS answers for the loopback rule; unset, the real resolver answers.
const dns = vi.hoisted(() => ({ answer: undefined as string[] | undefined }));
vi.mock("node:dns/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:dns/promises")>();
  const lookup = (host: string, options: object) =>
    dns.answer ? Promise.resolve(dns.answer.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))) : real.lookup(host, options);
  return { ...real, lookup };
});

const text = { name: "c", type: 253 };
const decimal = { name: "c", type: 246 };
const bigint = { name: "c", type: 8 };

describe("cells", () => {
  it("keeps numbers numeric only when they survive the round trip", () => {
    expect(cell("12.50", decimal, false)).toBe(12.5);
    expect(cell("42", bigint, false)).toBe(42);
    expect(cell("9223372036854775807", bigint, false)).toBe("9223372036854775807");
    expect(cell("12.50", text, false)).toBe("12.50");
  });

  it("shrinks blobs and long text", () => {
    expect(cell(Buffer.from([0xde, 0xad]), text, false)).toBe("0xdead");
    expect(cell(Buffer.alloc(100), text, false)).toBe("<blob 100 bytes>");
    expect(cell("x".repeat(250), text, false)).toBe(`${"x".repeat(200)}... (+50 chars; --full)`);
    expect(cell("x".repeat(250), text, true)).toHaveLength(250);
    expect(cell({ a: 1 }, text, false)).toBe('{"a":1}');
    expect(cell(null, text, false)).toBeNull();
  });

  it("de-duplicates column names", () => {
    expect(uniqueNames([{ name: "id", type: 3 }, { name: "id", type: 3 }, { name: "", type: 3 }])).toEqual(["id", "id_2", "?column?"]);
  });
});

describe("grants", () => {
  it("separates write privileges, column grants, grant option and roles", () => {
    const summary = summarizeGrants([
      "GRANT USAGE ON *.* TO `agent`@`%`",
      "GRANT SELECT, SHOW VIEW ON `shop`.* TO `agent`@`%`",
      "GRANT SELECT (`id`, `email`), UPDATE (`email`) ON `shop`.`customers` TO `agent`@`%` WITH GRANT OPTION",
      "GRANT `reporting`@`%` TO `agent`@`%`",
    ]);
    expect(summary.read).toEqual(["USAGE", "SELECT", "SHOW VIEW"]);
    expect(summary.write).toEqual(["UPDATE", "GRANT OPTION"]);
    expect(summary.roles).toEqual(["reporting@%"]);
  });

  it("treats a SELECT-only account as read-only", () => {
    expect(summarizeGrants(["GRANT SELECT ON `shop`.* TO `ro`@`%`"]).write).toEqual([]);
  });

  it("counts EXECUTE as write-capable (definer-rights routines)", () => {
    expect(summarizeGrants(["GRANT SELECT, EXECUTE ON `shop`.* TO `ro`@`%`"]).write).toEqual(["EXECUTE"]);
  });
});

describe("write classification", () => {
  const reason = (sql: string) => classify(singleStatement(sql)).irreversible;

  it.each([
    "DROP TABLE orders",
    "DROP DATABASE IF EXISTS shop",
    "TRUNCATE TABLE sessions",
    "DELETE FROM orders",
    "DELETE FROM orders LIMIT 10",
    "UPDATE orders SET status = 'x'",
    "UPDATE orders SET total = (SELECT 1 FROM t WHERE id = 1)",
    "ALTER TABLE orders DROP COLUMN note",
    "WITH old AS (SELECT id FROM orders) DELETE FROM orders",
    "REPLACE INTO customers (id, name) VALUES (1, 'x')",
    "LOAD DATA INFILE '/tmp/x.csv' REPLACE INTO TABLE t",
    "DELETE s1 FROM subscribers s1 JOIN subscribers s2 ON s1.email = s2.email AND s1.id > s2.id",
    "ALTER TABLE t ALTER COLUMN c DROP DEFAULT, DROP COLUMN d",
  ])("needs --confirm: %s", (sql) => {
    expect(reason(sql)).toBeTruthy();
  });

  it.each([
    "DELETE FROM orders WHERE id = 1",
    "UPDATE orders SET status = 'x' WHERE id = 1",
    "INSERT INTO orders (id) VALUES (1)",
    "INSERT INTO customers (id, name) VALUES (1, 'x') ON DUPLICATE KEY UPDATE name = VALUES(name)",
    "LOAD DATA INFILE '/tmp/x.csv' INTO TABLE t",
    "ALTER TABLE t ALTER COLUMN c DROP DEFAULT",
    "ALTER TABLE orders ADD COLUMN note TEXT",
    "CREATE TABLE t (a INT)",
    "SELECT * FROM orders",
  ])("runs directly: %s", (sql) => {
    expect(reason(sql)).toBeUndefined();
  });

  it("treats a routine body as one statement", () => {
    expect(reason("CREATE PROCEDURE p() BEGIN DELETE FROM t; SELECT 1; END")).toBeUndefined();
  });

  it("refuses several statements and points at import", () => {
    expect(() => singleStatement("DELETE FROM a WHERE id = 1; DROP TABLE b")).toThrow(/one statement per call/);
  });
});

describe("script splitting", () => {
  it("splits like the mysql client, honouring quotes, comments and DELIMITER", () => {
    const script = [
      "-- header; not a statement",
      "/*!40101 SET NAMES utf8mb4 */;",
      "INSERT INTO t VALUES ('a;b'), ('it''s'), ('back\\\\slash;');",
      "DELIMITER ;;",
      "CREATE FUNCTION f() RETURNS INT DETERMINISTIC BEGIN RETURN 1; END;;",
      "DELIMITER ;",
      "SELECT `odd;name` FROM t; # trailing",
    ].join("\n");
    expect(splitScript(script)).toEqual([
      "-- header; not a statement\n/*!40101 SET NAMES utf8mb4 */",
      "INSERT INTO t VALUES ('a;b'), ('it''s'), ('back\\\\slash;')",
      "CREATE FUNCTION f() RETURNS INT DETERMINISTIC BEGIN RETURN 1; END",
      "SELECT `odd;name` FROM t",
      "# trailing",
    ]);
  });

  it("fails on an unterminated string instead of guessing", () => {
    expect(() => splitScript("INSERT INTO t VALUES ('x);")).toThrow(/unterminated string/);
  });
});

describe("streaming splitter", () => {
  const script = [
    "/*!40101 SET NAMES utf8mb4 */;",
    "-- comment ; with delimiter",
    "INSERT INTO t VALUES ('a;b', 'it''s', 'back\\\\slash\\';', \"dq;\"), (`x``y`, 2);",
    "# hash comment",
    "DELIMITER ;;",
    "CREATE PROCEDURE p() BEGIN SELECT 1; SELECT '2;'; END;;",
    "DELIMITER ;",
    "SELECT 1--1;",
    "SELECT /* c ; */ 2; SELECT 3",
  ].join("\n");

  it.each(Array.from({ length: 40 }, (_, i) => i + 1))("gives the same statements in chunks of %i chars", (size) => {
    const splitter = new ScriptSplitter();
    const got: string[] = [];
    for (let i = 0; i < script.length; i += size) got.push(...splitter.push(script.slice(i, i + size)));
    got.push(...splitter.end());
    expect(got).toEqual(splitScript(script));
  });

  it("splits the reference script as the mysql client would", () => {
    const statements = splitScript(script);
    expect(statements).toHaveLength(7);
    expect(statements[3]).toBe("CREATE PROCEDURE p() BEGIN SELECT 1; SELECT '2;'; END");
  });
});

describe("loopback rule", () => {
  it.each(["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"])("accepts %s", (a) => expect(isLoopback(a)).toBe(true));
  it.each(["10.0.0.1", "192.168.1.5", "0.0.0.0", "::", "128.0.0.1"])("refuses %s", (a) => expect(isLoopback(a)).toBe(false));

  const target = { label: "t", source: "profile" as const, port: 3306, user: "root", password: "", tls: false };

  it("refuses a non-loopback host before connecting", async () => {
    await expect(loopbackOnly({ ...target, host: "203.0.113.7" })).rejects.toThrow(/only connects to loopback/);
  });

  it("pins localhost to the resolved loopback address and allows sockets", async () => {
    expect(isLoopback((await loopbackOnly({ ...target, host: "localhost" })).host!)).toBe(true);
    expect(await loopbackOnly({ ...target, socket: "/tmp/mysql.sock" })).toMatchObject({ socket: "/tmp/mysql.sock" });
  });

  describe("with scripted DNS answers", () => {
    const resolve = async (answer: string[], host = "localhost") => {
      dns.answer = answer;
      try {
        return (await loopbackOnly({ ...target, host })).host;
      } finally {
        dns.answer = undefined;
      }
    };

    it("prefers 127.x when localhost resolves to ::1 first, as on macOS", async () => {
      expect(await resolve(["::1", "127.0.0.1"])).toBe("127.0.0.1");
      expect(await resolve(["::1", "127.0.1.1"], "devbox")).toBe("127.0.1.1");
    });

    it("keeps the first address when no IPv4 loopback is among them", async () => {
      expect(await resolve(["::1"])).toBe("::1");
      expect(await resolve(["::1", "::ffff:127.0.0.1"])).toBe("::1");
    });

    it("still refuses a name with any address outside loopback", async () => {
      await expect(resolve(["::1", "127.0.0.1", "10.0.0.5"], "mixed")).rejects.toThrow(/refusing host 'mixed' \(10\.0\.0\.5\)/);
    });
  });
});

describe("connection URLs", () => {
  it("parses user, password, host, port, database and options", () => {
    expect(parseUrl("mysql://app%40x:p%3Ass@db.example.test:3307/shop?tls=true", "X")).toMatchObject({
      user: "app@x",
      password: "p:ss",
      host: "db.example.test",
      port: 3307,
      database: "shop",
      tls: true,
    });
    expect(parseUrl("mysql://root@localhost/?socket=/tmp/m.sock", "X")).toMatchObject({ socket: "/tmp/m.sock", port: 3306 });
  });

  it("never echoes the URL in errors", () => {
    expect(() => parseUrl("postgres://u:hunter2@h/db", "X")).toThrow(/must start with mysql/);
    try {
      parseUrl("mysql://:hunter2@h/db", "X");
    } catch (error) {
      expect(String(error)).not.toContain("hunter2");
    }
  });
});

describe("hoistLeadingFlags", () => {
  const hoist = (...argv: string[]) => hoistLeadingFlags(argv, { ...READ_COMMANDS, db: READ_COMMANDS["query"] });
  it("moves flags written before the command or bare SQL after it and its arguments", () => {
    expect(hoist("--profile", "staging", "databases")).toEqual(["databases", "--profile", "staging"]);
    expect(hoist("-p", "dev", "db", "drop", "x")).toEqual(["db", "drop", "x", "-p", "dev"]);
    expect(hoist("-p", "dev", "-d", "shop", "query", "SELECT 1")).toEqual(["query", "SELECT 1", "-p", "dev", "-d", "shop"]);
    expect(hoist("--full", "SELECT * FROM orders")).toEqual(["SELECT * FROM orders", "--full"]);
  });
  it("keeps them before a -- terminator and never takes a flag's value for the command", () => {
    expect(hoist("-d", "shop", "query", "--", "-1")).toEqual(["query", "-d", "shop", "--", "-1"]);
    expect(hoist("-d", "tables", "tables")).toEqual(["tables", "-d", "tables"]);
  });
  it("runs flags without a command as the home view", () => {
    expect(hoist("--profile", "dev")).toEqual(["home", "--profile", "dev"]);
    expect(hoist("-d", "tables")).toEqual(["home", "-d", "tables"]);
  });
  it("leaves help, version, stdin and commands that come first alone", () => {
    expect(hoist("--help", "query")).toEqual(["--help", "query"]);
    expect(hoist("-p", "dev", "--help")).toEqual(["-p", "dev", "--help"]);
    expect(hoist("-v")).toEqual(["-v"]);
    expect(hoist("-", "query")).toEqual(["-", "query"]);
    expect(hoist("tables", "-p", "dev")).toEqual(["tables", "-p", "dev"]);
  });
});

describe("hint commands", () => {
  const parse = (...args: string[]) =>
    parseArgs(args, [...CONNECTION_FLAGS, { name: "--limit" }, { name: "--file" }, { name: "--confirm", boolean: true }], "mysql-rw-axi query");

  it("quotes for a POSIX shell only when needed", () => {
    expect(shellQuote("shop_test")).toBe("shop_test");
    expect(shellQuote("/tmp/dump-2026.sql")).toBe("/tmp/dump-2026.sql");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("$HOME")).toBe("'$HOME'");
    expect(shellQuote("=x")).toBe("'=x'");
    expect(shellQuote("")).toBe("''");
  });

  it("carries -p and -d into follow-up commands", () => {
    expect(followUp(parse("-p", "staging", "--database=my shop"), "describe <table>")).toBe("mysql-rw-axi describe <table> -p staging -d 'my shop'");
    expect(followUp(parse("--profile", "staging", "-d", "shop"), "databases", { database: false })).toBe("mysql-rw-axi databases -p staging");
    expect(followUp(parse("SELECT 1"), "doctor")).toBe("mysql-rw-axi doctor");
  });

  it("rebuilds the command with flags replaced in place, added or removed", () => {
    const rerun = (args: string[], set: Record<string, string | true | null>) => rerunHint(parse(...args), set, "again");
    expect(rerun(["SELECT 1", "--limit=5", "-p", "dev"], { "--limit": "72" })).toBe("Run `mysql-rw-axi query 'SELECT 1' --limit 72 -p dev` again");
    expect(rerun(["-d", "shop", "--file", "fix.sql"], { "--database": null, "--confirm": true })).toBe("Run `mysql-rw-axi query --file fix.sql --confirm` again");
    expect(rerun(["--", "-1"], { "--limit": "2" })).toBe("Run `mysql-rw-axi query --limit 2 -- -1` again");
  });

  it("never repeats a password", () => {
    expect(rerunHint(parse("UPDATE users SET password = 'hunter2'"), { "--confirm": true }, "to execute")).toBe("Rerun the same command with --confirm to execute");
  });

  it("gives back the same argv through sh", () => {
    const args = ["SELECT 'it''s', \"q\", `id`, '$HOME', '\\n', '!*' FROM t WHERE a = 'ü'\n  AND b = 1 -- note", "-d", "my shop", "--", "--limit"];
    const hint = rerunHint(parse(...args), { "--limit": "3" }, "now");
    const command = hint.slice("Run `".length, -"` now".length);
    const printed = execFileSync("/bin/sh", ["-c", command.replace(/^mysql-rw-axi query /, "printf '%s\\0' ")], { encoding: "utf-8" });
    expect(printed.split("\0").slice(0, -1)).toEqual([args[0], "-d", "my shop", "--limit", "3", "--", "--limit"]);
  });
});
