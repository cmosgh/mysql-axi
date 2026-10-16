import { runAxiCli } from "axi-sdk-js";
import { authCommand, authHelp } from "./commands/auth.js";
import { doctorCommand, doctorHelp } from "./commands/doctor.js";
import { homeCommand } from "./commands/home.js";
import {
  databasesCommand,
  databasesHelp,
  describeCommand,
  describeHelp,
  explainCommand,
  explainHelp,
  queryCommand,
  queryHelp,
  sampleCommand,
  sampleHelp,
  tablesCommand,
  tablesHelp,
} from "./commands/read.js";
import { setupCommand, setupHelp } from "./commands/setup.js";
import { AxiError, exitCodeForError } from "./errors.js";
import { renderErrorOutput } from "./render.js";
import { setTool, type Tool } from "./tool.js";

export interface Command {
  run: (args: string[]) => Promise<string>;
  help: () => string;
}

/** Commands both CLIs share; all of them read through a read-only session. */
export const READ_COMMANDS: Record<string, Command> = {
  databases: { run: databasesCommand, help: databasesHelp },
  tables: { run: tablesCommand, help: tablesHelp },
  describe: { run: describeCommand, help: describeHelp },
  sample: { run: sampleCommand, help: sampleHelp },
  query: { run: queryCommand, help: queryHelp },
  explain: { run: explainCommand, help: explainHelp },
  doctor: { run: doctorCommand, help: doctorHelp },
  auth: { run: authCommand, help: authHelp },
  setup: { run: setupCommand, help: setupHelp },
};

const ALIASES: Record<string, string> = { desc: "describe", dbs: "databases" };

const SQL_VERBS =
  /^\s*\(*\s*(select|with|show|desc|describe|explain|table|values|checksum|insert|update|delete|replace|create|alter|drop|truncate|rename|set|call|do|load|grant|revoke|lock|unlock|flush|kill|analyze|optimize|repair|start|begin|commit|rollback|use)\b/i;

/**
 * `tool "SELECT 1"` runs as `tool query "SELECT 1"`, the most common agent slip.
 * Only one argument holding whitespace counts as SQL, so `tool desc orders` stays a command; writes still meet the query guard.
 */
export function routeBareSql(argv: string[], commands: Record<string, Command>): string[] {
  const [first] = argv;
  if (first === undefined || commands[first] || !/\s/.test(first.trim()) || !SQL_VERBS.test(first)) return argv;
  return ["query", ...argv];
}

export interface CliSpec {
  tool: Tool;
  version: string;
  description: string;
  topHelp: string;
  commands: Record<string, Command>;
}

export interface MainOptions {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
}

function formatError(error: unknown): { output: string; exitCode: number } {
  const axi = error instanceof AxiError ? error : new AxiError(error instanceof Error ? error.message : String(error), "UNKNOWN");
  return { output: `${renderErrorOutput(axi.message, axi.code, axi.suggestions)}\n`, exitCode: exitCodeForError(axi) };
}

export async function runCli(spec: CliSpec, options: MainOptions = {}): Promise<void> {
  setTool(spec.tool);
  const commands: Record<string, Command> = { ...spec.commands };
  for (const [alias, target] of Object.entries(ALIASES)) if (commands[target]) commands[alias] = commands[target]!;
  await runAxiCli({
    argv: routeBareSql(options.argv ?? process.argv.slice(2), commands),
    ...(options.stdout ? { stdout: options.stdout } : {}),
    description: spec.description,
    version: spec.version,
    topLevelHelp: spec.topHelp,
    home: () => homeCommand(),
    commands: Object.fromEntries(
      Object.entries(commands).map(([name, c]) => [name, async (args: string[]) => (args.includes("-h") ? c.help().trimEnd() : c.run(args))]),
    ),
    getCommandHelp: (command) => commands[command]?.help(),
    renderUnknownCommand: (command) =>
      `${renderErrorOutput(`unknown command '${command}'`, "VALIDATION_ERROR", [
        `commands: ${Object.keys(spec.commands).join(", ")} (no command = overview)`,
        `Run \`${spec.tool.name} --help\` for examples`,
      ])}\n`,
    formatError,
  });
}
