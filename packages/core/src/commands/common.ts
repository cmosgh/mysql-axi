import { readFileSync } from "node:fs";
import { flag, intFlag, type FlagSpec, type ParsedArgs } from "../args.js";
import { usageError } from "../errors.js";
import { redactSecrets } from "../secrets.js";
import { resolveTarget, type Target } from "../target.js";
import { tool } from "../tool.js";

/** Accepted by every command that connects. */
export const PROFILE_FLAG: FlagSpec = { name: "--profile", alias: "-p" };
export const CONNECTION_FLAGS: readonly FlagSpec[] = [PROFILE_FLAG, { name: "--database", alias: "-d" }];
export const TIMEOUT_FLAG: FlagSpec = { name: "--timeout" };
export const CONNECTION_FLAGS_HELP = "-p/--profile <name>, -d/--database <name>";

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

// Words that need no quoting in sh or zsh (a leading `=` expands in zsh).
const SHELL_WORD = /^[\w@%+:,./-][\w@%+=:,./-]*$/;

/** POSIX single-quote quoting, so a hint pastes back into a shell unchanged. */
export function shellQuote(word: string): string {
  return SHELL_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** `mysql-axi describe <table> -p staging -d shop`: a follow-up command on the connection this one used. */
export function followUp(parsed: ParsedArgs, rest: string, options: { database?: boolean } = {}): string {
  const profile = flag(parsed, "--profile");
  const database = options.database === false ? undefined : flag(parsed, "--database");
  return [tool().name, rest, ...(profile ? ["-p", shellQuote(profile)] : []), ...(database ? ["-d", shellQuote(database)] : [])].join(" ");
}

/**
 * "Run `<this command, flags changed>` <why>": `set` replaces or adds flags (true for a boolean) and removes them (null).
 * An argument holding a password is never repeated: the hint then names the change only.
 */
export function rerunHint(parsed: ParsedArgs, set: Record<string, string | true | null>, why: string): string {
  const tokens = (name: string): string[] => {
    const value = set[name];
    return value === null || value === undefined ? [] : value === true ? [name] : [name, value];
  };
  const args: string[] = [];
  const replaced = new Set<string>();
  let at = 0;
  for (const span of parsed.spans) {
    if (!Object.hasOwn(set, span.name)) continue;
    args.push(...parsed.args.slice(at, span.start), ...(replaced.has(span.name) ? [] : tokens(span.name)));
    replaced.add(span.name);
    at = span.end;
  }
  args.push(...parsed.args.slice(at));
  // New flags go before a `--` terminator, after which they would read as positionals.
  const end = args.indexOf("--");
  args.splice(end === -1 ? args.length : end, 0, ...Object.keys(set).filter((name) => !replaced.has(name)).flatMap(tokens));
  if (args.some((arg) => redactSecrets(arg) !== arg)) {
    const change = Object.entries(set).map(([name, value]) => (value === null ? `without ${name}` : value === true ? `with ${name}` : `with ${name} ${value}`));
    return `Rerun the same command ${change.join(" ")} ${why}`;
  }
  return `Run \`${[parsed.command, ...args.map(shellQuote)].join(" ")}\` ${why}`;
}

export function requireDatabase(target: Target, parsed: ParsedArgs, usage: string): string {
  if (target.database) return target.database;
  throw usageError("no database selected", [
    `Pass -d <database> (\`${followUp(parsed, "databases", { database: false })}\` lists them) or set --database on the profile`,
    `usage: ${usage}`,
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
export function tableRef(raw: string, target: Target, parsed: ParsedArgs, usage: string): { database: string; table: string } {
  const parts = raw.split(".").map((p) => p.replace(/^`|`$/g, ""));
  if (parts.length === 2 && parts[0] && parts[1]) return { database: parts[0], table: parts[1] };
  if (parts.length === 1 && parts[0]) return { database: requireDatabase(target, parsed, usage), table: parts[0] };
  throw usageError(`invalid table '${raw}' - expected <table> or <database>.<table>`);
}
