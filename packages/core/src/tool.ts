import type { Target } from "./target.js";

/** Which CLI is running. Each has its own config dir, keychain service and env vars. */
export interface Tool {
  name: string;
  mode: "read-only" | "read-write";
  /** First lines of the home view: what this tool can and cannot do. */
  banner: Record<string, string>;
  /** Env var prefix, e.g. MYSQL_AXI -> MYSQL_AXI_URL. */
  envPrefix: string;
  /** Vetoes a target before any connection (the write tool's loopback rule). */
  checkTarget?: (target: Target) => Promise<Target>;
  /** Last line of the home view: where writes go. */
  writeHint?: string;
  /** The write command, e.g. `exec "<sql>"`, that read-only refusals suggest with the invocation's connection flags. */
  writeCommand?: string;
}

let current: Tool | undefined;

export function setTool(tool: Tool): void {
  current = tool;
}

export function tool(): Tool {
  if (!current) throw new Error("tool not initialised");
  return current;
}

export function env(suffix: string): string | undefined {
  const value = process.env[`${tool().envPrefix}_${suffix}`];
  return value === "" ? undefined : value;
}
