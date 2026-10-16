import { bool, intFlag, parseArgs } from "../../../core/src/args.js";
import { rowsBlock } from "../../../core/src/cells.js";
import { CONNECTION_FLAGS, CONNECTION_FLAGS_HELP, MAX_ROWS, sqlInput, targetFrom } from "../../../core/src/commands/common.js";
import { withSession } from "../../../core/src/connection.js";
import { block, helpBlock, out, snippet, type Obj } from "../../../core/src/render.js";
import { describeTarget } from "../../../core/src/target.js";
import { classify, singleStatement } from "../classify.js";

export const EXEC_HELP = `usage: mysql-rw-axi exec "<sql>" [flags]
WRITES. Runs ONE statement of any kind on a loopback database, with no time limit.
Irreversible statements preview until --confirm - DROP, TRUNCATE, ALTER ... DROP, and DELETE/UPDATE without WHERE.
flags:
  ${CONNECTION_FLAGS_HELP}, --confirm, --file <path> (or - for stdin), --limit <n> (rows if it returns any; default 50), --full
examples:
  mysql-rw-axi exec "UPDATE orders SET status = 'paid' WHERE id = 42"
  mysql-rw-axi exec "ALTER TABLE orders ADD COLUMN note TEXT"
  mysql-rw-axi exec "TRUNCATE TABLE sessions" --confirm
`;

export async function execCommand(args: string[]): Promise<string> {
  const command = "mysql-rw-axi exec";
  const parsed = parseArgs(
    args,
    [...CONNECTION_FLAGS, { name: "--confirm", boolean: true }, { name: "--file" }, { name: "--limit" }, { name: "--full", boolean: true }],
    command,
  );
  const sql = sqlInput(parsed, `${command} "<sql>"`);
  const limit = intFlag(parsed, "--limit", 50, { min: 1, max: MAX_ROWS });
  const { verb, irreversible } = classify(singleStatement(sql));
  const target = await targetFrom(parsed);

  if (irreversible && !bool(parsed, "--confirm")) {
    return out(
      block({ preview: { statement: snippet(sql), risk: `irreversible - ${irreversible}`, target: describeTarget(target) } }),
      helpBlock(["Nothing was run. Rerun the same command with --confirm to execute"]),
    );
  }

  const { outcome, warnings } = await withSession(target, { readOnly: false }, async (s) => {
    const outcome = await s.run(sql, limit);
    const warnings = outcome.kind === "ok" && outcome.warnings > 0 ? await s.all<Obj>("SHOW WARNINGS") : [];
    return { outcome, warnings };
  });
  if (outcome.kind === "rows") return rowsBlock(outcome, bool(parsed, "--full"), limit);

  const result: Obj = { statement: snippet(sql), verb: verb.toUpperCase(), affected_rows: outcome.affectedRows };
  if (outcome.insertId > 0) result["insert_id"] = outcome.insertId;
  if (outcome.info) result["info"] = outcome.info;
  result["elapsed_ms"] = outcome.elapsedMs;
  return out(
    block({ exec: result }),
    warnings.length > 0 && block({ warnings: warnings.map((w) => ({ level: w["Level"], code: w["Code"], message: w["Message"] })) }),
  );
}
