import { homedir } from "node:os";
import { expectPositionals, flag, parseArgs, type ParsedArgs } from "../args.js";
import { readConfig } from "../config.js";
import { openSession, type Session } from "../connection.js";
import { AxiError, axiError, fromDriverError } from "../errors.js";
import { block, helpBlock, humanBytes, out, type Obj } from "../render.js";
import { describeTarget, isConfigured, loginHint, parseUrl, profileProblem, profileTarget, selectedProfile, type Target } from "../target.js";
import { env, tool } from "../tool.js";
import { CONNECTION_FLAGS, followUp, SYSTEM_SCHEMAS, targetFrom } from "./common.js";

/** Short limits: the overview must answer quickly even when the server does not. */
const CONNECT_MS = 3000;
const QUERY_MS = 5000;
const DEADLINE_MS = 10_000;
const TOP = 10;

export const homeHelp = (): string => `usage: ${tool().name} [-p <profile>] [-d <database>]
Live overview: the server version, then the default database's tables or the largest databases, read in a read-only session like every other command.
Connects with short time limits; when the server cannot be reached it says why and still exits 0. \`${tool().name} context\` is the offline summary.
examples:
  ${tool().name}
  ${tool().name} -d shop
  ${tool().name} -p staging -d shop
`;

/** The SDK's home header (`bin`, `description`), for views it does not render itself. */
export function homeHeader(description: string): string {
  const home = homedir();
  const bin = process.argv[1] ?? tool().name;
  return block({ bin: bin.startsWith(home) ? `~${bin.slice(home.length)}` : bin, description });
}

/** The configured connection and profiles, from config and env only: no network, no keychain. */
export function connectionStatus(): { blocks: string[]; help: string[] } {
  const urlVar = `${tool().envPrefix}_URL`;
  if (!isConfigured()) return { blocks: [block({ status: "not configured" })], help: [loginHint(), `Or set ${urlVar}=mysql://user:password@host:port/database`] };
  const status: Obj = {};
  const url = env("URL");
  if (url) {
    try {
      status["connection"] = `${describeTarget(parseUrl(url, urlVar))} (${urlVar})`;
    } catch {
      status["connection"] = `${urlVar} is set but invalid`;
    }
  }
  const active = selectedProfile();
  const profiles = Object.entries(readConfig().profiles ?? {}).map(([profile, p]) => {
    const problem = profileProblem(p);
    return { name: profile, target: problem ? `invalid - ${problem}` : describeTarget(profileTarget(profile, p, "")), active: !url && profile === active };
  });
  return { blocks: [Object.keys(status).length > 0 ? block(status) : "", profiles.length > 0 ? block({ profiles }) : ""].filter(Boolean), help: [] };
}

/** Command hints shared by the overview and the session context: [explore, query, writes?]. */
export function exploreHelp(parsed?: ParsedArgs): string[] {
  const name = tool().name;
  const f = (rest: string): string => (parsed ? followUp(parsed, rest) : `${name} ${rest}`);
  // Without connection flags to carry, show where they go.
  const query = parsed && (flag(parsed, "--profile") || flag(parsed, "--database")) ? f('query "<sql>"') : `${name} query "<sql>" -p <profile> -d <database>`;
  return [
    `Run \`${f("find <name>")}\`, \`${f("tables")}\`, \`${f("describe <table>...")}\` or \`${f("sample <table>")}\` to explore`,
    `Run \`${query}\` or \`${f('explain "<select>"')}\`; \`${name} <command> --help\` for flags`,
    ...(tool().writeCommand ? [`Writes go through \`${f(tool().writeCommand!)}\``] : []),
  ];
}

const connectionText = (target: Target): string => `${describeTarget(target)} (${target.source === "env" ? target.label : `profile ${target.label}`})`;

const n = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

function serverText(version: unknown, readOnly: unknown): string {
  const v = String(version ?? "unknown");
  const product = /mariadb/i.test(v) ? `MariaDB ${v.split("-")[0]}` : `MySQL ${v}`;
  return Number(readOnly) === 1 ? `${product} - read_only is on` : product;
}

interface Live {
  blocks: string[];
  help: string[];
}

async function databaseOverview(s: Session, database: string, parsed: ParsedArgs): Promise<Live> {
  const [totals] = await s.all<Obj>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(TABLE_TYPE = 'VIEW'), 0) AS views, COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS bytes
     FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
    [database],
  );
  const count = n(totals?.["n"]);
  if (count === 0) {
    if ((await s.all("SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [database])).length > 0) {
      return { blocks: [block({ database: `${database} - no tables` })], help: [] };
    }
    return {
      blocks: [block({ database: `${database} - not found or not visible to this account` })],
      help: [`Run \`${followUp(parsed, "databases", { database: false })}\` to list databases`],
    };
  }
  const names = await s.all<{ name: string }>(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT ${TOP * 2}`,
    [database],
  );
  const views = n(totals?.["views"]);
  const parts = [`${count - views} tables`, ...(views > 0 ? [`${views} views`] : []), humanBytes(n(totals?.["bytes"]))];
  const tables = names.map((r) => r.name);
  if (count > tables.length) tables.push(`+${count - tables.length} more`);
  return {
    blocks: [block({ database: `${database} - ${parts.join("; ")}` }), block({ tables })],
    help: [`Run \`${followUp(parsed, "tables")}\` for row estimates and sizes; \`${followUp(parsed, "describe <table>")}\` for columns and indexes`],
  };
}

async function serverOverview(s: Session, parsed: ParsedArgs): Promise<Live> {
  const system = [...SYSTEM_SCHEMAS];
  const notSystem = `NOT IN (${system.map(() => "?").join(", ")})`;
  const rows = await s.all<{ name: string; tables: unknown; bytes: unknown }>(
    `SELECT s.SCHEMA_NAME AS name, COUNT(t.TABLE_NAME) AS tables, COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS bytes
     FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
     WHERE s.SCHEMA_NAME ${notSystem} GROUP BY s.SCHEMA_NAME ORDER BY bytes DESC, name LIMIT ${TOP}`,
    system,
  );
  if (rows.length === 0) return { blocks: [block({ databases: "none besides the system schemas" })], help: [] };
  const total = rows.length < TOP ? rows.length : n((await s.all<Obj>(`SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME ${notSystem}`, system))[0]?.["n"]);
  const help = [`Run \`${followUp(parsed, "tables -d <database>", { database: false })}\` to list a database's tables`];
  if (total > rows.length) help.unshift(`Largest ${rows.length} of ${total} shown - \`${followUp(parsed, "databases", { database: false })}\` lists all`);
  return { blocks: [block({ databases: rows.map((r) => ({ name: r.name, tables: n(r.tables), size: humanBytes(n(r.bytes)) })) })], help };
}

async function liveOverview(target: Target, parsed: ParsedArgs): Promise<Live> {
  // Connected without the default database, so a missing one is reported below instead of failing the connection.
  const { database, ...server } = target;
  const done = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(axiError(`no answer within ${DEADLINE_MS / 1000} s`, "TIMEOUT")), DEADLINE_MS);
  });
  try {
    return await Promise.race([
      (async () => {
        const s = await openSession(server, { readOnly: true, timeoutMs: QUERY_MS, connectTimeoutMs: CONNECT_MS, signal: done.signal });
        const [info] = await s.all<Obj>("SELECT VERSION() AS version, @@global.read_only AS read_only");
        const detail = database ? await databaseOverview(s, database, parsed) : await serverOverview(s, parsed);
        await s.close();
        return { blocks: [block({ server: serverText(info?.["version"], info?.["read_only"]) }), ...detail.blocks], help: detail.help };
      })(),
      deadline,
    ]);
  } catch (error) {
    throw fromDriverError(error, describeTarget(target));
  } finally {
    clearTimeout(timer);
    // Past the deadline the connection may still be opening or mid-query: drop it.
    done.abort();
  }
}

/**
 * The no-argument view: connects with short limits and shows live state. Any failure is reported
 * as `live: unavailable` with exit 0, so it is safe to run first in every session.
 */
export async function homeCommand(args: string[] = []): Promise<string> {
  const name = tool().name;
  const parsed = parseArgs(args, CONNECTION_FLAGS, name);
  expectPositionals(parsed, 0, `${name} [-p <profile>] [-d <database>]`);
  const banner = block(tool().banner);
  if (!isConfigured()) {
    const status = connectionStatus();
    return out(banner, ...status.blocks, helpBlock(status.help));
  }
  let target: Target | undefined;
  try {
    target = await targetFrom(parsed);
    const live = await liveOverview(target, parsed);
    // The live hints already point at tables and describe.
    return out(banner, block({ connection: connectionText(target) }), ...live.blocks, helpBlock([...live.help, ...exploreHelp(parsed).slice(1)]));
  } catch (error) {
    // Flags the agent typed get a real error; the bare overview never fails.
    if (args.length > 0 && error instanceof AxiError && error.code === "VALIDATION_ERROR") throw error;
    const axi = error instanceof AxiError ? error : fromDriverError(error, target ? describeTarget(target) : "the server");
    return out(
      banner,
      ...(target ? [block({ connection: connectionText(target) })] : connectionStatus().blocks),
      block({ live: `unavailable - ${axi.message}` }),
      // A time limit hint would name --timeout, which this view does not take.
      helpBlock([...(axi.code === "TIMEOUT" ? [] : axi.suggestions), `Run \`${followUp(parsed, "doctor")}\` to diagnose`]),
    );
  }
}
