import { installSessionStartHooks, sessionStartHookStatus, uninstallSessionStartHooks } from "axi-sdk-js";
import { bool, expectPositionals, parseArgs } from "../args.js";
import { usageError } from "../errors.js";
import { block, helpBlock, out } from "../render.js";
import { tool } from "../tool.js";

export const setupHelp = (): string => `usage: ${tool().name} setup <hooks|status|uninstall> [--project]
Manage the opt-in SessionStart integration that shows the ${tool().name} home view to Claude Code, Codex and OpenCode at session start.
flags:
  --project (install into the current repository's agent config instead of your user config)
notes:
  The home view never connects to a database or reads the keychain.
examples:
  ${tool().name} setup hooks --project
  ${tool().name} setup status
`;

export async function setupCommand(args: string[]): Promise<string> {
  const name = tool().name;
  const [sub, ...rest] = args;
  if (sub !== "hooks" && sub !== "status" && sub !== "uninstall") {
    throw usageError(sub ? `unknown setup action '${sub}'` : "missing setup action", [
      `Run \`${name} setup hooks\` to install, \`${name} setup status\` to inspect, \`${name} setup uninstall\` to remove`,
    ]);
  }
  const command = `${name} setup ${sub}`;
  const parsed = parseArgs(rest, [{ name: "--project", boolean: true }], command);
  expectPositionals(parsed, 0, `${command} [--project]`);
  const scope = bool(parsed, "--project") ? "project" : "user";
  const identity = { marker: name, binaryNames: [name] };

  if (sub === "status") {
    const status = sessionStartHookStatus({ ...identity, scope });
    return block({
      hooks: {
        scope,
        claude_code: status.claude.installed ? "installed" : "not installed",
        codex: status.codex.installed ? "installed" : "not installed",
        opencode: status.opencode.installed ? "installed" : "not installed",
      },
    });
  }
  if (sub === "uninstall") {
    await uninstallSessionStartHooks({ ...identity, scope });
    return block({ hooks: { scope, status: "removed (or were not installed)" } });
  }
  await installSessionStartHooks({ ...identity, scope });
  return out(
    block({ hooks: { scope, status: "installed or already up to date", integrations: "Claude Code; Codex; OpenCode" } }),
    helpBlock([`Restart the agent session to receive the ${name} home view as ambient context`]),
  );
}
