import mysql from "mysql2";
import { fromDriverError } from "./errors.js";
import { describeTarget, type Target } from "./target.js";

export interface Column {
  name: string;
  /** mysql2 column type id (MYSQL_TYPE_*). */
  type: number;
}

export interface RowsOutcome {
  kind: "rows";
  columns: Column[];
  rows: unknown[][];
  /** More rows existed than the cap. */
  truncated: boolean;
  /** Row count past the cap: exact when the server finished first, else at least this many. */
  total?: { rows: number; exact: boolean };
  elapsedMs: number;
}

export interface OkOutcome {
  kind: "ok";
  affectedRows: number;
  insertId: number;
  warnings: number;
  info: string;
  elapsedMs: number;
}

export type Outcome = RowsOutcome | OkOutcome;

export interface SessionOptions {
  readOnly: boolean;
  /** Server-side cap for SELECT (max_execution_time); omitted = none. */
  timeoutMs?: number;
  /** Bypass the cached information_schema statistics so sizes are current. */
  freshStats?: boolean;
  /** Limit for the TCP connect and handshake (default 10 s). */
  connectTimeoutMs?: number;
  /** Aborting destroys the connection, also while it is still opening. */
  signal?: AbortSignal;
}

function connectionOptions(target: Target, options: SessionOptions): mysql.ConnectionOptions {
  return {
    ...(target.socket ? { socketPath: target.socket } : { host: target.host ?? "localhost", port: target.port }),
    user: target.user,
    password: target.password,
    ...(target.database ? { database: target.database } : {}),
    ...(target.tls ? { ssl: {} } : {}),
    // One statement per call is what makes the read-only session unescapable.
    multipleStatements: false,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectTimeout: options.connectTimeoutMs ?? 10_000,
    // affectedRows = rows changed, as in the mysql client, so a rerun UPDATE shows 0.
    flags: ["-FOUND_ROWS"],
  };
}

export class Session {
  private destroyed = false;

  constructor(
    private readonly conn: mysql.Connection,
    readonly target: Target,
  ) {}

  /** Small internal queries: every row, as objects. */
  async all<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
    const [rows] = await this.conn.promise().query(sql, values);
    return rows as T[];
  }

  /** Runs one statement for its effect; returns affected rows (0 for result sets). */
  async execute(sql: string): Promise<number> {
    const [result] = await this.conn.promise().query(sql);
    return Array.isArray(result) ? 0 : (result as mysql.ResultSetHeader).affectedRows;
  }

  /** Like execute, plus the warning count (import reports them). */
  async apply(sql: string): Promise<{ affectedRows: number; warnings: number }> {
    const [result] = await this.conn.promise().query(sql);
    if (Array.isArray(result)) return { affectedRows: 0, warnings: 0 };
    const header = result as mysql.ResultSetHeader;
    return { affectedRows: header.affectedRows, warnings: header.warningStatus };
  }

  /**
   * Keeps at most `limit` rows and counts on to `countTo` without storing them.
   * Past `countTo` the connection is destroyed so the server stops sending; the session is unusable afterwards.
   */
  run(sql: string, limit: number, values: unknown[] = [], countTo = limit): Promise<Outcome> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let columns: Column[] | undefined;
      let header: Partial<mysql.ResultSetHeader> = {};
      const rows: unknown[][] = [];
      let skipped = 0;
      let settled = false;
      const finish = (exact: boolean): void => {
        if (settled) return;
        settled = true;
        const elapsedMs = Date.now() - started;
        if (columns) {
          const truncated = skipped > 0;
          const total = truncated && countTo > limit ? { total: { rows: rows.length + skipped, exact } } : {};
          resolve({ kind: "rows", columns, rows, truncated, ...total, elapsedMs });
        } else {
          resolve({
            kind: "ok",
            affectedRows: header.affectedRows ?? 0,
            insertId: Number(header.insertId ?? 0),
            warnings: header.warningStatus ?? 0,
            info: header.info ?? "",
            elapsedMs,
          });
        }
      };
      const query = this.conn.query({ sql, rowsAsArray: true, values });
      query.on("fields", (fields: unknown) => {
        // Emitted with undefined for OK packets (INSERT, DDL). Several result sets keep the first.
        if (!Array.isArray(fields)) return;
        columns ??= (fields as mysql.FieldPacket[]).map((f) => ({ name: f.name, type: f.columnType ?? f.type ?? 0 }));
      });
      query.on("result", (row: unknown, resultSet?: number) => {
        if (settled) return;
        // OK packets arrive as objects, also after a CALL's result set; only the first set's rows count.
        if (!Array.isArray(row)) {
          if (!columns) header = row as mysql.ResultSetHeader;
          return;
        }
        if (!columns || (resultSet ?? 0) > 0) return;
        if (rows.length < limit) {
          rows.push(row as unknown[]);
          return;
        }
        skipped++;
        if (rows.length + skipped <= countTo) return;
        this.destroy();
        finish(false);
      });
      query.on("error", (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      query.on("end", () => finish(true));
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.conn.destroy();
  }

  async close(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    // Ending without COMMIT rolls the read-only transaction back.
    await new Promise<void>((resolve) => this.conn.end(() => resolve()));
  }
}

/**
 * Opens a session. Read sessions run in `transaction_read_only` (the only
 * mode that also blocks DDL) inside START TRANSACTION READ ONLY.
 */
export async function openSession(target: Target, options: SessionOptions): Promise<Session> {
  const conn = mysql.createConnection(connectionOptions(target, options));
  // Late socket errors (after destroy) must not crash the process.
  conn.on("error", () => {});
  const session = new Session(conn, target);
  options.signal?.addEventListener("abort", () => session.destroy(), { once: true });
  try {
    await new Promise<void>((resolve, reject) => conn.connect((error) => (error ? reject(error) : resolve())));
    const settings: string[] = [];
    const values: unknown[] = [];
    if (options.readOnly) settings.push("SESSION transaction_read_only = ON");
    if (options.timeoutMs !== undefined) {
      settings.push("SESSION max_execution_time = ?");
      values.push(options.timeoutMs);
    }
    if (options.freshStats) settings.push("SESSION information_schema_stats_expiry = 0");
    if (settings.length > 0) await session.all(`SET ${settings.join(", ")}`, values);
    if (options.readOnly) await session.all("START TRANSACTION READ ONLY");
    return session;
  } catch (error) {
    session.destroy();
    throw fromDriverError(error, describeTarget(target));
  }
}

export async function withSession<T>(target: Target, options: SessionOptions, fn: (session: Session) => Promise<T>): Promise<T> {
  const session = await openSession(target, options);
  try {
    return await fn(session);
  } catch (error) {
    throw fromDriverError(error, describeTarget(target));
  } finally {
    await session.close().catch(() => {});
  }
}
