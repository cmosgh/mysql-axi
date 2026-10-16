import { expectPositionals, parseArgs } from "../args.js";
import { withSession } from "../connection.js";
import { summarizeGrants } from "../grants.js";
import { block, helpBlock, out, type Obj } from "../render.js";
import { describeTarget } from "../target.js";
import { tool } from "../tool.js";
import { CONNECTION_FLAGS, CONNECTION_FLAGS_HELP, targetFrom, TIMEOUT_FLAG, timeoutMs } from "./common.js";

const SHOWN_PRIVILEGES = 8;

function listPrivileges(privileges: readonly string[]): string {
  const shown = privileges.slice(0, SHOWN_PRIVILEGES).join("; ");
  return privileges.length > SHOWN_PRIVILEGES ? `${shown} (+${privileges.length - SHOWN_PRIVILEGES} more)` : shown;
}

export const doctorHelp = (): string => `usage: ${tool().name} doctor [flags]
Connects and checks the server, the user, the read-only session and the account's grants.
flags:
  ${CONNECTION_FLAGS_HELP}, --timeout <seconds>
`;

export async function doctorCommand(args: string[]): Promise<string> {
  const command = `${tool().name} doctor`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, TIMEOUT_FLAG], command);
  expectPositionals(parsed, 0, command);
  const target = await targetFrom(parsed);
  const started = Date.now();
  const facts = await withSession(target, { readOnly: true, timeoutMs: timeoutMs(parsed) }, async (s) => {
    const latency = Date.now() - started;
    const [info] = await s.all<Obj>("SELECT VERSION() AS version, CURRENT_USER() AS user, DATABASE() AS db, @@transaction_read_only AS ro, @@global.read_only AS server_ro");
    const grants = await s.all<Obj>("SHOW GRANTS");
    return { latency, info: info ?? {}, grants: grants.map((g) => String(Object.values(g)[0])) };
  });

  const grants = summarizeGrants(facts.grants);
  const report: Obj = {
    target: `${describeTarget(target)} (${target.source === "env" ? target.label : `profile ${target.label}`})`,
    connection: `ok (${facts.latency} ms)`,
    server: facts.info["version"],
    user: facts.info["user"],
    database: facts.info["db"] ?? "none",
    read_only_session: Number(facts.info["ro"]) === 1 ? "verified" : "NOT ACTIVE",
  };
  if (Number(facts.info["server_ro"]) === 1) report["server_read_only"] = "on (the whole server refuses writes)";
  report["grants"] = grants.write.length > 0 ? `write-capable - ${listPrivileges(grants.write)}` : `read-only - ${grants.read.join("; ") || "none"}`;
  if (grants.roles.length > 0) report["roles"] = `${grants.roles.join("; ")} (privileges not expanded)`;

  const help: string[] = [];
  let warning: Obj | undefined;
  if (tool().mode === "read-only" && (grants.write.length > 0 || grants.roles.length > 0)) {
    warning = { warning: `these credentials ${grants.write.length > 0 ? "can write" : "may write through roles"} - ${tool().name} blocks writes with its client guard and a read-only session only` };
    if (grants.write.includes("EXECUTE")) {
      help.push("EXECUTE runs stored routines with their definer's rights - a routine called from a SELECT can change server state the guard cannot see");
    }
    help.push("For a hard guarantee use a SELECT-only account - CREATE USER 'agent_ro'@'%' IDENTIFIED BY '<password>'; GRANT SELECT, SHOW VIEW ON <database>.* TO 'agent_ro'@'%';");
  }
  return out(warning && block(warning), block({ doctor: report }), helpBlock(help));
}
