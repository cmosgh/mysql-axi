import { AxiError, axiError, usageError } from "./errors.js";

export type TokenKind = "word" | "ident" | "string" | "number" | "var" | "punct";

export interface Token {
  kind: TokenKind;
  /** Lower-cased for words; raw text otherwise. */
  text: string;
}

export interface Tokens {
  tokens: Token[];
  /** `/*! ... *\/` executable comment seen; its body is tokenized as code. */
  executableComment: boolean;
  /** Bodies of `/*+ ... *\/` optimizer hints; SET_VAR in one sets a system variable. */
  hints: string[];
}

export interface TokenizeOptions {
  /** MySQL default; off under sql_mode NO_BACKSLASH_ESCAPES. */
  backslashEscapes: boolean;
}

const isWordChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c) || c > "\u007f";

/**
 * Lexes MySQL just far enough to classify statements: comments are dropped,
 * quoted text becomes one opaque token, keywords become lower-cased words.
 * Throws on unterminated quotes or comments instead of guessing.
 */
export function tokenize(sql: string, options: TokenizeOptions = { backslashEscapes: true }): Tokens {
  if (sql.includes("\0")) throw usageError("SQL contains a NUL byte");
  const tokens: Token[] = [];
  let executableComment = false;
  const hints: string[] = [];
  let inExecutable = false;
  const n = sql.length;
  let i = 0;

  const skipQuoted = (quote: string): number => {
    let j = i + 1;
    while (j < n) {
      const c = sql[j]!;
      if (c === "\\" && options.backslashEscapes && quote !== "`") {
        j += 2;
        continue;
      }
      if (c === quote) {
        if (sql[j + 1] === quote) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    throw usageError(`unterminated ${quote === "`" ? "quoted identifier" : "string"} in SQL`);
  };

  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "#" || (c === "-" && next === "-" && (i + 2 >= n || /[\s\x00-\x1f]/.test(sql[i + 2]!)))) {
      const eol = sql.indexOf("\n", i);
      i = eol === -1 ? n : eol + 1;
      continue;
    }
    if (inExecutable && c === "*" && next === "/") {
      inExecutable = false;
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      const marker = sql[i + 2];
      if (marker === "!") {
        if (inExecutable) throw usageError("nested executable comment in SQL");
        executableComment = true;
        inExecutable = true;
        i += 3;
        while (i < n && /[0-9]/.test(sql[i]!)) i++;
        continue;
      }
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw usageError("unterminated comment in SQL");
      if (marker === "+") hints.push(sql.slice(i + 3, end));
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = skipQuoted(c);
      tokens.push({ kind: "string", text: sql.slice(i, end) });
      i = end;
      continue;
    }
    if (c === "`") {
      const end = skipQuoted(c);
      tokens.push({ kind: "ident", text: sql.slice(i, end) });
      i = end;
      continue;
    }
    if (c === "@") {
      let j = i + 1;
      if (sql[j] === "@") j++;
      if (sql[j] === "'" || sql[j] === '"' || sql[j] === "`") {
        const save = i;
        i = j;
        j = skipQuoted(sql[j]!);
        i = save;
      } else {
        while (j < n && (isWordChar(sql[j]!) || sql[j] === ".")) j++;
      }
      tokens.push({ kind: "var", text: sql.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && next !== undefined && /[0-9]/.test(next))) {
      let j = i + 1;
      while (j < n && (isWordChar(sql[j]!) || sql[j] === ".")) j++;
      tokens.push({ kind: "number", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (isWordChar(c)) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j]!)) j++;
      tokens.push({ kind: "word", text: sql.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    tokens.push({ kind: "punct", text: c });
    i++;
  }
  if (inExecutable) throw usageError("unterminated executable comment in SQL");
  return { tokens, executableComment, hints };
}

/** Split on `;` into non-empty statements (token lists). */
export function statements(tokens: readonly Token[]): Token[][] {
  const result: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === "punct" && token.text === ";") result.push([]);
    else result[result.length - 1]!.push(token);
  }
  return result.filter((s) => s.length > 0);
}

const isWord = (t: Token | undefined, ...words: string[]): boolean => t?.kind === "word" && words.includes(t.text);
const isPunct = (t: Token | undefined, text: string): boolean => t?.kind === "punct" && t.text === text;

/** Index just past the balanced parenthesis group starting at `open`. */
function skipGroup(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (isPunct(tokens[i], "(")) depth++;
    else if (isPunct(tokens[i], ")") && --depth === 0) return i + 1;
  }
  return tokens.length;
}

/**
 * The verb that decides what a statement does: the first word, skipping
 * leading parentheses and a WITH clause's CTE definitions
 * (`WITH x AS (...) DELETE ...` is a DELETE).
 */
export function mainVerb(statement: readonly Token[]): string | undefined {
  let i = 0;
  while (isPunct(statement[i], "(")) i++;
  if (!isWord(statement[i], "with")) return statement[i]?.kind === "word" ? statement[i]!.text : undefined;
  i++;
  if (isWord(statement[i], "recursive")) i++;
  for (;;) {
    i++; // CTE name
    if (isPunct(statement[i], "(")) i = skipGroup(statement, i);
    if (!isWord(statement[i], "as")) return undefined;
    i++;
    if (!isPunct(statement[i], "(")) return undefined;
    i = skipGroup(statement, i);
    if (!isPunct(statement[i], ",")) break;
    i++;
  }
  while (isPunct(statement[i], "(")) i++;
  return statement[i]?.kind === "word" ? statement[i]!.text : undefined;
}

/** Words at parenthesis depth 0 - the statement's own clauses, not subqueries. */
export function topLevelWords(statement: readonly Token[]): string[] {
  const words: string[] = [];
  let depth = 0;
  for (const t of statement) {
    if (isPunct(t, "(")) depth++;
    else if (isPunct(t, ")")) depth--;
    else if (depth === 0 && t.kind === "word") words.push(t.text);
  }
  return words;
}

export const READ_VERBS = ["select", "with", "show", "desc", "describe", "explain", "table", "checksum"] as const;
const READ_MAIN_VERBS = new Set(["select", "table", "values"]);

/** Words refused anywhere in a read-only statement, with the reason shown to the agent. */
const DENIED_WORDS: Record<string, string> = {
  into: "INTO writes files (OUTFILE/DUMPFILE) or variables",
  outfile: "OUTFILE writes a file on the server",
  dumpfile: "DUMPFILE writes a file on the server",
  lock: "LOCK IN SHARE MODE takes row locks",
  analyze: "ANALYZE executes the statement - the explain --analyze command runs a SELECT read-only and time-capped",
  analyse: "ANALYSE executes the statement - the explain --analyze command runs a SELECT read-only and time-capped",
};

/** Built-in functions refused when called; as plain names (a column called sleep) they are fine. */
const DENIED_CALLS: Record<string, string> = {
  load_file: "LOAD_FILE reads files from the server host",
  sleep: "SLEEP holds a connection",
  benchmark: "BENCHMARK burns server CPU",
  get_lock: "GET_LOCK takes a named lock",
  release_lock: "RELEASE_LOCK releases a named lock",
  release_all_locks: "RELEASE_ALL_LOCKS releases named locks",
  master_pos_wait: "it blocks waiting on replication",
  source_pos_wait: "it blocks waiting on replication",
  wait_for_executed_gtid_set: "it blocks waiting on replication",
  wait_until_sql_thread_after_gtids: "it blocks waiting on replication",
};

/** Hints that change state; the rest (INDEX, JOIN_ORDER, MAX_EXECUTION_TIME, ...) only steer the plan. */
const DENIED_HINTS = /\b(set_var|resource_group)\b/i;

/** Statements MySQL refuses to EXPLAIN inside a read-only transaction. */
const WRITE_VERBS = new Set(["insert", "update", "delete", "replace"]);

// Loadable functions (UDFs) that change server state; several ship enabled in MySQL 8.0
// and run inside a read-only transaction.
const DENIED_FUNCTION_PREFIXES = [
  "asynchronous_connection_failover_",
  "innodb_",
  "group_replication_",
  "version_tokens_",
  "keyring_",
  "audit_log_",
  "mysql_firewall_",
  "set_firewall_",
  "service_get_",
  "service_release_",
  "gen_dictionary_",
  "masking_dictionary_",
];
const DENIED_FUNCTIONS = new Set(["load_rewrite_rules", "sys_exec", "sys_eval"]);

/** Why calling `name(...)` is refused. Quoted names count: `` `sleep`(1) `` still calls SLEEP. */
function deniedCall(name: string): string | undefined {
  const fn = name.toLowerCase();
  if (DENIED_CALLS[fn]) return DENIED_CALLS[fn];
  if (DENIED_FUNCTIONS.has(fn) || DENIED_FUNCTION_PREFIXES.some((prefix) => fn.startsWith(prefix))) {
    return `${fn}() is a loadable function that can change server state`;
  }
  return undefined;
}

/** The bare name of a word, `ident` or (ANSI_QUOTES) "ident" token. */
function callName(t: Token): string | undefined {
  if (t.kind === "word") return t.text;
  if (t.kind !== "ident" && t.kind !== "string") return undefined;
  const quote = t.text[0]!;
  if (t.text.length < 2 || t.text[t.text.length - 1] !== quote) return undefined;
  return t.text.slice(1, -1).replaceAll(quote + quote, quote);
}

export interface ReadOnlyOptions {
  /** Extra suggestion appended to refusals (e.g. where writes can go instead). */
  writeHint?: string;
}

function refuse(reason: string, options: ReadOnlyOptions): never {
  throw axiError(`refused by the read-only guard - ${reason}`, "READ_ONLY", [
    "Read-only accepts one SELECT, WITH ... SELECT, SHOW, DESC, EXPLAIN or TABLE statement",
    ...(options.writeHint ? [options.writeHint] : []),
  ]);
}

function checkReadOnly(sql: string, lex: TokenizeOptions, options: ReadOnlyOptions): void {
  const { tokens, executableComment, hints } = tokenize(sql, lex);
  if (executableComment) refuse("executable comments (/*! ... */) are not allowed", options);
  const stateHint = hints.map((h) => DENIED_HINTS.exec(h)?.[1]).find(Boolean);
  if (stateHint) refuse(`the ${stateHint.toUpperCase()} optimizer hint changes session state`, options);
  const list = statements(tokens);
  if (list.length === 0) throw usageError("the SQL is empty");
  if (list.length > 1) refuse(`one statement per call (got ${list.length})`, options);
  const statement = list[0]!;

  let i = 0;
  while (isPunct(statement[i], "(")) i++;
  const first = statement[i];
  if (first?.kind !== "word" || !(READ_VERBS as readonly string[]).includes(first.text)) {
    refuse(`${first ? `'${first.text.toUpperCase()}'` : "this"} statements are not allowed`, options);
  }
  if (first.text === "checksum" && !isWord(statement[i + 1], "table")) refuse("only CHECKSUM TABLE is a read", options);
  if (first.text === "explain" || first.text === "desc" || first.text === "describe") {
    // EXPLAIN [FORMAT = x] <statement>; DESC <table> has an identifier here instead.
    let k = i + 1;
    if (isWord(statement[k], "format")) k += isPunct(statement[k + 1], "=") ? 3 : 2;
    const target = statement[k];
    if (target?.kind === "word" && WRITE_VERBS.has(target.text)) {
      refuse(`EXPLAIN ${target.text.toUpperCase()} needs a write session - explain the matching SELECT instead`, options);
    }
  }
  if (first.text === "with") {
    const verb = mainVerb(statement);
    if (!verb || !READ_MAIN_VERBS.has(verb)) refuse(`WITH ... ${verb ? verb.toUpperCase() : "?"} is not a read`, options);
  }
  for (let j = 0; j < statement.length; j++) {
    const t = statement[j]!;
    if (isPunct(statement[j + 1], "(")) {
      const name = callName(t);
      const denied = name === undefined ? undefined : deniedCall(name);
      if (denied) refuse(denied, options);
    }
    if (t.kind !== "word") continue;
    const denied = DENIED_WORDS[t.text];
    if (denied) refuse(denied, options);
    if (t.text === "for" && isWord(statement[j + 1], "update", "share")) {
      refuse(`FOR ${statement[j + 1]!.text.toUpperCase()} takes row locks`, options);
    }
  }
}

/**
 * Throws READ_ONLY unless `sql` is a single read statement. It must pass
 * with and without backslash escapes, so a server running
 * NO_BACKSLASH_ESCAPES cannot see a statement the guard did not.
 */
export function assertReadOnly(sql: string, options: ReadOnlyOptions = {}): void {
  checkReadOnly(sql, { backslashEscapes: true }, options);
  try {
    checkReadOnly(sql, { backslashEscapes: false }, options);
  } catch (error) {
    // Lexes with backslash escapes but not without: a \' or \" inside a string.
    if (error instanceof AxiError && error.code === "VALIDATION_ERROR" && /unterminated/.test(error.message)) {
      throw usageError("a backslash-escaped quote (\\' or \\\") reads differently under NO_BACKSLASH_ESCAPES - double the quote instead ('O''Brien')");
    }
    throw error;
  }
}

/** Quote an identifier with backticks. */
export function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}
