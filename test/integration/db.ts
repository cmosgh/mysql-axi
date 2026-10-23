import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { inject } from "vitest";
import { shellQuote } from "../../packages/core/src/commands/common.js";
import { useTestEnv } from "../helpers.js";

export const rootUrl = (database?: string): string => `${inject("mysqlRootUrl")}${database ? `/${database}` : ""}`;

export const serverPort = (): number => Number(new URL(inject("mysqlRootUrl")).port);

/** Admin access that bypasses the tools: fixtures and after-the-fact checks. */
export async function sql<T = Record<string, unknown>>(query: string, database?: string, values: unknown[] = []): Promise<T[]> {
  const conn = await mysql.createConnection({ uri: rootUrl(database) });
  try {
    const [rows] = await conn.query(query, values);
    return (Array.isArray(rows) ? rows : []) as T[];
  } finally {
    await conn.end();
  }
}

export async function scalar(query: string, database?: string): Promise<unknown> {
  const [row] = await sql(query, database);
  return row ? Object.values(row)[0] : undefined;
}

/** A fresh database with both tools pointed at it as root. */
export async function scratchDatabase(name: string, fixture: readonly string[] = []): Promise<string> {
  useTestEnv();
  await sql(`DROP DATABASE IF EXISTS \`${name}\``);
  await sql(`CREATE DATABASE \`${name}\``);
  for (const statement of fixture) await sql(statement, name);
  process.env["MYSQL_AXI_URL"] = rootUrl(name);
  process.env["MYSQL_RW_AXI_URL"] = rootUrl(name);
  return name;
}

/** Runs a statement as root inside the test container, e.g. mysqldump. */
export function inContainer(args: string[]): string {
  const password = new URL(inject("mysqlRootUrl")).password;
  const result = spawnSync("docker", ["exec", "-e", `MYSQL_PWD=${password}`, inject("mysqlContainer"), ...args], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`docker exec ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const bins = {
  ro: fileURLToPath(new URL("../../packages/mysql-axi/bin/mysql-axi.ts", import.meta.url)),
  rw: fileURLToPath(new URL("../../packages/mysql-rw-axi/bin/mysql-rw-axi.ts", import.meta.url)),
};

/** The real bin in a child process: stdin, exit codes and process wiring. */
export function spawnCli(which: keyof typeof bins, args: string[], input?: string): { stdout: string; exitCode: number } {
  const result = spawnSync(process.execPath, [tsxCli, bins[which], ...args], { encoding: "utf-8", input: input ?? "", env: process.env });
  return { stdout: result.stdout, exitCode: result.status ?? -1 };
}

let binDir: string | undefined;

/** A PATH entry where `mysql-axi` and `mysql-rw-axi` run the bins from source. */
function shims(): string {
  if (binDir) return binDir;
  binDir = mkdtempSync(join(tmpdir(), "mysql-axi-bin-"));
  for (const [which, name] of [["ro", "mysql-axi"], ["rw", "mysql-rw-axi"]] as const) {
    writeFileSync(join(binDir, name), `#!/bin/sh\nexec ${[process.execPath, tsxCli, bins[which]].map(shellQuote).join(" ")} "$@"\n`, { mode: 0o755 });
  }
  return binDir;
}

/** The command of the `Run \`<command>\` <why>` hint in a CLI output. */
export function hinted(output: string, why: string): string {
  const end = output.indexOf(`\` ${why}`);
  const start = output.lastIndexOf("Run `", end);
  if (end === -1 || start === -1) throw new Error(`no hint '... ${why}' in:\n${output}`);
  return output.slice(start + "Run `".length, end);
}

/** A command line run by sh, the way an agent pastes a hint. */
export function shell(command: string, input?: string): { stdout: string; exitCode: number } {
  const env = { ...process.env, PATH: `${shims()}:${process.env["PATH"] ?? ""}` };
  const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf-8", input: input ?? "", env });
  return { stdout: result.stdout, exitCode: result.status ?? -1 };
}
