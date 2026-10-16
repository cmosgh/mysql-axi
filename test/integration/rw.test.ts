import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ro, rw } from "../helpers.js";
import { inContainer, rootUrl, scalar, scratchDatabase, serverPort, spawnCli, sql } from "./db.js";

const DB = "axi_it_rw";
const dir = mkdtempSync(join(tmpdir(), "mysql-axi-it-"));
const tableExists = async (table: string, database = DB) =>
  (await sql("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", undefined, [database, table])).length > 0;

beforeAll(async () => {
  await scratchDatabase(DB);
});

describe("read commands stay read-only", () => {
  beforeAll(async () => {
    await sql("CREATE TABLE notes (id INT PRIMARY KEY, body VARCHAR(20))", DB);
    await sql("INSERT INTO notes VALUES (1, 'kept')", DB);
    await sql("CREATE FUNCTION scribble() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN INSERT INTO notes VALUES (2, 'x'); RETURN 1; END", DB);
  });

  it("query refuses writes and points at exec", async () => {
    const { stdout, exitCode } = await rw("query", "DELETE FROM notes");
    expect(exitCode).toBe(2);
    expect(stdout).toContain('Writes go through `mysql-rw-axi exec "<sql>"`');
  });

  it("query runs in a read-only session, so a writing function fails", async () => {
    expect((await rw("query", "SELECT scribble()")).stdout).toContain("READ ONLY transaction");
    expect((await rw("sample", "notes")).stdout).toContain("result[1]{id,body}:\n  1,kept");
    expect(await scalar("SELECT COUNT(*) FROM notes", DB)).toBe(1);
  });

  it("doctor reports the write grants without a warning", async () => {
    const { stdout } = await rw("doctor");
    expect(stdout).toContain("grants: write-capable - ");
    expect(stdout).not.toContain("warning");
  });
});

describe("exec", () => {
  beforeEach(async () => {
    await sql("DROP TABLE IF EXISTS items", DB);
    await sql("CREATE TABLE items (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(10) NOT NULL, qty INT DEFAULT 0, KEY by_qty (qty))", DB);
    await sql("INSERT INTO items (name, qty) VALUES ('a', 1), ('b', 2), ('c', 3)", DB);
  });

  it("runs DML directly and reports the outcome", async () => {
    const insert = await rw("exec", "INSERT INTO items (name) VALUES ('d')");
    expect(insert.stdout).toContain("verb: INSERT\n  affected_rows: 1\n  insert_id: 4");
    const update = await rw("exec", "UPDATE items SET qty = qty + 1 WHERE id <= 2");
    expect(update.stdout).toContain("affected_rows: 2");
    expect(update.stdout).toContain("affected_rows: 2\n  matched_rows: 2\n  elapsed_ms");
    expect((await rw("exec", "DELETE FROM items WHERE id = 4")).stdout).toContain("affected_rows: 1");
    expect(await sql("SELECT id, qty FROM items ORDER BY id", DB)).toEqual([
      { id: 1, qty: 2 },
      { id: 2, qty: 3 },
      { id: 3, qty: 3 },
    ]);
  });

  it("runs reversible DDL directly", async () => {
    expect((await rw("exec", "ALTER TABLE items ADD COLUMN note TEXT")).exitCode).toBe(0);
    expect((await rw("exec", "CREATE INDEX by_name ON items (name)")).exitCode).toBe(0);
    expect(await sql("SHOW INDEX FROM items WHERE Key_name = 'by_name'", DB)).toHaveLength(1);
  });

  it("returns rows for a statement that has them", async () => {
    expect((await rw("exec", "SELECT name FROM items ORDER BY id LIMIT 2")).stdout).toContain("result[2]{name}:\n  a\n  b");
  });

  it("shows server warnings", async () => {
    const { stdout } = await rw("exec", "INSERT IGNORE INTO items (id, name) VALUES (1, 'dup')");
    expect(stdout).toContain("affected_rows: 0");
    expect(stdout).toContain("warnings[1]{level,code,message}:\n  Warning,1062,");
  });

  it("maps server errors and applies nothing", async () => {
    const dup = await rw("exec", "INSERT INTO items (id, name) VALUES (1, 'dup')");
    expect(dup.exitCode).toBe(1);
    expect(dup.stdout).toContain("code: SQL_ERROR");
    expect((await rw("exec", "INSERT INTO nowhere VALUES (1)")).stdout).toContain("code: NOT_FOUND");
    expect(await scalar("SELECT COUNT(*) FROM items", DB)).toBe(3);
  });

  it("never echoes a password and asks no confirmation for DROP DEFAULT", async () => {
    const user = await rw("exec", "CREATE USER axi_it_app IDENTIFIED BY 's3cret-pw'");
    expect(user.stdout).toContain("IDENTIFIED BY '<redacted>'");
    expect(user.stdout).not.toContain("s3cret-pw");
    const bad = await rw("exec", "ALTER USER axi_it_app IDENTIFIED BY 's3cret-pw' WITH NONSENSE");
    expect(bad.stdout).toContain("code: SQL_ERROR");
    expect(bad.stdout).not.toContain("s3cret-pw");
    await sql("DROP USER axi_it_app");
    expect((await rw("exec", "ALTER TABLE items ALTER COLUMN qty DROP DEFAULT")).stdout).toContain("verb: ALTER");
    expect((await rw("exec", "DELETE i1 FROM items i1 JOIN items i2 ON i1.name = i2.name AND i1.id > i2.id")).stdout).toContain(
      "risk: irreversible - multi-table DELETE without WHERE affects every joined row",
    );
  });

  it("refuses more than one statement", async () => {
    const { stdout, exitCode } = await rw("exec", "DELETE FROM items WHERE id = 1; DROP TABLE items");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("exec runs one statement per call (got 2)");
    expect(await scalar("SELECT COUNT(*) FROM items", DB)).toBe(3);
  });

  it.each([
    ["DROP TABLE items", "DROP", async () => !(await tableExists("items"))],
    ["TRUNCATE TABLE items", "TRUNCATE", async () => (await scalar("SELECT COUNT(*) FROM items", DB)) === 0],
    ["DELETE FROM items", "DELETE without WHERE", async () => (await scalar("SELECT COUNT(*) FROM items", DB)) === 0],
    ["UPDATE items SET qty = 0", "UPDATE without WHERE", async () => (await scalar("SELECT SUM(qty) FROM items", DB)) === "0"],
    ["ALTER TABLE items DROP COLUMN qty", "ALTER ... DROP", async () => (await sql("SHOW COLUMNS FROM items LIKE 'qty'", DB)).length === 0],
    ["ALTER TABLE items DROP INDEX by_qty", "ALTER ... DROP", async () => (await sql("SHOW INDEX FROM items WHERE Key_name = 'by_qty'", DB)).length === 0],
  ])("%s previews until --confirm", async (statement, risk, applied) => {
    const preview = await rw("exec", statement);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain(`risk: irreversible - ${risk}`);
    expect(preview.stdout).toContain(`target: "root@127.0.0.1:${serverPort()}/${DB}"`);
    expect(await applied()).toBe(false);
    const confirmed = await rw("exec", statement, "--confirm");
    expect(confirmed.exitCode, confirmed.stdout).toBe(0);
    expect(await applied()).toBe(true);
  });

  it("creates routines and triggers whose bodies contain semicolons", async () => {
    await rw("exec", "CREATE TABLE audit (item_id INT, at_qty INT)");
    const trigger = await rw("exec", "CREATE TRIGGER items_audit AFTER INSERT ON items FOR EACH ROW BEGIN INSERT INTO audit VALUES (NEW.id, NEW.qty); END");
    expect(trigger.exitCode, trigger.stdout).toBe(0);
    const procedure = await rw("exec", "CREATE PROCEDURE restock(IN amount INT) BEGIN UPDATE items SET qty = qty + amount WHERE qty < 3; SELECT ROW_COUNT() AS changed; END");
    expect(procedure.exitCode, procedure.stdout).toBe(0);
    await rw("exec", "INSERT INTO items (name, qty) VALUES ('e', 9)");
    expect(await sql("SELECT * FROM audit", DB)).toEqual([{ item_id: 4, at_qty: 9 }]);
    // The trailing OK packet of a CALL is not a row.
    const called = await rw("exec", "CALL restock(10)");
    expect(called.stdout).toBe("result[1]{changed}:\n  2\n");
    await sql("DROP PROCEDURE restock", DB);
    await sql("DROP TABLE audit", DB);
  });

  it("reads SQL from --file", async () => {
    const file = join(dir, "one.sql");
    writeFileSync(file, "UPDATE items SET name = 'z' WHERE id = 3;\n");
    expect((await rw("exec", "--file", file)).stdout).toContain("affected_rows: 1");
  });
});

describe("import", () => {
  const write = (name: string, lines: string[]): string => {
    const file = join(dir, name);
    writeFileSync(file, lines.join("\n"));
    return file;
  };

  it("round-trips a real mysqldump with routines, triggers and views", async () => {
    const source = "axi_it_dump_src";
    await scratchDatabase(source, [
      "CREATE TABLE people (id INT PRIMARY KEY, name VARCHAR(40), note TEXT)",
      "CREATE TABLE log (person_id INT, what VARCHAR(20))",
      "INSERT INTO people VALUES (1, 'Ada', 'semi;colon'), (2, 'O''Brien', 'back\\\\slash'), (3, '日本🙂', NULL)",
      "CREATE TRIGGER people_log AFTER INSERT ON people FOR EACH ROW INSERT INTO log VALUES (NEW.id, 'insert')",
      "CREATE FUNCTION shout(s TEXT) RETURNS TEXT DETERMINISTIC BEGIN DECLARE out_text TEXT; SET out_text = UPPER(s); RETURN out_text; END",
      "CREATE VIEW names AS SELECT name FROM people",
    ]);
    const dump = inContainer(["mysqldump", "-uroot", "--routines", "--triggers", "--skip-dump-date", source]);
    const file = write("real-dump.sql", [dump]);
    await scratchDatabase(DB);

    const preview = await rw("import", file);
    expect(preview.stdout).toContain("irreversible_statements[");
    expect(preview.stdout).toContain("DROP TABLE IF EXISTS `people`");
    expect(await tableExists("people")).toBe(false);

    const { stdout, exitCode } = await rw("import", file, "--confirm");
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain(`writes_to: ${DB}`);
    const checksum = async (database: string) => sql("CHECKSUM TABLE people, log", database).then((rows) => rows.map((r) => r["Checksum"]));
    expect(await checksum(DB)).toEqual(await checksum(source));
    expect(await scalar("SELECT COUNT(*) FROM names", DB)).toBe(3);
    expect(await scalar("SELECT shout('ok')", DB)).toBe("OK");
    await sql("INSERT INTO people VALUES (4, 'Grace', NULL)", DB);
    expect(await scalar("SELECT COUNT(*) FROM log WHERE person_id = 4", DB)).toBe(1);
    await sql(`DROP DATABASE ${source}`);
  });

  it("runs a script without irreversible statements directly, from stdin", async () => {
    const script = ["CREATE TABLE piped (a INT);", "INSERT INTO piped VALUES (1), (2);", "-- trailer"].join("\n");
    const { stdout, exitCode } = spawnCli("rw", ["import", "-"], script);
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain("statements: 2\n  affected_rows: 2");
    expect(await scalar("SELECT COUNT(*) FROM piped", DB)).toBe(2);
  });

  it("stops at the failing statement and reports what was applied", async () => {
    const file = write("broken.sql", ["CREATE TABLE partial (a INT);", "INSERT INTO partial VALUES (1);", "INSERT INTO partial VALUES ('not a number');", "INSERT INTO partial VALUES (3);"]);
    const { stdout, exitCode } = await rw("import", file);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("statement 3 of 4 failed");
    expect(stdout).toContain("2 earlier statements were applied (autocommit)");
    expect(await sql("SELECT a FROM partial", DB)).toEqual([{ a: 1 }]);
  });

  it("reports warnings and definers that do not exist here", async () => {
    const file = write("legacy.sql", [
      "CREATE TABLE legacy (code CHAR(2), at DATETIME);",
      "INSERT IGNORE INTO legacy VALUES ('toolong', '2026-01-01'), ('ok', '2026-01-02');",
      "CREATE DEFINER=`axi_it_ghost`@`%` SQL SECURITY DEFINER VIEW legacy_view AS SELECT code FROM legacy;",
    ]);
    const { stdout, exitCode } = await rw("import", file);
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain("warnings: 2");
    expect(stdout).toContain("first_warnings[2]{at,level,code,message}:\n  2,Warning,1265,");
    expect(stdout).toContain("3,Note,1449,");
    expect(stdout).toContain("definer 'axi_it_ghost'@'%' does not exist on this server");
    expect((await ro("query", "SELECT * FROM legacy_view")).stdout).toContain("MySQL 1449");
  });

  it("streams a dump bigger than one read chunk", async () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => `(${i}, '${"x".repeat(40)};${i}')`);
    const file = write("big.sql", ["CREATE TABLE big (id INT PRIMARY KEY, v VARCHAR(60));", `INSERT INTO big VALUES ${rows.slice(0, 15_000).join(",")};`, `INSERT INTO big VALUES ${rows.slice(15_000).join(",")};`]);
    const { stdout, exitCode } = await rw("import", file);
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain("statements: 3\n  affected_rows: 30000");
    expect(await scalar("SELECT COUNT(*) FROM big WHERE v LIKE '%;29999'", DB)).toBe(1);
  });

  it("refuses an empty script", async () => {
    const { stdout, exitCode } = await rw("import", write("empty.sql", ["-- nothing here", "/* or here */"]));
    expect(exitCode).toBe(2);
    expect(stdout).toContain("the script has no statements");
  });
});

describe("db", () => {
  const name = "axi_it_created";
  beforeEach(async () => {
    await sql(`DROP DATABASE IF EXISTS ${name}`);
  });

  it("creates with a charset, is idempotent, previews the drop and drops", async () => {
    expect((await rw("db", "create", name, "--charset", "utf8mb4", "--collation", "utf8mb4_bin")).stdout).toContain("result: created");
    expect(await scalar(`SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${name}'`)).toBe("utf8mb4_bin");
    expect((await rw("db", "create", name)).stdout).toContain("already exists (no-op)");
    await sql("CREATE TABLE t (a INT)", name);

    const preview = await rw("db", "drop", name);
    expect(preview.stdout).toContain("risk: irreversible - deletes 1 tables");
    expect(await scalar(`SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${name}'`)).toBe(1);
    expect((await rw("db", "drop", name, "--confirm")).stdout).toContain("result: dropped (1 tables;");
    expect((await rw("db", "drop", name, "--confirm")).stdout).toContain("does not exist (no-op)");
  });

  it("works when the default database does not exist yet", async () => {
    process.env["MYSQL_RW_AXI_URL"] = rootUrl(name);
    try {
      expect((await rw("db", "create", name)).stdout).toContain("result: created");
      expect((await rw("exec", "CREATE TABLE first (a INT)")).exitCode).toBe(0);
      expect(await tableExists("first", name)).toBe(true);
    } finally {
      process.env["MYSQL_RW_AXI_URL"] = rootUrl(DB);
    }
  });

  it.each(["mysql", "sys", "information_schema", "performance_schema", "MySQL"])("never drops the system schema %s", async (schema) => {
    const { stdout, exitCode } = await rw("db", "drop", schema, "--confirm");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("refusing to drop the system schema");
  });

  it("rejects names that would need quoting", async () => {
    expect((await rw("db", "create", "bad`name")).exitCode).toBe(2);
    expect((await rw("db", "create", "a b")).exitCode).toBe(2);
  });
});

describe("loopback only", () => {
  it.each(["10.0.0.1", "192.168.1.10", "8.8.8.8", "[2001:db8::1]"])("refuses %s before connecting", async (host) => {
    process.env["MYSQL_RW_AXI_URL"] = `mysql://root:pw@${host}:${serverPort()}/${DB}`;
    try {
      for (const args of [["exec", "SELECT 1"], ["db", "create", "x"], ["query", "SELECT 1"], ["doctor"]]) {
        const started = Date.now();
        const { stdout, exitCode } = await rw(...args);
        expect(exitCode, stdout).toBe(1);
        expect(stdout).toContain("code: FORBIDDEN");
        expect(Date.now() - started).toBeLessThan(2000);
      }
    } finally {
      process.env["MYSQL_RW_AXI_URL"] = rootUrl(DB);
    }
  });

  it("refuses a non-loopback profile at login and stores nothing", async () => {
    const { stdout } = await rw("auth", "login", "--profile", "remote", "--host", "10.0.0.1", "--user", "root", "--no-password");
    expect(stdout).toContain("code: FORBIDDEN");
    expect((await rw("auth", "status")).stdout).toContain("profiles: none");
  });

  it("the read-only tool has no such rule but no write commands either", async () => {
    for (const command of ["exec", "import", "db"]) {
      const { stdout, exitCode } = await ro(command, "x");
      expect(exitCode).toBe(2);
      expect(stdout).toContain(`unknown command '${command}'`);
    }
  });
});
