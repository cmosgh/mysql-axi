# mysql-axi

Two [AXI](https://axi.md) MySQL CLIs for agents, built from one shared core:

| Package | Can write? | Hosts | Use for |
|---|---|---|---|
| [`mysql-axi`](packages/mysql-axi) | **No.** Client-side guard plus read-only session | any | reading any database |
| [`mysql-rw-axi`](packages/mysql-rw-axi) | **Yes.** `exec`, `import`, `db` | loopback and unix sockets only | changing a local dev database |

These are two separate packages, so installing or allowing only `mysql-axi` means an agent has no write command available.

## Documentation

**[mysql-axi](packages/mysql-axi)** (read-only)
- [Safe to auto-approve](packages/mysql-axi#safe-to-auto-approve): what the same agent statements do through the plain `mysql` client, a read-only MCP server and `mysql-axi`, verified in CI
- [How writes are blocked](packages/mysql-axi#how-writes-are-blocked) and [Limitations](packages/mysql-axi#limitations): what the guard does **not** cover
- [Recipes](packages/mysql-axi#recipes): slow queries, orphan rows, collation drift, checking a migration
- [Session hook](packages/mysql-axi#session-hook): start every agent session knowing the tool (`setup hooks`, `--project`, `--local`)
- Benchmarks against the `mysql` client and an MCP server: [Token usage](packages/mysql-axi#token-usage), [Accuracy](packages/mysql-axi#accuracy), [Large tables](packages/mysql-axi#large-tables)
- [Connections](packages/mysql-axi#connections): profiles, keychain, `MYSQL_AXI_URL`

**[mysql-rw-axi](packages/mysql-rw-axi)** (writes, loopback only)
- [What it does](packages/mysql-rw-axi#what-it-does): `exec`, `import`, `db`, and which statements need `--confirm`
- [Recipes](packages/mysql-rw-axi#recipes): restore and compare a dump, dedupe before a unique index, upsert, rerunnable fixes
- [Session hook](packages/mysql-rw-axi#session-hook): install it only where writing is wanted (`--local`)
- [Connections](packages/mysql-rw-axi#connections): separate profiles and keychain entries from `mysql-axi`

## Layout

```
packages/core          shared code (private, bundled into both CLIs)
packages/mysql-axi     read-only CLI
packages/mysql-rw-axi  write CLI: exec, import, db, loopback rule
test/                  guard, unit, whole-CLI (mocked mysql2) and integration tests
```

## Development

```sh
pnpm install
pnpm run check              # typecheck, tests, bundle, skill freshness
pnpm run test:integration   # needs Docker: starts a throwaway MySQL 8 on a random loopback port
TOKENS_SUITE=accuracy TOKENS_MODEL=haiku pnpm run test:tokens   # local only, spends model tokens: efficiency|accuracy|large suites
pnpm run tokens:readme      # publish test/tokens/results/<suite>/<model>.json as the README tables
pnpm run safety:readme      # render the safety matrix that test/integration/safety.test.ts verifies
```

Both packages are released together: `npm version patch && git push --follow-tags` bumps the root and both packages, and the Release workflow stages both on npm for 2FA approval.

MIT licensed.
