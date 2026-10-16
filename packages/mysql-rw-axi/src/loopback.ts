import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { axiError } from "../../core/src/errors.js";
import type { Target } from "../../core/src/target.js";

export function isLoopback(address: string): boolean {
  const a = address.toLowerCase();
  return /^127\.\d+\.\d+\.\d+$/.test(a) || a === "::1" || a === "0:0:0:0:0:0:0:1" || /^::ffff:127\.\d+\.\d+\.\d+$/.test(a);
}

/**
 * The write tool's hard rule: only unix sockets and hosts that resolve
 * exclusively to loopback. No flag or env var overrides it.
 */
export async function loopbackOnly(target: Target): Promise<Target> {
  if (target.socket) return target;
  const host = target.host ?? "localhost";
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw axiError(`cannot resolve host '${host}'`, "NETWORK");
    }
  }
  const outside = addresses.filter((a) => !isLoopback(a));
  if (addresses.length === 0 || outside.length > 0) {
    throw axiError(
      `refusing host '${host}'${outside.length > 0 && outside[0] !== host ? ` (${outside.join("; ")})` : ""} - mysql-rw-axi only connects to loopback hosts and unix sockets`,
      "FORBIDDEN",
      ["Use mysql-axi (read-only) for any database that is not local"],
    );
  }
  // Connect to the address that was checked, not a name that could re-resolve elsewhere.
  return { ...target, host: addresses[0]! };
}
