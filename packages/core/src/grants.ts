/** Privileges that cannot change data, schema or server state. */
const READ_PRIVILEGES = new Set(["USAGE", "SELECT", "SHOW VIEW", "SHOW DATABASES", "PROCESS", "REPLICATION CLIENT", "EXECUTE"]);

export interface GrantSummary {
  /** Privileges outside the read set, de-duplicated, in first-seen order. */
  write: string[];
  read: string[];
  /** Granted roles; their privileges are not expanded. */
  roles: string[];
}

/** Classifies `SHOW GRANTS` lines. */
export function summarizeGrants(lines: readonly string[]): GrantSummary {
  const write = new Set<string>();
  const read = new Set<string>();
  const roles: string[] = [];
  for (const line of lines) {
    const match = /^GRANT\s+(.+?)\s+ON\s+.+?\s+TO\s+.+$/is.exec(line);
    if (!match) {
      const role = /^GRANT\s+(.+?)\s+TO\s+/is.exec(line);
      if (role) roles.push(...role[1]!.split(",").map((r) => r.trim().replace(/`/g, "")));
      continue;
    }
    // Column-level grants: SELECT (a, b) -> SELECT
    const privileges = match[1]!.replace(/\([^)]*\)/g, "").split(",").map((p) => p.trim().toUpperCase()).filter(Boolean);
    for (const privilege of privileges) (READ_PRIVILEGES.has(privilege) ? read : write).add(privilege);
    if (/WITH\s+GRANT\s+OPTION\s*$/i.test(line)) write.add("GRANT OPTION");
  }
  return { write: [...write], read: [...read], roles };
}
