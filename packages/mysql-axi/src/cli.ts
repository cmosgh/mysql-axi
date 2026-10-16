import { READ_COMMANDS, runCli, type MainOptions } from "../../core/src/cli.js";
import type { Tool } from "../../core/src/tool.js";
import { VERSION } from "./version.js";

export const TOOL: Tool = {
  name: "mysql-axi",
  mode: "read-only",
  envPrefix: "MYSQL_AXI",
  banner: {
    mode: "READ-ONLY - one SELECT/WITH/SHOW/DESC/EXPLAIN/TABLE statement per call; results capped at 50 rows",
  },
};

export const DESCRIPTION =
  "READ-ONLY MySQL CLI for agents - explore schemas and run capped read queries, with TOON output. Writes are refused by a client-side guard plus a read-only session (not a grant check).";

export const TOP_HELP = `usage: mysql-axi [command] [args] [flags]
commands[9]:
  (none)=overview, databases, tables, describe, sample, query, explain, doctor, auth, setup
examples:
  mysql-axi tables --sort size
  mysql-axi describe orders
  mysql-axi query "SELECT status, COUNT(*) FROM orders GROUP BY status"
  mysql-axi query --help
`;

export async function main(options: MainOptions = {}): Promise<void> {
  await runCli({ tool: TOOL, version: VERSION, description: DESCRIPTION, topHelp: TOP_HELP, commands: READ_COMMANDS }, options);
}
