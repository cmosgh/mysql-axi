import { accessSync, constants, createWriteStream, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { bool, expectPositionals, parseArgs } from "../../../core/src/args.js";
import { CONNECTION_FLAGS, CONNECTION_FLAGS_HELP, targetFrom } from "../../../core/src/commands/common.js";
import { openSession, withSession } from "../../../core/src/connection.js";
import { AxiError, fromDriverError, usageError } from "../../../core/src/errors.js";
import { block, helpBlock, out, snippet, type Obj } from "../../../core/src/render.js";
import { mainVerb, statements, tokenize, type Token } from "../../../core/src/sql.js";
import { describeTarget, type Target } from "../../../core/src/target.js";
import { classify } from "../classify.js";
import { SYSTEM_SCHEMAS } from "./db.js";
import { scriptStatements } from "../script.js";

export const IMPORT_HELP = `usage: mysql-rw-axi import <file.sql|-> [flags]
WRITES. Runs a SQL script (e.g. a mysqldump file) statement by statement on a loopback database.
Scripts with irreversible statements (DROP, TRUNCATE, ...) preview until --confirm. Statements run with autocommit: a failure stops the import, earlier statements stay applied.
Dumps made with --databases contain USE/CREATE DATABASE; with -d they are refused unless --skip-use (load into -d) or --follow-use (write where the script says). System schemas are always refused.
flags:
  ${CONNECTION_FLAGS_HELP}, --confirm, --skip-use, --follow-use
examples:
  mysql-rw-axi import shop.sql -d shop_restore
  mysql-rw-axi import shop.sql -d shop_restore --confirm
  mysql-rw-axi import multi-db.sql -d shop_restore --skip-use --confirm
  gunzip -c dump.sql.gz | mysql-rw-axi import - -d shop_test --confirm
`;

const PREVIEW_ITEMS = 5;

/** Dumps put `-- Table structure for ...` banners in front of each statement. */
function withoutLeadingComments(statement: string): string {
  let rest = statement;
  for (;;) {
    const next = rest.replace(/^\s*(--[^\n]*|#[^\n]*|\/\*(?![!+])[\s\S]*?\*\/)/, "");
    if (next === rest) return rest.trim();
    rest = next;
  }
}

/** Comment-only chunks (a dump's trailer) would fail with "Query was empty". */
function hasCode(statement: string): boolean {
  try {
    const { tokens, executableComment } = tokenize(statement);
    return tokens.length > 0 || executableComment;
  } catch {
    return true;
  }
}

interface Switch {
  at: number;
  kind: "USE" | "CREATE DATABASE";
  name: string;
}

const unquote = (t: Token | undefined): string | undefined =>
  t?.kind === "ident" ? t.text.slice(1, -1).replaceAll("``", "`") : t?.kind === "word" ? t.text : undefined;

/** `USE x` and `CREATE DATABASE x` move the statements after them out of the -d target. */
function databaseSwitch(tokens: readonly Token[], at: number): Switch | undefined {
  const [first, second] = tokens;
  if (first?.kind === "word" && first.text === "use") {
    const name = unquote(second);
    return name === undefined ? undefined : { at, kind: "USE", name };
  }
  if (first?.kind === "word" && first.text === "create" && second?.kind === "word" && (second.text === "database" || second.text === "schema")) {
    let i = 2;
    while (tokens[i]?.kind === "word" && ["if", "not", "exists"].includes(tokens[i]!.text)) i++;
    const name = unquote(tokens[i]);
    return name === undefined ? undefined : { at, kind: "CREATE DATABASE", name };
  }
  return undefined;
}

export async function importCommand(args: string[]): Promise<string> {
  const command = "mysql-rw-axi import";
  const parsed = parseArgs(
    args,
    [...CONNECTION_FLAGS, { name: "--confirm", boolean: true }, { name: "--skip-use", boolean: true }, { name: "--follow-use", boolean: true }],
    command,
  );
  const skipUse = bool(parsed, "--skip-use");
  const followUse = bool(parsed, "--follow-use");
  if (skipUse && followUse) throw usageError("pass --skip-use or --follow-use, not both");
  const [file] = expectPositionals(parsed, 1, `${command} <file.sql|->`);
  const path = file === "-" ? await spoolStdin() : file!;
  if (file !== "-") {
    try {
      accessSync(path, constants.R_OK);
    } catch {
      throw usageError(`cannot read '${file}'`);
    }
  }

  // Pass 1 reads only what the preview needs, so dumps larger than memory work.
  const scan = scanScript(path);
  if (scan.statements === 0) throw usageError("the script has no statements");
  const { switches } = scan;
  const system = switches.find((s) => SYSTEM_SCHEMAS.has(s.name.toLowerCase()));
  if (system) {
    throw usageError(`the script switches to the system schema '${system.name}' (${system.kind} at statement ${system.at}) - import refuses system schemas`, [
      "Dump only application databases (mysqldump --databases <names>), not --all-databases",
    ]);
  }
  const target = await targetFrom(parsed);
  const usesTarget = skipUse ? scan.statements > switches.length : scan.writesBeforeSwitch;
  const writesTo = [...new Set([...(target.database && usesTarget ? [target.database] : []), ...(skipUse ? [] : switches.map((s) => s.name))])];
  const elsewhere = skipUse ? [] : switches.filter((s) => s.name !== target.database);
  if (target.database && elsewhere.length > 0 && !followUse) {
    const names = [...new Set(elsewhere.map((s) => s.name))].join(", ");
    throw usageError(`the script writes to '${names}' (${elsewhere[0]!.kind} at statement ${elsewhere[0]!.at}), not to '${target.database}' - a dump made with --databases`, [
      `Rerun with --skip-use to load everything into '${target.database}'`,
      `Rerun with --follow-use to write to ${names} as the script says`,
    ]);
  }
  const statementsToRun = scan.statements - (skipUse ? switches.length : 0);
  const definerHelp = (missing: string[]) =>
    missing.map((d) => `definer ${d} does not exist on this server - its views; triggers and routines fail with MySQL 1449 until you create it`);

  if (scan.irreversible.length > 0 && !bool(parsed, "--confirm")) {
    const missing = await missingDefiners(target, scan.definers);
    return out(
      block({
        preview: {
          file,
          statements: statementsToRun,
          irreversible: scan.irreversibleCount,
          target: describeTarget(target),
          writes_to: writesTo.join("; ") || "none",
        },
      }),
      block({ irreversible_statements: scan.irreversible }),
      helpBlock([
        ...(scan.irreversibleCount > PREVIEW_ITEMS ? [`${scan.irreversibleCount - PREVIEW_ITEMS} more not shown`] : []),
        ...definerHelp(missing),
        "Nothing was run. Rerun the same command with --confirm to import",
      ]),
    );
  }

  const started = Date.now();
  const missing = await missingDefiners(target, scan.definers);
  const session = await openSession(target, { readOnly: false });
  let affected = 0;
  let applied = 0;
  let warningCount = 0;
  const warnings: Obj[] = [];
  let at = 0;
  let current = "";
  try {
    for (const statement of scriptStatements(path)) {
      if (!hasCode(statement)) continue;
      at++;
      if (skipUse && switchOf(statement, at)) continue;
      current = statement;
      const result = await session.apply(statement);
      affected += result.affectedRows;
      applied++;
      if (result.warnings > 0) {
        warningCount += result.warnings;
        if (warnings.length < PREVIEW_ITEMS) {
          for (const w of await session.all<Obj>("SHOW WARNINGS")) {
            if (warnings.length < PREVIEW_ITEMS) warnings.push({ at, level: w["Level"], code: w["Code"], message: w["Message"] });
          }
        }
      }
    }
  } catch (error) {
    const cause = fromDriverError(error, describeTarget(target));
    throw new AxiError(`statement ${at} of ${scan.statements} failed - ${cause.message}`, cause.code, [
      `failed statement: ${snippet(withoutLeadingComments(current), 160)}`,
      `${applied} earlier statements were applied (autocommit)`,
    ]);
  } finally {
    await session.close().catch(() => {});
  }
  return out(
    block({
      import: {
        file,
        statements: applied,
        affected_rows: affected,
        ...(warningCount > 0 ? { warnings: warningCount } : {}),
        writes_to: writesTo.join("; ") || "none",
        elapsed_ms: Date.now() - started,
      },
    }),
    warnings.length > 0 && block({ first_warnings: warnings }),
    helpBlock([...definerHelp(missing), ...(warningCount > warnings.length ? [`${warningCount - warnings.length} more warnings not shown`] : [])]),
  );
}

interface Scan {
  statements: number;
  irreversible: Array<{ at: number; statement: string }>;
  irreversibleCount: number;
  switches: Switch[];
  /** A non-SET statement runs before the first USE/CREATE DATABASE. */
  writesBeforeSwitch: boolean;
  definers: string[];
}

const DEFINER = /DEFINER\s*=\s*(`(?:[^`]|``)+`|'[^']+'|[\w.$-]+)\s*@\s*(`(?:[^`]|``)+`|'[^']+'|[\w.%$-]+)/gi;
const account = (user: string, host: string): string => `'${user}'@'${host}'`;
const unquoteName = (raw: string): string => raw.replace(/^[`']|[`']$/g, "").replaceAll("``", "`");

function lex(statement: string): Token[] | undefined {
  try {
    return statements(tokenize(statement).tokens)[0] ?? [];
  } catch {
    // Unlexable statements are still sent; the server is the judge.
    return undefined;
  }
}

function switchOf(statement: string, at: number): Switch | undefined {
  const tokens = lex(statement);
  return tokens ? databaseSwitch(tokens, at) : undefined;
}

function scanScript(path: string): Scan {
  const scan: Scan = { statements: 0, irreversible: [], irreversibleCount: 0, switches: [], writesBeforeSwitch: false, definers: [] };
  const definers = new Set<string>();
  for (const statement of scriptStatements(path)) {
    if (!hasCode(statement)) continue;
    const at = ++scan.statements;
    const tokens = lex(statement);
    const change = tokens && databaseSwitch(tokens, at);
    if (change) scan.switches.push(change);
    else if (scan.switches.length === 0 && (!tokens || mainVerb(tokens) !== "set")) scan.writesBeforeSwitch = true;
    const reason = tokens && classify(tokens).irreversible;
    if (reason) {
      scan.irreversibleCount++;
      if (scan.irreversible.length < PREVIEW_ITEMS) scan.irreversible.push({ at, statement: snippet(withoutLeadingComments(statement), 80) });
    }
    for (const match of statement.matchAll(DEFINER)) definers.add(account(unquoteName(match[1]!), unquoteName(match[2]!)));
  }
  scan.definers = [...definers];
  return scan;
}

/** Definers missing on the server; [] when the account cannot read mysql.user. */
async function missingDefiners(target: Target, definers: string[]): Promise<string[]> {
  if (definers.length === 0) return [];
  try {
    const rows = await withSession(target, { readOnly: true }, (s) => s.all<{ u: string; h: string }>("SELECT User AS u, Host AS h FROM mysql.user"));
    const existing = new Set(rows.map((r) => account(r.u, r.h)));
    return definers.filter((d) => !existing.has(d));
  } catch {
    return [];
  }
}

/** stdin is read twice (preview scan, then the run), so it goes to a temp file first. */
async function spoolStdin(): Promise<string> {
  if (process.stdin.isTTY) throw usageError("no script on stdin");
  const path = join(mkdtempSync(join(tmpdir(), "mysql-rw-axi-")), "stdin.sql");
  await pipeline(process.stdin, createWriteStream(path));
  return path;
}
