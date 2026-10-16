import { readFileSync } from "node:fs";
import { flag, intFlag, type FlagSpec, type ParsedArgs } from "../args.js";
import { usageError } from "../errors.js";
import { resolveTarget, type Target } from "../target.js";
import { tool } from "../tool.js";

/** Accepted by every command that connects. */
export const CONNECTION_FLAGS: readonly FlagSpec[] = [{ name: "--profile" }, { name: "--database", alias: "-d" }];
export const TIMEOUT_FLAG: FlagSpec = { name: "--timeout" };
export const CONNECTION_FLAGS_HELP = "--profile <name>, -d/--database <name>";

export const DEFAULT_TIMEOUT_S = 30;
export const MAX_ROWS = 1000;

export function timeoutMs(parsed: ParsedArgs): number {
  return intFlag(parsed, "--timeout", DEFAULT_TIMEOUT_S, { min: 1, max: 3600 }) * 1000;
}

export async function targetFrom(parsed: ParsedArgs): Promise<Target> {
  const profile = flag(parsed, "--profile");
  const database = flag(parsed, "--database");
  return resolveTarget({ ...(profile ? { profile } : {}), ...(database ? { database } : {}) });
}

export function requireDatabase(target: Target, command: string): string {
  if (target.database) return target.database;
  throw usageError("no database selected", [
    `Pass -d <database> (\`${tool().name} databases\` lists them) or set --database on the profile`,
    `usage: ${command}`,
  ]);
}

/** SQL from one positional, `-` (stdin) or --file. */
export function sqlInput(parsed: ParsedArgs, usage: string): string {
  const file = flag(parsed, "--file");
  if (file !== undefined && parsed.positionals.length > 0) throw usageError("pass the SQL as an argument or --file, not both", [`usage: ${usage}`]);
  if (parsed.positionals.length > 1) {
    throw usageError(`unexpected argument '${parsed.positionals[1]}' - quote the whole statement as one argument`, [`usage: ${usage}`]);
  }
  let sql: string;
  if (file === "-" || (file === undefined && parsed.positionals[0] === "-")) {
    if (process.stdin.isTTY) throw usageError("no SQL on stdin", [`usage: ${usage}`]);
    sql = readFileSync(0, "utf-8");
  } else if (file !== undefined) {
    try {
      sql = readFileSync(file, "utf-8");
    } catch {
      throw usageError(`cannot read --file '${file}'`);
    }
  } else if (parsed.positionals[0] !== undefined) {
    sql = parsed.positionals[0];
  } else {
    throw usageError("missing SQL", [`usage: ${usage}`]);
  }
  if (sql.trim() === "") throw usageError("the SQL is empty", [`usage: ${usage}`]);
  return sql;
}

/** `db.table` or `table` (+ the session database). Backticks are optional. */
export function tableRef(raw: string, target: Target, command: string): { database: string; table: string } {
  const parts = raw.split(".").map((p) => p.replace(/^`|`$/g, ""));
  if (parts.length === 2 && parts[0] && parts[1]) return { database: parts[0], table: parts[1] };
  if (parts.length === 1 && parts[0]) return { database: requireDatabase(target, command), table: parts[0] };
  throw usageError(`invalid table '${raw}' - expected <table> or <database>.<table>`);
}
