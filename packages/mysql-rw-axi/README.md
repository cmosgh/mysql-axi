# mysql-rw-axi

> [!CAUTION]
> **WRITE ACCESS. This tool can modify and DROP data.**
> It only connects to loopback hosts (127.0.0.0/8, ::1) and unix sockets, and nothing can override that. However, **an SSH tunnel to 127.0.0.1 also counts as loopback**: never tunnel it to a shared or production database.
> For reading, or for any database that is not a local dev copy, use the read-only [`mysql-axi`](https://www.npmjs.com/package/mysql-axi).

MySQL CLI for agents that need to change a **local** development database. It follows the [AXI](https://axi.md) principles and prints token-efficient [TOON](https://github.com/toon-format/toon).

```sh
npm install -g mysql-rw-axi
mysql-rw-axi auth login --profile local --user root --no-password -d shop_dev
mysql-rw-axi exec "UPDATE orders SET status = 'paid' WHERE id = 42"
mysql-rw-axi exec "TRUNCATE TABLE sessions"            # previews; nothing runs
mysql-rw-axi exec "TRUNCATE TABLE sessions" --confirm  # runs
mysql-rw-axi import dump.sql --confirm
mysql-rw-axi db create shop_test
```

## What it does

- **`exec "<sql>"`:** runs one statement of any kind. Routine definitions with `BEGIN … END` bodies count as one statement.
  - **Needs `--confirm`:** `DROP`, `TRUNCATE`, `ALTER … DROP`, `REPLACE` (it deletes the conflicting row, and `ON DELETE CASCADE` children with it), and `DELETE`/`UPDATE` without `WHERE`. These show a preview until you pass it.
  - Everything else runs directly.
  - `affected_rows` counts rows actually changed. An `UPDATE` also reports `matched_rows`, so a rerun shows `affected_rows: 0`.
- **`import <file.sql|->`:** runs a script such as a mysqldump file, statement by statement, honouring `DELIMITER` lines. It previews until `--confirm` when the script contains irreversible statements. Statements autocommit: if one fails, the import stops and reports how many statements were already applied.
  - **Dumps made with `--databases`** contain `USE`/`CREATE DATABASE`. With a target database they are refused unless you pass `--skip-use` (load everything into the target) or `--follow-use` (write where the script says). Scripts that switch to a system schema are always refused.
  - The preview and the summary name every database written (`writes_to`).
  - The file is streamed, so dumps larger than memory work; `-` (stdin) is spooled to a temp file first.
  - The summary counts server warnings and shows the first five (silent truncation, zero dates). DEFINER accounts that do not exist on this server are flagged, because their views, triggers and routines fail later with MySQL 1449.
- **`db create|drop <name>`:** idempotent. `drop` previews the table count and size until `--confirm`, and system schemas are always refused.
- **Every `mysql-axi` command** (`query`, `sample`, `describe`, `tables`, …). These **still run read-only**, so writes always go through `exec`.

The irreversible-statement detection is a best-effort check against mistakes, not a sandbox. The loopback rule is the real boundary.

## Recipes

These are the flows in `test/integration/scenarios.test.ts`.

**Restore a dump into a scratch database and compare it with the source.**
```sh
mysql-rw-axi db create shop_restore
mysql-rw-axi import shop.sql -d shop_restore             # preview: irreversible statements, writes_to
mysql-rw-axi import shop.sql -d shop_restore --confirm   # add --skip-use for a --databases dump
mysql-rw-axi query "SELECT (SELECT COUNT(*) FROM shop.orders) AS src, (SELECT COUNT(*) FROM shop_restore.orders) AS copy"
mysql-rw-axi db drop shop_restore --confirm
```

**A unique index fails on duplicates: find them, keep the oldest, add the index.**
```sh
mysql-rw-axi query "SELECT email, COUNT(*) AS n, GROUP_CONCAT(id ORDER BY id SEPARATOR ' ') AS ids FROM subscribers GROUP BY email HAVING n > 1"
mysql-rw-axi exec "WITH ranked AS (SELECT id, ROW_NUMBER() OVER (PARTITION BY email ORDER BY id) AS rn FROM subscribers) DELETE FROM subscribers WHERE id IN (SELECT id FROM ranked WHERE rn > 1)"
mysql-rw-axi exec "ALTER TABLE subscribers ADD UNIQUE KEY uq_email (email)"
```

**Upsert without losing child rows.** Prefer this to `REPLACE`, which deletes first:
```sh
mysql-rw-axi exec "INSERT INTO customers (id, email, name) VALUES (1, 'a@example.test', 'Ada') AS new ON DUPLICATE KEY UPDATE name = new.name"
```

**A one-off data fix that is safe to rerun.**
```sh
mysql-rw-axi exec "UPDATE orders SET status = 'paid' WHERE id = 42"   # affected_rows: 1
mysql-rw-axi exec "UPDATE orders SET status = 'paid' WHERE id = 42"   # affected_rows: 0, matched_rows: 1
```

## Connections

- **Profiles:** `auth login` connects first, then stores the profile. The password goes in the OS keychain and the rest goes in `~/.config/mysql-rw-axi/config.json`.
- **Separate from `mysql-axi`:** the profiles, keychain entries and env vars are not shared, so read-write credentials are never visible to the read-only tool.
- **Env override:** `MYSQL_RW_AXI_URL=mysql://user:password@127.0.0.1:3306/database`.

MySQL 8.x only. MIT licensed.
