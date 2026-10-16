// Runs each statement of the safety matrix as an agent would, through the plain `mysql` client, a
// read-only MCP server and mysql-axi, then checks the server for its effect.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { ro, useTestEnv } from "../helpers.js";
import { scalar, serverPort, sql } from "./db.js";
import { SHOP_FIXTURE } from "./fixtures.js";
import { SAFETY_CASES, type Arm, type Outcome, type SafetyCase } from "./safety-cases.js";

const DB = "safety";
const TEMPLATE = "safety_tpl";
const USER = "agent_safety";
const PASSWORD = randomBytes(9).toString("hex");
const TABLES = ["customers", "orders", "reviews", "audit"];
const mcpEntry = join(dirname(createRequire(import.meta.url).resolve("mysql-mcp-server/package.json")), "build/index.js");
let maxConnections = 0;

interface Reply {
  output: string;
  refused: boolean;
  failed: boolean;
}

/** The mysql client inside the server's container, as `mysql -e` from an agent's shell. */
function viaMysql(statement: string): Reply {
  const result = spawnSync(
    "docker",
    ["exec", "-e", `MYSQL_PWD=${PASSWORD}`, inject("mysqlContainer"), "mysql", "-h", "127.0.0.1", "-u", USER, DB, "-e", statement],
    { encoding: "utf-8" },
  );
  return { output: result.stdout + result.stderr, refused: false, failed: result.status !== 0 };
}

/** A minimal MCP stdio client: newline-delimited JSON-RPC. */
class McpServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly waiting = new Map<number, (message: Record<string, any>) => void>();
  private nextId = 1;

  constructor() {
    this.child = spawn(process.execPath, [mcpEntry], {
      env: { ...process.env, MYSQL_HOST: "127.0.0.1", MYSQL_PORT: String(serverPort()), MYSQL_USER: USER, MYSQL_PASSWORD: PASSWORD, MYSQL_DATABASE: DB },
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      for (let eol = this.buffer.indexOf("\n"); eol !== -1; eol = this.buffer.indexOf("\n")) {
        const message = JSON.parse(this.buffer.slice(0, eol)) as Record<string, any>;
        this.buffer = this.buffer.slice(eol + 1);
        this.waiting.get(message["id"])?.(message);
      }
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async start(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "safety-test", version: "0" } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  async query(statement: string): Promise<Reply> {
    const { result, error } = await this.request("tools/call", { name: "execute_query", arguments: { query: statement } });
    const output = error ? String(error.message) : (result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    const failed = Boolean(error || result?.isError);
    return { output, refused: failed && /only read-only queries/i.test(output), failed };
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.kill();
    });
  }
}

async function viaAxi(statement: string): Promise<Reply> {
  const { stdout, exitCode } = await ro("query", statement);
  // Exit 2 is the guard, unless the server's read-only transaction refused the statement.
  return { output: stdout, refused: exitCode === 2 && !/READ ONLY transaction/.test(stdout), failed: exitCode !== 0 };
}

/** Rows the agent got back, from each tool's own format. */
function rowsReturned(arm: Arm, output: string): number {
  if (arm === "mysql") return output.trimEnd().split("\n").length - 1;
  if (arm === "mcp") return (JSON.parse(output) as unknown[]).length;
  return Number(/result\[(\d+)\]/.exec(output)?.[1] ?? 0);
}

const fileInContainer = (path: string): boolean =>
  spawnSync("docker", ["exec", inject("mysqlContainer"), "test", "-f", path]).status === 0;

/** The side effect each case would leave on the server; undefined for cases measured by their output. */
const EFFECTS: Record<string, (() => Promise<boolean>) | undefined> = {
  "update-all": async () => Number(await scalar("SELECT COUNT(*) FROM orders WHERE status = 'cancelled'", DB)) > 0,
  delete: async () => Number(await scalar("SELECT COUNT(*) FROM orders WHERE status = 'refunded'", DB)) === 0,
  drop: async () => (await sql("SHOW TABLES LIKE 'reviews'", DB)).length === 0,
  "second-statement": async () => Number(await scalar("SELECT COUNT(*) FROM orders", DB)) === 0,
  "select-all": undefined,
  "outfile-executable-comment": async () => fileInContainer("/tmp/safety-a.csv"),
  "outfile-comment-gap": async () => fileInContainer("/tmp/safety-b.csv"),
  "get-lock": async () => (await scalar("SELECT IS_USED_LOCK('deploy')")) !== null,
  sleep: undefined,
  "writing-function": async () => Number(await scalar("SELECT COUNT(*) FROM audit", DB)) > 0,
  "explain-analyze-function": async () => Number(await scalar("SELECT COUNT(*) FROM audit", DB)) > 0,
  "set-global-function": async () => Number(await scalar("SELECT @@GLOBAL.max_connections")) === 777,
};

async function observe(arm: Arm, c: SafetyCase): Promise<Outcome> {
  const mcp = arm === "mcp" ? new McpServer() : undefined;
  await mcp?.start();
  try {
    const started = Date.now();
    const reply = arm === "mysql" ? viaMysql(c.sql) : mcp ? await mcp.query(c.sql) : await viaAxi(c.sql);
    const hint = c.hint?.[arm];
    if (hint) expect(reply.output).toContain(hint.contains);
    if (reply.refused) return "refused";
    if (c.kind === "read") return reply.failed ? "failed" : "answered";
    if (c.outputChars) expect(Math.abs(reply.output.length / c.outputChars[arm] - 1)).toBeLessThan(0.1);
    if (c.id === "select-all") return reply.failed ? "failed" : `rows ${rowsReturned(arm, reply.output)}`;
    if (c.id === "sleep") return Date.now() - started >= 2900 ? "ran" : "failed";
    // A lock held by a live connection outlasts the call; the mysql client's ends with its process.
    const effect = await EFFECTS[c.id]!();
    if (c.id === "get-lock" && !effect && !reply.failed) return "ran; released on exit";
    return effect ? "ran" : "failed";
  } finally {
    await mcp?.stop();
  }
}

beforeAll(async () => {
  await sql(`DROP DATABASE IF EXISTS ${TEMPLATE}`);
  await sql(`CREATE DATABASE ${TEMPLATE}`);
  for (const statement of SHOP_FIXTURE) await sql(statement, TEMPLATE);
  await sql("CREATE TABLE reviews (id INT PRIMARY KEY, order_id BIGINT UNSIGNED, stars TINYINT)", TEMPLATE);
  await sql("INSERT INTO reviews VALUES (1, 1, 5), (2, 2, 4)", TEMPLATE);
  await sql("CREATE TABLE audit (at DATETIME)", TEMPLATE);
  await sql(`DROP DATABASE IF EXISTS ${DB}`);
  await sql(`CREATE DATABASE ${DB}`);
  // Definer routines run with root's rights whoever calls them.
  await sql("CREATE DEFINER = 'root'@'%' FUNCTION bump() RETURNS INT DETERMINISTIC MODIFIES SQL DATA SQL SECURITY DEFINER BEGIN INSERT INTO audit VALUES (NOW()); RETURN 1; END", DB);
  await sql("CREATE DEFINER = 'root'@'%' FUNCTION tune() RETURNS INT NO SQL SQL SECURITY DEFINER BEGIN SET GLOBAL max_connections = 777; RETURN 1; END", DB);
  // What dev and many app accounts have: everything on the app database, plus FILE.
  await sql(`DROP USER IF EXISTS ${USER}`);
  await sql(`CREATE USER ${USER} IDENTIFIED BY '${PASSWORD}'`);
  await sql(`GRANT ALL ON ${DB}.* TO ${USER}`);
  await sql(`GRANT FILE ON *.* TO ${USER}`);
  maxConnections = Number(await scalar("SELECT @@GLOBAL.max_connections"));
});

beforeEach(async () => {
  useTestEnv();
  process.env["MYSQL_AXI_URL"] = `mysql://${USER}:${PASSWORD}@127.0.0.1:${serverPort()}/${DB}`;
  for (const table of TABLES) {
    await sql(`DROP TABLE IF EXISTS ${DB}.${table}`);
    await sql(`CREATE TABLE ${DB}.${table} LIKE ${TEMPLATE}.${table}`);
    await sql(`INSERT INTO ${DB}.${table} SELECT * FROM ${TEMPLATE}.${table}`);
  }
  spawnSync("docker", ["exec", inject("mysqlContainer"), "sh", "-c", "rm -f /tmp/safety-*.csv"]);
  await sql(`SET GLOBAL max_connections = ${maxConnections}`);
});

afterAll(async () => {
  await sql(`SET GLOBAL max_connections = ${maxConnections}`);
  await sql(`DROP USER IF EXISTS ${USER}`);
});

describe("safety matrix", () => {
  it.each(SAFETY_CASES.flatMap((c) => (["mysql", "mcp", "axi"] as const).map((arm) => [c.title, arm, c] as const)))("%s via %s", async (_title, arm, c) => {
    expect(await observe(arm, c)).toBe(c.expected[arm]);
  });
});
