// Runs only with MYSQL_AXI_IT_URL=mysql://root@127.0.0.1:3306 (an account that
// can create databases). Everything happens in a throwaway axi_it_* database.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSession } from "../packages/core/src/connection.js";
import { parseUrl } from "../packages/core/src/target.js";
import { ro, rw, useTestEnv } from "./helpers.js";

const BASE = process.env["MYSQL_AXI_IT_URL"];
const DB = `axi_it_${Date.now()}`;

describe.skipIf(!BASE)("against a real MySQL server", () => {
  const url = `${BASE?.replace(/\/$/, "")}/${DB}`;
  const target = () => parseUrl(url, "MYSQL_AXI_IT_URL");

  beforeAll(async () => {
    useTestEnv();
    process.env["MYSQL_AXI_URL"] = url;
    process.env["MYSQL_RW_AXI_URL"] = url;
    expect((await rw("db", "create", DB)).exitCode).toBe(0);
    for (const sql of [
      "CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(40))",
      "CREATE TABLE orders (id INT PRIMARY KEY AUTO_INCREMENT, customer_id INT, total DECIMAL(10,2), FOREIGN KEY (customer_id) REFERENCES customers(id))",
      "INSERT INTO customers VALUES (1, 'Ada'), (2, 'Linus')",
      "INSERT INTO orders (customer_id, total) VALUES (1, 9.90), (1, 15.00), (2, 3.50)",
      "CREATE FUNCTION bump() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN INSERT INTO customers VALUES (99, 'x'); RETURN 1; END",
    ]) {
      const { stdout, exitCode } = await rw("exec", sql);
      expect(exitCode, stdout).toBe(0);
    }
  });

  afterAll(async () => {
    if (BASE) await rw("db", "drop", DB, "--confirm");
  });

  describe("server facts the guard design relies on", () => {
    it("DDL escapes START TRANSACTION READ ONLY on its own", async () => {
      const conn = await mysql.createConnection({ uri: url });
      try {
        await conn.query("START TRANSACTION READ ONLY");
        await conn.query("CREATE TABLE leaked (a INT)");
        const [rows] = await conn.query("SHOW TABLES LIKE 'leaked'");
        expect(rows).toHaveLength(1);
        await conn.query("DROP TABLE leaked");
      } finally {
        await conn.end();
      }
    });

    it("the read-only session blocks DDL, DML and writing functions", async () => {
      for (const sql of ["CREATE TABLE blocked (a INT)", "INSERT INTO customers VALUES (3, 'c')", "DROP TABLE orders", "SELECT bump()"]) {
        const session = await openSession(target(), { readOnly: true });
        try {
          await expect(session.execute(sql), sql).rejects.toMatchObject({ errno: 1792 });
        } finally {
          await session.close();
        }
      }
    });

    it("server-level statements pass the read-only session, so the guard must refuse them", async () => {
      const session = await openSession(target(), { readOnly: true });
      try {
        await expect(session.execute("SET GLOBAL max_connect_errors = @@global.max_connect_errors")).resolves.toBe(0);
        await expect(session.execute("SET SESSION transaction_read_only = OFF")).resolves.toBe(0);
      } finally {
        await session.close();
      }
      for (const sql of ["SET GLOBAL max_connect_errors = @@global.max_connect_errors", "FLUSH TABLES", "SET SESSION transaction_read_only = OFF"]) {
        const { stdout, exitCode } = await ro("query", sql);
        expect(exitCode, sql).toBe(2);
        expect(stdout).toContain("code: READ_ONLY");
      }
    });
  });

  describe("mysql-axi", () => {
    it("lists, describes, samples, queries and explains", async () => {
      expect((await ro("tables")).stdout).toContain("total: 2 tables; 0 views");
      const described = await ro("describe", "orders");
      expect(described.stdout).toContain("customer_id,customers(id)");
      expect((await ro("describe", "customers")).stdout).toContain("referenced_by[1]{table,columns}:\n  orders,customer_id");
      expect((await ro("sample", "orders", "--limit", "2")).stdout).toContain("rows: 2 shown - more rows exist");
      const query = await ro("query", "SELECT customer_id, SUM(total) AS spent FROM orders GROUP BY customer_id ORDER BY customer_id;");
      expect(query.stdout).toContain("result[2]{customer_id,spent}:\n  1,24.9\n  2,3.5");
      expect((await ro("explain", "SELECT * FROM orders WHERE id = 1")).stdout).toMatch(/^plan:\n---\n-> /);
    });

    it("cannot write through a stored function", async () => {
      const { stdout, exitCode } = await ro("query", "SELECT bump()");
      expect(exitCode).toBe(2);
      expect(stdout).toContain("READ ONLY transaction");
    });
  });

  describe("mysql-rw-axi", () => {
    it("previews, then runs, irreversible statements", async () => {
      await rw("exec", "CREATE TABLE scratch (a INT)");
      await rw("exec", "INSERT INTO scratch VALUES (1), (2)");
      expect((await rw("exec", "DELETE FROM scratch")).stdout).toContain("preview:");
      expect((await ro("query", "SELECT COUNT(*) AS n FROM scratch")).stdout).toContain("result[1]{n}:\n  2");
      expect((await rw("exec", "DELETE FROM scratch", "--confirm")).stdout).toContain("affected_rows: 2");
    });

    it("imports a dump with DELIMITER blocks", async () => {
      const file = join(process.env["MYSQL_RW_AXI_CONFIG_DIR"]!, "dump.sql");
      writeFileSync(
        file,
        [
          "/*!40101 SET NAMES utf8mb4 */;",
          "DROP TABLE IF EXISTS imported;",
          "CREATE TABLE imported (a VARCHAR(20));",
          "INSERT INTO imported VALUES ('semi;colon'), ('it''s');",
          "DELIMITER ;;",
          "CREATE FUNCTION two() RETURNS INT DETERMINISTIC BEGIN DECLARE x INT; SET x = 2; RETURN x; END;;",
          "DELIMITER ;",
          "-- Dump completed",
        ].join("\n"),
      );
      expect((await rw("import", file)).stdout).toContain("irreversible: 1");
      const { stdout, exitCode } = await rw("import", file, "--confirm");
      expect(exitCode, stdout).toBe(0);
      expect(stdout).toContain("statements: 5");
      expect((await ro("query", "SELECT two() AS t, COUNT(*) AS n FROM imported")).stdout).toContain("2,2");
    });
  });
});
