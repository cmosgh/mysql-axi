import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { inject } from "vitest";
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
