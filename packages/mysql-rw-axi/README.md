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
  - **Needs `--confirm`:** `DROP`, `TRUNCATE`, `ALTER … DROP`, and `DELETE`/`UPDATE` without `WHERE`. These show a preview until you pass it.
  - Everything else runs directly.
- **`import <file.sql|->`:** runs a script such as a mysqldump file, statement by statement, honouring `DELIMITER` lines. It previews until `--confirm` when the script contains irreversible statements. Statements autocommit: if one fails, the import stops and reports how many statements were already applied.
- **`db create|drop <name>`:** idempotent. `drop` previews the table count and size until `--confirm`, and system schemas are always refused.
- **Every `mysql-axi` command** (`query`, `sample`, `describe`, `tables`, …). These **still run read-only**, so writes always go through `exec`.

The irreversible-statement detection is a best-effort check against mistakes, not a sandbox. The loopback rule is the real boundary.

## Connections

- **Profiles:** `auth login` connects first, then stores the profile. The password goes in the OS keychain and the rest goes in `~/.config/mysql-rw-axi/config.json`.
- **Separate from `mysql-axi`:** the profiles, keychain entries and env vars are not shared, so read-write credentials are never visible to the read-only tool.
- **Env override:** `MYSQL_RW_AXI_URL=mysql://user:password@127.0.0.1:3306/database`.

MySQL 8.x only. MIT licensed.
