import { readFileSync } from "node:fs";
import { bool, expectPositionals, flag, intFlag, parseArgs, requireFlag } from "../args.js";
import { readConfig, writeConfig, type Profile } from "../config.js";
import { withSession } from "../connection.js";
import { usageError } from "../errors.js";
import { block, helpBlock, out } from "../render.js";
import { clearPassword, describeTarget, loginHint, profileProblem, profileTarget, selectedProfile, storePassword, validProfileName } from "../target.js";
import { env, tool } from "../tool.js";
import { followUp, shellQuote } from "./common.js";

export const authHelp = (): string => {
  const name = tool().name;
  return `usage: ${name} auth <subcommand> [flags]
subcommands[4]:
  status, login, use <profile>, logout
flags{login}:
  --profile <name> (required), --user <user> (required), --host <host> (default 127.0.0.1), --port <port> (default 3306), --socket <path>, -d/--database <name> (default database), --tls, --password-stdin | --no-password (one is required)
flags{logout}:
  --profile <name> (default: the active profile)
notes:
  Passwords are read from stdin only and stored in the OS keychain; profiles (non-secret) live in ~/.config/${name}.
  ${tool().envPrefix}_URL=mysql://user:password@host:port/database overrides the profiles; ${tool().envPrefix}_PROFILE picks one for a single command.
  Login connects first, so a typo never replaces a working profile.
examples:
  printf %s "$DB_PASSWORD" | ${name} auth login --profile dev --host 127.0.0.1 --user app -d shop --password-stdin
  ${name} auth login --profile local --user root --no-password
  ${name} auth use dev
  ${name} auth logout --profile dev
`;
};

export async function authCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "status") return authStatus(rest);
  if (sub === "login") return authLogin(rest);
  if (sub === "use") return authUse(rest);
  if (sub === "logout") return authLogout(rest);
  throw usageError(sub ? `unknown auth subcommand '${sub}'` : "missing auth subcommand", ["subcommands: status, login, use, logout"]);
}

async function authStatus(args: string[]): Promise<string> {
  const command = `${tool().name} auth status`;
  expectPositionals(parseArgs(args, [], command), 0, command);
  const config = readConfig();
  const active = selectedProfile();
  const profiles = Object.entries(config.profiles ?? {}).map(([name, p]) => {
    const problem = profileProblem(p);
    return {
      name,
      target: problem ? `invalid - ${problem}` : describeTarget(profileTarget(name, p, "")),
      password: !problem && p.password ? "OS keychain" : "none",
      active: name === active,
    };
  });
  const url = env("URL");
  return out(
    url ? block({ override: `${tool().envPrefix}_URL is set and wins over the profiles` }) : "",
    profiles.length > 0 ? block({ profiles }) : block({ profiles: "none" }),
    helpBlock(profiles.length > 0 || url ? [`Run \`${tool().name} doctor\` to test the connection`] : [loginHint()]),
  );
}

async function authLogin(args: string[]): Promise<string> {
  const command = `${tool().name} auth login`;
  const usage = `${command} --profile <name> --user <user> [--host <host>] [--port <port>] [-d <database>] --password-stdin|--no-password`;
  const parsed = parseArgs(
    args,
    [
      { name: "--profile" },
      { name: "--user" },
      { name: "--host" },
      { name: "--port" },
      { name: "--socket" },
      { name: "--database", alias: "-d" },
      { name: "--tls", boolean: true },
      { name: "--password-stdin", boolean: true },
      { name: "--no-password", boolean: true },
    ],
    command,
  );
  expectPositionals(parsed, 0, usage);
  const name = requireFlag(parsed, "--profile", usage);
  if (!validProfileName(name)) throw usageError(`invalid profile name '${name}' - use letters, digits, '.', '_' and '-'`);
  const user = requireFlag(parsed, "--user", usage);
  const socket = flag(parsed, "--socket");
  const host = flag(parsed, "--host");
  if (socket && host) throw usageError("pass --host or --socket, not both");
  const port = intFlag(parsed, "--port", 3306, { min: 1, max: 65_535 });
  const database = flag(parsed, "--database");
  const fromStdin = bool(parsed, "--password-stdin");
  if (fromStdin === bool(parsed, "--no-password")) throw usageError("pass exactly one of --password-stdin or --no-password", [`usage: ${usage}`]);

  let password = "";
  if (fromStdin) {
    if (process.stdin.isTTY) throw usageError(`no password on stdin (${tool().name} never prompts)`, [`usage: printf %s "$DB_PASSWORD" | ${usage}`]);
    password = readFileSync(0, "utf-8").replace(/\r?\n$/, "");
    if (password === "") throw usageError("the password read from stdin is empty - use --no-password for an account without one");
  }

  const profile: Profile = {
    ...(socket ? { socket } : { host: host ?? "127.0.0.1", port }),
    user,
    ...(database ? { database } : {}),
    ...(bool(parsed, "--tls") ? { tls: true } : {}),
    password: fromStdin,
  };
  let target = profileTarget(name, profile, password);
  if (tool().checkTarget) target = await tool().checkTarget!(target);
  // Validate before storing so a typo never replaces a working profile. The
  // default database may not exist yet (the write tool creates it), so connect without it.
  const { info, databaseExists } = await withSession({ ...target, database: undefined }, { readOnly: true, timeoutMs: 10_000 }, async (s) => {
    const [info] = await s.all<{ version: string; user: string }>("SELECT VERSION() AS version, CURRENT_USER() AS user");
    const databaseExists = !database || (await s.all("SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [database])).length > 0;
    return { info, databaseExists };
  });

  if (fromStdin) await storePassword(name, password);
  else await clearPassword(name);
  const config = readConfig();
  writeConfig({ ...config, profiles: { ...(config.profiles ?? {}), [name]: profile }, active: name });
  return out(
    block({ auth: { status: "logged in", profile: name, target: describeTarget(target), server: info?.version ?? "unknown", user: info?.user ?? user, active: true } }),
    helpBlock([
      ...(database && !databaseExists
        ? [`Database '${database}' does not exist yet${tool().mode === "read-write" ? ` - create it with \`${followUp(parsed, `db create ${shellQuote(database)}`, { database: false })}\`` : ""}`]
        : []),
      `Run \`${followUp(parsed, "doctor", { database: false })}\` to check the account's grants`,
      `Run \`${tool().name}\` for an overview`,
    ]),
  );
}

async function authUse(args: string[]): Promise<string> {
  const command = `${tool().name} auth use`;
  const [name] = expectPositionals(parseArgs(args, [], command), 1, `${command} <profile>`);
  const config = readConfig();
  const profiles = Object.keys(config.profiles ?? {});
  if (!profiles.includes(name!)) throw usageError(`no profile '${name}'`, [`profiles: ${profiles.join(", ") || "none"}`, loginHint()]);
  if (config.active === name) return block({ auth: { active: name, result: "already active (no-op)" } });
  writeConfig({ ...config, active: name! });
  return out(block({ auth: { active: name, result: "switched" } }), helpBlock(env("URL") ? [`${tool().envPrefix}_URL is set and still wins over the profiles`] : []));
}

async function authLogout(args: string[]): Promise<string> {
  const command = `${tool().name} auth logout`;
  const parsed = parseArgs(args, [{ name: "--profile" }], command);
  expectPositionals(parsed, 0, `${command} [--profile <name>]`);
  const config = readConfig();
  const name = flag(parsed, "--profile") ?? config.active;
  const profiles = { ...(config.profiles ?? {}) };
  if (!name || !profiles[name]) return block({ auth: { status: "no such profile (no-op)" } });
  const hadPassword = profiles[name]!.password;
  if (hadPassword) await clearPassword(name);
  delete profiles[name];
  const active = config.active === name ? Object.keys(profiles)[0] : config.active;
  writeConfig({ ...(active ? { active } : {}), profiles });
  return block({ auth: { profile: name, status: hadPassword ? "removed - password deleted from the OS keychain" : "removed", active: active ?? "none" } });
}
