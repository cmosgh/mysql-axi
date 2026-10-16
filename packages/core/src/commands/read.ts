import { bool, enumFlag, expectPositionals, flag, intFlag, parseArgs, parseFields, type ParsedArgs } from "../args.js";
import { rowsBlock } from "../cells.js";
import { withSession, type Session } from "../connection.js";
import { axiError, usageError } from "../errors.js";
import { block, fenced, helpBlock, humanBytes, out, type Obj } from "../render.js";
import { assertReadOnly, mainVerb, quoteIdent, statements, tokenize } from "../sql.js";
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
  const help = [`Run \`${tool().name} describe <table>\` for columns; indexes and foreign keys`, `Run \`${tool().name} sample <table>\` for a few rows`];
  if (rows.length > limit) help.unshift(`Showing ${limit} of ${rows.length} - raise --limit`);
  return out(
    block({ database, total: `${rows.length - views} tables; ${views} views; ${humanBytes(total)}` }),
    list.length > 0 ? block({ tables: list }) : block({ tables: "none" }),
    helpBlock(help),
  );
}

// --- describe ---

export const describeHelp = (): string => `usage: ${tool().name} describe <table|database.table> [flags]
Columns, indexes, foreign keys and the tables that reference this one.
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
      `SELECT TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS rows_est, DATA_LENGTH + INDEX_LENGTH AS bytes, TABLE_COMMENT AS comment
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, table],
    );
    if (!info) {
      const names = await s.all<{ name: string }>("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME", [database]);
      return { found: false as const, names: names.map((r) => r.name) };
    }
    const columns = await s.all<Obj>(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS k, COLUMN_DEFAULT AS def, EXTRA AS extra, COLUMN_COMMENT AS comment
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
      `SELECT CONSTRAINT_NAME AS name, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR ';') AS cols,
              REFERENCED_TABLE_SCHEMA AS ref_db, REFERENCED_TABLE_NAME AS ref_table,
              GROUP_CONCAT(REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR ';') AS ref_cols
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
       GROUP BY CONSTRAINT_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME ORDER BY CONSTRAINT_NAME`,
      [database, table],
    );
    const incoming = await s.all<Obj>(
      `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS tbl, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR ';') AS cols
       FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?
       GROUP BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME ORDER BY TABLE_NAME`,
      [database, table],
    );
    return { found: true as const, info, columns, indexes, outgoing, incoming };
  });

  if (!result.found) {
    const close = closeNames(table, result.names);
    throw axiError(`table '${name}' not found`, "NOT_FOUND", [
      ...(close.length > 0 ? [`did you mean: ${close.join(", ")}`] : []),
      `Run \`${tool().name} tables -d ${database}\``,
    ]);
  }
  const { info, columns, indexes, outgoing, incoming } = result;
  const view = info["type"] === "VIEW";
  const header: Obj = { name, kind: view ? "view" : "table" };
  if (!view) Object.assign(header, { engine: info["engine"], rows_est: n(info["rows_est"]), size: humanBytes(n(info["bytes"])) });
  if (info["comment"]) header["comment"] = info["comment"];
  const withComments = columns.some((c) => c["comment"]);
  const cols = columns.map((c) => ({
    name: c["name"],
    type: c["type"],
    nullable: c["nullable"] === "YES",
    key: c["k"] || null,
    default: c["def"] ?? null,
    extra: c["extra"] || null,
    ...(withComments ? { comment: c["comment"] || null } : {}),
  }));
  const ref = (db: unknown, t: unknown): string => (db === database ? String(t) : `${String(db)}.${String(t)}`);
  return out(
    block({ table: header }),
    block({ columns: cols }),
    indexes.length > 0 && block({ indexes: indexes.map((i) => ({ name: i["name"], columns: i["cols"], unique: n(i["non_unique"]) === 0 })) }),
    outgoing.length > 0 &&
      block({ foreign_keys: outgoing.map((f) => ({ name: f["name"], columns: f["cols"], references: `${ref(f["ref_db"], f["ref_table"])}(${String(f["ref_cols"])})` })) }),
    incoming.length > 0 && block({ referenced_by: incoming.map((f) => ({ table: ref(f["db"], f["tbl"]), columns: f["cols"] })) }),
    helpBlock([`Run \`${tool().name} sample ${raw}\` for a few rows`]),
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
Runs ONE read statement: SELECT, WITH ... SELECT, SHOW, DESC, EXPLAIN or TABLE.
It runs in a read-only session and transaction; INTO, FOR UPDATE/SHARE, LOCK, SLEEP, GET_LOCK, LOAD_FILE, executable comments and optimizer hints are refused.
flags:
  ${CONNECTION_FLAGS_HELP}, --limit <n> (rows; default 50; max ${MAX_ROWS}), --full (no 200-char cell truncation), --file <path> (SQL from a file; or pass - for stdin), --timeout <seconds> (default 30)
examples:
  ${tool().name} query "SELECT id, status FROM orders WHERE created_at > NOW() - INTERVAL 1 DAY"
  ${tool().name} query "SHOW CREATE TABLE orders"
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
  const outcome = await read(target, parsed, (s) => s.run(sql, limit));
  if (outcome.kind !== "rows") return block({ result: "ok - no rows", elapsed_ms: outcome.elapsedMs });
  const help = outcome.truncated ? [`Add WHERE or LIMIT to the query, or raise --limit (max ${MAX_ROWS})`] : [];
  return out(rowsBlock(outcome, bool(parsed, "--full"), limit), helpBlock(help));
}

// --- explain ---

export const explainHelp = (): string => `usage: ${tool().name} explain "<select>" [flags]
The optimizer plan of a read query, without running it (EXPLAIN FORMAT=TREE; EXPLAIN ANALYZE is refused).
flags:
  ${CONNECTION_FLAGS_HELP}, --format tree|traditional (default tree), --file <path>, --timeout <seconds>
examples:
  ${tool().name} explain "SELECT * FROM orders WHERE customer_id = 42"
  ${tool().name} explain --format traditional "SELECT ..."
`;

export async function explainCommand(args: string[]): Promise<string> {
  const command = `${tool().name} explain`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, TIMEOUT_FLAG, { name: "--format" }, { name: "--file" }], command);
  const sql = sqlInput(parsed, `${command} "<select>"`);
  const format = enumFlag(parsed, "--format", ["tree", "traditional"] as const, "tree");
  assertReadOnly(sql);
  const verb = mainVerb(statements(tokenize(sql).tokens)[0] ?? []);
  if (verb !== "select" && verb !== "table") {
    throw usageError("explain takes a SELECT (or WITH ... SELECT / TABLE) query", ["Pass the query without the EXPLAIN keyword"]);
  }
  const target = await targetFrom(parsed);
  const outcome = await read(target, parsed, (s) => s.run(`EXPLAIN FORMAT=${format.toUpperCase()} ${sql}`, MAX_ROWS));
  if (outcome.kind !== "rows") throw axiError("the server returned no plan", "UNKNOWN");
  if (format === "tree") return fenced("plan", outcome.rows.map((r) => String(r[0])).join("\n"));
  return rowsBlock(outcome, true, MAX_ROWS);
}
