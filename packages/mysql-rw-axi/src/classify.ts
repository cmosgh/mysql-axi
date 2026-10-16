import { usageError } from "../../core/src/errors.js";
import { mainVerb, statements, tokenize, topLevelWords, type Token } from "../../core/src/sql.js";

export interface Classification {
  verb: string;
  /** Why the statement cannot be undone; set only for irreversible ones. */
  irreversible?: string;
}

/** Decides whether a statement needs --confirm. Best effort: it gates mistakes, it is not a sandbox. */
export function classify(statement: readonly Token[]): Classification {
  const verb = mainVerb(statement) ?? "?";
  const words = topLevelWords(statement);
  switch (verb) {
    case "drop":
      return { verb, irreversible: `DROP ${(words[1] ?? "").toUpperCase()} removes the object and its data` };
    case "truncate":
      return { verb, irreversible: "TRUNCATE deletes every row" };
    case "delete":
    case "update":
      return words.includes("where") ? { verb } : { verb, irreversible: `${verb.toUpperCase()} without WHERE affects every row` };
    case "alter":
      return words.includes("drop") ? { verb, irreversible: "ALTER ... DROP removes a column; index; partition or constraint" } : { verb };
    default:
      return { verb };
  }
}

const ROUTINES = new Set(["procedure", "function", "trigger", "event"]);

/** Exactly one statement, tokenized. Routine bodies (BEGIN ...; ... END) count as one. */
export function singleStatement(sql: string): Token[] {
  const { tokens } = tokenize(sql);
  const list = statements(tokens);
  if (list.length === 0) throw usageError("the SQL is empty");
  const first = list[0]!;
  if (mainVerb(first) === "create" && topLevelWords(first).some((w) => ROUTINES.has(w))) {
    return tokens.filter((t) => !(t.kind === "punct" && t.text === ";"));
  }
  if (list.length > 1) throw usageError(`exec runs one statement per call (got ${list.length})`, ["Run a multi-statement script with `mysql-rw-axi import <file.sql>`"]);
  return list[0]!;
}
