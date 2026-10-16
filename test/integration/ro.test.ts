import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ro } from "../helpers.js";
import { rootUrl, scalar, scratchDatabase, serverPort, spawnCli, sql } from "./db.js";

const DB = "axi_it_ro";
const RO_USER = "axi_it_reader";
const NOPW_USER = "axi_it_nopw";

/** Everything the deny tests could damage, as one comparable value. */
const snapshot = async () => ({
  tables: await sql("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY 1", undefined, [DB]),
  customers: await sql("SELECT * FROM customers ORDER BY id", DB),
  orders: await sql("SELECT * FROM orders ORDER BY id", DB),
});

beforeAll(async () => {
  await scratchDatabase(DB, [
    "CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL COMMENT 'display name', KEY by_name (name))",
    "CREATE TABLE orders (id INT PRIMARY KEY AUTO_INCREMENT, customer_id INT NOT NULL, total DECIMAL(10,2), FOREIGN KEY (customer_id) REFERENCES customers(id))",
    "CREATE VIEW big_spenders AS SELECT customer_id, SUM(total) AS spent FROM orders GROUP BY customer_id HAVING spent > 10",
    `CREATE TABLE kinds (id INT PRIMARY KEY, n BIGINT, huge BIGINT UNSIGNED, exact DECIMAL(30,10), price DECIMAL(10,2), dt DATETIME, d DATE,
       j JSON, b BLOB, small VARBINARY(4), long_text TEXT, uni VARCHAR(20))`,
    "CREATE TABLE seq (n INT PRIMARY KEY)",
    "INSERT INTO customers VALUES (1, 'Ada'), (2, 'Linus')",
    "INSERT INTO orders (customer_id, total) VALUES (1, 9.90), (1, 15.00), (2, 3.50)",
    `INSERT INTO kinds VALUES (1, -42, 18446744073709551615, 12345678901234567890.1234567890, 9.90, '2026-01-02 03:04:05', '2026-01-02',
       JSON_OBJECT('k', 1), REPEAT('x', 100), 0x01020304, REPEAT('e', 300), '日本🙂'),
       (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
    "INSERT INTO seq WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 1000) SELECT n FROM r",
    "CREATE FUNCTION bump() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN INSERT INTO customers VALUES (99, 'x'); RETURN 1; END",
    "CREATE PROCEDURE wipe() MODIFIES SQL DATA DELETE FROM orders",
    "ANALYZE TABLE seq",
  ]);
  for (const user of [RO_USER, NOPW_USER]) await sql(`DROP USER IF EXISTS ${user}`);
  await sql(`CREATE USER ${RO_USER} IDENTIFIED BY 'reader-pw'`);
  await sql(`GRANT SELECT, SHOW VIEW ON ${DB}.* TO ${RO_USER}`);
  await sql(`CREATE USER ${NOPW_USER}`);
  await sql(`GRANT SELECT ON ${DB}.* TO ${NOPW_USER}`);
});

afterAll(async () => {
  for (const user of [RO_USER, NOPW_USER]) await sql(`DROP USER IF EXISTS ${user}`);
});

describe("listing and schema", () => {
  it("databases hides system schemas unless --all", async () => {
    const plain = await ro("databases");
    expect(plain.stdout).toMatch(new RegExp(`\\n  ${DB},5,`));
    expect(plain.stdout).not.toMatch(/\n  mysql,/);
    expect(plain.stdout).toContain("hidden: 4 system schemas (--all)");
    expect((await ro("databases", "--all")).stdout).toMatch(/\n  mysql,\d+,/);
  });

  it("tables counts views apart and sorts by size or rows", async () => {
    const { stdout } = await ro("tables");
    expect(stdout).toContain(`database: ${DB}\ntotal: 4 tables; 1 views;`);
    expect(stdout).toContain("big_spenders,view,null,null");
    expect((await ro("tables", "--sort", "rows")).stdout).toMatch(/tables\[5\]\{name,kind,rows_est,size\}:\n {2}seq,table,1000,/);
    expect((await ro("tables", "--fields", "engine,comment", "--limit", "1")).stdout).toContain("Showing 1 of 5 - raise --limit");
  });

  it("tables takes -d and reports an unknown database", async () => {
    expect((await ro("tables", "-d", "mysql")).stdout).toContain("database: mysql");
    const missing = await ro("tables", "-d", "axi_it_nowhere");
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("code: NOT_FOUND");
  });

  it("describe shows columns, indexes, foreign keys and back references", async () => {
    const orders = await ro("describe", "orders");
    expect(orders.stdout).toMatch(new RegExp(`^table:\\n  name: ${DB}\\.orders\\n  rows_est: \\d+\\n  size: `));
    expect(orders.stdout).toContain("foreign_keys[1]{name,columns,references,on_delete,on_update}:\n  orders_ibfk_1,customer_id,customers(id),NO ACTION,NO ACTION");
    const customers = await ro("describe", `${DB}.customers`);
    expect(customers.stdout).toContain("columns[2]{name,type,nullable,key,default,extra,comment}:");
    expect(customers.stdout).toContain("name,varchar(40),false,MUL,null,null,display name");
    expect(customers.stdout).toContain("indexes[2]{name,columns,unique}:\n  PRIMARY,id,true\n  by_name,name,false");
    expect(customers.stdout).toContain("referenced_by[1]{table,columns}:\n  orders,customer_id");
    expect((await ro("describe", "big_spenders")).stdout).toContain("kind: view");
  });

  it("describe suggests close names for a missing table", async () => {
    const { stdout, exitCode } = await ro("describe", "order");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("did you mean: orders");
  });
});

describe("reads the guard used to refuse, and raw text", () => {
  beforeAll(async () => {
    await sql("CREATE TABLE timings (id INT PRIMARY KEY, sleep INT, benchmark VARCHAR(10), flag BIT(1))", DB);
    await sql("INSERT INTO timings VALUES (1, 8, 'fast', b'1'), (2, 6, 'slow', b'0')", DB);
    await sql("INSERT INTO customers VALUES (3, 'O''Brien')", DB);
  });
  afterAll(async () => {
    await sql("DELETE FROM customers WHERE id = 3", DB);
  });

  it("allows columns named like functions, plan hints and CHECKSUM TABLE", async () => {
    expect((await ro("query", "SELECT id, sleep, benchmark, flag FROM timings ORDER BY id")).stdout).toContain("result[2]{id,sleep,benchmark,flag}:\n  1,8,fast,1\n  2,6,slow,0");
    expect((await ro("query", "SELECT /*+ INDEX(c by_name) MAX_EXECUTION_TIME(1000) */ name FROM customers c WHERE name = 'Ada'")).stdout).toContain("result[1]{name}:\n  Ada");
    expect((await ro("query", "CHECKSUM TABLE customers, orders")).stdout).toMatch(/result\[2\]\{Table,Checksum\}:\n {2}axi_it_ro\.customers,\d+/);
  });

  it("explains how to write a quote instead of a misleading error", async () => {
    const { stdout, exitCode } = await ro("query", "SELECT id FROM customers WHERE name = 'O\\'Brien'");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("double the quote instead");
    expect((await ro("query", "SELECT id FROM customers WHERE name = 'O''Brien'")).stdout).toContain("result[1]{id}:\n  3");
  });

  it("refuses EXPLAIN of a write with a pointer to the SELECT", async () => {
    const { stdout, exitCode } = await ro("query", "EXPLAIN UPDATE orders SET total = 0 WHERE id = 1");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("EXPLAIN UPDATE needs a write session");
  });

  it("prints DDL, JSON plans and InnoDB status untruncated between fences", async () => {
    const ddl = await ro("query", "SHOW CREATE TABLE orders");
    expect(ddl.stdout).toMatch(/^Table: orders\ncreate_table:\n---\nCREATE TABLE `orders` \(\n/);
    expect(ddl.stdout).toContain("FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`)");
    expect(ddl.stdout).not.toContain("--full");
    const json = await ro("query", "EXPLAIN FORMAT=JSON SELECT * FROM orders WHERE id = 1");
    expect(json.stdout).toMatch(/^explain:\n---\n\{\n {2}"query_block"/);
    expect((await ro("query", "SHOW ENGINE INNODB STATUS")).stdout).toMatch(/status:\n---\n[\s\S]*TRANSACTIONS/);
  });

  it("explain --analyze runs the query read-only and stays under --timeout", async () => {
    expect((await ro("explain", "--analyze", "SELECT COUNT(*) FROM orders o JOIN customers c ON c.id = o.customer_id")).stdout).toMatch(/\(actual time=/);
    const slow = await ro("explain", "--analyze", "--timeout", "1", "SELECT SUM(a.n + b.n + c.n) FROM seq a, seq b, seq c");
    expect(slow.stdout).toContain("Stopped at the 1s --timeout - actual rows and times are partial");
    expect((await ro("explain", "--format", "traditional", "SELECT * FROM orders WHERE id = 1")).stdout).toMatch(/,PRIMARY,4,const,1,100,/);
  });

  it("never prints credential hashes", async () => {
    const users = await ro("query", "SELECT User, authentication_string FROM mysql.user WHERE User = 'axi_it_reader'");
    expect(users.stdout).toContain("result[1]{User,authentication_string}:\n  axi_it_reader,<redacted>");
    const create = await ro("query", "SHOW CREATE USER axi_it_reader");
    expect(create.stdout).toContain("AS '<redacted>'");
    expect(create.stdout).not.toMatch(/\$A\$005\$/);
  });

  it("describe shows generated columns, collation drift, FK rules, checks and triggers", async () => {
    await sql(
      `CREATE TABLE ledger (id INT PRIMARY KEY, customer_id INT, amount DECIMAL(10,2), doubled DECIMAL(10,2) AS (amount * 2) VIRTUAL,
         code VARCHAR(10) COLLATE utf8mb4_bin, CONSTRAINT chk_amount CHECK (amount >= 0),
         CONSTRAINT fk_ledger_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE SET NULL ON UPDATE CASCADE)`,
      DB,
    );
    await sql("CREATE TRIGGER ledger_guard BEFORE INSERT ON ledger FOR EACH ROW SET NEW.code = UPPER(NEW.code)", DB);
    const { stdout } = await ro("describe", "ledger");
    expect(stdout).toContain("columns[5]{name,type,nullable,key,default,extra,generated,collation}:");
    expect(stdout).toContain("doubled,\"decimal(10,2)\",true,null,null,VIRTUAL GENERATED,(`amount` * 2),null");
    expect(stdout).toContain("code,varchar(10),true,null,null,null,null,utf8mb4_bin");
    expect(stdout).toContain("fk_ledger_customer,customer_id,customers(id),SET NULL,CASCADE");
    expect(stdout).toContain("checks[1]{name,clause}:\n  chk_amount,");
    expect(stdout).toContain("triggers[1]{name,timing,event}:\n  ledger_guard,BEFORE,INSERT");
    await sql("DROP TABLE ledger", DB);
  });
});

describe("rows and values", () => {
  it("sample keeps numbers exact and shrinks blobs and long text", async () => {
    const { stdout } = await ro("sample", "kinds");
    expect(stdout).toContain("result[2]{id,n,huge,exact,price,dt,d,j,b,small,long_text,uni}:");
    expect(stdout).toContain(
      `1,-42,"18446744073709551615","12345678901234567890.1234567890",9.9,"2026-01-02 03:04:05",2026-01-02,"{\\"k\\":1}",<blob 100 bytes>,0x01020304,${"e".repeat(200)}... (+100 chars; --full),日本🙂`,
    );
    expect(stdout).toContain("2,null,null,null,null,null,null,null,null,null,null,null");
    expect((await ro("sample", "kinds", "--full")).stdout).toContain(`,${"e".repeat(300)},`);
  });

  it("query caps rows, stops reading and says so", async () => {
    const started = Date.now();
    const { stdout } = await ro("query", "SELECT a.n FROM seq a, seq b", "--limit", "1000");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(stdout).toContain("rows: 1000 shown - more rows exist (limit 1000)");
    expect(stdout).toContain("Add WHERE or LIMIT to the query");
    expect((await ro("query", "SELECT n FROM seq")).stdout).toContain("rows: 50 shown - more rows exist (limit 50)");
    const over = await ro("query", "SELECT 1", "--limit", "1001");
    expect(over.exitCode).toBe(2);
  });

  it("query handles CTEs, TABLE, SHOW, duplicate names and empty results", async () => {
    const cte = await ro("query", "WITH s AS (SELECT customer_id, SUM(total) AS spent FROM orders GROUP BY customer_id) SELECT * FROM s ORDER BY customer_id;");
    expect(cte.stdout).toContain("result[2]{customer_id,spent}:\n  1,24.9\n  2,3.5");
    expect((await ro("query", "TABLE customers ORDER BY id")).stdout).toContain("result[2]{id,name}:\n  1,Ada\n  2,Linus");
    expect((await ro("query", "SHOW CREATE TABLE customers")).stdout).toContain("CREATE TABLE");
    expect((await ro("query", "SELECT 1 AS a, 2 AS a")).stdout).toContain("result[1]{a,a_2}:\n  1,2");
    expect((await ro("query", "SELECT * FROM customers WHERE id < 0")).stdout).toContain("rows: 0\ncolumns: id; name");
    expect((await ro("query", "SELECT * FROM customers WHERE id < 0")).stdout).toContain("columns: id; name");
  });

  it("query reads SQL from --file and from stdin", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "mysql-axi-it-")), "q.sql");
    writeFileSync(file, "-- report\nSELECT name FROM customers ORDER BY id\n");
    expect((await ro("query", "--file", file)).stdout).toContain("result[2]{name}:\n  Ada\n  Linus");
    const piped = spawnCli("ro", ["query", "-"], "SELECT COUNT(*) AS n FROM orders");
    expect(piped.exitCode).toBe(0);
    expect(piped.stdout).toContain("result[1]{n}:\n  3");
  });

  it("query maps server errors", async () => {
    const syntax = await ro("query", "SELECT FROM WHERE");
    expect(syntax.exitCode).toBe(1);
    expect(syntax.stdout).toContain("code: SQL_ERROR");
    expect((await ro("query", "SELECT * FROM nowhere")).stdout).toContain("code: NOT_FOUND");
  });

  it("--timeout stops a slow query on the server", async () => {
    const started = Date.now();
    const { stdout, exitCode } = await ro("query", "SELECT SUM(a.n + b.n + c.n) FROM seq a, seq b, seq c", "--timeout", "1");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: TIMEOUT");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("explain prints a tree or a traditional plan and refuses ANALYZE", async () => {
    expect((await ro("explain", "SELECT * FROM orders WHERE customer_id = 1")).stdout).toMatch(/^plan:\n---\n-> /);
    expect((await ro("explain", "--format", "traditional", "SELECT * FROM orders WHERE id = 1")).stdout).toMatch(/result\[1\]\{id,select_type,table,/);
    expect((await ro("explain", "SHOW TABLES")).exitCode).toBe(2);
    expect((await ro("query", "EXPLAIN ANALYZE SELECT * FROM orders")).stdout).toContain("code: READ_ONLY");
  });
});

describe("nothing gets written", () => {
  let before: Awaited<ReturnType<typeof snapshot>>;
  beforeAll(async () => {
    before = await snapshot();
  });

  it.each([
    ["INSERT INTO customers VALUES (3, 'c')"],
    ["UPDATE customers SET name = 'x'"],
    ["DELETE FROM orders"],
    ["REPLACE INTO customers VALUES (1, 'x')"],
    ["DROP TABLE orders"],
    ["TRUNCATE orders"],
    ["CREATE TABLE extra (a INT)"],
    ["ALTER TABLE orders ADD COLUMN x INT"],
    ["RENAME TABLE orders TO gone"],
    ["CALL wipe()"],
    ["DO bump()"],
    ["SET GLOBAL max_connections = 1"],
    ["SET SESSION transaction_read_only = OFF"],
    ["LOCK TABLES orders WRITE"],
    ["FLUSH TABLES"],
    ["GRANT ALL ON *.* TO axi_it_reader"],
    ["SELECT 1; DELETE FROM orders"],
    ["SELECT 1 /*!, (SELECT 1) */; DELETE FROM orders"],
    ["SELECT 1 /*! ; DELETE FROM orders */"],
    ["SELECT /*+ SET_VAR(transaction_read_only=0) */ 1"],
    ["WITH x AS (SELECT 1) DELETE FROM orders"],
    ["SELECT * FROM orders FOR UPDATE"],
    ["SELECT * FROM orders FOR SHARE"],
    ["SELECT * FROM orders LOCK IN SHARE MODE"],
    ["SELECT * FROM orders INTO OUTFILE '/tmp/axi_it_orders.csv'"],
    ["SELECT 1 INTO @x"],
    ["SELECT SLEEP(5)"],
    ["SELECT BENCHMARK(1000000000, MD5('x'))"],
    ["SELECT GET_LOCK('axi_it', 0)"],
    ["SELECT LOAD_FILE('/etc/passwd')"],
    ["SELECT `sleep`(5)"],
    ["SELECT asynchronous_connection_failover_add_source('ch', '127.0.0.1', 3306, '', 50)"],
    ["SELECT innodb_redo_log_archive_start('label', 'dir')"],
    ["SELECT 'a\\' ; DELETE FROM orders; -- '"],
    ["HANDLER orders OPEN"],
  ])("refuses %s before connecting", async (statement) => {
    const { stdout, exitCode } = await ro("query", statement);
    expect(exitCode, stdout).toBe(2);
    expect(stdout).toContain("code: READ_ONLY");
    expect(stdout).toContain("read-only guard");
  });

  it("a writing stored function is stopped by the read-only session", async () => {
    const { stdout, exitCode } = await ro("query", "SELECT bump()");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("READ ONLY transaction");
  });

  it("the data is untouched", async () => {
    expect(await snapshot()).toEqual(before);
  });
});

describe("under a server running NO_BACKSLASH_ESCAPES", () => {
  let mode: unknown;
  beforeAll(async () => {
    mode = await scalar("SELECT @@GLOBAL.sql_mode");
    await sql("SET GLOBAL sql_mode = CONCAT(@@GLOBAL.sql_mode, ',NO_BACKSLASH_ESCAPES')");
  });
  afterAll(async () => {
    await sql("SET GLOBAL sql_mode = ?", undefined, [mode]);
  });

  it("the backslash trick is still refused and plain backslashes still read", async () => {
    expect((await ro("query", "SELECT 'a\\' ; DELETE FROM orders; -- '")).stdout).toContain("code: READ_ONLY");
    expect((await ro("query", "SELECT 'C:\\dir' AS p")).stdout).toContain("result[1]{p}:\n  \"C:\\\\dir\"");
    expect(await scalar("SELECT COUNT(*) FROM orders", DB)).toBe(3);
  });
});

describe("accounts and connections", () => {
  it("doctor verifies the read-only session and warns about write grants", async () => {
    const { stdout } = await ro("doctor");
    expect(stdout).toContain("read_only_session: verified");
    expect(stdout).toMatch(/^warning: these credentials can write/);
  });

  it("a SELECT-only account sees only its grants and gets no warning", async () => {
    const url = rootUrl(DB).replace(/\/\/root:[^@]+@/, `//${RO_USER}:reader-pw@`);
    process.env["MYSQL_AXI_URL"] = url;
    try {
      const doctor = await ro("doctor");
      expect(doctor.stdout).not.toContain("warning");
      expect(doctor.stdout).toContain("grants: read-only - ");
      const dbs = await ro("databases");
      expect(dbs.stdout).toContain("databases[1]{name,tables,size}:");
      expect((await ro("query", "SELECT COUNT(*) AS n FROM customers")).stdout).toContain("result[1]{n}:\n  2");
    } finally {
      process.env["MYSQL_AXI_URL"] = rootUrl(DB);
    }
  });

  it("doctor warns that EXECUTE can run definer-rights routines", async () => {
    await sql("DROP USER IF EXISTS axi_it_exec");
    await sql("CREATE USER axi_it_exec IDENTIFIED BY 'exec-pw'");
    await sql(`GRANT SELECT, EXECUTE ON ${DB}.* TO axi_it_exec`);
    process.env["MYSQL_AXI_URL"] = rootUrl(DB).replace(/\/\/root:[^@]+@/, "//axi_it_exec:exec-pw@");
    try {
      const { stdout } = await ro("doctor");
      expect(stdout).toMatch(/^warning: these credentials can write/);
      expect(stdout).toContain("grants: write-capable - EXECUTE");
      expect(stdout).toContain("EXECUTE runs stored routines with their definer's rights");
    } finally {
      process.env["MYSQL_AXI_URL"] = rootUrl(DB);
      await sql("DROP USER axi_it_exec");
    }
  });

  it("logs in to a profile, uses it without the env URL and logs out", async () => {
    const url = process.env["MYSQL_AXI_URL"];
    delete process.env["MYSQL_AXI_URL"];
    try {
      const port = String(serverPort());
      const login = await ro("auth", "login", "--profile", "it", "--user", NOPW_USER, "--port", port, "-d", DB, "--no-password");
      expect(login.exitCode, login.stdout).toBe(0);
      expect(login.stdout).toContain(`target: "${NOPW_USER}@127.0.0.1:${port}/${DB}"`);
      expect((await ro("auth", "status")).stdout).toContain("it,");
      expect((await ro("query", "SELECT CURRENT_USER() AS u")).stdout).toContain(`${NOPW_USER}@%`);
      const failed = await ro("auth", "login", "--profile", "broken", "--user", "axi_it_nobody", "--port", port, "--no-password");
      expect(failed.stdout).toContain("code: AUTH_REQUIRED");
      expect((await ro("auth", "status")).stdout).not.toContain("broken");
      expect((await ro("auth", "logout")).stdout).toContain("status: removed");
    } finally {
      process.env["MYSQL_AXI_URL"] = url;
    }
  });

  it("maps connection failures without echoing the password", async () => {
    process.env["MYSQL_AXI_URL"] = rootUrl(DB).replace(/:[^:@/]+@/, ":wrong-secret@");
    try {
      const denied = await ro("tables");
      expect(denied.stdout).toContain("code: AUTH_REQUIRED");
      expect(denied.stdout).not.toContain("wrong-secret");

      const free = createServer();
      await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
      const port = (free.address() as { port: number }).port;
      await new Promise((resolve) => free.close(resolve));
      process.env["MYSQL_AXI_URL"] = `mysql://root:pw@127.0.0.1:${port}/${DB}`;
      expect((await ro("tables")).stdout).toContain("code: NETWORK");

      process.env["MYSQL_AXI_URL"] = rootUrl("axi_it_nowhere");
      expect((await ro("query", "SELECT 1")).stdout).toContain("code: NOT_FOUND");
    } finally {
      process.env["MYSQL_AXI_URL"] = rootUrl(DB);
    }
  });
});
