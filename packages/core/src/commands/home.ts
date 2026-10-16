import { readConfig } from "../config.js";
import { block, helpBlock, out, type Obj } from "../render.js";
import { describeTarget, isConfigured, loginHint, parseUrl, profileTarget, selectedProfile } from "../target.js";
import { env, tool } from "../tool.js";

/**
 * Runs at every agent session start: never touches the network or the
 * keychain, so it stays instant and silent about secrets.
 */
export async function homeCommand(): Promise<string> {
  const name = tool().name;
  const banner = block(tool().banner);
  const urlVar = `${tool().envPrefix}_URL`;
  if (!isConfigured()) {
    return out(banner, block({ status: "not configured" }), helpBlock([loginHint(), `Or set ${urlVar}=mysql://user:password@host:port/database`]));
  }
  const status: Obj = {};
  const url = env("URL");
  if (url) {
    try {
      status["connection"] = `${describeTarget(parseUrl(url, urlVar))} (${urlVar})`;
    } catch {
      status["connection"] = `${urlVar} is set but invalid`;
    }
  }
  const config = readConfig();
  const active = selectedProfile();
  const profiles = Object.entries(config.profiles ?? {}).map(([profile, p]) => ({
    name: profile,
    target: describeTarget(profileTarget(profile, p, "")),
    active: !url && profile === active,
  }));
  return out(
    banner,
    Object.keys(status).length > 0 && block(status),
    profiles.length > 0 && block({ profiles }),
    helpBlock([
      `Run \`${name} databases\` or \`${name} tables\` to explore`,
      `Run \`${name} query "SELECT ..."\` for a capped read`,
      `Run \`${name} doctor\` to check the connection and grants`,
      `Run \`${name} --help\` for every command`,
    ]),
  );
}
