import { READ_COMMANDS, runCli, type MainOptions } from "../../core/src/cli.js";
import type { Tool } from "../../core/src/tool.js";
import { dbCommand, DB_HELP } from "./commands/db.js";
import { execCommand, EXEC_HELP } from "./commands/exec.js";
import { importCommand, IMPORT_HELP } from "./commands/import.js";
import { loopbackOnly } from "./loopback.js";
import { VERSION } from "./version.js";

export const TOOL: Tool = {
  name: "mysql-rw-axi",
  mode: "read-write",
  envPrefix: "MYSQL_RW_AXI",
  banner: {
    warning: "WRITE-CAPABLE - exec; import and db can modify and DROP data",
    scope: "loopback hosts only - 127.0.0.0/8; IPv6 loopback; unix sockets. An SSH tunnel to 127.0.0.1 also counts as loopback - never tunnel to a shared database",
    reads: "query; sample; describe and the other read commands still run read-only",
  },
  checkTarget: loopbackOnly,
  writeHint: 'Writes go through `mysql-rw-axi exec "<sql>"`',
};

export const DESCRIPTION =
  "WRITE ACCESS - MySQL CLI for agents that CAN MODIFY AND DROP DATA on loopback databases (local dev): exec, import, db create/drop, plus every read-only mysql-axi command. Irreversible statements preview until --confirm. Use mysql-axi for anything that is not local.";

export const TOP_HELP = `usage: mysql-rw-axi [command] [args] [flags]
WARNING: WRITE-CAPABLE. exec, import and db change data; loopback hosts and unix sockets only (an SSH tunnel to 127.0.0.1 counts as loopback).
Read commands (query, sample, ...) still run in a read-only session - writes go through exec.
commands[12]:
  (none)=overview, exec, import, db, databases, tables, describe, sample, query, explain, doctor, auth, setup
flags[2]:
  --help, -v/-V/--version
examples:
  mysql-rw-axi
  mysql-rw-axi exec "UPDATE orders SET status = 'paid' WHERE id = 42"
  mysql-rw-axi exec "DROP TABLE tmp_import" --confirm
  mysql-rw-axi import dump.sql -d shop_test --confirm
  mysql-rw-axi db create shop_test
  mysql-rw-axi query "SELECT COUNT(*) FROM orders"
  mysql-rw-axi exec --help
`;

export async function main(options: MainOptions = {}): Promise<void> {
  await runCli(
    {
      tool: TOOL,
      version: VERSION,
      description: DESCRIPTION,
      topHelp: TOP_HELP,
      commands: {
        exec: { run: execCommand, help: () => EXEC_HELP },
        import: { run: importCommand, help: () => IMPORT_HELP },
        db: { run: dbCommand, help: () => DB_HELP },
        ...READ_COMMANDS,
      },
    },
    options,
  );
}
