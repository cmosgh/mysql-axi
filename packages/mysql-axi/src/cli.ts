import { READ_COMMANDS, runCli, upgradeHint, type MainOptions, type Refusal } from "../../core/src/cli.js";
import { axiError } from "../../core/src/errors.js";
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
commands[10]:
  (none)=overview, find, databases, tables, describe, sample, query, explain, doctor, auth, setup
connection flags (every command that reads):
  -p/--profile <name>, -d/--database <name>, --timeout <seconds> (default 30)
examples:
  mysql-axi find voucher
  mysql-axi tables --sort size
  mysql-axi describe orders customers
  mysql-axi query "SELECT status, COUNT(*) FROM orders GROUP BY status" -p staging -d shop
  mysql-axi query --help
`;

/** mysql-rw-axi's commands answer READ_ONLY here, with the command to use on a local database instead. */
const writeCommand =
  (command: string, usage: string): Refusal =>
  () =>
    axiError(`${command} is a mysql-rw-axi command - mysql-axi is read-only`, "READ_ONLY", [`For a local dev database use \`mysql-rw-axi ${usage}\``]);

const REFUSALS = {
  update: () =>
    axiError("mysql-axi is read-only and has no update command", "READ_ONLY", [
      "For data on a local dev database use `mysql-rw-axi exec 'UPDATE ...'`",
      upgradeHint("mysql-axi"),
    ]),
  exec: writeCommand("exec", 'exec "<sql>"'),
  import: writeCommand("import", "import <file.sql>"),
  db: writeCommand("db", "db <create|drop> <name>"),
};

export async function main(options: MainOptions = {}): Promise<void> {
  await runCli({ tool: TOOL, version: VERSION, description: DESCRIPTION, topHelp: TOP_HELP, commands: READ_COMMANDS, refusals: REFUSALS }, options);
}
