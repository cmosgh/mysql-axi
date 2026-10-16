// Passwords in SQL text (IDENTIFIED BY '...', SET PASSWORD = '...') and stored hashes never reach stdout.
const QUOTED = String.raw`('(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*")`;
const SECRET_SQL = new RegExp(
  String.raw`(\bIDENTIFIED\s+(?:WITH\s+\S+\s+)?(?:BY|AS)\s+|\bPASSWORD(?:\s+FOR\s+\S+)?\s*=\s*|\bREPLACE\s+(?=['"]))` + QUOTED,
  "gi",
);

export const REDACTED = "<redacted>";

export function redactSecrets(text: string): string {
  return text.replace(SECRET_SQL, `$1'${REDACTED}'`);
}

/** Columns that hold credential hashes (mysql.user and friends). */
export const isSecretColumn = (name: string): boolean => /^(authentication_string|password)$/i.test(name);
