import { READ_COMMANDS, runCli, type MainOptions } from "../../core/src/cli.js";
import type { Tool } from "../../core/src/tool.js";
import { VERSION } from "./version.js";

export const TOOL: Tool = {
  name: "mysql-axi",
  mode: "read-only",
  envPrefix: "MYSQL_AXI",
  banner: {
    mode: "READ-ONLY MySQL - one SELECT/WITH/SHOW/DESC/EXPLAIN/TABLE statement per call",
    limits: "writes are blocked by a client-side guard plus a read-only session - not a grant check; use a SELECT-only account for a hard guarantee",
  },
};

export const DESCRIPTION =
  "READ-ONLY MySQL CLI for agents - databases, tables, describe, sample rows and capped read queries in TOON. Writes are refused by a client-side guard plus a read-only session (not a grant check). It cannot change data; use it for any database that is not a local dev copy.";

export const TOP_HELP = `usage: mysql-axi [command] [args] [flags]
READ-ONLY: every statement runs in a read-only session after a client-side guard. Not a grant check - see \`mysql-axi doctor\`.
commands[9]:
  (none)=overview, databases, tables, describe, sample, query, explain, doctor, auth, setup
flags[2]:
  --help, -v/-V/--version
examples:
  mysql-axi
  mysql-axi tables -d shop --sort size
  mysql-axi describe orders
  mysql-axi sample orders --limit 5
  mysql-axi query "SELECT status, COUNT(*) FROM orders GROUP BY status"
  mysql-axi explain "SELECT * FROM orders WHERE customer_id = 42"
  mysql-axi query --help
`;

export async function main(options: MainOptions = {}): Promise<void> {
  await runCli({ tool: TOOL, version: VERSION, description: DESCRIPTION, topHelp: TOP_HELP, commands: READ_COMMANDS }, options);
}
