import { readConfig, type Profile } from "./config.js";
import { axiError, usageError } from "./errors.js";
import { env, tool } from "./tool.js";

export interface Target {
  /** Profile name, or the env var name when the URL came from the environment. */
  label: string;
  source: "env" | "profile";
  host?: string;
  port: number;
  socket?: string;
  user: string;
  password: string;
  database?: string;
  tls: boolean;
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

async function keychainEntry(profile: string): Promise<KeyringEntry> {
  if (env("NO_KEYCHAIN") === "1") throw axiError(`the OS keychain is disabled (${tool().envPrefix}_NO_KEYCHAIN=1)`, "AUTH_REQUIRED", [`Set ${tool().envPrefix}_URL instead`]);
  try {
    // Loaded lazily: an unsupported platform degrades to the env-var path.
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(tool().name, profile);
  } catch {
    throw axiError("OS keychain is not available on this system", "AUTH_REQUIRED", [`Set ${tool().envPrefix}_URL in the environment instead`]);
  }
}

export async function storePassword(profile: string, password: string): Promise<void> {
  (await keychainEntry(profile)).setPassword(password);
}

/** Returns true when a stored password was removed. */
export async function clearPassword(profile: string): Promise<boolean> {
  try {
    return (await keychainEntry(profile)).deletePassword();
  } catch {
    return false;
  }
}

export function validProfileName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,62}$/i.test(name);
}

export function loginHint(): string {
  return `Run \`printf %s "$DB_PASSWORD" | ${tool().name} auth login --profile <name> --host <host> --user <user> --password-stdin\` (or --no-password)`;
}

/** `mysql://user:pass@host:port/db?socket=/path&tls=true`. Errors never echo the URL: it may hold a password. */
export function parseUrl(raw: string, label: string): Target {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError(`${label} is not a valid URL - expected mysql://user:password@host:port/database`);
  }
  if (url.protocol !== "mysql:") throw usageError(`${label} must start with mysql://`);
  const user = decodeURIComponent(url.username);
  if (!user) throw usageError(`${label} has no user - expected mysql://user:password@host:port/database`);
  const port = url.port ? Number(url.port) : 3306;
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined;
  const socket = url.searchParams.get("socket") ?? undefined;
  const tls = ["1", "true"].includes(url.searchParams.get("tls") ?? url.searchParams.get("ssl") ?? "");
  return {
    label,
    source: "env",
    ...(url.hostname ? { host: url.hostname.replace(/^\[|\]$/g, "") } : {}),
    port,
    ...(socket ? { socket } : {}),
    user,
    password: decodeURIComponent(url.password),
    ...(database ? { database } : {}),
    tls,
  };
}

const filled = (value: unknown): boolean => typeof value === "string" && value !== "";

/** Why a stored profile cannot be used: a hand-edited one must never fall back to a default host or user. */
export function profileProblem(profile: unknown): string | undefined {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) return "is not an object";
  const p = profile as Record<string, unknown>;
  if (!filled(p["user"])) return "has no user";
  if (!filled(p["host"]) && !filled(p["socket"])) return "has no host or socket";
  for (const key of ["host", "socket", "database"]) if (p[key] !== undefined && typeof p[key] !== "string") return `has a ${key} that is not a string`;
  const port = p["port"];
  if (port !== undefined && !(Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535)) return "has a port outside 1-65535";
  for (const key of ["tls", "password"]) if (p[key] !== undefined && typeof p[key] !== "boolean") return `has a ${key} that is not true or false`;
  return undefined;
}

export function profileTarget(name: string, profile: Profile, password: string): Target {
  return {
    label: name,
    source: "profile",
    ...(profile.host ? { host: profile.host } : {}),
    port: profile.port ?? 3306,
    ...(profile.socket ? { socket: profile.socket } : {}),
    user: profile.user,
    password,
    ...(profile.database ? { database: profile.database } : {}),
    tls: profile.tls ?? false,
  };
}

/** The profile a command uses: --profile, then <PREFIX>_PROFILE, then the active one. */
export function selectedProfile(explicit?: string): string | undefined {
  return explicit ?? env("PROFILE") ?? readConfig().active;
}

/** True when there is anything to connect to, without touching the keychain. */
export function isConfigured(): boolean {
  return Boolean(env("URL")) || Object.keys(readConfig().profiles ?? {}).length > 0;
}

export interface TargetOptions {
  profile?: string;
  database?: string;
}

/** --profile wins over <PREFIX>_URL, which wins over the active profile. */
export async function resolveTarget(options: TargetOptions = {}): Promise<Target> {
  const urlVar = `${tool().envPrefix}_URL`;
  const url = env("URL");
  let target: Target;
  if (url && !options.profile) {
    target = parseUrl(url, urlVar);
  } else {
    const name = selectedProfile(options.profile);
    const profiles = readConfig().profiles ?? {};
    if (!name) throw axiError("no connection configured", "AUTH_REQUIRED", [loginHint(), `Or set ${urlVar}=mysql://user:password@host:port/database`]);
    const profile = profiles[name];
    if (!profile) throw usageError(`no profile '${name}'`, [`profiles: ${Object.keys(profiles).join(", ") || "none"}`, loginHint()]);
    const problem = profileProblem(profile);
    if (problem) throw axiError(`profile '${name}' in config.json ${problem}`, "AUTH_REQUIRED", [loginHint()]);
    let password = "";
    if (profile.password) {
      password = (await keychainEntry(name)).getPassword() ?? "";
      if (!password) throw axiError(`no password stored for profile '${name}'`, "AUTH_REQUIRED", [loginHint()]);
    }
    target = profileTarget(name, profile, password);
  }
  if (options.database) target = { ...target, database: options.database };
  return tool().checkTarget ? tool().checkTarget!(target) : target;
}

export function describeTarget(t: Pick<Target, "user" | "host" | "port" | "socket" | "database">): string {
  const where = t.socket ? `socket ${t.socket}` : `${t.host ?? "localhost"}:${t.port}`;
  return `${t.user}@${where}${t.database ? `/${t.database}` : ""}`;
}
