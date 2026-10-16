// vitest globalSetup: a throwaway MySQL in Docker on a random loopback port, so the
// suite never touches a developer's own server and can change server globals freely.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** mysql://root:<password>@127.0.0.1:<port> (no database). */
    mysqlRootUrl: string;
    mysqlContainer: string;
  }
}

const IMAGE = process.env["MYSQL_AXI_IT_IMAGE"] ?? "mysql:8.0";
const READY_TIMEOUT_MS = 120_000;

const docker = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function waitUntilReady(url: string, container: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      // The image's init phase runs with --skip-networking, so a TCP query only succeeds on the real server.
      const conn = await mysql.createConnection({ uri: url, connectTimeout: 2000 });
      await conn.query("SELECT 1");
      await conn.end();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`MySQL container ${container} not ready after ${READY_TIMEOUT_MS / 1000}s: ${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

export default async function setup(project: TestProject): Promise<() => void> {
  try {
    docker("version", "--format", "{{.Server.Version}}");
  } catch {
    throw new Error("the integration tests start their own MySQL container and need a running Docker daemon");
  }
  const password = randomBytes(12).toString("hex");
  const container = docker(
    "run", "-d", "--rm", "--label", "mysql-axi-it",
    "-e", `MYSQL_ROOT_PASSWORD=${password}`,
    "-p", "127.0.0.1::3306",
    "--tmpfs", "/var/lib/mysql",
    IMAGE,
    // INTO OUTFILE works on this server, so only the guard stands in its way.
    "--secure-file-priv=/tmp",
  );
  const stop = (): void => {
    try {
      docker("rm", "-f", container);
    } catch {
      // Already gone (--rm).
    }
  };
  try {
    const port = docker("port", container, "3306/tcp").split("\n")[0]!.split(":").pop();
    const url = `mysql://root:${password}@127.0.0.1:${port}`;
    await waitUntilReady(url, container);
    project.provide("mysqlRootUrl", url);
    project.provide("mysqlContainer", container);
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
