import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { usageError } from "../../core/src/errors.js";

const DELIMITER_LINE = /^[ \t]*delimiter[ \t]+(\S+)[^\n]*(\n|$)/i;
const CHUNK_BYTES = 1 << 20;

/**
 * Splits a SQL script (e.g. a mysqldump file) into statements the way the
 * mysql client does: quote- and comment-aware, honouring DELIMITER lines.
 * Executable comments (`/*!40101 SET ... *\/`) stay inside their statement.
 * Fed in chunks, so a dump larger than memory streams through.
 */
export class ScriptSplitter {
  private buffer = "";
  /** Scan position inside `buffer`; the current statement starts at 0. */
  private i = 0;
  private delimiter = ";";
  /** Whether buffer[0] starts a line (DELIMITER is only honoured there). */
  private lineStart = true;

  /** Statements completed by this chunk. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    return this.scan(false);
  }

  /** The rest of the script; throws on an unterminated quote or comment. */
  end(): string[] {
    return this.scan(true);
  }

  private scan(final: boolean): string[] {
    const out: string[] = [];
    const text = this.buffer;
    const n = text.length;
    let start = 0;
    let i = this.i;
    const emit = (end: number): void => {
      const statement = text.slice(start, end).trim();
      if (statement !== "") out.push(statement);
    };

    while (i < n) {
      if (i === 0 ? this.lineStart : text[i - 1] === "\n") {
        const eol = text.indexOf("\n", i);
        if (eol === -1 && !final && /^[ \t]*d/i.test(text.slice(i, i + 20))) break; // maybe a DELIMITER line
        const match = DELIMITER_LINE.exec(text.slice(i, eol === -1 ? n : eol + 1));
        if (match) {
          emit(i);
          this.delimiter = match[1]!;
          i += match[0].length;
          start = i;
          continue;
        }
      }
      const c = text[i]!;
      if (c === "'" || c === '"' || c === "`") {
        let j = i + 1;
        let closed = false;
        while (j < n) {
          if (text[j] === "\\" && c !== "`") {
            j += 2;
            continue;
          }
          if (text[j] === c) {
            if (j + 1 >= n && !final) break; // a doubled quote may follow in the next chunk
            if (text[j + 1] === c) {
              j += 2;
              continue;
            }
            closed = true;
            break;
          }
          j++;
        }
        if (!closed) {
          if (final) throw usageError(`unterminated ${c === "`" ? "quoted identifier" : "string"} in the script`);
          break;
        }
        i = j + 1;
        continue;
      }
      if (c === "#" || (c === "-" && text[i + 1] === "-")) {
        if (c === "-" && i + 2 >= n && !final) break;
        if (c === "#" || /\s/.test(text[i + 2] ?? "\n")) {
          const eol = text.indexOf("\n", i);
          if (eol === -1 && !final) break;
          i = eol === -1 ? n : eol + 1;
          continue;
        }
      }
      if (c === "/" || c === "-") {
        if (i + 1 >= n && !final) break;
      }
      if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end === -1) {
          if (final) throw usageError("unterminated comment in the script");
          break;
        }
        i = end + 2;
        continue;
      }
      if (!final && i + this.delimiter.length > n && this.delimiter.startsWith(text.slice(i))) break;
      if (text.startsWith(this.delimiter, i)) {
        emit(i);
        i += this.delimiter.length;
        start = i;
        continue;
      }
      i++;
    }
    if (final) {
      emit(n);
      this.buffer = "";
      this.i = 0;
    } else {
      if (start > 0) this.lineStart = text[start - 1] === "\n";
      this.buffer = text.slice(start);
      this.i = i - start;
    }
    return out;
  }
}

export function splitScript(text: string): string[] {
  const splitter = new ScriptSplitter();
  return [...splitter.push(text), ...splitter.end()];
}

/** Statements of a file, read 1 MiB at a time. */
export function* scriptStatements(path: string): Generator<string> {
  const fd = openSync(path, "r");
  try {
    const splitter = new ScriptSplitter();
    const decoder = new StringDecoder("utf8");
    const bytes = Buffer.alloc(CHUNK_BYTES);
    for (;;) {
      const read = readSync(fd, bytes, 0, CHUNK_BYTES, null);
      if (read === 0) break;
      yield* splitter.push(decoder.write(bytes.subarray(0, read)));
    }
    yield* splitter.push(decoder.end());
    yield* splitter.end();
  } finally {
    closeSync(fd);
  }
}
