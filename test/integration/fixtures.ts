/** About 1k customers and 10k orders: enough rows for the optimizer to prefer an index. */
export const SHOP_FIXTURE = [
  "CREATE TABLE digits (d TINYINT PRIMARY KEY)",
  "INSERT INTO digits VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)",
  `CREATE TABLE customers (
     id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, email VARCHAR(191) NOT NULL, name VARCHAR(80) NOT NULL,
     created_at DATETIME NOT NULL, deleted_at DATETIME NULL, UNIQUE KEY uq_email_deleted (email, deleted_at))`,
  `CREATE TABLE orders (
     id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, customer_id BIGINT UNSIGNED NOT NULL, status VARCHAR(20) NOT NULL,
     total DECIMAL(10,2) NOT NULL, meta JSON NULL, created_at DATETIME NOT NULL, KEY by_customer (customer_id),
     CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE)`,
  `INSERT INTO customers (email, name, created_at)
     SELECT CONCAT('user', n, '@example.test'), CONCAT('User ', n), '2025-01-01' + INTERVAL n DAY
     FROM (SELECT a.d * 100 + b.d * 10 + c.d AS n FROM digits a, digits b, digits c ORDER BY n) s`,
  `INSERT INTO orders (customer_id, status, total, meta, created_at)
     SELECT 1 + n % 1000, ELT(1 + n % 3, 'paid', 'pending', 'refunded'), n % 200 + 0.5,
            JSON_OBJECT('ship', JSON_OBJECT('country', ELT(1 + n % 4, 'DE', 'FR', 'NL', 'AT'))), '2026-01-01' + INTERVAL n % 300 DAY
     FROM (SELECT a.d * 1000 + b.d * 100 + c.d * 10 + e.d AS n FROM digits a, digits b, digits c, digits e ORDER BY n) s`,
  "ANALYZE TABLE customers, orders",
];
