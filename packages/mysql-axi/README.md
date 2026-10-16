# mysql-axi

**Read-only** MySQL CLI for agents, following the [AXI](https://axi.md) principles. You can list databases and tables, describe schemas, sample rows, and run capped `SELECT`/`SHOW`/`DESC`/`EXPLAIN` queries. Output is token-efficient [TOON](https://github.com/toon-format/toon).

It cannot change data. For writing to a **local** dev database there is a separate package, [`mysql-rw-axi`](https://www.npmjs.com/package/mysql-rw-axi).

```sh
npm install -g mysql-axi
printf %s "$DB_PASSWORD" | mysql-axi auth login --profile dev --host 127.0.0.1 --user app -d shop --password-stdin
mysql-axi                      # overview: what this tool can do and the configured connections
mysql-axi tables --sort size
mysql-axi describe orders
mysql-axi query "SELECT status, COUNT(*) FROM orders GROUP BY status"
```

## How writes are blocked

Every statement passes through two layers:

1. **A client-side guard.** It lexes the SQL, skipping comments and treating quoted text as opaque, and accepts exactly **one** statement starting with `SELECT`, `WITH … SELECT`, `SHOW`, `DESC`/`DESCRIBE`, `EXPLAIN` or `TABLE`. It refuses:
   - `INTO` (OUTFILE, DUMPFILE, @var);
   - `FOR UPDATE`/`FOR SHARE` and `LOCK IN SHARE MODE`;
   - `EXPLAIN ANALYZE`;
   - `SLEEP`, `BENCHMARK`, `GET_LOCK`/`RELEASE_LOCK` and `LOAD_FILE`;
   - executable comments (`/*! */`) and optimizer hints (`/*+ */`).

   The SQL must pass under both backslash-escape modes, so a server running `NO_BACKSLASH_ESCAPES` cannot read a statement differently from the guard.
2. **A read-only session.** Each call opens its own connection, sets `SESSION transaction_read_only = ON` and runs inside `START TRANSACTION READ ONLY`, with `multipleStatements` off. MySQL itself then refuses DML, DDL and writes made by stored functions.

## Limitations

- **It is not a grant check.** If your account has write privileges, a bug in the guard plus a gap in MySQL's read-only mode could still write. For a hard guarantee, connect with a SELECT-only account:
  ```sql
  CREATE USER 'agent_ro'@'%' IDENTIFIED BY '<password>';
  GRANT SELECT, SHOW VIEW ON shop.* TO 'agent_ro'@'%';
  ```
  `mysql-axi doctor` reports the account's grants and warns when it can write.
- The read-only session does **not** cover server-level statements (`SET GLOBAL`, `FLUSH`, `KILL`) or file writes (`INTO OUTFILE`). Only the guard stops those.
- Results are capped at 50 rows by default (max 1000, `--limit`) and 30 s (`--timeout`). `max_execution_time` applies to SELECT only.
- MySQL 8.x only. MariaDB is not supported.

## Connections

- **Profiles:** `auth login` creates one. The password goes in the OS keychain and the rest goes in `~/.config/mysql-axi/config.json`.
- **Env override:** `MYSQL_AXI_URL=mysql://user:password@host:port/database` overrides the profiles.
- **Picking a profile:** use `--profile <name>`, or `MYSQL_AXI_PROFILE` for a single command.

## Agent integration

- **Session start:** `mysql-axi setup hooks` shows the home view at the start of each Claude Code, Codex or OpenCode session. The home view never connects to a database or reads the keychain.
- **Skill:** a discovery skill ships in `skills/mysql-axi/SKILL.md`.

MIT licensed.
