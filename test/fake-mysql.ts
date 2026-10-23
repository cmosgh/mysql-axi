// In-memory stand-in for the parts of mysql2 the CLIs use. Tests script
// replies per SQL text through `fake.responder` and inspect `fake.calls`.
import { EventEmitter } from "node:events";

export interface Reply {
  columns?: string[];
  /** mysql2 column type ids, parallel to `columns` (default VAR_STRING). */
  types?: number[];
  rows?: unknown[][];
  ok?: { affectedRows?: number; insertId?: number; warningStatus?: number; info?: string };
  error?: { errno?: number; code?: string; sqlMessage?: string };
  /** Never answers, like a server stuck on the statement. */
  hang?: boolean;
}

export interface ConnectionRecord {
  options: Record<string, unknown>;
  destroyed: boolean;
  ended: boolean;
}

export const fake = {
  responder: (_sql: string, _values: unknown[]): Reply | undefined => undefined,
  calls: [] as Array<{ sql: string; values: unknown[] }>,
  connections: [] as ConnectionRecord[],
  connectError: undefined as Reply["error"] | undefined,
};

export function resetFake(): void {
  fake.responder = () => undefined;
  fake.calls = [];
  fake.connections = [];
  fake.connectError = undefined;
}

function driverError(e: NonNullable<Reply["error"]>): Error {
  return Object.assign(new Error(e.sqlMessage ?? e.code ?? "error"), e);
}

function reply(sql: string, values: unknown[]): Reply {
  fake.calls.push({ sql, values });
  const scripted = fake.responder(sql, values);
  if (scripted) return scripted;
  if (/^(SET |START TRANSACTION)/.test(sql)) return { ok: {} };
  return { error: { errno: 1064, sqlMessage: `no fake reply for: ${sql}` } };
}

function header(r: Reply): Record<string, unknown> {
  return { affectedRows: 0, insertId: 0, warningStatus: 0, info: "", ...r.ok };
}

class FakeConnection extends EventEmitter {
  private readonly record: ConnectionRecord;

  constructor(options: Record<string, unknown>) {
    super();
    this.record = { options, destroyed: false, ended: false };
    fake.connections.push(this.record);
  }

  connect(callback: (error: Error | null) => void): void {
    setImmediate(() => callback(fake.connectError ? driverError(fake.connectError) : null));
  }

  promise(): { query: (sql: string, values?: unknown[]) => Promise<[unknown, unknown]> } {
    return {
      query: async (sql: string, values: unknown[] = []) => {
        const r = reply(sql, values);
        if (r.hang) return new Promise<never>(() => {});
        if (r.error) throw driverError(r.error);
        if (r.columns) {
          const columns = r.columns;
          return [(r.rows ?? []).map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]]))), columns.map((name) => ({ name }))];
        }
        return [header(r), undefined];
      },
    };
  }

  query(options: { sql: string; values?: unknown[] }): EventEmitter {
    const emitter = new EventEmitter();
    setImmediate(() => {
      const r = reply(options.sql, options.values ?? []);
      if (r.hang) return;
      if (r.error) {
        emitter.emit("error", driverError(r.error));
        return;
      }
      if (r.columns) {
        emitter.emit("fields", r.columns.map((name, i) => ({ name, columnType: r.types?.[i] ?? 253 })));
        for (const row of r.rows ?? []) {
          if (this.record.destroyed) return;
          emitter.emit("result", row);
        }
      } else {
        emitter.emit("fields", undefined);
        emitter.emit("result", header(r));
      }
      emitter.emit("end");
    });
    return emitter;
  }

  destroy(): void {
    this.record.destroyed = true;
  }

  end(callback?: () => void): void {
    this.record.ended = true;
    callback?.();
  }
}

export default {
  createConnection: (options: Record<string, unknown>) => new FakeConnection(options),
};
