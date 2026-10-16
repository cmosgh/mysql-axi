# mysql-axi

Two [AXI](https://axi.md) MySQL CLIs for agents, built from one shared core:

| Package | Can write? | Hosts | Use for |
|---|---|---|---|
| [`mysql-axi`](packages/mysql-axi) | **No.** Client-side guard plus read-only session | any | reading any database |
| [`mysql-rw-axi`](packages/mysql-rw-axi) | **Yes.** `exec`, `import`, `db` | loopback and unix sockets only | changing a local dev database |

The [safety table](packages/mysql-axi#safe-to-auto-approve) shows what the same agent statements do through the plain `mysql` client, a read-only MCP server and `mysql-axi`. The [token usage](packages/mysql-axi#token-usage) and [accuracy](packages/mysql-axi#accuracy) tables compare the same agent tasks run with the plain `mysql` client, with `mysql-axi` and with a read-only MySQL MCP server.

These are two separate packages, so installing or allowing only `mysql-axi` means an agent has no write command available. See [packages/mysql-axi](packages/mysql-axi#how-writes-are-blocked) for how writes are blocked and what the guard does **not** cover.

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
TOKENS_MODEL=opus pnpm run test:tokens   # local only: the model with the mysql client vs with mysql-axi; spends model tokens
pnpm run tokens:readme      # publish test/tokens/results/*.json as the README tables
```

Both packages are released together: `npm version patch && git push --follow-tags` bumps the root and both packages, and the Release workflow stages both on npm for 2FA approval.

MIT licensed.
