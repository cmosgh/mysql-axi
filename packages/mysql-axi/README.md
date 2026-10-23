# mysql-axi

**Read-only** MySQL CLI for agents, following the [AXI](https://axi.md) principles. You can list databases and tables, describe schemas, sample rows, and run capped `SELECT`/`SHOW`/`DESC`/`EXPLAIN` queries. Output is token-efficient [TOON](https://github.com/toon-format/toon).

It cannot change data. For writing to a **local** dev database there is a separate package, [`mysql-rw-axi`](https://www.npmjs.com/package/mysql-rw-axi).

```sh
npm install -g mysql-axi
printf %s "$DB_PASSWORD" | mysql-axi auth login --profile dev --host 127.0.0.1 --user app -d shop --password-stdin
mysql-axi                      # live overview: the server and the default database's tables
mysql-axi find voucher         # tables and columns whose name contains 'voucher', any case
mysql-axi tables --sort size
mysql-axi describe orders customers
mysql-axi query "SELECT status, COUNT(*) FROM orders GROUP BY status"
mysql-axi "SHOW TABLES"         # bare SQL runs as query
```

## Safe to auto-approve

An agent with plain `mysql` through Bash can run anything its account allows, so each call needs a human to read it first. `mysql-axi` is read-only by construction (a SQL guard plus a read-only transaction with a 30 s limit), so `Bash(mysql-axi:*)` can be allowed without prompts.

The same statements sent by an agent through each tool, against a throwaway MySQL 8 where the agent's account has everything on the app database plus `FILE`, as dev and many app accounts do. Every cell is checked by `test/integration/safety.test.ts` in CI. **ran** means the effect was on the server afterwards.

<!-- safety:start -->
| Statement from the agent | `mysql` client | `mysql-mcp-server` 0.1.4 | `mysql-axi` |
| --- | --- | --- | --- |
| *Reads an agent needs* |  |  |  |
| `EXPLAIN` a `SELECT` - does it use an index? | works | works | works |
| `EXPLAIN UPDATE` - would the update use an index? | works | refused | refused; says to explain the matching `SELECT` |
| `EXPLAIN ANALYZE` - runs the query and times it | works | works | refused; points to `explain --analyze` (read-only; time-capped) |
| *Mistakes* |  |  |  |
| `UPDATE` without `WHERE` | **ran** | blocked by the tool | blocked by the tool |
| `DELETE` | **ran** | blocked by the tool | blocked by the tool |
| `DROP TABLE` | **ran** | blocked by the tool | blocked by the tool |
| a second statement after a `SELECT` | **ran** | blocked by the tool | blocked by the tool |
| `SELECT *` on a 10,000-row table | 10,000 rows; ≈176k tokens | 1,000 rows; ≈53k tokens | 50 rows; ≈1k tokens |
| *Ways around a keyword filter* |  |  |  |
| `INTO OUTFILE` inside an executable comment `/*! */` | **ran** | **ran** | blocked by the tool |
| `INTO/**/OUTFILE` (a comment instead of a space) | **ran** | **ran** | blocked by the tool |
| `GET_LOCK` - a named lock a deploy or migration waits on | ran; released when the client exits | **ran** | blocked by the tool |
| `EXPLAIN ANALYZE` of a stored function that writes - it executes | **ran** | **ran** | blocked by the tool |
| `SLEEP` - holds a connection | **ran** | **ran** | blocked by the tool |
| a stored function that writes a table | **ran** | **ran** | blocked by the read-only transaction |
| a definer function that runs `SET GLOBAL` | **ran** | **ran** | **ran** |
<!-- safety:end -->

The last row is the documented gap: a stored routine runs with its definer's rights, and the guard cannot see inside it. Table writes inside it still fail in the read-only transaction; server-level statements such as `SET GLOBAL` do not. `mysql-axi doctor` reports an account with `EXECUTE` as write-capable.

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
- Results are capped at 50 rows by default (max 1000, `--limit`) and 30 s (`--timeout`). A cut result counts on to 1000 rows and reports the total (`rows: 50 of 72 shown`), so one rerun with `--limit 72` gets them all. `max_execution_time` applies to SELECT only.
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
- **Picking a profile:** use `-p/--profile <name>` (before or after the command), or `MYSQL_AXI_PROFILE` for a single command.

## Live overview

Run `mysql-axi` with no command to see the server version, then the default database's tables, or the largest databases when no database is set, and the next commands to try. It reads through the same read-only session as every other command, with short limits: 3 s to reach the server and 10 s in total. When it cannot connect it prints `live: unavailable - <why>` with a hint and still exits 0. `-p` and `-d` work without a command: `mysql-axi -p staging -d shop`.

```text
$ mysql-axi
bin: ~/.npm-global/bin/mysql-axi
description: "READ-ONLY MySQL CLI for agents - explore schemas and run capped read queries, with TOON output. Writes are refused by a client-side guard plus a read-only session (not a grant check)."
mode: READ-ONLY - one SELECT/WITH/SHOW/DESC/EXPLAIN/TABLE statement per call; results capped at 50 rows
connection: "app@127.0.0.1:3306/shop (profile dev)"
server: MySQL 8.0.46
database: shop - 4 tables; 1 views; 2.3 MB
tables[5]: customers,order_items,orders,paid_orders,reviews
help[2]:
  Run `mysql-axi tables` for row estimates and sizes; `mysql-axi describe <table>` for columns and indexes
  Run `mysql-axi query "<sql>" -p <profile> -d <database>` or `mysql-axi explain "<select>"`; `mysql-axi <command> --help` for flags
```

## Agent integration

There are two ways to tell an agent about `mysql-axi`. You only need one.

| | Session hook | Skill |
|---|---|---|
| Install | `mysql-axi setup hooks` | `npx skills add cmosgh/mysql-axi --skill mysql-axi` |
| What the agent gets | a summary at every session start (about 200 tokens): the connection, the profiles, what the last session in this directory ran, and the commands to try | a short skill that loads when a task needs MySQL and points at `mysql-axi --help` |
| Cost | every session | only when the task needs it |
| Agents | Claude Code, Codex, OpenCode | any agent that reads [Agent Skills](https://agentskills.io) |

### Session hook

`mysql-axi setup hooks` installs two hooks:

- **Session start** (Claude Code, Codex, OpenCode) runs `mysql-axi context`, which prints the summary below. It reads only the config file. It never connects or reads the keychain, so it adds no delay.
- **Session end** (Claude Code) runs `mysql-axi context end`. It reads the session transcript and records which `mysql-axi` commands ran: command names, counts and the `-p`/`-d` values, never SQL or other arguments. The record goes in `~/.config/mysql-axi/sessions.json`, keyed by directory, and the next session in that directory sees it as `last_session`.

The agent then knows the tool and the database before its first command, instead of spending turns on `--help`. In the benchmarks agents with the hook needed 15-33% fewer turns than without it.

```text
$ mysql-axi context
bin: ~/.npm-global/bin/mysql-axi
description: "READ-ONLY MySQL CLI for agents - explore schemas and run capped read queries, with TOON output. Writes are refused by a client-side guard plus a read-only session (not a grant check)."
mode: READ-ONLY - one SELECT/WITH/SHOW/DESC/EXPLAIN/TABLE statement per call; results capped at 50 rows
profiles[1]{name,target,active}:
  dev,"app@127.0.0.1:3306/shop",true
last_session: 2026-10-22 - query 6; describe 3; tables 1 - profile dev; database shop
help[3]:
  Run `mysql-axi` for live server state; `mysql-axi --help` for commands
  Run `mysql-axi find <name>`, `mysql-axi tables`, `mysql-axi describe <table>...` or `mysql-axi sample <table>` to explore
  Run `mysql-axi query "<sql>" -p <profile> -d <database>` or `mysql-axi explain "<select>"`; `mysql-axi <command> --help` for flags
```

| Command | Applies to | Files written |
|---|---|---|
| `mysql-axi setup hooks` | every session of yours | `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.config/opencode/plugins/` |
| `mysql-axi setup hooks --project` | everyone working in this repository (commit the files) | `.claude/settings.json`, `.codex/hooks.json`, `.opencode/plugins/`; Codex also needs `[features] hooks = true` in `~/.codex/config.toml`, which this adds |
| `mysql-axi setup hooks --local` | only you, only in this repository (Claude Code) | `.claude/settings.local.json`; it says so if git would commit the file |

- **Install first:** run setup from a global install (`npm install -g mysql-axi`). An `npx` or `pnpm dlx` copy is refused: its cache is not on PATH in later sessions, so the hook would break.
- **Scope:** run `--project` and `--local` from the repository root. `setup status` and `setup uninstall` take the same flag. The hook runs `mysql-axi` when that is on your PATH, so a committed `--project` hook works for teammates who install it too; otherwise it stores the absolute path of your install.
- **Repairs:** rerun `setup hooks` after you upgrade or move the install. It rewrites the hook command and is a no-op when nothing changed. `setup status` shows `broken` or `outdated` when a rerun is needed. Hooks installed by 0.1.x ran the overview at session start, and a rerun switches them to `context`.
- **Other hooks:** setup changes only its own hooks. It recognises them by the binary name and `context` argument, and leaves any other hook alone.

### Skill

`npx skills add cmosgh/mysql-axi --skill mysql-axi` installs [`skills/mysql-axi/SKILL.md`](skills/mysql-axi/SKILL.md). It carries no live state and no per-session cost: the agent loads it when a task needs MySQL, and it points at `npx -y mysql-axi --help` for current guidance. The file is generated from the CLI's own description, and CI fails when it is stale.

MIT licensed.

## Token usage

The same agent tasks, run with the plain `mysql` client, with `mysql-axi` (without and with its [session hook](#session-hook)) and with a read-only MCP server:

<!-- token-usage:start -->
Headless Claude Code (Bash only, no MCP servers or user settings), each model in its own run against its own throwaway MySQL with the same seeded data (about 1k customers, 10k orders, long-text articles) and the same account. Totals sum the per-task medians over all tasks; percentages compare with `mysql` for the same model.

- **mysql**: the `mysql` command-line client, which the model already knows.
- **mysql-axi**: `mysql-axi` with no prior context, so the agent first discovers it (`--help`).
- **mysql-axi + hook**: `mysql-axi` installed with `mysql-axi setup hooks`, so the agent starts the session already knowing the tool, its limits and the connection (see [Session hook](#session-hook)).
- **mysql-axi + skill**: `mysql-axi` installed in the project (`npm i -D mysql-axi`) with its skill in `.claude/skills/`, so Claude Code lists the skill and loads it on demand. The skill points the agent at `npx -y mysql-axi` for current guidance. Enabling skills also brings the Skill tool and Claude Code's bundled skill list into every turn, about 2,000 tokens the other arms do not carry; compare turns for the skill itself.
- **MCP server**: the read-only [`mysql-mcp-server`](https://www.npmjs.com/package/mysql-mcp-server) 0.1.4 MCP server, started with npx, and no Bash. Results come back as pretty-printed JSON. Without the Bash tool its system prompt is about 1,000-2,200 tokens smaller per turn, which lowers its total tokens. These runs were added later on the same data (see `laterArms` in the results files).

Total tokens include the cached system prompt that every turn re-reads, so a saved turn matters as much as smaller output. Every run (commands, output sizes, answers, versions, prompts) is in `test/tokens/results/efficiency/`. Reproduce with `TOKENS_MODEL=<model> pnpm run test:tokens`, then `pnpm run tokens:readme`.

| Model | Arm | Correct | Turns | Tool output tokens ≈ | Total tokens | Cost USD |
|---|---|---|---|---|---|---|
| claude-haiku-5-5 | mysql | 30/30 | 27 | 2,770 | 169,114 | 0.013 |
| claude-haiku-5-5 | mysql-axi | 30/30 | 46 | 4,314 (+56%) | 253,498 (+50%) | 0.016 (+20%) |
| claude-haiku-5-5 | mysql-axi + hook | 30/30 | 35 | 2,661 (−4%) | 196,140 (+16%) | 0.015 (+15%) |
| claude-haiku-5-5 | mysql-axi + skill | 30/30 | 59 | 6,230 (+125%) | 488,129 (+189%) | 0.025 (+88%) |
| claude-haiku-5-5 | MCP server | 30/30 | 39 | 5,210 (+88%) | 157,090 (−7%) | 0.014 (+6%) |
| claude-sonnet-5-5 | mysql | 30/30 | 24 | 2,520 | 124,379 | 0.169 |
| claude-sonnet-5-5 | mysql-axi | 30/30 | 34 | 2,765 (+10%) | 179,053 (+44%) | 0.189 (+12%) |
| claude-sonnet-5-5 | mysql-axi + hook | 30/30 | 24 | 1,415 (−44%) | 132,391 (+6%) | 0.182 (+8%) |
| claude-sonnet-5-5 | mysql-axi + skill | 30/30 | 56 | 4,139 (+64%) | 394,440 (+217%) | 0.345 (+104%) |
| claude-sonnet-5-5 | MCP server | 30/30 | 32 | 4,028 (+60%) | 130,222 (+5%) | 0.193 (+14%) |
| claude-opus-5-5 | mysql | 30/30 | 29 | 3,013 | 156,795 | 0.426 |
| claude-opus-5-5 | mysql-axi | 30/30 | 34 | 3,000 (−0%) | 184,299 (+18%) | 0.439 (+3%) |
| claude-opus-5-5 | mysql-axi + hook | 30/30 | 29 | 1,911 (−37%) | 166,523 (+6%) | 0.446 (+5%) |
| claude-opus-5-5 | mysql-axi + skill | 30/30 | 53 | 4,393 (+46%) | 392,165 (+150%) | 0.781 (+83%) |
| claude-opus-5-5 | MCP server | 30/30 | 39 | 4,184 (+39%) | 150,560 (−4%) | 0.459 (+8%) |

<details><summary>Per task: claude-haiku-5-5</summary>

`claude-haiku-5-5`, 3 runs per task and arm, 2026-10-16. Cells: mysql / mysql-axi / mysql-axi + hook / mysql-axi + skill / MCP server.

| Task | Correct | Turns | Tool output tokens ≈ | Total tokens | Cost USD |
|---|---|---|---|---|---|
| orders per status | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 3 / 4 / 5 / 2 | 14 / 131 / 245 / 344 / 45 | 11,452 / 17,614 / 19,772 / 38,301 / 9,566 | 0.001 / 0.001 / 0.001 / 0.002 / 0.001 |
| FK delete rule | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 3 / 3 / 5 / 3 | 61 / 302 / 193 / 494 / 257 | 12,291 / 18,816 / 13,700 / 38,670 / 11,163 | 0.001 / 0.001 / 0.002 / 0.002 / 0.001 |
| index use | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 5 / 3 / 6 / 3 | 146 / 640 / 192 / 546 / 268 | 12,012 / 27,075 / 12,908 / 48,950 / 10,591 | 0.001 / 0.002 / 0.001 / 0.002 / 0.001 |
| orphan rows | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 5 / 3 / 6 / 5 | 257 / 480 / 309 / 717 / 431 | 18,555 / 26,090 / 19,912 / 50,221 / 16,423 | 0.001 / 0.002 / 0.001 / 0.002 / 0.001 |
| largest table | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 3 / 2 / 5 / 2 | 65 / 194 / 64 / 360 / 326 | 12,015 / 17,651 / 12,554 / 38,063 / 10,772 | 0.001 / 0.001 / 0.001 / 0.002 / 0.001 |
| duplicate emails | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 6 / 4 / 6 / 4 | 79 / 398 / 220 / 589 / 257 | 18,377 / 32,654 / 26,563 / 49,184 / 21,002 | 0.001 / 0.002 / 0.002 / 0.002 / 0.001 |
| top country revenue | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 4 / 5 / 4 / 6 / 5 | 218 / 530 / 299 / 974 / 506 | 25,824 / 26,993 / 28,435 / 52,236 / 17,177 | 0.002 / 0.002 / 0.002 / 0.003 / 0.001 |
| long text article | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 3 / 2 / 5 / 3 | 1,656 / 263 / 150 / 506 / 1,775 | 12,892 / 17,845 / 12,477 / 38,815 / 11,430 | 0.001 / 0.001 / 0.001 / 0.002 / 0.001 |
| schema overview | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 7 / 5 / 8 / 5 | 124 / 799 / 606 / 908 / 774 | 19,377 / 33,817 / 20,429 / 71,880 / 18,817 | 0.002 / 0.002 / 0.002 / 0.003 / 0.002 |
| customers without orders | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 4 / 6 / 5 / 7 / 7 | 151 / 578 / 385 / 792 / 573 | 26,319 / 34,943 / 29,390 / 61,809 / 30,149 | 0.002 / 0.002 / 0.002 / 0.003 / 0.002 |

</details>

<details><summary>Per task: claude-sonnet-5-5</summary>

`claude-sonnet-5-5`, 3 runs per task and arm, 2026-10-16. Cells: mysql / mysql-axi / mysql-axi + hook / mysql-axi + skill / MCP server.

| Task | Correct | Turns | Tool output tokens ≈ | Total tokens | Cost USD |
|---|---|---|---|---|---|
| orders per status | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 3 / 2 / 5 / 3 | 11 / 128 / 16 / 177 / 239 | 9,813 / 15,008 / 10,469 / 33,882 / 12,771 | 0.014 / 0.016 / 0.015 / 0.030 / 0.022 |
| FK delete rule | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 3 / 2 / 5 / 2 | 40 / 156 / 134 / 445 / 57 | 10,573 / 15,766 / 10,915 / 35,213 / 8,640 | 0.019 / 0.020 / 0.018 / 0.037 / 0.018 |
| index use | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 3 / 2 / 6 / 3 | 146 / 304 / 46 / 544 / 248 | 10,279 / 15,622 / 10,661 / 44,406 / 8,841 | 0.016 / 0.018 / 0.016 / 0.036 / 0.018 |
| orphan rows | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 4 / 3 / 6 / 4 | 227 / 389 / 218 / 429 / 307 | 15,855 / 21,504 / 16,955 / 43,844 / 13,477 | 0.017 / 0.020 / 0.021 / 0.034 / 0.018 |
| largest table | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 3 / 2 / 5 / 2 | 48 / 150 / 47 / 230 / 211 | 9,965 / 15,156 / 10,644 / 33,946 / 8,476 | 0.015 / 0.016 / 0.016 / 0.030 / 0.016 |
| duplicate emails | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 4 / 3 / 6 / 4 | 51 / 286 / 102 / 409 / 233 | 15,212 / 21,132 / 16,319 / 43,947 / 17,205 | 0.017 / 0.020 / 0.019 / 0.036 / 0.018 |
| top country revenue | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 4 / 3 / 6 / 4 | 151 / 565 / 441 / 765 / 334 | 15,672 / 22,771 / 17,646 / 46,240 / 18,066 | 0.018 / 0.024 / 0.021 / 0.040 / 0.021 |
| long text article | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 3 / 2 / 5 / 2 | 1,656 / 187 / 75 / 229 / 1,649 | 11,253 / 15,075 / 10,534 / 33,912 / 9,310 | 0.019 / 0.016 / 0.015 / 0.030 / 0.018 |
| schema overview | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 3 / 2 / 6 / 2 | 61 / 216 / 106 / 430 / 242 | 10,248 / 15,650 / 11,305 / 35,024 / 9,027 | 0.016 / 0.019 / 0.021 / 0.036 / 0.019 |
| customers without orders | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 4 / 3 / 6 / 6 | 129 / 385 / 231 / 484 / 509 | 15,509 / 21,369 / 16,943 / 44,026 / 24,409 | 0.017 / 0.020 / 0.020 / 0.035 / 0.026 |

</details>

<details><summary>Per task: claude-opus-5-5</summary>

`claude-opus-5-5`, 3 runs per task and arm, 2026-10-16. Cells: mysql / mysql-axi / mysql-axi + hook / mysql-axi + skill / MCP server.

| Task | Correct | Turns | Tool output tokens ≈ | Total tokens | Cost USD |
|---|---|---|---|---|---|
| orders per status | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 2 / 2 / 5 / 2 | 13 / 129 / 16 / 346 / 38 | 9,884 / 10,077 / 10,517 / 35,013 / 7,923 | 0.029 / 0.031 / 0.032 / 0.088 / 0.037 |
| FK delete rule | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 4 / 3 / 6 / 3 | 189 / 196 / 57 / 492 / 58 | 16,500 / 22,157 / 17,323 / 44,767 / 13,663 | 0.047 / 0.053 / 0.049 / 0.087 / 0.048 |
| index use | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 3 / 2 / 5 / 3 | 146 / 304 / 192 / 374 / 248 | 10,504 / 16,057 / 11,156 / 34,917 / 8,922 | 0.037 / 0.044 / 0.038 / 0.072 / 0.038 |
| orphan rows | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 4 / 3 / 5 / 4 | 113 / 398 / 225 / 429 / 320 | 15,643 / 21,926 / 17,070 / 35,461 / 13,610 | 0.038 / 0.044 / 0.043 / 0.072 / 0.038 |
| largest table | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 4 / 3 / 5 / 3 / 6 | 193 / 256 / 190 / 263 / 384 | 22,716 / 15,599 / 29,477 / 25,179 / 30,434 | 0.054 / 0.038 / 0.059 / 0.062 / 0.066 |
| duplicate emails | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 3 / 3 / 6 / 5 | 152 / 249 / 222 / 333 / 316 | 16,047 / 15,912 / 16,947 / 44,178 / 18,163 | 0.044 / 0.042 / 0.044 / 0.076 / 0.049 |
| top country revenue | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 4 / 4 / 3 / 6 / 7 | 301 / 576 / 398 / 658 / 530 | 21,576 / 23,149 / 17,954 / 46,407 / 20,431 | 0.046 / 0.054 / 0.048 / 0.089 / 0.056 |
| long text article | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 3 / 2 / 5 / 2 | 1,656 / 210 / 75 / 230 / 1,649 | 11,312 / 15,656 / 10,679 / 34,175 / 9,318 | 0.039 / 0.037 / 0.032 / 0.064 / 0.036 |
| schema overview | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 4 / 3 / 6 / 2 | 92 / 278 / 158 / 431 / 123 | 16,322 / 21,801 / 17,483 / 45,663 / 8,739 | 0.047 / 0.049 / 0.051 / 0.085 / 0.037 |
| customers without orders | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 4 / 3 / 6 / 5 | 159 / 406 / 380 / 838 / 521 | 16,291 / 21,965 / 17,917 / 46,405 / 19,357 | 0.046 / 0.048 / 0.050 / 0.086 / 0.054 |

</details>
<!-- token-usage:end -->

## Accuracy

Token savings only count if the answers stay right. These tasks are traps where the output format can mislead an agent:

<!-- accuracy:start -->
Same setup as above, with tasks built as traps where a tool's output can lead to a wrong answer: more matching rows than the 50-row cap, the deciding sentence at the end of a long text, the text 'NULL' next to SQL NULL, ids above 2^53 that lose precision as doubles, and an exact money total. Answers are checked strictly against values computed from the database.

Runs are in `test/tokens/results/accuracy/`. Reproduce with `TOKENS_SUITE=accuracy TOKENS_MODEL=<model> pnpm run test:tokens`, then `pnpm run tokens:readme`.

| Model | Arm | Correct | Turns | Tool output tokens ≈ | Total tokens | Cost USD |
|---|---|---|---|---|---|---|
| claude-haiku-5-5 | mysql | 15/15 | 17 | 2,536 | 109,473 | 0.008 |
| claude-haiku-5-5 | mysql-axi | 15/15 | 26 | 3,624 (+43%) | 160,913 (+47%) | 0.009 (+19%) |
| claude-haiku-5-5 | mysql-axi + hook | 15/15 | 22 | 2,664 (+5%) | 139,372 (+27%) | 0.009 (+20%) |
| claude-haiku-5-5 | mysql-axi + skill | 15/15 | 35 | 4,332 (+71%) | 306,093 (+180%) | 0.014 (+80%) |
| claude-haiku-5-5 | MCP server | 15/15 | 26 | 6,955 (+174%) | 143,134 (+31%) | 0.011 (+36%) |
| claude-sonnet-5-5 | mysql | 15/15 | 13 | 1,587 | 68,309 | 0.092 |
| claude-sonnet-5-5 | mysql-axi | 15/15 | 24 | 2,362 (+49%) | 132,001 (+93%) | 0.118 (+29%) |
| claude-sonnet-5-5 | mysql-axi + hook | 15/15 | 16 | 2,220 (+40%) | 92,419 (+35%) | 0.113 (+23%) |
| claude-sonnet-5-5 | mysql-axi + skill | 15/15 | 35 | 2,482 (+56%) | 268,802 (+294%) | 0.199 (+117%) |
| claude-sonnet-5-5 | MCP server | 15/15 | 23 | 3,234 (+104%) | 94,084 (+38%) | 0.125 (+36%) |
| claude-opus-5-5 | mysql | 15/15 | 17 | 1,807 | 95,276 | 0.245 |
| claude-opus-5-5 | mysql-axi | 15/15 | 21 | 2,236 (+24%) | 120,263 (+26%) | 0.264 (+8%) |
| claude-opus-5-5 | mysql-axi + hook | 15/15 | 17 | 1,540 (−15%) | 100,485 (+5%) | 0.252 (+3%) |
| claude-opus-5-5 | mysql-axi + skill | 15/15 | 29 | 2,765 (+53%) | 228,483 (+140%) | 0.416 (+70%) |
| claude-opus-5-5 | MCP server | 15/15 | 23 | 4,297 (+138%) | 106,534 (+12%) | 0.275 (+12%) |

<details><summary>Per task: claude-haiku-5-5</summary>

`claude-haiku-5-5`, 3 runs per task and arm, 2026-10-16. Cells: mysql / mysql-axi / mysql-axi + hook / mysql-axi + skill / MCP server.

| Task | Correct | Turns | Tool output tokens ≈ | Total tokens | Cost USD |
|---|---|---|---|---|---|
| all out-of-stock SKUs | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 4 / 5 / 5 / 7 / 4 | 537 / 683 / 537 / 690 / 1,868 | 25,636 / 33,661 / 35,963 / 61,885 / 24,688 | 0.002 / 0.002 / 0.003 / 0.003 / 0.002 |
| root cause at the end of a report | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 6 / 4 / 7 / 4 | 1,331 / 1,380 / 1,247 / 1,549 / 1,520 | 19,543 / 33,537 / 27,937 / 60,404 / 17,116 | 0.002 / 0.002 / 0.002 / 0.003 / 0.001 |
| literal 'NULL' text vs SQL NULL | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 6 / 4 / 7 / 6 | 81 / 401 / 173 / 578 / 353 | 18,516 / 33,404 / 20,181 / 59,989 / 30,080 | 0.001 / 0.002 / 0.002 / 0.003 / 0.002 |
| exact BIGINT id | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 4 / 4 / 7 / 4 | 150 / 368 / 219 / 435 / 301 | 18,323 / 24,848 / 25,848 / 59,195 / 20,901 | 0.001 / 0.001 / 0.001 / 0.003 / 0.001 |
| top spender in March | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 4 / 5 / 5 / 7 / 8 | 437 / 792 / 489 / 1,081 / 2,913 | 27,455 / 35,463 / 29,443 / 64,620 / 50,349 | 0.002 / 0.002 / 0.002 / 0.003 / 0.004 |

</details>

<details><summary>Per task: claude-sonnet-5-5</summary>

`claude-sonnet-5-5`, 3 runs per task and arm, 2026-10-16. Cells: mysql / mysql-axi / mysql-axi + hook / mysql-axi + skill / MCP server.

| Task | Correct | Turns | Tool output tokens ≈ | Total tokens | Cost USD |
|---|---|---|---|---|---|
| all out-of-stock SKUs | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 6 / 4 / 8 / 3 | 165 / 588 / 450 / 583 / 695 | 10,776 / 34,775 / 24,009 / 64,985 / 14,873 | 0.020 / 0.032 / 0.030 / 0.048 / 0.031 |
| root cause at the end of a report | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 5 / 4 / 8 / 5 | 1,156 / 837 / 1,378 / 786 / 1,233 | 16,694 / 27,617 / 24,188 / 63,027 / 19,095 | 0.023 / 0.024 / 0.027 / 0.043 / 0.025 |
| literal 'NULL' text vs SQL NULL | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 5 / 2 / 7 / 5 | 21 / 258 / 7 / 381 / 306 | 10,001 / 26,952 / 10,671 / 53,482 / 23,052 | 0.014 / 0.023 / 0.016 / 0.038 / 0.024 |
| exact BIGINT id | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 4 / 3 / 6 / 4 | 92 / 225 / 112 / 285 / 301 | 15,140 / 20,586 / 16,218 / 43,172 / 17,359 | 0.016 / 0.018 / 0.018 / 0.033 / 0.018 |
| top spender in March | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 4 / 3 / 6 / 6 | 154 / 455 / 274 / 447 / 699 | 15,698 / 22,071 / 17,333 / 44,136 / 19,705 | 0.018 / 0.023 / 0.022 / 0.037 / 0.027 |

</details>

<details><summary>Per task: claude-opus-5-5</summary>

`claude-opus-5-5`, 3 runs per task and arm, 2026-10-16. Cells: mysql / mysql-axi / mysql-axi + hook / mysql-axi + skill / MCP server.

| Task | Correct | Turns | Tool output tokens ≈ | Total tokens | Cost USD |
|---|---|---|---|---|---|
| all out-of-stock SKUs | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 4 / 4 / 6 / 4 | 298 / 525 / 315 / 774 / 1,755 | 16,658 / 24,088 / 24,346 / 46,460 / 24,558 | 0.051 / 0.064 / 0.066 / 0.091 / 0.076 |
| root cause at the end of a report | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 4 / 5 / 4 / 7 / 4 | 827 / 504 / 390 / 563 / 1,225 | 23,389 / 28,024 / 23,225 / 54,069 / 18,697 | 0.052 / 0.051 / 0.048 / 0.086 / 0.047 |
| literal 'NULL' text vs SQL NULL | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 3 / 2 / 3 / 3 | 102 / 130 / 77 / 131 / 80 | 16,076 / 15,743 / 10,896 / 25,206 / 12,753 | 0.042 / 0.038 / 0.035 / 0.060 / 0.036 |
| exact BIGINT id | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 4 / 3 / 6 / 5 | 178 / 385 / 217 / 446 / 336 | 15,746 / 21,727 / 16,544 / 44,538 / 17,860 | 0.039 / 0.044 / 0.038 / 0.075 / 0.043 |
| top spender in March | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 4 / 5 / 4 / 7 / 7 | 402 / 693 / 542 / 852 / 902 | 23,407 / 30,681 / 25,474 / 58,210 / 32,666 | 0.061 / 0.068 / 0.065 / 0.104 / 0.073 |

</details>
<!-- accuracy:end -->

## Large tables

<!-- large:start -->
Same setup, on a database shaped like a real one: a 1M-row events table, a 66-column profiles table with long TEXT and JSON cells, and 60 more small tables (65 in all). Tasks are everyday work on such a database - describe a wide table, look up one wide row, find the always-NULL columns, rank tables by rows, aggregate the big table, list every match of a filter (86 rows) - with answers checked against values computed from the data. The MCP server returns up to 1,000 rows as pretty-printed JSON with no cell truncation; mysql-axi shows 50 rows and 200 characters per cell by default and reports what was cut.

Runs are in `test/tokens/results/large/`. Reproduce with `TOKENS_SUITE=large TOKENS_MODEL=<model> pnpm run test:tokens`, then `pnpm run tokens:readme`.

| Model | Arm | Correct | Turns | Tool output tokens ≈ | Total tokens | Cost USD |
|---|---|---|---|---|---|---|
| claude-haiku-5-5 | mysql | 18/18 | 18 | 4,148 | 131,331 | 0.011 |
| claude-haiku-5-5 | mysql-axi | 18/18 | 28 | 6,843 (+65%) | 190,127 (+45%) | 0.013 (+13%) |
| claude-haiku-5-5 | mysql-axi + hook | 18/18 | 23 | 6,283 (+51%) | 167,010 (+27%) | 0.012 (+9%) |
| claude-haiku-5-5 | mysql-axi + skill | 18/18 | 38 | 7,929 (+91%) | 339,390 (+158%) | 0.017 (+57%) |
| claude-haiku-5-5 | MCP server | 18/18 | 23 | 16,494 (+298%) | 177,848 (+35%) | 0.015 (+38%) |

<details><summary>Per task: claude-haiku-5-5</summary>

`claude-haiku-5-5`, 3 runs per task and arm, 2026-10-16. Cells: mysql / mysql-axi / mysql-axi + hook / mysql-axi + skill / MCP server.

| Task | Correct | Turns | Tool output tokens ≈ | Total tokens | Cost USD |
|---|---|---|---|---|---|
| wide table columns | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 3 / 2 / 5 / 2 | 461 / 872 / 760 / 892 / 2,158 | 13,147 / 19,449 / 14,002 / 39,033 / 14,286 | 0.001 / 0.002 / 0.002 / 0.002 / 0.002 |
| one wide row | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 6 / 5 / 7 / 4 | 1,023 / 1,768 / 1,654 / 2,201 / 3,736 | 21,885 / 36,628 / 41,074 / 66,132 / 36,559 | 0.002 / 0.002 / 0.002 / 0.003 / 0.003 |
| always-NULL columns | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 5 / 4 / 6 / 4 | 647 / 1,203 / 821 / 1,163 / 2,262 | 22,010 / 39,774 / 22,838 / 52,485 / 24,561 | 0.002 / 0.003 / 0.002 / 0.003 / 0.002 |
| largest tables | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 3 / 4 / 3 / 6 / 4 | 300 / 693 / 570 / 937 / 1,510 | 19,643 / 27,482 / 21,701 / 51,189 / 30,806 | 0.002 / 0.002 / 0.002 / 0.003 / 0.002 |
| events per kind | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 2 / 3 / 3 / 6 / 3 | 28 / 258 / 145 / 557 / 301 | 11,498 / 18,094 / 12,930 / 49,118 / 15,420 | 0.001 / 0.001 / 0.001 / 0.002 / 0.001 |
| all enterprise handles in Norway | 3/3 / 3/3 / 3/3 / 3/3 / 3/3 | 5 / 7 / 6 / 8 / 6 | 1,688 / 2,049 / 2,333 / 2,179 / 6,528 | 43,148 / 48,700 / 54,465 / 81,433 / 56,216 | 0.003 / 0.003 / 0.003 / 0.004 / 0.005 |

</details>
<!-- large:end -->
