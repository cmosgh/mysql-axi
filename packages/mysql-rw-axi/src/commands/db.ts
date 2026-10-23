import { bool, expectPositionals, flag, parseArgs } from "../../../core/src/args.js";
import { followUp, PROFILE_FLAG, rerunHint, shellQuote, targetFrom } from "../../../core/src/commands/common.js";
import { withSession } from "../../../core/src/connection.js";
import { usageError } from "../../../core/src/errors.js";
import { block, helpBlock, humanBytes, out } from "../../../core/src/render.js";
import { quoteIdent } from "../../../core/src/sql.js";
import { describeTarget } from "../../../core/src/target.js";

export const DB_HELP = `usage: mysql-rw-axi db <create|drop> <name> [flags]
WRITES. Create or drop a database on a loopback server. Both are idempotent; drop previews until --confirm.
flags{create}:
  --charset <name>, --collation <name>, -p/--profile <name>
flags{drop}:
  --confirm, -p/--profile <name>
examples:
  mysql-rw-axi db create shop_test --charset utf8mb4
  mysql-rw-axi db drop shop_test --confirm
`;

export const SYSTEM_SCHEMAS = new Set(["mysql", "sys", "information_schema", "performance_schema"]);

function databaseName(raw: string | undefined): string {
  if (!raw || !/^[A-Za-z0-9_$-]{1,64}$/.test(raw)) throw usageError(`invalid database name '${raw ?? ""}' - use letters, digits, '_', '$' and '-'`);
  return raw;
}

export async function dbCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "create") return dbCreate(rest);
  if (sub === "drop") return dbDrop(rest);
  throw usageError(sub ? `unknown db subcommand '${sub}'` : "missing db subcommand", ["subcommands: create, drop"]);
}

async function dbCreate(args: string[]): Promise<string> {
  const command = "mysql-rw-axi db create";
  const parsed = parseArgs(args, [PROFILE_FLAG, { name: "--charset" }, { name: "--collation" }], command);
  const [raw] = expectPositionals(parsed, 1, `${command} <name>`);
  const name = databaseName(raw);
  const charset = flag(parsed, "--charset");
  const collation = flag(parsed, "--collation");
  for (const [label, value] of [["--charset", charset], ["--collation", collation]] as const) {
    if (value !== undefined && !/^[A-Za-z0-9_]+$/.test(value)) throw usageError(`invalid ${label} '${value}'`);
  }
  // The profile's default database may be the one being created: connect without it.
  const target = { ...(await targetFrom(parsed)), database: undefined };
  const created = await withSession(target, { readOnly: false }, async (s) => {
    if ((await s.all("SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [name])).length > 0) return false;
    await s.execute(`CREATE DATABASE ${quoteIdent(name)}${charset ? ` CHARACTER SET ${charset}` : ""}${collation ? ` COLLATE ${collation}` : ""}`);
    return true;
  });
  return out(
    block({ db: { name, result: created ? "created" : "already exists (no-op)" } }),
    helpBlock([`Run \`${followUp(parsed, `import <file.sql> -d ${shellQuote(name)}`)}\` to load a dump`]),
  );
}

async function dbDrop(args: string[]): Promise<string> {
  const command = "mysql-rw-axi db drop";
  const parsed = parseArgs(args, [PROFILE_FLAG, { name: "--confirm", boolean: true }], command);
  const [raw] = expectPositionals(parsed, 1, `${command} <name>`);
  const name = databaseName(raw);
  if (SYSTEM_SCHEMAS.has(name.toLowerCase())) throw usageError(`refusing to drop the system schema '${name}'`);
  const confirm = bool(parsed, "--confirm");
  const target = { ...(await targetFrom(parsed)), database: undefined };
  const result = await withSession(target, { readOnly: false }, async (s) => {
    const [info] = await s.all<{ tables: unknown; bytes: unknown }>(
      `SELECT COUNT(t.TABLE_NAME) AS tables, COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS bytes
       FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
       WHERE s.SCHEMA_NAME = ? GROUP BY s.SCHEMA_NAME`,
      [name],
    );
    if (!info) return { exists: false as const };
    if (confirm) await s.execute(`DROP DATABASE ${quoteIdent(name)}`);
    return { exists: true as const, tables: Number(info.tables), size: humanBytes(Number(info.bytes)) };
  });
  if (!result.exists) return block({ db: { name, result: "does not exist (no-op)" } });
  if (!confirm) {
    return out(
      block({ preview: { statement: `DROP DATABASE ${name}`, risk: `irreversible - deletes ${result.tables} tables (${result.size})`, target: describeTarget(target) } }),
      helpBlock([`Nothing was run. ${rerunHint(parsed, { "--confirm": true }, "to drop it")}`]),
    );
  }
  return block({ db: { name, result: `dropped (${result.tables} tables; ${result.size})` } });
}
