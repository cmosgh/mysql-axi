# mysql-axi - contributor notes for agents

Monorepo for two AXI MySQL CLIs: `mysql-axi` (read-only) and `mysql-rw-axi` (writes, loopback only). Read the AXI principles (https://axi.md) before changing output.

- **The split is the safety model.** Write code (exec, import, db, loopback, classify, script) lives only in `packages/mysql-rw-axi`. `scripts/build.ts` fails if write-tool code ends up in the `mysql-axi` bundle. Never add a write path to `packages/core`.
- **Read path, always:** `assertReadOnly()` in `packages/core/src/sql.ts` runs before connecting. Then `withSession({ readOnly: true })` in `connection.ts` sets `transaction_read_only` and runs inside `START TRANSACTION READ ONLY`, with `multipleStatements` off. Read commands in `mysql-rw-axi` use the same path. Changes to the guard need cases in `test/guard.test.ts` and, for server behaviour, `test/integration/`.
- **Output is the product.** Every stdout byte costs tokens. Default list schemas stay at 3-5 fields; extras go behind `--fields`. Keep numbers as numbers. Avoid commas, colons and double quotes in literal TOON strings.
- **Handlers return strings** built with `block()`, `helpBlock()`, `out()` and `fenced()` from `packages/core/src/render.ts`. Raw text (plans) goes between `---` fences.
- **Every flag is declared.** `parseArgs()` rejects unknown flags with the valid set inline. Validate input before connecting; usage errors and guard refusals exit 2.
- **Mutations are idempotent and irreversible ones need `--confirm`,** previewing otherwise.
- **The home view runs at every session start.** It never connects or reads the keychain.
- **Secrets:** passwords come from stdin or `<PREFIX>_URL` only, are stored in the OS keychain, and are never echoed (URL parse errors included).
- `packages/core/src/version.ts` and each package's `src/version.ts` are leaf modules (node builtins only) for the `--version` fast path.
- **Tests:**
  - `test/guard.test.ts`, `test/unit.test.ts` cover pure logic.
  - `test/commands.test.ts` runs the whole CLI via `main()` with `mysql2` mocked by `test/fake-mysql.ts`.
  - `test/integration/` (`pnpm run test:integration`, needs Docker) starts its own throwaway MySQL container on a random loopback port: `server-facts` (what MySQL itself blocks), `ro` and `rw`. It never touches a local server.
  - `test/tokens/` (`pnpm run test:tokens`, local only: Docker, a logged-in `claude` CLI and a `mysql` client) runs the same tasks with the plain `mysql` client and with `mysql-axi` in its own container and writes `test/tokens/results/<model>.json` (`TOKENS_MODEL`, default sonnet; every run with its commands, output sizes and answer). `pnpm run tokens:readme` puts the tables into `packages/mysql-axi/README.md`; the suite never edits the README. `TOKENS_ONLY=<task id>` runs a smoke subset without touching the README.
  - Fixtures are synthetic: never use real database, table or people names.
- `pnpm run check` must pass. The `SKILL.md` files are generated with `pnpm run build:skill`. Package `dependencies` must match the root `devDependencies` (the build checks this).
