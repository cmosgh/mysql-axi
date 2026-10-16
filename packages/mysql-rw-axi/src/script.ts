import { usageError } from "../../core/src/errors.js";

const DELIMITER_LINE = /^[ \t]*delimiter[ \t]+(\S+)[^\n]*(\n|$)/i;

/**
 * Splits a SQL script (e.g. a mysqldump file) into statements the way the
 * mysql client does: quote- and comment-aware, honouring DELIMITER lines.
 * Executable comments (`/*!40101 SET ... *\/`) stay inside their statement.
 */
export function splitScript(text: string): string[] {
  const result: string[] = [];
  let delimiter = ";";
  let start = 0;
  let i = 0;
  const n = text.length;
  const push = (end: number): void => {
    const statement = text.slice(start, end).trim();
    if (statement !== "") result.push(statement);
  };

  while (i < n) {
    if (i === 0 || text[i - 1] === "\n") {
      const match = DELIMITER_LINE.exec(text.slice(i, i + 200));
      if (match) {
        push(i);
        delimiter = match[1]!;
        i += match[0].length;
        start = i;
        continue;
      }
    }
    const c = text[i]!;
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\" && c !== "`") j += 2;
        else if (text[j] === c && text[j + 1] === c) j += 2;
        else if (text[j] === c) break;
        else j++;
      }
      if (j >= n) throw usageError(`unterminated ${c === "`" ? "quoted identifier" : "string"} in the script`);
      i = j + 1;
      continue;
    }
    if (c === "#" || (c === "-" && text[i + 1] === "-" && /[\s]/.test(text[i + 2] ?? "\n"))) {
      const eol = text.indexOf("\n", i);
      i = eol === -1 ? n : eol + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw usageError("unterminated comment in the script");
      i = end + 2;
      continue;
    }
    if (text.startsWith(delimiter, i)) {
      push(i);
      i += delimiter.length;
      start = i;
      continue;
    }
    i++;
  }
  push(n);
  return result;
}
