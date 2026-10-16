import { describe, expect, it } from "vitest";
import { AxiError } from "../packages/core/src/errors.js";
import { assertReadOnly, mainVerb, statements, tokenize } from "../packages/core/src/sql.js";

function refusal(sql: string): string | undefined {
  try {
    assertReadOnly(sql);
    return undefined;
  } catch (error) {
    if (!(error instanceof AxiError)) throw error;
    return `${error.code}: ${error.message}`;
  }
}

describe("read-only guard - allowed", () => {
  it.each([
    "SELECT 1",
    "select * from orders where id = 1",
    "SELECT 1;",
    "  SELECT 1 ;  -- trailing comment",
    "(SELECT 1) UNION (SELECT 2)",
    "WITH recent AS (SELECT * FROM orders) SELECT * FROM recent",
    "WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5) SELECT i FROM n",
    "WITH a AS (SELECT 1), b (x) AS (SELECT 2) (SELECT * FROM a)",
    "SHOW TABLES",
    "SHOW CREATE TABLE orders",
    "SHOW FULL PROCESSLIST",
    "DESC orders",
    "DESCRIBE orders",
    "EXPLAIN SELECT * FROM orders",
    "EXPLAIN FORMAT=TREE SELECT 1",
    "TABLE orders",
    "SELECT 'DROP TABLE x; INTO OUTFILE' AS s",
    "SELECT `into`, `lock`, `sleep` FROM t",
    'SELECT "it\'s" AS s',
    "SELECT 'it''s' AS s",
    "SELECT * FROM t WHERE note = 'a;b'",
    "SELECT /* a plain comment; DROP TABLE x */ 1",
    "SELECT 1 # comment ; DROP\n",
    "SELECT @@version, @x := 1",
    "SELECT CAST(x AS CHAR CHARACTER SET utf8mb4) FROM t",
    "SELECT created_at, updated_by, drop_reason FROM t",
    "SELECT 1--1",
    "SELECT * FROM t ORDER BY id DESC LIMIT 5",
  ])("%s", (sql) => {
    expect(refusal(sql)).toBeUndefined();
  });
});

describe("read-only guard - refused", () => {
  it.each([
    ["DROP TABLE orders", "'DROP' statements"],
    ["INSERT INTO t VALUES (1)", "'INSERT'"],
    ["UPDATE t SET a = 1", "'UPDATE'"],
    ["DELETE FROM t", "'DELETE'"],
    ["REPLACE INTO t VALUES (1)", "'REPLACE'"],
    ["CREATE TABLE t (a INT)", "'CREATE'"],
    ["ALTER TABLE t ADD c INT", "'ALTER'"],
    ["TRUNCATE t", "'TRUNCATE'"],
    ["SET GLOBAL max_connections = 1", "'SET'"],
    ["SET SESSION transaction_read_only = OFF", "'SET'"],
    ["FLUSH TABLES", "'FLUSH'"],
    ["KILL 42", "'KILL'"],
    ["SHUTDOWN", "'SHUTDOWN'"],
    ["CALL p()", "'CALL'"],
    ["DO SLEEP(1)", "'DO'"],
    ["HANDLER t OPEN", "'HANDLER'"],
    ["LOCK TABLES t READ", "'LOCK'"],
    ["GRANT ALL ON *.* TO x", "'GRANT'"],
    ["USE other", "'USE'"],
    ["LOAD DATA INFILE '/x' INTO TABLE t", "'LOAD'"],
    ["ANALYZE TABLE t", "'ANALYZE'"],
    ["SELECT 1; DROP TABLE t", "one statement per call"],
    ["SELECT 1; SELECT 2", "one statement per call"],
    ["SELECT * INTO OUTFILE '/tmp/x' FROM t", "INTO"],
    ["SELECT * FROM t INTO DUMPFILE '/tmp/x'", "INTO"],
    ["SELECT 1 INTO @v", "INTO"],
    ["TABLE t INTO OUTFILE '/tmp/x'", "INTO"],
    ["SELECT * FROM t FOR UPDATE", "FOR UPDATE"],
    ["SELECT * FROM t FOR SHARE", "FOR SHARE"],
    ["SELECT * FROM t LOCK IN SHARE MODE", "LOCK"],
    ["SELECT SLEEP(10)", "SLEEP"],
    ["SELECT sleep (10)", "SLEEP"],
    ["SELECT BENCHMARK(1e9, MD5('x'))", "BENCHMARK"],
    ["SELECT GET_LOCK('x', 10)", "GET_LOCK"],
    ["SELECT RELEASE_ALL_LOCKS()", "RELEASE_ALL_LOCKS"],
    ["SELECT LOAD_FILE('/etc/passwd')", "LOAD_FILE"],
    ["SELECT SOURCE_POS_WAIT('f', 4)", "replication"],
    ["EXPLAIN ANALYZE SELECT * FROM t", "ANALYZE"],
    ["DESCRIBE ANALYZE SELECT 1", "ANALYZE"],
    ["WITH x AS (SELECT 1) DELETE FROM t", "WITH ... DELETE"],
    ["WITH x AS (SELECT 1) UPDATE t SET a = 1", "WITH ... UPDATE"],
    ["/*!50000 DROP TABLE t */", "executable comments"],
    ["SELECT 1 /*!50000 ; DROP TABLE t */", "executable comments"],
    ["SELECT /*+ SET_VAR(transaction_read_only = 0) */ 1", "optimizer hints"],
    // Hides a second statement from a lexer that honours backslash escapes, but
    // not from a server running NO_BACKSLASH_ESCAPES.
    ["SELECT 'a\\' ; DROP TABLE t; -- '", "one statement per call"],
  ])("%s", (sql, reason) => {
    const message = refusal(sql);
    expect(message).toMatch(/^READ_ONLY: refused by the read-only guard/);
    expect(message).toContain(reason);
  });

  it.each([
    ["", "empty"],
    ["   -- only a comment", "empty"],
    ["SELECT 'unterminated", "unterminated string"],
    ["SELECT `unterminated", "unterminated quoted identifier"],
    ["SELECT 1 /* open", "unterminated comment"],
    ["SELECT 1 /*!50000 open", "unterminated"],
    ["SELECT '\0'", "NUL"],
  ])("rejects malformed SQL: %j", (sql, reason) => {
    const message = refusal(sql);
    expect(message).toMatch(/^VALIDATION_ERROR/);
    expect(message).toContain(reason);
  });
});

describe("tokenizer", () => {
  it("drops comments and keeps quoted text opaque", () => {
    const { tokens } = tokenize("SELECT `a b`, 'x;y' -- c\n FROM t /* d */");
    expect(tokens.map((t) => `${t.kind}:${t.text}`)).toEqual(["word:select", "ident:`a b`", "punct:,", "string:'x;y'", "word:from", "word:t"]);
  });

  it("lexes the body of an executable comment as code", () => {
    const result = tokenize("/*!40101 SET NAMES utf8 */");
    expect(result.executableComment).toBe(true);
    expect(result.tokens.map((t) => t.text)).toEqual(["set", "names", "utf8"]);
  });

  it("finds the verb behind a WITH clause", () => {
    const verb = (sql: string) => mainVerb(statements(tokenize(sql).tokens)[0]!);
    expect(verb("WITH a AS (SELECT 1), b AS (SELECT 2) DELETE FROM t")).toBe("delete");
    expect(verb("WITH RECURSIVE a (x) AS (SELECT 1) SELECT * FROM a")).toBe("select");
    expect(verb("((SELECT 1))")).toBe("select");
  });
});
