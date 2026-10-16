import { readFileSync } from "node:fs";
import { bool, expectPositionals, parseArgs } from "../../../core/src/args.js";
import { CONNECTION_FLAGS, CONNECTION_FLAGS_HELP, targetFrom } from "../../../core/src/commands/common.js";
import { openSession } from "../../../core/src/connection.js";
import { AxiError, fromDriverError, usageError } from "../../../core/src/errors.js";
import { block, helpBlock, out, snippet } from "../../../core/src/render.js";
import { statements, tokenize } from "../../../core/src/sql.js";
import { describeTarget } from "../../../core/src/target.js";
import { classify } from "../classify.js";
import { splitScript } from "../script.js";

export const IMPORT_HELP = `usage: mysql-rw-axi import <file.sql|-> [flags]
WRITES. Runs a SQL script (e.g. a mysqldump file) statement by statement on a loopback database.
Scripts with irreversible statements (DROP, TRUNCATE, ...) preview until --confirm. Statements run with autocommit: a failure stops the import, earlier statements stay applied.
flags:
  ${CONNECTION_FLAGS_HELP}, --confirm
examples:
  mysql-rw-axi import dump.sql -d shop_test
  mysql-rw-axi import dump.sql -d shop_test --confirm
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

export async function importCommand(args: string[]): Promise<string> {
  const command = "mysql-rw-axi import";
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, { name: "--confirm", boolean: true }], command);
  const [file] = expectPositionals(parsed, 1, `${command} <file.sql|->`);
  let text: string;
  if (file === "-") {
    if (process.stdin.isTTY) throw usageError("no script on stdin");
    text = readFileSync(0, "utf-8");
  } else {
    try {
      text = readFileSync(file!, "utf-8");
    } catch {
      throw usageError(`cannot read '${file}'`);
    }
  }
  const script = splitScript(text).filter(hasCode);
  if (script.length === 0) throw usageError("the script has no statements");

  const irreversible: Array<{ at: number; statement: string }> = [];
  for (const [index, statement] of script.entries()) {
    try {
      const reason = classify(statements(tokenize(statement).tokens)[0] ?? []).irreversible;
      if (reason) irreversible.push({ at: index + 1, statement: snippet(withoutLeadingComments(statement), 80) });
    } catch {
      // Unlexable statements are still sent; the server is the judge.
    }
  }
  const target = await targetFrom(parsed);
  if (irreversible.length > 0 && !bool(parsed, "--confirm")) {
    return out(
      block({
        preview: {
          file,
          statements: script.length,
          irreversible: irreversible.length,
          target: describeTarget(target),
        },
      }),
      block({ irreversible_statements: irreversible.slice(0, PREVIEW_ITEMS) }),
      helpBlock([
        ...(irreversible.length > PREVIEW_ITEMS ? [`${irreversible.length - PREVIEW_ITEMS} more not shown`] : []),
        "Nothing was run. Rerun the same command with --confirm to import",
      ]),
    );
  }

  const started = Date.now();
  const session = await openSession(target, { readOnly: false });
  let affected = 0;
  let index = 0;
  try {
    for (; index < script.length; index++) affected += await session.execute(script[index]!);
  } catch (error) {
    const cause = fromDriverError(error, describeTarget(target));
    throw new AxiError(`statement ${index + 1} of ${script.length} failed - ${cause.message}`, cause.code, [
      `failed statement: ${snippet(withoutLeadingComments(script[index]!), 160)}`,
      `${index} earlier statements were applied (autocommit)`,
    ]);
  } finally {
    await session.close().catch(() => {});
  }
  return block({
    import: { file, statements: script.length, affected_rows: affected, database: target.database ?? "none", elapsed_ms: Date.now() - started },
  });
}
