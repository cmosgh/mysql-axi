// Agent task flows: each test is the command sequence an agent runs for one real task.
// The README "Recipes" sections are taken from these; keep them in sync.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ro, rw } from "../helpers.js";
import { inContainer, rootUrl, scalar, scratchDatabase, sql } from "./db.js";
import { SHOP_FIXTURE } from "./fixtures.js";

const SHOP = "axi_it_shop";
const dir = mkdtempSync(join(tmpdir(), "mysql-axi-it-"));

beforeAll(async () => {
  await scratchDatabase(SHOP, SHOP_FIXTURE);
});

const useShop = () => {
  process.env["MYSQL_AXI_URL"] = rootUrl(SHOP);
  process.env["MYSQL_RW_AXI_URL"] = rootUrl(SHOP);
};

describe("investigate read-only, fix locally", () => {
  it("M1: the paid-orders page is slow - EXPLAIN shows a table scan, add an index, the plan uses it", async () => {
    useShop();
    const slow = "SELECT id, total FROM orders WHERE status = 'paid' AND created_at >= '2026-10-01'";
    expect((await ro("describe", "orders")).stdout).not.toContain("by_status_created");
    expect((await ro("explain", slow)).stdout).toContain("Table scan on orders");

    const index = await rw("exec", "CREATE INDEX by_status_created ON orders (status, created_at) ALGORITHM=INPLACE LOCK=NONE");
    expect(index.exitCode, index.stdout).toBe(0);

    expect((await ro("explain", slow)).stdout).toMatch(/Index range scan on orders using by_status_created/);
    const traditional = await ro("explain", "--format", "traditional", slow);
    expect(traditional.stdout).toMatch(/\n {2}1,SIMPLE,orders,null,range,[^\n]*,by_status_created,/);
  });

  it("M2: a unique index on email fails - find the duplicates, dedupe, add the index", async () => {
    useShop();
    await sql("CREATE TABLE subscribers (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(100), created_at DATETIME)", SHOP);
    await sql(
      "INSERT INTO subscribers (email, created_at) VALUES ('a@x.test', '2026-01-01'), ('A@x.test', '2026-01-02'), ('b@x.test', '2026-01-03'), ('b@x.test', '2026-01-04'), ('c@x.test', '2026-01-05')",
      SHOP,
    );
    const failed = await rw("exec", "ALTER TABLE subscribers ADD UNIQUE KEY uq_email (email)");
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain("for key 'subscribers.uq_email' (MySQL 1062)");

    // The case-insensitive collation folds A@x.test into a@x.test.
    const dupes = await ro("query", "SELECT email, COUNT(*) AS n, GROUP_CONCAT(id ORDER BY id SEPARATOR ' ') AS ids FROM subscribers GROUP BY email HAVING n > 1 ORDER BY email");
    expect(dupes.stdout).toContain("result[2]{email,n,ids}:\n  a@x.test,2,1 2\n  b@x.test,2,3 4");

    // Keeps the oldest row per email; it has a WHERE, so it runs without a preview.
    const dedupe = await rw(
      "exec",
      "WITH ranked AS (SELECT id, ROW_NUMBER() OVER (PARTITION BY email ORDER BY id) AS rn FROM subscribers) DELETE FROM subscribers WHERE id IN (SELECT id FROM ranked WHERE rn > 1)",
    );
    expect(dedupe.stdout).toContain("affected_rows: 2");
    expect((await rw("exec", "ALTER TABLE subscribers ADD UNIQUE KEY uq_email (email)")).exitCode).toBe(0);
  });

  it("M3: the FK migration fails - fix the column type, clean up orphans, add the FK", async () => {
    useShop();
    await sql("CREATE TABLE reviews (id INT AUTO_INCREMENT PRIMARY KEY, order_id INT NOT NULL, stars TINYINT)", SHOP);
    await sql("INSERT INTO reviews (order_id, stars) VALUES (1, 5), (2, 4), (999999, 1)", SHOP);
    const addFk = "ALTER TABLE reviews ADD CONSTRAINT fk_reviews_order FOREIGN KEY (order_id) REFERENCES orders (id)";

    expect((await rw("exec", addFk)).stdout).toContain("are incompatible. (MySQL 3780)");
    expect((await ro("describe", "reviews")).stdout).toContain("order_id,int,false");
    expect((await ro("describe", "orders")).stdout).toContain("id,bigint unsigned,false,PRI");
    expect((await rw("exec", "ALTER TABLE reviews MODIFY order_id BIGINT UNSIGNED NOT NULL")).exitCode).toBe(0);

    expect((await rw("exec", addFk)).stdout).toMatch(/foreign key constraint fails .*\(MySQL 1452\)/);
    const orphans = await ro("query", "SELECT r.id, r.order_id FROM reviews r LEFT JOIN orders o ON o.id = r.order_id WHERE o.id IS NULL");
    expect(orphans.stdout).toContain("result[1]{id,order_id}:\n  3,999999");
    expect((await rw("exec", "DELETE FROM reviews WHERE id = 3")).stdout).toContain("affected_rows: 1");

    expect((await rw("exec", addFk)).exitCode).toBe(0);
    expect((await ro("describe", "reviews")).stdout).toContain(
      "foreign_keys[1]{name,columns,references,on_delete,on_update}:\n  fk_reviews_order,order_id,orders(id),NO ACTION,NO ACTION",
    );
  });

  it("M4: a report fails with 'Illegal mix of collations' - find the drifted column, convert it", async () => {
    useShop();
    await sql("CREATE TABLE legacy_users (email VARCHAR(191) PRIMARY KEY, plan VARCHAR(20)) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci", SHOP);
    await sql("INSERT INTO legacy_users VALUES ('user1@example.test', 'pro')", SHOP);
    const report = "SELECT c.email, l.plan FROM customers c JOIN legacy_users l ON l.email = c.email";

    const failed = await ro("query", report);
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain("Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and (utf8mb4_0900_ai_ci,IMPLICIT)");

    const drift = await ro(
      "query",
      "SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col, COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'email' ORDER BY 1",
    );
    expect(drift.stdout).toContain("customers,email,utf8mb4_0900_ai_ci\n  legacy_users,email,utf8mb4_unicode_ci");

    // Read-only workaround first, then the local fix.
    expect((await ro("query", report.replace("ON l.email = c.email", "ON l.email COLLATE utf8mb4_0900_ai_ci = c.email"))).stdout).toContain("result[1]{email,plan}:");
    expect((await rw("exec", "ALTER TABLE legacy_users CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci")).exitCode).toBe(0);
    expect((await ro("query", report)).stdout).toContain("result[1]{email,plan}:\n  user1@example.test,pro");
  });

  it("M5: after running a migration, check the table matches the ORM entity", async () => {
    useShop();
    const migration = join(dir, "migration.sql");
    writeFileSync(
      migration,
      [
        "ALTER TABLE orders",
        "  ADD COLUMN ship_country CHAR(2) AS (meta->>'$.ship.country') VIRTUAL,",
        "  ADD CONSTRAINT chk_total CHECK (total >= 0),",
        "  ADD COLUMN updated_at DATETIME NULL;",
        "CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW SET NEW.updated_at = NOW();",
      ].join("\n"),
    );
    const applied = await rw("import", migration);
    expect(applied.exitCode, applied.stdout).toBe(0);
    expect(applied.stdout).toContain("statements: 2");

    const described = await ro("describe", "orders");
    // One describe covers the generated column, the CHECK, the trigger and the FK delete rule.
    expect(described.stdout).toContain("ship_country,char(2),true,null,null,VIRTUAL GENERATED,");
    expect(described.stdout).toContain("updated_at,datetime,true,null,null,null,null");
    expect(described.stdout).toContain("checks[1]{name,clause}:\n  chk_total,");
    expect(described.stdout).toContain("triggers[1]{name,timing,event}:\n  orders_touch,BEFORE,UPDATE");
    expect(described.stdout).toContain("fk_orders_customer,customer_id,customers(id),CASCADE,NO ACTION");
    expect((await ro("query", "SHOW CREATE TABLE orders")).stdout).toContain("CONSTRAINT `chk_total` CHECK");
    expect((await ro("query", "SELECT ship_country, COUNT(*) AS n FROM orders GROUP BY ship_country ORDER BY ship_country")).stdout).toContain(
      "result[4]{ship_country,n}:\n  AT,2500",
    );
  });
});

describe("local data work", () => {
  it("M6: restore a dump into a scratch database and compare it with the source", async () => {
    useShop();
    const dump = join(dir, "shop.sql");
    writeFileSync(dump, inContainer(["mysqldump", "-uroot", "--routines", "--triggers", "--skip-dump-date", SHOP]));
    const copy = `${SHOP}_restore`;

    expect((await rw("db", "create", copy)).stdout).toContain("result: created");
    const preview = await rw("import", dump, "-d", copy);
    expect(preview.stdout).toContain("DROP TABLE IF EXISTS `orders`");
    expect(preview.stdout).toContain(`writes_to: ${copy}`);
    const restored = await rw("import", dump, "-d", copy, "--confirm");
    expect(restored.exitCode, restored.stdout).toBe(0);
    expect(restored.stdout).toContain(`writes_to: ${copy}`);

    // rows_est in `tables` is an estimate: compare with COUNT(*) and a content hash.
    const counts = await ro("query", `SELECT (SELECT COUNT(*) FROM ${SHOP}.orders) AS src, (SELECT COUNT(*) FROM ${copy}.orders) AS copy`);
    expect(counts.stdout).toContain("result[1]{src,copy}:\n  10000,10000");
    const hash = (db: string) => `SELECT '${db}' AS db, BIT_XOR(CRC32(CONCAT_WS('#', id, customer_id, status, total, created_at))) AS h FROM ${db}.orders`;
    const hashes = await ro("query", `${hash(SHOP)} UNION ALL ${hash(copy)}`);
    const [src, dst] = [...hashes.stdout.matchAll(/\n {2}\w+,(\d+)/g)].map((m) => m[1]);
    expect(src).toBeDefined();
    expect(dst).toBe(src);

    expect((await rw("db", "drop", copy)).stdout).toMatch(/risk: irreversible - deletes \d+ tables/);
    expect((await rw("db", "drop", copy, "--confirm")).stdout).toContain("result: dropped");
  });

  it("M7: a --databases dump restored with -d never writes to the original database", async () => {
    await scratchDatabase("axi_it_blog", ["CREATE TABLE posts (id INT PRIMARY KEY, title VARCHAR(20))", "INSERT INTO posts VALUES (1, 'original')"]);
    const dump = join(dir, "blog.sql");
    writeFileSync(dump, inContainer(["mysqldump", "-uroot", "--databases", "axi_it_blog", "--skip-dump-date"]));
    await sql("UPDATE posts SET title = 'local edit'", "axi_it_blog");
    await sql("DROP DATABASE IF EXISTS axi_it_blog_restore");
    await rw("db", "create", "axi_it_blog_restore");

    const refused = await rw("import", dump, "-d", "axi_it_blog_restore", "--confirm");
    expect(refused.exitCode).toBe(2);
    expect(refused.stdout).toContain("the script writes to 'axi_it_blog'");
    expect(refused.stdout).toContain("Rerun with --skip-use to load everything into 'axi_it_blog_restore'");

    const preview = await rw("import", dump, "-d", "axi_it_blog_restore", "--follow-use");
    expect(preview.stdout).toContain("writes_to: axi_it_blog\n");

    const restored = await rw("import", dump, "-d", "axi_it_blog_restore", "--skip-use", "--confirm");
    expect(restored.exitCode, restored.stdout).toBe(0);
    expect(restored.stdout).toContain("writes_to: axi_it_blog_restore");
    expect(await scalar("SELECT title FROM posts", "axi_it_blog_restore")).toBe("original");
    expect(await scalar("SELECT title FROM posts", "axi_it_blog")).toBe("local edit");

    const system = join(dir, "all.sql");
    writeFileSync(system, "USE `mysql`;\nDELETE FROM user WHERE user = 'nobody';\n");
    const refusedSystem = await rw("import", system, "--confirm");
    expect(refusedSystem.exitCode).toBe(2);
    expect(refusedSystem.stdout).toContain("import refuses system schemas");
  });

  it("M8: fix one order's status - a rerun shows nothing changed", async () => {
    useShop();
    await sql("UPDATE orders SET status = 'pending' WHERE id = 42", SHOP);
    const fix = "UPDATE orders SET status = 'paid' WHERE id = 42";
    expect((await rw("exec", fix)).stdout).toContain("affected_rows: 1\n  matched_rows: 1\n  elapsed_ms");
    expect((await rw("exec", fix)).stdout).toContain("affected_rows: 0\n  matched_rows: 1\n  elapsed_ms");
    expect((await ro("query", "SELECT id, status FROM orders WHERE id = 42")).stdout).toContain("42,paid");
  });

  it("upsert a customer without losing their orders - REPLACE previews, ON DUPLICATE KEY UPDATE runs", async () => {
    useShop();
    const ordersOf1 = () => scalar("SELECT COUNT(*) FROM orders WHERE customer_id = 1", SHOP);
    const before = await ordersOf1();
    expect(before).toBeGreaterThan(0);

    const replace = await rw("exec", "REPLACE INTO customers (id, email, name, created_at) VALUES (1, 'user0@example.test', 'Renamed', NOW())");
    expect(replace.stdout).toContain("risk: irreversible - REPLACE deletes the conflicting row first - ON DELETE CASCADE children go with it");
    expect(await ordersOf1()).toBe(before);

    const upsert = await rw(
      "exec",
      "INSERT INTO customers (id, email, name, created_at) VALUES (1, 'user0@example.test', 'Renamed', NOW()) AS new ON DUPLICATE KEY UPDATE name = new.name",
    );
    expect(upsert.stdout).toContain("affected_rows: 2");
    expect(await scalar("SELECT name FROM customers WHERE id = 1", SHOP)).toBe("Renamed");
    expect(await ordersOf1()).toBe(before);
  });
});
