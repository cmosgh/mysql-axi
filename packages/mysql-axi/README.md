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

## Token usage

The same agent tasks, run with the plain `mysql` client and with `mysql-axi` (cold, and with its home view loaded at session start):

<!-- token-usage:start -->
Headless Claude Code (Bash only, no MCP servers or user settings), each model in its own run against its own throwaway MySQL with the same seeded data (about 1k customers, 10k orders, long-text articles) and the same account. Totals sum the per-task medians over all tasks; percentages compare with plain for the same model.

- **plain**: the `mysql` command-line client, which the model already knows.
- **axi**: `mysql-axi` with no prior context, so the agent first discovers it (`--help`).
- **axi+home**: `mysql-axi` with its home view in the system prompt, as `mysql-axi setup hooks` does at session start.

Total tokens include the cached system prompt that every turn re-reads, so a saved turn matters as much as smaller output. Every run (commands, output sizes, answers, versions, prompts) is in `test/tokens/results/`. Reproduce with `TOKENS_MODEL=<model> pnpm run test:tokens`, then `pnpm run tokens:readme`.

| Model | Arm | Correct | Turns | Tool output tokens ≈ | Total tokens | Cost USD |
|---|---|---|---|---|---|---|
| claude-haiku-5-5 | plain | 30/30 | 27 | 2,770 | 169,114 | 0.013 |
| claude-haiku-5-5 | axi | 30/30 | 46 | 4,314 (+56%) | 253,498 (+50%) | 0.016 (+20%) |
| claude-haiku-5-5 | axi+home | 30/30 | 35 | 2,661 (−4%) | 196,140 (+16%) | 0.015 (+15%) |
| claude-sonnet-5-5 | plain | 30/30 | 24 | 2,520 | 124,379 | 0.169 |
| claude-sonnet-5-5 | axi | 30/30 | 34 | 2,765 (+10%) | 179,053 (+44%) | 0.189 (+12%) |
| claude-sonnet-5-5 | axi+home | 30/30 | 24 | 1,415 (−44%) | 132,391 (+6%) | 0.182 (+8%) |
| claude-opus-5-5 | plain | 30/30 | 29 | 3,013 | 156,795 | 0.426 |
| claude-opus-5-5 | axi | 30/30 | 34 | 3,000 (−0%) | 184,299 (+18%) | 0.439 (+3%) |
| claude-opus-5-5 | axi+home | 30/30 | 29 | 1,911 (−37%) | 166,523 (+6%) | 0.446 (+5%) |

<details><summary>Per task: claude-haiku-5-5</summary>

`claude-haiku-5-5`, 3 runs per task and arm, 2026-10-16. Cells: plain / axi / axi+home.

| Task | Correct | Turns | Tool output tokens ≈ | Total tokens | Cost USD |
|---|---|---|---|---|---|
| orders per status | 3/3 / 3/3 / 3/3 | 2 / 3 / 4 | 14 / 131 / 245 | 11,452 / 17,614 / 19,772 | 0.001 / 0.001 / 0.001 |
| FK delete rule | 3/3 / 3/3 / 3/3 | 2 / 3 / 3 | 61 / 302 / 193 | 12,291 / 18,816 / 13,700 | 0.001 / 0.001 / 0.002 |
| index use | 3/3 / 3/3 / 3/3 | 2 / 5 / 3 | 146 / 640 / 192 | 12,012 / 27,075 / 12,908 | 0.001 / 0.002 / 0.001 |
| orphan rows | 3/3 / 3/3 / 3/3 | 3 / 5 / 3 | 257 / 480 / 309 | 18,555 / 26,090 / 19,912 | 0.001 / 0.002 / 0.001 |
| largest table | 3/3 / 3/3 / 3/3 | 2 / 3 / 2 | 65 / 194 / 64 | 12,015 / 17,651 / 12,554 | 0.001 / 0.001 / 0.001 |
| duplicate emails | 3/3 / 3/3 / 3/3 | 3 / 6 / 4 | 79 / 398 / 220 | 18,377 / 32,654 / 26,563 | 0.001 / 0.002 / 0.002 |
| top country revenue | 3/3 / 3/3 / 3/3 | 4 / 5 / 4 | 218 / 530 / 299 | 25,824 / 26,993 / 28,435 | 0.002 / 0.002 / 0.002 |
| long text article | 3/3 / 3/3 / 3/3 | 2 / 3 / 2 | 1,656 / 263 / 150 | 12,892 / 17,845 / 12,477 | 0.001 / 0.001 / 0.001 |
| schema overview | 3/3 / 3/3 / 3/3 | 3 / 7 / 5 | 124 / 799 / 606 | 19,377 / 33,817 / 20,429 | 0.002 / 0.002 / 0.002 |
| customers without orders | 3/3 / 3/3 / 3/3 | 4 / 6 / 5 | 151 / 578 / 385 | 26,319 / 34,943 / 29,390 | 0.002 / 0.002 / 0.002 |

</details>

<details><summary>Per task: claude-sonnet-5-5</summary>

`claude-sonnet-5-5`, 3 runs per task and arm, 2026-10-16. Cells: plain / axi / axi+home.

| Task | Correct | Turns | Tool output tokens ≈ | Total tokens | Cost USD |
|---|---|---|---|---|---|
| orders per status | 3/3 / 3/3 / 3/3 | 2 / 3 / 2 | 11 / 128 / 16 | 9,813 / 15,008 / 10,469 | 0.014 / 0.016 / 0.015 |
| FK delete rule | 3/3 / 3/3 / 3/3 | 2 / 3 / 2 | 40 / 156 / 134 | 10,573 / 15,766 / 10,915 | 0.019 / 0.020 / 0.018 |
| index use | 3/3 / 3/3 / 3/3 | 2 / 3 / 2 | 146 / 304 / 46 | 10,279 / 15,622 / 10,661 | 0.016 / 0.018 / 0.016 |
| orphan rows | 3/3 / 3/3 / 3/3 | 3 / 4 / 3 | 227 / 389 / 218 | 15,855 / 21,504 / 16,955 | 0.017 / 0.020 / 0.021 |
| largest table | 3/3 / 3/3 / 3/3 | 2 / 3 / 2 | 48 / 150 / 47 | 9,965 / 15,156 / 10,644 | 0.015 / 0.016 / 0.016 |
| duplicate emails | 3/3 / 3/3 / 3/3 | 3 / 4 / 3 | 51 / 286 / 102 | 15,212 / 21,132 / 16,319 | 0.017 / 0.020 / 0.019 |
| top country revenue | 3/3 / 3/3 / 3/3 | 3 / 4 / 3 | 151 / 565 / 441 | 15,672 / 22,771 / 17,646 | 0.018 / 0.024 / 0.021 |
| long text article | 3/3 / 3/3 / 3/3 | 2 / 3 / 2 | 1,656 / 187 / 75 | 11,253 / 15,075 / 10,534 | 0.019 / 0.016 / 0.015 |
| schema overview | 3/3 / 3/3 / 3/3 | 2 / 3 / 2 | 61 / 216 / 106 | 10,248 / 15,650 / 11,305 | 0.016 / 0.019 / 0.021 |
| customers without orders | 3/3 / 3/3 / 3/3 | 3 / 4 / 3 | 129 / 385 / 231 | 15,509 / 21,369 / 16,943 | 0.017 / 0.020 / 0.020 |

</details>

<details><summary>Per task: claude-opus-5-5</summary>

`claude-opus-5-5`, 3 runs per task and arm, 2026-10-16. Cells: plain / axi / axi+home.

| Task | Correct | Turns | Tool output tokens ≈ | Total tokens | Cost USD |
|---|---|---|---|---|---|
| orders per status | 3/3 / 3/3 / 3/3 | 2 / 2 / 2 | 13 / 129 / 16 | 9,884 / 10,077 / 10,517 | 0.029 / 0.031 / 0.032 |
| FK delete rule | 3/3 / 3/3 / 3/3 | 3 / 4 / 3 | 189 / 196 / 57 | 16,500 / 22,157 / 17,323 | 0.047 / 0.053 / 0.049 |
| index use | 3/3 / 3/3 / 3/3 | 2 / 3 / 2 | 146 / 304 / 192 | 10,504 / 16,057 / 11,156 | 0.037 / 0.044 / 0.038 |
| orphan rows | 3/3 / 3/3 / 3/3 | 3 / 4 / 3 | 113 / 398 / 225 | 15,643 / 21,926 / 17,070 | 0.038 / 0.044 / 0.043 |
| largest table | 3/3 / 3/3 / 3/3 | 4 / 3 / 5 | 193 / 256 / 190 | 22,716 / 15,599 / 29,477 | 0.054 / 0.038 / 0.059 |
| duplicate emails | 3/3 / 3/3 / 3/3 | 3 / 3 / 3 | 152 / 249 / 222 | 16,047 / 15,912 / 16,947 | 0.044 / 0.042 / 0.044 |
| top country revenue | 3/3 / 3/3 / 3/3 | 4 / 4 / 3 | 301 / 576 / 398 | 21,576 / 23,149 / 17,954 | 0.046 / 0.054 / 0.048 |
| long text article | 3/3 / 3/3 / 3/3 | 2 / 3 / 2 | 1,656 / 210 / 75 | 11,312 / 15,656 / 10,679 | 0.039 / 0.037 / 0.032 |
| schema overview | 3/3 / 3/3 / 3/3 | 3 / 4 / 3 | 92 / 278 / 158 | 16,322 / 21,801 / 17,483 | 0.047 / 0.049 / 0.051 |
| customers without orders | 3/3 / 3/3 / 3/3 | 3 / 4 / 3 | 159 / 406 / 380 | 16,291 / 21,965 / 17,917 | 0.046 / 0.048 / 0.050 |

</details>
<!-- token-usage:end -->

## How writes are blocked

Every statement passes through two layers:

1. **A client-side guard.** It lexes the SQL, skipping comments and treating quoted text as opaque, and accepts exactly **one** statement starting with `SELECT`, `WITH … SELECT`, `SHOW`, `DESC`/`DESCRIBE`, `EXPLAIN`, `TABLE` or `CHECKSUM TABLE`. It refuses:
   - `INTO` (OUTFILE, DUMPFILE, @var);
   - `FOR UPDATE`/`FOR SHARE` and `LOCK IN SHARE MODE`;
   - `EXPLAIN ANALYZE` in SQL (use `explain --analyze`, which allows only a SELECT) and `EXPLAIN` of INSERT/UPDATE/DELETE;
   - calls to `SLEEP`, `BENCHMARK`, `GET_LOCK`/`RELEASE_LOCK`, `LOAD_FILE` and state-changing loadable functions, also with quoted names. Columns that share these names are fine;
   - executable comments (`/*! */`) and the `SET_VAR`/`RESOURCE_GROUP` optimizer hints. Plan hints such as `INDEX()` are allowed.

   The SQL must pass under both backslash-escape modes, so a server running `NO_BACKSLASH_ESCAPES` cannot read a statement differently from the guard.
2. **A read-only session.** Each call opens its own connection, sets `SESSION transaction_read_only = ON` and runs inside `START TRANSACTION READ ONLY`, with `multipleStatements` off. MySQL itself then refuses DML, DDL and writes made by stored functions.

## Limitations

- **It is not a grant check.** If your account has write privileges, a bug in the guard plus a gap in MySQL's read-only mode could still write. For a hard guarantee, connect with a SELECT-only account:
  ```sql
  CREATE USER 'agent_ro'@'%' IDENTIFIED BY '<password>';
  GRANT SELECT, SHOW VIEW ON shop.* TO 'agent_ro'@'%';
  ```
  `mysql-axi doctor` reports the account's grants and warns when it can write.
- The read-only session does **not** cover server-level statements (`SET GLOBAL`, `FLUSH`, `KILL`) or file writes (`INTO OUTFILE`). Only the guard stops those, including calls to state-changing loadable functions such as `asynchronous_connection_failover_*` and `innodb_*`, quoted or not.
- **Stored routines run with their definer's rights.** If your account has `EXECUTE`, a function called from a `SELECT` can run `SET GLOBAL` or other server-level statements, and the guard cannot see inside it. `doctor` reports `EXECUTE` as write-capable.
- Password hashes (`authentication_string`, `SHOW CREATE USER`) and passwords inside SQL text are printed as `<redacted>`.
- Results are capped at 50 rows by default (max 1000, `--limit`) and 30 s (`--timeout`). `max_execution_time` applies to SELECT only.
- MySQL 8.x only. MariaDB is not supported.

## Recipes

These are the flows in `test/integration/scenarios.test.ts`. The fixes need the local-only [`mysql-rw-axi`](https://www.npmjs.com/package/mysql-rw-axi).

**Slow query: find the table scan, check the fix.**
```sh
mysql-axi explain "SELECT id, total FROM orders WHERE status = 'paid' AND created_at >= '2026-10-01'"
# -> Table scan on orders
mysql-rw-axi exec "CREATE INDEX by_status_created ON orders (status, created_at) ALGORITHM=INPLACE LOCK=NONE"
mysql-axi explain "<same query>"
# -> Index range scan on orders using by_status_created
```

**An FK migration fails: types first, then orphan rows.**
```sh
mysql-axi describe reviews     # order_id,int ...
mysql-axi describe orders      # id,bigint unsigned ... -> MySQL 3780 until the types match
mysql-axi query "SELECT r.id, r.order_id FROM reviews r LEFT JOIN orders o ON o.id = r.order_id WHERE o.id IS NULL"
```

**"Illegal mix of collations": find the drifted column.**
```sh
mysql-axi query "SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'email'"
mysql-axi query "SELECT c.email, l.plan FROM customers c JOIN legacy_users l ON l.email COLLATE utf8mb4_0900_ai_ci = c.email"
```

**Check a migration against the ORM entity.**
```sh
mysql-axi describe orders      # columns, generated columns, indexes, foreign keys
mysql-axi query "SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()"
mysql-axi query "SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_TABLE = 'orders'"
mysql-axi query "SHOW CREATE TABLE orders" --full
```

## Connections

- **Profiles:** `auth login` creates one. The password goes in the OS keychain and the rest goes in `~/.config/mysql-axi/config.json`.
- **Env override:** `MYSQL_AXI_URL=mysql://user:password@host:port/database` overrides the profiles.
- **Picking a profile:** use `--profile <name>`, or `MYSQL_AXI_PROFILE` for a single command.

## Agent integration

- **Session start:** `mysql-axi setup hooks` shows the home view at the start of each Claude Code, Codex or OpenCode session. The home view never connects to a database or reads the keychain.
- **Skill:** a discovery skill ships in `skills/mysql-axi/SKILL.md`.

MIT licensed.
