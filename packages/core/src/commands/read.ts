import { bool, enumFlag, expectPositionals, flag, intFlag, parseArgs, parseFields, type ParsedArgs } from "../args.js";
import { records, rowsBlock, truncationHelp } from "../cells.js";
import { withSession, type RowsOutcome, type Session } from "../connection.js";
import { axiError, usageError } from "../errors.js";
import { block, fenced, helpBlock, humanBytes, out, type Obj } from "../render.js";
import { redactSecrets } from "../secrets.js";
import { assertReadOnly, mainVerb, quoteIdent, statements, tokenize, type Token } from "../sql.js";
import type { Target } from "../target.js";
import { tool } from "../tool.js";
import { CONNECTION_FLAGS, CONNECTION_FLAGS_HELP, MAX_ROWS, requireDatabase, sqlInput, tableRef, targetFrom, TIMEOUT_FLAG, timeoutMs } from "./common.js";

const SYSTEM_SCHEMAS = new Set(["mysql", "sys", "information_schema", "performance_schema"]);

const n = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

/** Every read command goes through here: read-only session, server-side time cap. */
function read<T>(target: Target, parsed: ParsedArgs, fn: (s: Session) => Promise<T>, freshStats = false): Promise<T> {
  return withSession(target, { readOnly: true, timeoutMs: timeoutMs(parsed), freshStats }, fn);
}

function closeNames(input: string, names: readonly string[]): string[] {
  const needle = input.toLowerCase();
  return names.filter((name) => name.toLowerCase().includes(needle) || needle.includes(name.toLowerCase())).slice(0, 5);
}

// --- databases ---

export const databasesHelp = (): string => `usage: ${tool().name} databases [--all] [--profile <name>]
Databases with table counts and sizes (sizes are InnoDB estimates).
flags:
  --all (include mysql, sys, information_schema, performance_schema), --limit <n> (default 100), --profile <name>, --timeout <seconds> (default 30)
examples:
  ${tool().name} databases
  ${tool().name} databases --all
`;

export async function databasesCommand(args: string[]): Promise<string> {
  const command = `${tool().name} databases`;
  const parsed = parseArgs(args, [{ name: "--profile" }, { name: "--all", boolean: true }, { name: "--limit" }, TIMEOUT_FLAG], command);
  expectPositionals(parsed, 0, command);
  const limit = intFlag(parsed, "--limit", 100, { min: 1, max: 10_000 });
  const target = await targetFrom(parsed);
  const rows = await read(
    target,
    parsed,
    (s) =>
      s.all<{ name: string; tables: unknown; bytes: unknown }>(
        `SELECT s.SCHEMA_NAME AS name, COUNT(t.TABLE_NAME) AS tables, COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS bytes
         FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
         GROUP BY s.SCHEMA_NAME ORDER BY s.SCHEMA_NAME`,
      ),
    true,
  );
  const all = bool(parsed, "--all");
  const shown = rows.filter((r) => all || !SYSTEM_SCHEMAS.has(r.name));
  const summary: Obj = {};
  if (target.database) summary["default"] = target.database;
  if (shown.length < rows.length) summary["hidden"] = `${rows.length - shown.length} system schemas (--all)`;
  return out(
    block({ databases: shown.slice(0, limit).map((r) => ({ name: r.name, tables: n(r.tables), size: humanBytes(n(r.bytes)) })) }),
    Object.keys(summary).length > 0 && block(summary),
    helpBlock([
      ...(shown.length > limit ? [`Showing ${limit} of ${shown.length} - raise --limit`] : []),
      `Run \`${tool().name} tables -d <database>\` to list its tables`,
    ]),
  );
}

// --- tables ---

const TABLE_FIELDS = ["engine", "collation", "comment", "created", "updated", "data_size", "index_size", "auto_increment"] as const;

export const tablesHelp = (): string => `usage: ${tool().name} tables [-d <database>] [flags]
Tables and views of one database with estimated rows and size.
flags:
  ${CONNECTION_FLAGS_HELP}, --sort name|size|rows (default name), --limit <n> (default 200), --fields <${TABLE_FIELDS.join(",")}>, --timeout <seconds>
examples:
  ${tool().name} tables
  ${tool().name} tables -d shop --sort size --limit 10
  ${tool().name} tables --fields engine,updated
`;

export async function tablesCommand(args: string[]): Promise<string> {
  const command = `${tool().name} tables`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, TIMEOUT_FLAG, { name: "--sort" }, { name: "--limit" }, { name: "--fields" }], command);
  expectPositionals(parsed, 0, `${command} [-d <database>]`);
  const sort = enumFlag(parsed, "--sort", ["name", "size", "rows"] as const, "name");
  const limit = intFlag(parsed, "--limit", 200, { min: 1, max: 10_000 });
  const fields = parseFields(flag(parsed, "--fields"), TABLE_FIELDS);
  const target = await targetFrom(parsed);
  const database = requireDatabase(target, `${command} -d <database>`);
  const { rows, exists } = await read(
    target,
    parsed,
    async (s) => {
      const rows = await s.all<Obj>(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS rows_est, DATA_LENGTH AS data, INDEX_LENGTH AS idx,
                ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_COMMENT AS comment, CREATE_TIME AS created,
                UPDATE_TIME AS updated, AUTO_INCREMENT AS auto_increment
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
        [database],
      );
      const exists = rows.length > 0 || (await s.all("SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [database])).length > 0;
      return { rows, exists };
    },
    true,
  );
  if (!exists) throw axiError(`database '${database}' not found`, "NOT_FOUND", [`Run \`${tool().name} databases\``]);

  const size = (r: Obj): number => n(r["data"]) + n(r["idx"]);
  const sorted = [...rows].sort((a, b) =>
    sort === "size" ? size(b) - size(a) : sort === "rows" ? n(b["rows_est"]) - n(a["rows_est"]) : String(a["name"]).localeCompare(String(b["name"])),
  );
  const views = rows.filter((r) => r["type"] === "VIEW").length;
  const total = rows.reduce((sum, r) => sum + size(r), 0);
  const extras: Record<(typeof TABLE_FIELDS)[number], (r: Obj) => unknown> = {
    engine: (r) => r["engine"] ?? null,
    collation: (r) => r["collation"] ?? null,
    comment: (r) => r["comment"] || null,
    created: (r) => r["created"] ?? null,
    updated: (r) => r["updated"] ?? null,
    data_size: (r) => humanBytes(n(r["data"])),
    index_size: (r) => humanBytes(n(r["idx"])),
    auto_increment: (r) => (r["auto_increment"] === null || r["auto_increment"] === undefined ? null : n(r["auto_increment"])),
  };
  const list = sorted.slice(0, limit).map((r) => {
    const view = r["type"] === "VIEW";
    const row: Obj = { name: r["name"], kind: view ? "view" : "table", rows_est: view ? null : n(r["rows_est"]), size: view ? null : humanBytes(size(r)) };
    for (const field of fields) row[field] = extras[field as (typeof TABLE_FIELDS)[number]](r);
    return row;
  });
  const help = [`Run \`${tool().name} describe <table>\` for columns; indexes and foreign keys`];
  if (rows.length > limit) help.unshift(`Showing ${limit} of ${rows.length} - raise --limit`);
  return out(
    block({ database, total: `${rows.length - views} tables; ${views} views; ${humanBytes(total)}` }),
    list.length > 0 ? block({ tables: list }) : block({ tables: "none" }),
    helpBlock(help),
  );
}

// --- describe ---

export const describeHelp = (): string => `usage: ${tool().name} describe <table|database.table> [flags]
Columns, indexes, foreign keys (with ON DELETE/UPDATE), CHECK constraints, triggers and the tables that reference this one.
flags:
  ${CONNECTION_FLAGS_HELP}, --timeout <seconds>
examples:
  ${tool().name} describe orders
  ${tool().name} describe shop.orders
`;

export async function describeCommand(args: string[]): Promise<string> {
  const command = `${tool().name} describe`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, TIMEOUT_FLAG], command);
  const [raw] = expectPositionals(parsed, 1, `${command} <table>`);
  const target = await targetFrom(parsed);
  const { database, table } = tableRef(raw!, target, `${command} <table>`);
  const name = `${database}.${table}`;

  const result = await read(target, parsed, async (s) => {
    const [info] = await s.all<Obj>(
      `SELECT TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS rows_est, DATA_LENGTH + INDEX_LENGTH AS bytes, TABLE_COMMENT AS comment,
              TABLE_COLLATION AS collation
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, table],
    );
    if (!info) {
      const names = await s.all<{ name: string }>("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME", [database]);
      return { found: false as const, names: names.map((r) => r.name) };
    }
    const columns = await s.all<Obj>(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS k, COLUMN_DEFAULT AS def, EXTRA AS extra, COLUMN_COMMENT AS comment,
              COLLATION_NAME AS coll, GENERATION_EXPRESSION AS gen
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [database, table],
    );
    const indexes = await s.all<Obj>(
      `SELECT INDEX_NAME AS name, GROUP_CONCAT(COALESCE(COLUMN_NAME, CONCAT('(', EXPRESSION, ')')) ORDER BY SEQ_IN_INDEX SEPARATOR ';') AS cols, MAX(NON_UNIQUE) AS non_unique
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       GROUP BY INDEX_NAME ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME`,
      [database, table],
    );
    const outgoing = await s.all<Obj>(
      `SELECT k.CONSTRAINT_NAME AS name, GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ';') AS cols,
              k.REFERENCED_TABLE_SCHEMA AS ref_db, k.REFERENCED_TABLE_NAME AS ref_table,
              GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ';') AS ref_cols,
              MAX(r.DELETE_RULE) AS on_delete, MAX(r.UPDATE_RULE) AS on_update
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
       WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
       GROUP BY k.CONSTRAINT_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME ORDER BY k.CONSTRAINT_NAME`,
      [database, table],
    );
    const checks = await s.all<Obj>(
      `SELECT c.CONSTRAINT_NAME AS name, c.CHECK_CLAUSE AS clause
       FROM information_schema.TABLE_CONSTRAINTS t
       JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA = t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME = t.CONSTRAINT_NAME
       WHERE t.TABLE_SCHEMA = ? AND t.TABLE_NAME = ? AND t.CONSTRAINT_TYPE = 'CHECK' ORDER BY c.CONSTRAINT_NAME`,
      [database, table],
    );
    const triggers = await s.all<Obj>(
      `SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event
       FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME`,
      [database, table],
    );
    const incoming = await s.all<Obj>(
      `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS tbl, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR ';') AS cols
       FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?
       GROUP BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME ORDER BY TABLE_NAME`,
      [database, table],
    );
    return { found: true as const, info, columns, indexes, outgoing, incoming, checks, triggers };
  });

  if (!result.found) {
    const close = closeNames(table, result.names);
    throw axiError(`table '${name}' not found`, "NOT_FOUND", [
      ...(close.length > 0 ? [`did you mean: ${close.join(", ")}`] : []),
      `Run \`${tool().name} tables -d ${database}\``,
    ]);
  }
  const { info, columns, indexes, outgoing, incoming, checks, triggers } = result;
  const view = info["type"] === "VIEW";
  // Defaults (a table, InnoDB) are left out; column collations are shown when they drift.
  const header: Obj = { name };
  if (view) header["kind"] = "view";
  else {
    if (info["engine"] !== "InnoDB") header["engine"] = info["engine"];
    Object.assign(header, { rows_est: n(info["rows_est"]), size: humanBytes(n(info["bytes"])) });
  }
  if (info["comment"]) header["comment"] = info["comment"];
  const withComments = columns.some((c) => c["comment"]);
  // Optional fields appear only when some column needs them.
  const drifted = (c: Obj) => (c["coll"] && info["collation"] && c["coll"] !== info["collation"] ? c["coll"] : null);
  const withCollation = !view && columns.some(drifted);
  const withGenerated = columns.some((c) => c["gen"]);
  const cols = columns.map((c) => ({
    name: c["name"],
    type: c["type"],
    nullable: c["nullable"] === "YES",
    key: c["k"] || null,
    default: c["def"] ?? null,
    extra: c["extra"] || null,
    ...(withGenerated ? { generated: c["gen"] || null } : {}),
    ...(withCollation ? { collation: drifted(c) } : {}),
    ...(withComments ? { comment: c["comment"] || null } : {}),
  }));
  const ref = (db: unknown, t: unknown): string => (db === database ? String(t) : `${String(db)}.${String(t)}`);
  return out(
    block({ table: header }),
    block({ columns: cols }),
    indexes.length > 0 && block({ indexes: indexes.map((i) => ({ name: i["name"], columns: i["cols"], unique: n(i["non_unique"]) === 0 })) }),
    outgoing.length > 0 &&
      block({
        foreign_keys: outgoing.map((f) => ({
          name: f["name"],
          columns: f["cols"],
          references: `${ref(f["ref_db"], f["ref_table"])}(${String(f["ref_cols"])})`,
          on_delete: f["on_delete"],
          on_update: f["on_update"],
        })),
      }),
    checks.length > 0 && block({ checks: checks.map((c) => ({ name: c["name"], clause: c["clause"] })) }),
    triggers.length > 0 && block({ triggers: triggers.map((t) => ({ name: t["name"], timing: t["timing"], event: t["event"] })) }),
    incoming.length > 0 && block({ referenced_by: incoming.map((f) => ({ table: ref(f["db"], f["tbl"]), columns: f["cols"] })) }),
  );
}

// --- sample ---

export const sampleHelp = (): string => `usage: ${tool().name} sample <table|database.table> [flags]
The first rows of a table (no ORDER BY - use query for a specific slice).
flags:
  ${CONNECTION_FLAGS_HELP}, --limit <n> (default 10; max ${MAX_ROWS}), --full (no ${200}-char cell truncation), --timeout <seconds>
examples:
  ${tool().name} sample orders
  ${tool().name} sample shop.orders --limit 3 --full
`;

export async function sampleCommand(args: string[]): Promise<string> {
  const command = `${tool().name} sample`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, TIMEOUT_FLAG, { name: "--limit" }, { name: "--full", boolean: true }], command);
  const [raw] = expectPositionals(parsed, 1, `${command} <table>`);
  const limit = intFlag(parsed, "--limit", 10, { min: 1, max: MAX_ROWS });
  const target = await targetFrom(parsed);
  const { database, table } = tableRef(raw!, target, `${command} <table>`);
  const outcome = await read(target, parsed, (s) => s.run(`SELECT * FROM ${quoteIdent(database)}.${quoteIdent(table)} LIMIT ${limit + 1}`, limit));
  if (outcome.kind !== "rows") throw axiError("the server returned no rows", "UNKNOWN");
  return rowsBlock(outcome, bool(parsed, "--full"), limit);
}

// --- query ---

export const queryHelp = (): string => `usage: ${tool().name} query "<sql>" [flags]
Runs ONE read statement: SELECT, WITH ... SELECT, SHOW, DESC, EXPLAIN or TABLE. \`${tool().name} "<sql>"\` is short for this.
It runs in a read-only session and transaction; INTO, FOR UPDATE/SHARE, LOCK, SLEEP, GET_LOCK, LOAD_FILE, executable comments and optimizer hints are refused.
flags:
  ${CONNECTION_FLAGS_HELP}, --limit <n> (rows; default 50; max ${MAX_ROWS}), --full (no 200-char cell truncation), --file <path> (SQL from a file; - reads stdin), --timeout <seconds> (default 30)
examples:
  ${tool().name} query "SELECT id, status FROM orders WHERE created_at > NOW() - INTERVAL 1 DAY"
  ${tool().name} query "SELECT r.id, r.order_id FROM reviews r LEFT JOIN orders o ON o.id = r.order_id WHERE o.id IS NULL"
  ${tool().name} query "SHOW CREATE TABLE orders" --full
  ${tool().name} query --file report.sql --limit 500
`;

export async function queryCommand(args: string[]): Promise<string> {
  const command = `${tool().name} query`;
  const parsed = parseArgs(
    args,
    [...CONNECTION_FLAGS, TIMEOUT_FLAG, { name: "--limit" }, { name: "--full", boolean: true }, { name: "--file" }],
    command,
  );
  const sql = sqlInput(parsed, `${command} "<sql>"`);
  const limit = intFlag(parsed, "--limit", 50, { min: 1, max: MAX_ROWS });
  assertReadOnly(sql, tool().writeHint ? { writeHint: tool().writeHint } : {});
  const target = await targetFrom(parsed);
  const outcome = await read(target, parsed, (s) => s.run(sql, limit, [], MAX_ROWS));
  if (outcome.kind !== "rows") return block({ result: "ok - no rows", elapsed_ms: outcome.elapsedMs });
  const raw = rawTextColumns(statements(tokenize(sql).tokens)[0] ?? [], outcome);
  if (raw.size > 0 && outcome.rows.length > 0) return rawTextOutput(outcome, raw, bool(parsed, "--full"));
  return out(rowsBlock(outcome, bool(parsed, "--full"), limit), helpBlock(truncationHelp(outcome, MAX_ROWS)));
}

/** Columns that hold one large text (DDL, InnoDB status, JSON plans): printed fenced and untruncated. */
function rawTextColumns(statement: readonly Token[], outcome: RowsOutcome): Set<number> {
  const [first, second] = statement;
  const words = (t: Token | undefined) => (t?.kind === "word" ? t.text : "");
  const raw = new Set<number>();
  outcome.columns.forEach((c, i) => {
    const name = c.name.toLowerCase();
    if (words(first) === "show" && words(second) === "create" && name.startsWith("create ")) raw.add(i);
    if (words(first) === "show" && words(second) === "engine" && name === "status") raw.add(i);
    if (["explain", "desc", "describe"].includes(words(first)) && name === "explain") raw.add(i);
  });
  return raw;
}

function rawTextOutput(outcome: RowsOutcome, raw: Set<number>, full: boolean): string {
  const rows = records({ ...outcome, columns: outcome.columns.filter((_, i) => !raw.has(i)), rows: outcome.rows.map((r) => r.filter((_, i) => !raw.has(i))) }, full);
  return out(
    ...outcome.rows.flatMap((row, r) => [
      Object.keys(rows[r]!).length > 0 && block(rows[r]!),
      ...[...raw].map((i) => fenced(outcome.columns[i]!.name.toLowerCase().split(" ").slice(0, 2).join("_"), redactSecrets(String(row[i] ?? "")))),
    ]),
  );
}

// --- explain ---

export const explainHelp = (): string => `usage: ${tool().name} explain "<select>" [flags]
The optimizer plan of a read query (EXPLAIN FORMAT=TREE). --analyze runs the query read-only and adds actual rows and times.
flags:
  ${CONNECTION_FLAGS_HELP}, --format tree|traditional (default tree), --analyze, --file <path>, --timeout <seconds>
examples:
  ${tool().name} explain "SELECT id, total FROM orders WHERE status = 'paid' AND created_at >= '2026-10-01'"
  ${tool().name} explain --format traditional "SELECT id, total FROM orders WHERE status = 'paid'"
  ${tool().name} explain --analyze "SELECT COUNT(*) FROM orders o JOIN customers c ON c.id = o.customer_id"
`;

export async function explainCommand(args: string[]): Promise<string> {
  const command = `${tool().name} explain`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, TIMEOUT_FLAG, { name: "--format" }, { name: "--file" }, { name: "--analyze", boolean: true }], command);
  const sql = sqlInput(parsed, `${command} "<select>"`);
  const format = enumFlag(parsed, "--format", ["tree", "traditional"] as const, "tree");
  const analyze = bool(parsed, "--analyze");
  if (analyze && format !== "tree") throw usageError("--analyze prints a tree - drop --format traditional");
  assertReadOnly(sql);
  const verb = mainVerb(statements(tokenize(sql).tokens)[0] ?? []);
  if (verb !== "select" && verb !== "table") {
    throw usageError("explain takes a SELECT (or WITH ... SELECT / TABLE) query", ["Pass the query without the EXPLAIN keyword"]);
  }
  const target = await targetFrom(parsed);
  // ANALYZE runs the SELECT, still inside the read-only transaction and --timeout.
  const prefix = analyze ? "EXPLAIN ANALYZE" : `EXPLAIN FORMAT=${format.toUpperCase()}`;
  const outcome = await read(target, parsed, (s) => s.run(`${prefix} ${sql}`, MAX_ROWS));
  if (outcome.kind !== "rows") throw axiError("the server returned no plan", "UNKNOWN");
  const plan = fenced("plan", outcome.rows.map((r) => String(r[0])).join("\n"));
  // The server cuts ANALYZE off at max_execution_time and still returns a plan.
  if (analyze && outcome.elapsedMs >= timeoutMs(parsed) * 0.95) {
    return out(plan, helpBlock([`Stopped at the ${timeoutMs(parsed) / 1000}s --timeout - actual rows and times are partial`]));
  }
  if (format === "tree") return plan;
  // key_len, rows and filtered arrive as text.
  const numeric = outcome.rows.map((row) => row.map((v) => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : v)));
  return rowsBlock({ ...outcome, rows: numeric }, true, MAX_ROWS);
}
