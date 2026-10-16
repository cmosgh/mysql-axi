import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fake, resetFake, type Reply } from "./fake-mysql.js";
import { ro, rw, useTestEnv } from "./helpers.js";

vi.mock("mysql2", async () => ({ default: (await import("./fake-mysql.js")).default }));

beforeEach(() => {
  useTestEnv();
  resetFake();
});

const answer = (map: Record<string, Reply>) => (sql: string) => Object.entries(map).find(([prefix]) => sql.startsWith(prefix))?.[1];
const sqls = () => fake.calls.map((c) => c.sql);

describe("home", () => {
  it("states the read-only limits and never connects", async () => {
    delete process.env["MYSQL_AXI_URL"];
    const { stdout, exitCode } = await ro();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("mode: READ-ONLY - one SELECT");
    expect(stdout).toContain("not a grant check");
    expect(stdout).toContain("status: not configured");
    expect(fake.connections).toHaveLength(0);
  });

  it("shows the env connection without its password", async () => {
    const { stdout } = await ro();
    expect(stdout).toContain("agent@127.0.0.1:3306/shop (MYSQL_AXI_URL)");
    expect(stdout).not.toContain("s3cret");
    expect(fake.connections).toHaveLength(0);
  });

  it("leads the write tool with the warning", async () => {
    const { stdout } = await rw();
    expect(stdout.split("\n").find((l) => !l.startsWith("bin:") && !l.startsWith("description:"))).toMatch(/^warning: WRITE-CAPABLE/);
    expect(stdout).toContain("SSH tunnel to 127.0.0.1 also counts as loopback");
    expect(stdout).toContain('Writes go through `mysql-rw-axi exec "<sql>"`');
  });
});

describe("query", () => {
  it("runs in a read-only session with a time cap and one statement per connection", async () => {
    fake.responder = answer({ "SELECT id": { columns: ["id", "total"], types: [3, 246], rows: [[1, "9.90"], [2, "15.00"]] } });
    const { stdout, exitCode } = await ro("query", "SELECT id, total FROM orders");
    expect(exitCode).toBe(0);
    expect(sqls()).toEqual(["SET SESSION transaction_read_only = ON, SESSION max_execution_time = ?", "START TRANSACTION READ ONLY", "SELECT id, total FROM orders"]);
    expect(fake.calls[0]!.values).toEqual([30_000]);
    expect(fake.connections[0]!.options).toMatchObject({ multipleStatements: false, user: "agent", password: "s3cret", database: "shop" });
    expect(stdout).toContain("result[2]{id,total}:\n  1,9.9\n  2,15");
    expect(fake.connections[0]!.ended).toBe(true);
  });

  it("refuses writes before connecting", async () => {
    const { stdout, exitCode } = await ro("query", "DELETE FROM orders");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("code: READ_ONLY");
    expect(fake.connections).toHaveLength(0);
  });

  it("counts the rows past the cap and names the --limit that shows them all", async () => {
    fake.responder = answer({ SELECT: { columns: ["id"], rows: [[1], [2], [3], [4]] } });
    const { stdout } = await ro("query", "SELECT id FROM orders", "--limit", "2");
    expect(stdout).toContain("rows: 2 of 4 shown");
    expect(stdout).toContain("Rerun with --limit 4 to see all rows");
    expect(stdout).toContain("result[2]{id}:\n  1\n  2\n");
  });

  it("stops counting past the maximum and suggests aggregating", async () => {
    fake.responder = answer({ SELECT: { columns: ["id"], rows: Array.from({ length: 1200 }, (_, i) => [i]) } });
    const { stdout } = await ro("query", "SELECT id FROM orders");
    expect(stdout).toContain("rows: 50 of more than 1000 shown");
    expect(stdout).toContain("aggregate (COUNT; GROUP BY; GROUP_CONCAT)");
    expect(fake.connections[0]!.destroyed).toBe(true);
  });

  it("stops reading at --limit 1000 without a total", async () => {
    fake.responder = answer({ SELECT: { columns: ["id"], rows: Array.from({ length: 1001 }, (_, i) => [i]) } });
    const { stdout } = await ro("query", "SELECT id FROM orders", "--limit", "1000");
    expect(stdout).toContain("rows: 1000 shown - more rows exist (limit 1000)");
    expect(stdout).toContain("raise --limit");
    expect(fake.connections[0]!.destroyed).toBe(true);
  });

  it("honours --timeout and -d", async () => {
    fake.responder = answer({ SELECT: { columns: ["n"], rows: [[1]] } });
    await ro("query", "SELECT 1 AS n", "--timeout", "5", "-d", "other");
    expect(fake.calls[0]!.values).toEqual([5000]);
    expect(fake.connections[0]!.options["database"]).toBe("other");
  });

  it("maps a server timeout to TIMEOUT", async () => {
    fake.responder = answer({ SELECT: { error: { errno: 3024, sqlMessage: "Query execution was interrupted" } } });
    const { stdout, exitCode } = await ro("query", "SELECT 1");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: TIMEOUT");
  });

  it("hints at renamed flags", async () => {
    const { stdout, exitCode } = await ro("query", "SELECT 1", "--max", "5");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("--max is not supported here; use --limit instead");
  });
});

describe("bare SQL", () => {
  it("runs as query", async () => {
    fake.responder = answer({ "SHOW TABLES": { columns: ["Tables_in_shop"], rows: [["orders"]] } });
    const { stdout, exitCode } = await ro("SHOW TABLES;", "--limit", "5");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("orders");
    expect(sqls()).toContain("SHOW TABLES;");
  });

  it("still meets the read-only guard", async () => {
    const { stdout, exitCode } = await ro("DELETE FROM orders WHERE id = 1");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("code: READ_ONLY");
    expect(fake.connections).toHaveLength(0);
  });

  it("points writes in the write tool to exec", async () => {
    const { stdout, exitCode } = await rw("UPDATE orders SET status = 'paid' WHERE id = 1");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("mysql-rw-axi exec");
    expect(fake.connections).toHaveLength(0);
  });

  it("leaves commands and non-SQL words alone", async () => {
    expect((await ro("hello world")).stdout).toContain("unknown command 'hello world'");
    expect((await ro("SELECT")).stdout).toContain("unknown command 'SELECT'");
  });
});

describe("flag placement", () => {
  it("accepts connection flags before the command or the bare SQL", async () => {
    fake.responder = answer({ "SHOW TABLES": { columns: ["Tables_in_shop"], rows: [["orders"]] } });
    expect((await ro("--limit", "5", "query", "SHOW TABLES")).stdout).toContain("orders");
    expect((await ro("-d", "shop", "SHOW TABLES")).stdout).toContain("orders");
  });

  it("takes -p for --profile", async () => {
    delete process.env["MYSQL_AXI_URL"];
    const { stdout, exitCode } = await ro("query", "SELECT 1", "-p", "nope");
    expect(exitCode).not.toBe(0);
    expect(stdout).not.toContain("unknown flag");
    expect(stdout).toContain("nope");
  });
});

describe("schema commands", () => {
  it("requires a database before connecting", async () => {
    process.env["MYSQL_AXI_URL"] = "mysql://agent@127.0.0.1:3306";
    const { stdout, exitCode } = await ro("tables");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("no database selected");
    expect(fake.connections).toHaveLength(0);
  });

  it("lists tables by size with honest totals", async () => {
    fake.responder = answer({
      "SET ": { ok: {} },
      "SELECT TABLE_NAME AS name, TABLE_TYPE": {
        columns: ["name", "type", "rows_est", "data", "idx"],
        rows: [["orders", "BASE TABLE", 1200, 2_000_000, 500_000], ["customers", "BASE TABLE", 50, 16384, 0], ["order_view", "VIEW", null, null, null]],
      },
    });
    const { stdout } = await ro("tables", "--sort", "size", "--limit", "1");
    expect(stdout).toContain("total: 2 tables; 1 views; 2.4 MB");
    expect(stdout).toContain("tables[1]{name,kind,rows_est,size}:\n  orders,table,1200,2.4 MB");
    expect(stdout).toContain("Showing 1 of 3");
    expect(sqls()[0]).toContain("information_schema_stats_expiry = 0");
  });

  it("describes columns, indexes and both directions of foreign keys", async () => {
    fake.responder = answer({
      "SELECT TABLE_TYPE": { columns: ["type", "engine", "rows_est", "bytes", "comment"], rows: [["BASE TABLE", "InnoDB", 10, 16384, ""]] },
      "SELECT COLUMN_NAME": {
        columns: ["name", "type", "nullable", "k", "def", "extra", "comment"],
        rows: [["id", "int", "NO", "PRI", null, "auto_increment", ""], ["customer_id", "int", "NO", "MUL", null, "", ""]],
      },
      "SELECT INDEX_NAME": { columns: ["name", "cols", "non_unique"], rows: [["PRIMARY", "id", 0], ["fk_customer", "customer_id", 1]] },
      "SELECT k.CONSTRAINT_NAME": {
        columns: ["name", "cols", "ref_db", "ref_table", "ref_cols", "on_delete", "on_update"],
        rows: [["fk_customer", "customer_id", "shop", "customers", "id", "CASCADE", "NO ACTION"]],
      },
      "SELECT c.CONSTRAINT_NAME": { columns: ["name", "clause"], rows: [["chk_total", "(`total` >= 0)"]] },
      "SELECT TRIGGER_NAME": { columns: ["name", "timing", "event"], rows: [] },
      "SELECT TABLE_SCHEMA": { columns: ["db", "tbl", "cols"], rows: [["shop", "order_items", "order_id"]] },
    });
    const { stdout } = await ro("describe", "orders");
    expect(stdout).toContain("columns[2]{name,type,nullable,key,default,extra}:\n  id,int,false,PRI,null,auto_increment");
    expect(stdout).toContain("indexes[2]{name,columns,unique}:\n  PRIMARY,id,true");
    expect(stdout).toContain("foreign_keys[1]{name,columns,references,on_delete,on_update}:\n  fk_customer,customer_id,customers(id),CASCADE,NO ACTION");
    expect(stdout).toContain("checks[1]{name,clause}:");
    expect(stdout).not.toContain("triggers");
    expect(stdout).toContain("referenced_by[1]{table,columns}:\n  order_items,order_id");
  });

  it("suggests close table names on a miss", async () => {
    fake.responder = answer({
      "SELECT TABLE_TYPE": { columns: ["type"], rows: [] },
      "SELECT TABLE_NAME AS name FROM": { columns: ["name"], rows: [["orders"], ["order_items"], ["customers"]] },
    });
    const { stdout, exitCode } = await ro("describe", "order");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: NOT_FOUND");
    expect(stdout).toContain("did you mean: orders, order_items");
  });

  it("explains without running and refuses non-SELECT", async () => {
    fake.responder = answer({ "EXPLAIN FORMAT=TREE": { columns: ["EXPLAIN"], rows: [["-> Index lookup on orders"]] } });
    const { stdout } = await ro("explain", "SELECT * FROM orders WHERE id = 1");
    expect(stdout).toBe("plan:\n---\n-> Index lookup on orders\n---\n");
    const shown = await ro("explain", "SHOW TABLES");
    expect(shown.exitCode).toBe(2);
  });
});

describe("doctor", () => {
  it("warns when read-only credentials can write", async () => {
    fake.responder = answer({
      "SELECT VERSION()": { columns: ["version", "user", "db", "ro", "server_ro"], rows: [["8.0.46", "agent@%", "shop", 1, 0]] },
      "SHOW GRANTS": { columns: ["Grants for agent@%"], rows: [["GRANT SELECT, INSERT, UPDATE ON `shop`.* TO `agent`@`%`"]] },
    });
    const { stdout } = await ro("doctor");
    expect(stdout).toMatch(/^warning: these credentials can write/);
    expect(stdout).toContain("read_only_session: verified");
    expect(stdout).toContain("grants: write-capable - INSERT; UPDATE");
    expect(stdout).toContain("GRANT SELECT, SHOW VIEW ON <database>.*");
  });

  it("stays quiet for a SELECT-only account", async () => {
    fake.responder = answer({
      "SELECT VERSION()": { columns: ["version", "user", "db", "ro", "server_ro"], rows: [["8.0.46", "agent@%", "shop", 1, 0]] },
      "SHOW GRANTS": { columns: ["g"], rows: [["GRANT USAGE ON *.* TO `agent`@`%`"], ["GRANT SELECT ON `shop`.* TO `agent`@`%`"]] },
    });
    const { stdout } = await ro("doctor");
    expect(stdout).not.toContain("warning");
    expect(stdout).toContain("grants: read-only - USAGE; SELECT");
  });
});

describe("setup --local", () => {
  const withProject = async (execPath: string, run: (dir: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "mysql-axi-setup-"));
    const argv1 = process.argv[1];
    process.argv[1] = execPath;
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      await run(dir);
    } finally {
      cwd.mockRestore();
      process.argv[1] = argv1!;
    }
  };

  it("installs into Claude Code's settings.local.json only, idempotently, and removes it", async () => {
    await withProject("/opt/npm/bin/mysql-axi", async (dir) => {
      const file = join(dir, ".claude/settings.local.json");
      expect((await ro("setup", "hooks", "--local")).stdout).toContain("status: installed\n  integrations: Claude Code");
      expect(JSON.parse(readFileSync(file, "utf-8")).hooks.SessionStart[0].hooks[0]).toEqual({ type: "command", command: "/opt/npm/bin/mysql-axi", timeout: 10 });
      expect((await ro("setup", "hooks", "--local")).stdout).toContain("already up to date (no-op)");
      expect((await ro("setup", "status", "--local")).stdout).toContain("claude_code: installed");
      expect((await ro("setup", "uninstall", "--local")).stdout).toContain("status: removed");
      expect((await ro("setup", "status", "--local")).stdout).toContain("claude_code: not installed");
    });
  });

  it("refuses a source checkout and --project with --local", async () => {
    await withProject("/src/packages/mysql-axi/bin/mysql-axi.ts", async () => {
      const dev = await ro("setup", "hooks", "--local");
      expect(dev.exitCode).toBe(2);
      expect(dev.stdout).toContain("not from a source checkout");
      expect((await ro("setup", "hooks", "--local", "--project")).stdout).toContain("pass --project or --local, not both");
    });
  });
});

describe("auth", () => {
  it("validates before saving a profile and keeps the password out of the config", async () => {
    delete process.env["MYSQL_AXI_URL"];
    fake.responder = answer({
      "SELECT VERSION()": { columns: ["version", "user"], rows: [["8.0.46", "root@%"]] },
      "SELECT 1 FROM information_schema.SCHEMATA": { columns: ["1"], rows: [[1]] },
    });
    const login = await ro("auth", "login", "--profile", "local", "--user", "root", "--no-password", "-d", "shop");
    expect(login.exitCode).toBe(0);
    expect(fake.connections[0]!.options["database"]).toBeUndefined();
    const home = await ro();
    expect(home.stdout).toContain("profiles[1]{name,target,active}:\n  local,\"root@127.0.0.1:3306/shop\",true");
  });

  it("does not save a profile the server rejects", async () => {
    delete process.env["MYSQL_AXI_URL"];
    fake.connectError = { errno: 1045, sqlMessage: "Access denied for user 'root'" };
    const { stdout, exitCode } = await ro("auth", "login", "--profile", "local", "--user", "root", "--no-password");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: AUTH_REQUIRED");
    expect((await ro()).stdout).toContain("status: not configured");
  });
});

describe("mysql-rw-axi", () => {
  it("refuses non-loopback hosts before connecting", async () => {
    process.env["MYSQL_RW_AXI_URL"] = "mysql://root@203.0.113.7:3306/shop";
    const { stdout, exitCode } = await rw("query", "SELECT 1");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: FORBIDDEN");
    expect(fake.connections).toHaveLength(0);
  });

  it("keeps query read-only and points writes at exec", async () => {
    const { stdout, exitCode } = await rw("query", "UPDATE orders SET status = 'x' WHERE id = 1");
    expect(exitCode).toBe(2);
    expect(stdout).toContain('Writes go through `mysql-rw-axi exec "<sql>"`');
  });

  it("runs exec without the read-only session", async () => {
    fake.responder = answer({ UPDATE: { ok: { affectedRows: 2, info: "Rows matched: 2  Changed: 2  Warnings: 0" } } });
    const { stdout, exitCode } = await rw("exec", "UPDATE orders SET status = 'paid' WHERE id IN (1, 2)");
    expect(exitCode).toBe(0);
    expect(sqls()).toEqual(["UPDATE orders SET status = 'paid' WHERE id IN (1, 2)"]);
    expect(stdout).toContain("affected_rows: 2");
  });

  it("previews irreversible statements until --confirm", async () => {
    const preview = await rw("exec", "DELETE FROM orders");
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain("risk: irreversible - DELETE without WHERE affects every row");
    expect(fake.connections).toHaveLength(0);
    fake.responder = answer({ DELETE: { ok: { affectedRows: 7 } } });
    const run = await rw("exec", "DELETE FROM orders", "--confirm");
    expect(run.stdout).toContain("affected_rows: 7");
  });

  it("shows server warnings after exec", async () => {
    fake.responder = answer({ INSERT: { ok: { affectedRows: 1, warningStatus: 1 } }, "SHOW WARNINGS": { columns: ["Level", "Code", "Message"], rows: [["Warning", 1265, "Data truncated"]] } });
    const { stdout } = await rw("exec", "INSERT INTO t VALUES ('long')");
    expect(stdout).toContain("warnings[1]{level,code,message}:\n  Warning,1265,Data truncated");
  });

  it("creates databases idempotently without the default database", async () => {
    let exists = false;
    fake.responder = (sql) => {
      if (sql.startsWith("SELECT 1 FROM information_schema.SCHEMATA")) return { columns: ["1"], rows: exists ? [[1]] : [] };
      if (sql.startsWith("CREATE DATABASE")) {
        exists = true;
        return { ok: {} };
      }
      return undefined;
    };
    expect((await rw("db", "create", "shop_test")).stdout).toContain("result: created");
    expect(sqls()).toContain("CREATE DATABASE `shop_test`");
    expect(fake.connections[0]!.options["database"]).toBeUndefined();
    expect((await rw("db", "create", "shop_test")).stdout).toContain("already exists (no-op)");
  });

  it("previews db drop with what it would delete", async () => {
    fake.responder = answer({ "SELECT COUNT": { columns: ["tables", "bytes"], rows: [[3, 49152]] } });
    const { stdout } = await rw("db", "drop", "shop_test");
    expect(stdout).toContain("risk: irreversible - deletes 3 tables (48 KB)");
    expect(sqls().some((s) => s.startsWith("DROP"))).toBe(false);
    expect((await rw("db", "drop", "mysql")).exitCode).toBe(2);
  });

  it("imports a script statement by statement after --confirm", async () => {
    const file = join(process.env["MYSQL_RW_AXI_CONFIG_DIR"]!, "dump.sql");
    writeFileSync(file, "-- Table structure\nDROP TABLE IF EXISTS t;\nCREATE TABLE t (a INT);\nINSERT INTO t VALUES (1),(2);\n-- Dump completed\n");
    const preview = await rw("import", file);
    expect(preview.stdout).toContain("irreversible_statements[1]{at,statement}:\n  1,DROP TABLE IF EXISTS t");
    expect(fake.connections).toHaveLength(0);
    fake.responder = answer({ "-- Table": { ok: {} }, CREATE: { ok: {} }, INSERT: { ok: { affectedRows: 2 } } });
    const { stdout } = await rw("import", file, "--confirm");
    expect(stdout).toContain("statements: 3");
    expect(stdout).toContain("affected_rows: 2");
    expect(fake.calls).toHaveLength(3);
  });

  it("reports which import statement failed and what was applied", async () => {
    const file = join(process.env["MYSQL_RW_AXI_CONFIG_DIR"]!, "bad.sql");
    writeFileSync(file, "CREATE TABLE t (a INT);\nINSERT INTO nope VALUES (1);\n");
    fake.responder = answer({ CREATE: { ok: {} }, INSERT: { error: { errno: 1146, sqlMessage: "Table 'shop.nope' doesn't exist" } } });
    const { stdout, exitCode } = await rw("import", file, "--confirm");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("statement 2 of 2 failed");
    expect(stdout).toContain("1 earlier statements were applied");
  });
});
