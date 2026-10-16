// What MySQL itself does and does not block. The guard's deny-list exists because of these.
import mysql from "mysql2/promise";
import { beforeAll, describe, expect, it } from "vitest";
import { openSession } from "../../packages/core/src/connection.js";
import { parseUrl } from "../../packages/core/src/target.js";
import { ro } from "../helpers.js";
import { rootUrl, scalar, scratchDatabase, sql } from "./db.js";

const DB = "axi_it_facts";
const target = () => parseUrl(rootUrl(DB), "test");

async function inReadOnlySession(statement: string): Promise<unknown> {
  const session = await openSession(target(), { readOnly: true });
  try {
    return await session.execute(statement);
  } finally {
    await session.close();
  }
}

beforeAll(async () => {
  await scratchDatabase(DB, [
    "CREATE TABLE t (id INT PRIMARY KEY)",
    "INSERT INTO t VALUES (1), (2)",
    "CREATE FUNCTION bump() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN INSERT INTO t VALUES (99); RETURN 1; END",
  ]);
});

describe("server facts the guard design relies on", () => {
  it("DDL escapes START TRANSACTION READ ONLY on its own", async () => {
    const conn = await mysql.createConnection({ uri: rootUrl(DB) });
    try {
      await conn.query("START TRANSACTION READ ONLY");
      await conn.query("CREATE TABLE leaked (a INT)");
      const [rows] = await conn.query("SHOW TABLES LIKE 'leaked'");
      expect(rows).toHaveLength(1);
    } finally {
      await conn.end();
    }
    await sql("DROP TABLE leaked", DB);
  });

  it.each([
    "CREATE TABLE blocked (a INT)",
    "INSERT INTO t VALUES (3)",
    "UPDATE t SET id = id + 10",
    "DROP TABLE t",
    "SELECT bump()",
    "SELECT * FROM t FOR UPDATE",
    "CREATE USER axi_it_blocked",
  ])("the read-only session refuses %s", async (statement) => {
    await expect(inReadOnlySession(statement)).rejects.toMatchObject({ errno: 1792 });
    expect(await scalar("SELECT COUNT(*) FROM t", DB)).toBe(2);
  });

  it.each([
    "SET GLOBAL max_connect_errors = @@global.max_connect_errors",
    "FLUSH TABLES",
    "SET SESSION transaction_read_only = OFF",
    "SELECT GET_LOCK('axi_it', 0)",
    `SELECT * FROM t INTO OUTFILE '/tmp/axi_it_${Date.now()}.csv'`,
    "SELECT `sleep`(0)",
    "SELECT `get_lock`('axi_it_quoted', 0)",
    "SELECT asynchronous_connection_failover_add_source('axi_it', '127.0.0.1', 3306, '', 50)",
  ])("the read-only session lets %s through, so the guard must refuse it", async (statement) => {
    await expect(inReadOnlySession(statement)).resolves.toBeTypeOf("number");
    const { stdout, exitCode } = await ro("query", statement);
    expect(exitCode, stdout).toBe(2);
    expect(stdout).toContain("read-only guard");
  });

  it("a definer-rights function changes server state from inside a read-only session", async () => {
    await sql("CREATE FUNCTION tweak() RETURNS INT DETERMINISTIC NO SQL BEGIN SET GLOBAL max_connect_errors = 4242; RETURN 1; END", DB);
    const before = await scalar("SELECT @@GLOBAL.max_connect_errors");
    try {
      // Not refusable by the guard: it only sees `SELECT tweak()`. doctor flags EXECUTE instead.
      await expect(inReadOnlySession("SELECT tweak()")).resolves.toBe(0);
      expect(await scalar("SELECT @@GLOBAL.max_connect_errors")).toBe(4242);
    } finally {
      await sql(`SET GLOBAL max_connect_errors = ${Number(before)}`);
    }
  });

  it("with multipleStatements off the server rejects a stacked statement as a syntax error", async () => {
    await expect(inReadOnlySession("SELECT 1; DROP TABLE t")).rejects.toMatchObject({ errno: 1064 });
    expect(await scalar("SELECT COUNT(*) FROM t", DB)).toBe(2);
  });
});
