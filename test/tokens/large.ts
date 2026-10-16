// Fixture for the `large` token suite: a 1M-row events table, a 66-column profiles table with long
// TEXT/JSON cells and 60 small tables, so the database has the shape where output caps start to matter.
// Everything derives from `n` out of the digits cross join, so a run is reproducible and seeds in seconds.

interface ProfileColumn {
  name: string;
  type: string;
  /** SQL producing the value for row `n` (0-based). */
  expr: string;
}

const PROFILE_COLUMNS: ProfileColumn[] = [
  { name: "id", type: "INT PRIMARY KEY", expr: "n + 1" },
  { name: "handle", type: "VARCHAR(20) NOT NULL UNIQUE", expr: "CONCAT('member_', LPAD(n + 1, 5, '0'))" },
  { name: "email", type: "VARCHAR(120) NOT NULL", expr: "CONCAT('member', n + 1, '@mail.test')" },
  { name: "display_name", type: "VARCHAR(80) NOT NULL", expr: "CONCAT('Member ', n + 1)" },
  { name: "country", type: "VARCHAR(40) NOT NULL", expr: "ELT(1 + n % 7, 'Germany', 'France', 'Netherlands', 'Austria', 'Norway', 'Poland', 'Spain')" },
  { name: "plan", type: "VARCHAR(20) NOT NULL", expr: "ELT(1 + n % 5, 'free', 'starter', 'pro', 'enterprise', 'trial')" },
  { name: "status", type: "VARCHAR(20) NOT NULL", expr: "ELT(1 + n % 3, 'active', 'active', 'suspended')" },
  { name: "signup_date", type: "DATE NOT NULL", expr: "'2024-01-01' + INTERVAL n % 900 DAY" },
  {
    name: "bio",
    type: "TEXT",
    expr: "CONCAT('Member ', n + 1, ' writes about ', ELT(1 + n % 4, 'gardening', 'cycling', 'woodwork', 'astronomy'), '. ', REPEAT('Longer biography text with several sentences about hobbies and work. ', 10 + n % 6))",
  },
  { name: "notes", type: "TEXT", expr: "CONCAT('Support notes. ', REPEAT('Ticket follow-up recorded by the support team. ', 6 + n % 4))" },
  {
    name: "preferences",
    type: "JSON",
    expr: "JSON_OBJECT('theme', ELT(1 + n % 2, 'dark', 'light'), 'newsletter', n % 3 = 0, 'digest', ELT(1 + n % 3, 'daily', 'weekly', 'never'), 'languages', JSON_ARRAY('en', ELT(1 + n % 3, 'de', 'fr', 'nl')))",
  },
  {
    name: "address",
    type: "JSON",
    expr: "JSON_OBJECT('street', CONCAT(n % 200 + 1, ' Example Street'), 'city', ELT(1 + n % 5, 'Northfield', 'Westbrook', 'Eastgate', 'Southport', 'Midtown'), 'zip', LPAD(n % 99999, 5, '0'))",
  },
  { name: "phone", type: "VARCHAR(30) NULL", expr: "IF(n % 3 = 0, NULL, CONCAT('+49 30 ', 200000 + n))" },
  // Never populated: the answer to the always-NULL task.
  { name: "deleted_at", type: "DATETIME NULL", expr: "NULL" },
  { name: "legacy_crm_id", type: "VARCHAR(40) NULL", expr: "NULL" },
  { name: "merged_into_id", type: "INT NULL", expr: "NULL" },
  // Sparse: NULL in a sample of rows but not in every row.
  { name: "referrer_code", type: "VARCHAR(20) NULL", expr: "IF(n % 500 = 7, CONCAT('REF', n), NULL)" },
  { name: "vat_number", type: "VARCHAR(30) NULL", expr: "IF(n % 250 = 3, CONCAT('EU', 100000 + n), NULL)" },
  { name: "cancelled_at", type: "DATETIME NULL", expr: "IF(n % 40 = 1, '2026-02-01 10:00:00' + INTERVAL n % 100 DAY, NULL)" },
  { name: "timezone", type: "VARCHAR(40) NOT NULL", expr: "ELT(1 + n % 4, 'Europe/Berlin', 'Europe/Paris', 'Europe/Oslo', 'Europe/Madrid')" },
  { name: "locale", type: "VARCHAR(10) NOT NULL", expr: "ELT(1 + n % 4, 'de-DE', 'fr-FR', 'nb-NO', 'es-ES')" },
  { name: "last_login_at", type: "DATETIME NOT NULL", expr: "'2026-09-01 08:00:00' + INTERVAL n % 40 DAY + INTERVAL n % 3600 SECOND" },
  { name: "login_count", type: "INT NOT NULL", expr: "n % 400" },
  { name: "failed_logins", type: "INT NOT NULL", expr: "n % 6" },
  { name: "mfa_enabled", type: "TINYINT(1) NOT NULL", expr: "n % 2" },
  { name: "newsletter_opt_in", type: "TINYINT(1) NOT NULL", expr: "n % 3 = 0" },
  { name: "marketing_opt_in", type: "TINYINT(1) NOT NULL", expr: "n % 4 = 0" },
  { name: "terms_version", type: "VARCHAR(10) NOT NULL", expr: "ELT(1 + n % 3, '2024-1', '2025-1', '2026-1')" },
  { name: "avatar_url", type: "VARCHAR(255) NOT NULL", expr: "CONCAT('https://img.example.test/avatars/', n + 1, '.png')" },
  { name: "website", type: "VARCHAR(255) NULL", expr: "IF(n % 5 = 0, CONCAT('https://member', n + 1, '.example.test'), NULL)" },
  { name: "company", type: "VARCHAR(80) NOT NULL", expr: "CONCAT('Company ', n % 300)" },
  { name: "job_title", type: "VARCHAR(80) NOT NULL", expr: "ELT(1 + n % 5, 'Engineer', 'Analyst', 'Manager', 'Designer', 'Founder')" },
  { name: "team_size", type: "INT NOT NULL", expr: "1 + n % 50" },
  { name: "industry", type: "VARCHAR(40) NOT NULL", expr: "ELT(1 + n % 6, 'retail', 'software', 'health', 'finance', 'education', 'logistics')" },
  { name: "seats", type: "INT NOT NULL", expr: "1 + n % 25" },
  { name: "storage_quota_mb", type: "INT NOT NULL", expr: "1024 * (1 + n % 10)" },
  { name: "storage_used_mb", type: "INT NOT NULL", expr: "n % 1000" },
  { name: "api_calls_30d", type: "INT NOT NULL", expr: "(n * 13) % 50000" },
  { name: "api_key_count", type: "INT NOT NULL", expr: "n % 4" },
  { name: "billing_cycle", type: "VARCHAR(10) NOT NULL", expr: "ELT(1 + n % 2, 'monthly', 'yearly')" },
  { name: "currency", type: "CHAR(3) NOT NULL", expr: "ELT(1 + n % 3, 'EUR', 'NOK', 'PLN')" },
  { name: "mrr_cents", type: "INT NOT NULL", expr: "(n % 5) * 2900" },
  { name: "lifetime_value_cents", type: "BIGINT NOT NULL", expr: "(n % 5) * 2900 * (1 + n % 30)" },
  { name: "discount_pct", type: "DECIMAL(5,2) NOT NULL", expr: "(n % 4) * 5.5" },
  { name: "trial_ends_at", type: "DATE NULL", expr: "IF(n % 5 = 4, '2026-10-01' + INTERVAL n % 30 DAY, NULL)" },
  { name: "renews_at", type: "DATE NOT NULL", expr: "'2026-11-01' + INTERVAL n % 365 DAY" },
  { name: "churn_risk", type: "DECIMAL(4,3) NOT NULL", expr: "(n % 1000) / 1000" },
  { name: "nps_score", type: "TINYINT NOT NULL", expr: "n % 11" },
  { name: "support_tickets", type: "INT NOT NULL", expr: "n % 9" },
  { name: "last_ticket_at", type: "DATETIME NULL", expr: "IF(n % 9 = 0, NULL, '2026-06-01 09:00:00' + INTERVAL n % 120 DAY)" },
  { name: "sla_tier", type: "VARCHAR(10) NOT NULL", expr: "ELT(1 + n % 3, 'bronze', 'silver', 'gold')" },
  { name: "account_manager", type: "VARCHAR(60) NOT NULL", expr: "CONCAT('Manager ', n % 12)" },
  { name: "region", type: "VARCHAR(20) NOT NULL", expr: "ELT(1 + n % 3, 'eu-central', 'eu-north', 'eu-west')" },
  { name: "utm_source", type: "VARCHAR(40) NOT NULL", expr: "ELT(1 + n % 4, 'search', 'social', 'referral', 'direct')" },
  { name: "utm_campaign", type: "VARCHAR(60) NOT NULL", expr: "CONCAT('campaign-', n % 20)" },
  { name: "first_seen_ip", type: "VARCHAR(45) NOT NULL", expr: "CONCAT('10.', n % 256, '.', (n DIV 256) % 256, '.', n % 200)" },
  { name: "last_seen_ip", type: "VARCHAR(45) NOT NULL", expr: "CONCAT('10.', (n + 7) % 256, '.', (n DIV 256) % 256, '.', n % 210)" },
  { name: "user_agent", type: "VARCHAR(255) NOT NULL", expr: "CONCAT('Mozilla/5.0 (', ELT(1 + n % 3, 'Macintosh', 'Windows NT 10.0', 'X11; Linux x86_64'), ') AppleWebKit/537.36 Chrome/1', n % 30, '.0 Safari/537.36')" },
  { name: "device_type", type: "VARCHAR(20) NOT NULL", expr: "ELT(1 + n % 3, 'desktop', 'mobile', 'tablet')" },
  { name: "os_name", type: "VARCHAR(20) NOT NULL", expr: "ELT(1 + n % 3, 'macOS', 'Windows', 'Linux')" },
  { name: "browser", type: "VARCHAR(20) NOT NULL", expr: "ELT(1 + n % 3, 'Chrome', 'Firefox', 'Safari')" },
  { name: "screen_width", type: "SMALLINT NOT NULL", expr: "ELT(1 + n % 3, 1920, 1440, 390)" },
  { name: "screen_height", type: "SMALLINT NOT NULL", expr: "ELT(1 + n % 3, 1080, 900, 844)" },
  { name: "score", type: "DECIMAL(6,2) NOT NULL", expr: "(n % 10000) / 100" },
  { name: "created_at", type: "DATETIME NOT NULL", expr: "'2024-01-01 00:00:00' + INTERVAL n % 900 DAY" },
  { name: "updated_at", type: "DATETIME NOT NULL", expr: "'2026-09-01 00:00:00' + INTERVAL n % 40 DAY" },
];

const PROFILE_ROWS = 3000;
const EVENT_ROWS = 1_000_000;

/** 60 small tables with ordinary names, so schema overviews have to scan a long list. */
const AREAS = ["billing", "catalog", "crm", "inventory", "support", "audit", "marketing", "shipping", "auth", "analytics", "payroll", "finance"];
const KINDS = ["settings", "log", "tags", "notes", "snapshots"];

const smallTables = AREAS.flatMap((area, i) =>
  KINDS.flatMap((kind, j) => {
    const name = `${area}_${kind}`;
    const rows = 5 + ((i * 7 + j * 13) % 90);
    return [
      `CREATE TABLE ${name} (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(60) NOT NULL, value TEXT, created_at DATETIME NOT NULL)`,
      `INSERT INTO ${name} (name, value, created_at) SELECT CONCAT('${name} ', n), REPEAT('v', 20), '2026-01-01' + INTERVAL n DAY
         FROM (SELECT a.d * 10 + b.d AS n FROM digits a, digits b) s WHERE n < ${rows}`,
    ];
  }),
);

export const PROFILE_COLUMN_NAMES = PROFILE_COLUMNS.map((c) => c.name);

export const LARGE_FIXTURE = [
  `CREATE TABLE profiles (${PROFILE_COLUMNS.map((c) => `${c.name} ${c.type}`).join(", ")})`,
  `INSERT INTO profiles SELECT ${PROFILE_COLUMNS.map((c) => c.expr).join(", ")}
     FROM (SELECT a.d * 1000 + b.d * 100 + c.d * 10 + e.d AS n FROM digits a, digits b, digits c, digits e) s WHERE n < ${PROFILE_ROWS}`,
  `CREATE TABLE events (
     id INT UNSIGNED PRIMARY KEY, customer_id BIGINT UNSIGNED NOT NULL, kind VARCHAR(20) NOT NULL, path VARCHAR(80) NOT NULL,
     duration_ms INT NOT NULL, created_at DATETIME NOT NULL, KEY by_customer (customer_id))`,
  // Skewed kinds so every per-kind count is distinct.
  `INSERT INTO events SELECT n + 1, 1 + n % 1000,
     CASE WHEN n % 100 < 40 THEN 'page_view' WHEN n % 100 < 65 THEN 'click' WHEN n % 100 < 80 THEN 'search' WHEN n % 100 < 90 THEN 'add_to_cart'
          WHEN n % 100 < 96 THEN 'checkout' WHEN n % 100 < 99 THEN 'refund' ELSE 'error' END,
     CONCAT('/p/', n % 500), (n * 7) % 3000, '2026-01-01' + INTERVAL n % 280 DAY + INTERVAL (n * 37) % 86400 SECOND
     FROM (SELECT a.d * 100000 + b.d * 10000 + c.d * 1000 + e.d * 100 + f.d * 10 + g.d AS n
           FROM digits a, digits b, digits c, digits e, digits f, digits g) s WHERE n < ${EVENT_ROWS}`,
  ...smallTables,
  `ANALYZE TABLE profiles, events, ${AREAS.flatMap((area) => KINDS.map((kind) => `${area}_${kind}`)).join(", ")}`,
];
