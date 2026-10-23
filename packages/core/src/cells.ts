import type { ParsedArgs } from "./args.js";
import { rerunHint } from "./commands/common.js";
import type { Column, RowsOutcome } from "./connection.js";
import { block, type Obj } from "./render.js";
import { isSecretColumn, REDACTED } from "./secrets.js";

const MYSQL_TYPE_BIT = 16;

export const CELL_CHARS = 200;
const HEX_BYTES = 32;

// MYSQL_TYPE_DECIMAL, NEWDECIMAL and LONGLONG arrive as strings (precision-safe).
const NUMERIC_STRING_TYPES = new Set([0, 246, 8]);

/** One value as TOON-friendly JSON: numbers stay numbers, blobs and long text shrink. */
export function cell(value: unknown, column: Column, full: boolean): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) {
    if (column.type === MYSQL_TYPE_BIT && value.length <= 6) return value.length === 0 ? 0 : value.readUIntBE(0, value.length);
    return value.length <= HEX_BYTES ? `0x${value.toString("hex")}` : `<blob ${value.length} bytes>`;
  }
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (typeof value === "number" || typeof value === "boolean") return value;
  let text: string;
  if (typeof value === "string") {
    if (NUMERIC_STRING_TYPES.has(column.type) && /^-?\d+(\.\d+)?$/.test(value)) {
      // Only when the number survives the round trip: "12.50" -> 12.5, a 19-digit BIGINT stays a string.
      const canonical = value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
      if (String(Number(value)) === canonical) return Number(value);
    }
    text = value;
  } else {
    // JSON columns arrive parsed.
    text = JSON.stringify(value);
  }
  if (full || text.length <= CELL_CHARS) return text;
  return `${text.slice(0, CELL_CHARS)}... (+${text.length - CELL_CHARS} chars; --full)`;
}

/** Column names made unique so `SELECT a.id, b.id` keeps both. */
export function uniqueNames(columns: readonly Column[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((c) => {
    const base = c.name || "?column?";
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

export function records(outcome: RowsOutcome, full: boolean): Obj[] {
  const names = uniqueNames(outcome.columns);
  const secret = outcome.columns.map((c) => isSecretColumn(c.name));
  return outcome.rows.map((row) =>
    Object.fromEntries(names.map((name, i) => [name, secret[i] && row[i] !== null && row[i] !== "" ? REDACTED : cell(row[i], outcome.columns[i]!, full)])),
  );
}

const SLOW_MS = 1000;

function shownOf(outcome: RowsOutcome, shown: number, limit: number): string {
  const { total } = outcome;
  if (!total) return `${shown} shown - more rows exist (limit ${limit})`;
  return total.exact ? `${shown} of ${total.rows} shown` : `${shown} of more than ${total.rows - 1} shown`;
}

/** What to do about a cut result; exact totals get this command again with the --limit that shows every row. */
export function truncationHelp(outcome: RowsOutcome, maxRows: number, parsed: ParsedArgs): string[] {
  if (!outcome.truncated) return [];
  const { total } = outcome;
  if (total?.exact && total.rows <= maxRows) return [`${rerunHint(parsed, { "--limit": String(total.rows) }, "to see all rows")}, or narrow with WHERE`];
  if (total) return [`More than ${maxRows} rows - aggregate (COUNT; GROUP BY; GROUP_CONCAT) or narrow with WHERE`];
  return [`Add WHERE or LIMIT to the query, or raise --limit (max ${maxRows})`];
}

/** `result[N]{...}:` table; a summary line only when rows were cut, none came back or it was slow. */
export function rowsBlock(outcome: RowsOutcome, full: boolean, limit: number): string {
  const rows = records(outcome, full);
  const summary: Obj = {};
  if (outcome.truncated) summary["rows"] = shownOf(outcome, rows.length, limit);
  if (rows.length === 0) Object.assign(summary, { rows: 0, columns: uniqueNames(outcome.columns).join("; ") });
  if (outcome.elapsedMs >= SLOW_MS) summary["elapsed_ms"] = outcome.elapsedMs;
  return [Object.keys(summary).length > 0 ? block(summary) : "", rows.length > 0 ? block({ result: rows }) : ""].filter(Boolean).join("\n");
}
