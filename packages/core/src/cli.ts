import { runAxiCli } from "axi-sdk-js";
import { VALUE_FLAGS } from "./args.js";
import { authCommand, authHelp } from "./commands/auth.js";
import { contextCommand, contextHelp } from "./commands/context.js";
import { doctorCommand, doctorHelp } from "./commands/doctor.js";
import { homeCommand, homeHeader, homeHelp } from "./commands/home.js";
import {
  databasesCommand,
  databasesHelp,
  describeCommand,
  describeHelp,
  explainCommand,
  explainHelp,
  findCommand,
  findHelp,
  queryCommand,
  queryHelp,
  sampleCommand,
  sampleHelp,
  tablesCommand,
  tablesHelp,
} from "./commands/read.js";
import { setupCommand, setupHelp } from "./commands/setup.js";
import { AxiError, exitCodeForError } from "./errors.js";
import { out, renderErrorOutput } from "./render.js";
import { setTool, type Tool } from "./tool.js";

export interface Command {
  run: (args: string[]) => Promise<string>;
  help: () => string;
}

/** Answers a command name with an error instead of running anything. */
export type Refusal = () => AxiError;

export const upgradeHint = (name: string): string => `Upgrading is \`npm install -g ${name}@latest\`, run by a human`;

/** Commands both CLIs share; all of them read through a read-only session. */
export const READ_COMMANDS: Record<string, Command> = {
  find: { run: findCommand, help: findHelp },
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
export function routeBareSql(argv: string[], commands: Record<string, unknown>): string[] {
  const [first] = argv;
  return first !== undefined && isBareSql(first, commands) ? ["query", ...argv] : argv;
}

const isBareSql = (token: string, commands: Record<string, unknown>): boolean => !commands[token] && /\s/.test(token.trim()) && SQL_VERBS.test(token);

const FRONT_ONLY = new Set(["--help", "-h", "--version", "-V", "-v"]);

const HOME = "home";

/**
 * `tool -p x db drop y` runs as `tool db drop y -p x`: agents often put connection flags first.
 * Flags without a command (`tool -p staging`) run the home view with them.
 */
export function hoistLeadingFlags(argv: string[], commands: Record<string, unknown>): string[] {
  if (!argv[0]?.startsWith("-") || argv[0] === "-") return argv;
  let at = -1;
  for (let i = 0; i < argv.length && at === -1; i++) {
    if (commands[argv[i]!] !== undefined || isBareSql(argv[i]!, commands)) at = i;
    // A flag's value (`-d tables`) is never the command.
    else if (VALUE_FLAGS.has(argv[i]!)) i++;
  }
  if (argv.slice(0, at === -1 ? argv.length : at).some((token) => FRONT_ONLY.has(token))) return argv;
  if (at === -1) return [HOME, ...argv];
  // After the subcommand and its arguments (`db drop y -p x`), but before a `--` terminator.
  const rest = argv.slice(at + 1);
  const end = rest.includes("--") ? rest.indexOf("--") : rest.length;
  return [argv[at]!, ...rest.slice(0, end), ...argv.slice(0, at), ...rest.slice(end)];
}

export interface CliSpec {
  tool: Tool;
  version: string;
  description: string;
  topHelp: string;
  commands: Record<string, Command>;
  /** Names that only refuse, kept out of help and the command list. `update` must shadow the SDK's built-in self-upgrade (a global npm install). */
  refusals: { update: Refusal } & Record<string, Refusal>;
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
  commands[HOME] = { run: async (args) => out(homeHeader(spec.description), await homeCommand(args)), help: homeHelp };
  // The session log keeps command names only: bare SQL counts as query, anything else unknown as other.
  const canonical = (word: string): string | undefined => (commands[word] ? (ALIASES[word] ?? word) : isBareSql(word, commands) ? "query" : undefined);
  commands["context"] = { run: (args) => contextCommand(args, { description: spec.description, canonical }), help: contextHelp };
  const names = { ...spec.refusals, ...commands };
  await runAxiCli({
    argv: routeBareSql(hoistLeadingFlags(options.argv ?? process.argv.slice(2), names), names),
    ...(options.stdout ? { stdout: options.stdout } : {}),
    description: spec.description,
    version: spec.version,
    topLevelHelp: spec.topHelp,
    home: () => homeCommand(),
    commands: {
      // Refusals have no help entry, so `--help` and `-h` refuse too.
      ...Object.fromEntries(
        Object.entries(spec.refusals).map(([name, refuse]) => [
          name,
          async () => {
            throw refuse();
          },
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(commands).map(([name, c]) => [name, async (args: string[]) => (args.includes("-h") ? c.help().trimEnd() : c.run(args))]),
      ),
    },
    getCommandHelp: (command) => commands[command]?.help(),
    renderUnknownCommand: (command) =>
      `${renderErrorOutput(`unknown command '${command}'`, "VALIDATION_ERROR", [
        `commands: ${[...Object.keys(spec.commands), "context"].join(", ")} (no command = live overview)`,
        `Run \`${spec.tool.name} --help\` for examples`,
      ])}\n`,
    formatError,
  });
}
