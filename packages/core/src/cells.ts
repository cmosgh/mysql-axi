import type { Column, RowsOutcome } from "./connection.js";
import { block, type Obj } from "./render.js";

export const CELL_CHARS = 200;
const HEX_BYTES = 32;

// MYSQL_TYPE_DECIMAL, NEWDECIMAL and LONGLONG arrive as strings (precision-safe).
const NUMERIC_STRING_TYPES = new Set([0, 246, 8]);

/** One value as TOON-friendly JSON: numbers stay numbers, blobs and long text shrink. */
export function cell(value: unknown, column: Column, full: boolean): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) {
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
  return outcome.rows.map((row) => Object.fromEntries(names.map((name, i) => [name, cell(row[i], outcome.columns[i]!, full)])));
}

/** `rows[N]{...}:` table plus an honest count line. */
export function rowsBlock(outcome: RowsOutcome, full: boolean, limit: number): string {
  const rows = records(outcome, full);
  const summary: Obj = {
    rows: outcome.truncated ? `${rows.length} shown - more rows exist (limit ${limit})` : rows.length,
    elapsed_ms: outcome.elapsedMs,
  };
  if (rows.length === 0) summary["columns"] = uniqueNames(outcome.columns).join("; ");
  return [block(summary), rows.length > 0 ? block({ result: rows }) : ""].filter(Boolean).join("\n");
}
