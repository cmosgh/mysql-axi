import { beforeAll, describe, expect, it } from "vitest";
import { cell, uniqueNames } from "../packages/core/src/cells.js";
import { summarizeGrants } from "../packages/core/src/grants.js";
import { parseUrl } from "../packages/core/src/target.js";
import { setTool } from "../packages/core/src/tool.js";
import { classify, singleStatement } from "../packages/mysql-rw-axi/src/classify.js";
import { isLoopback, loopbackOnly } from "../packages/mysql-rw-axi/src/loopback.js";
import { ScriptSplitter, splitScript } from "../packages/mysql-rw-axi/src/script.js";
import { TOOL } from "../packages/mysql-rw-axi/src/cli.js";

beforeAll(() => setTool(TOOL));

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
