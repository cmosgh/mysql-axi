// The safety matrix: what an agent's statement does through each tool. safety.test.ts checks every
// cell against a throwaway server; scripts/safety-readme.ts renders it, so the README states only what CI verified.

export type Arm = "mysql" | "mcp" | "axi";

export const ARM_TITLES: Record<Arm, string> = {
  mysql: "`mysql` client",
  mcp: "`mysql-mcp-server` 0.1.4",
  axi: "`mysql-axi`",
};

/** What happened, as the test observes it. `ran` means the effect is on the server afterwards; `answered` is a read that worked. */
export type Outcome = "ran" | "refused" | "failed" | `rows ${number}` | "ran; released on exit" | "answered";

export interface SafetyCase {
  id: string;
  /** README row label. */
  title: string;
  /** `read`: something an agent legitimately needs, which should work. */
  kind: "read" | "accident" | "bypass";
  sql: string;
  expected: Record<Arm, Outcome>;
  /** Characters the agent gets back, checked within 10%; /4 approximates tokens. */
  outputChars?: Record<Arm, number>;
  /** What a refusal tells the agent to do instead; `contains` is checked against the output. */
  hint?: Partial<Record<Arm, { contains: string; label: string }>>;
}

export const SAFETY_CASES: SafetyCase[] = [
  {
    id: "explain-select",
    title: "`EXPLAIN` a `SELECT` - does it use an index?",
    kind: "read",
    sql: "EXPLAIN SELECT * FROM orders WHERE customer_id = 7",
    expected: { mysql: "answered", mcp: "answered", axi: "answered" },
  },
  {
    id: "explain-update",
    title: "`EXPLAIN UPDATE` - would the update use an index?",
    kind: "read",
    sql: "EXPLAIN UPDATE orders SET status = 'paid' WHERE customer_id = 7",
    expected: { mysql: "answered", mcp: "refused", axi: "refused" },
    hint: { axi: { contains: "explain the matching SELECT instead", label: "refused; says to explain the matching `SELECT`" } },
  },
  {
    id: "explain-analyze",
    title: "`EXPLAIN ANALYZE` - runs the query and times it",
    kind: "read",
    sql: "EXPLAIN ANALYZE SELECT COUNT(*) FROM orders WHERE status = 'paid'",
    expected: { mysql: "answered", mcp: "answered", axi: "refused" },
    hint: { axi: { contains: "explain --analyze", label: "refused; points to `explain --analyze` (read-only; time-capped)" } },
  },
  {
    id: "update-all",
    title: "`UPDATE` without `WHERE`",
    kind: "accident",
    sql: "UPDATE orders SET status = 'cancelled'",
    expected: { mysql: "ran", mcp: "refused", axi: "refused" },
  },
  {
    id: "delete",
    title: "`DELETE`",
    kind: "accident",
    sql: "DELETE FROM orders WHERE status = 'refunded'",
    expected: { mysql: "ran", mcp: "refused", axi: "refused" },
  },
  {
    id: "drop",
    title: "`DROP TABLE`",
    kind: "accident",
    sql: "DROP TABLE reviews",
    expected: { mysql: "ran", mcp: "refused", axi: "refused" },
  },
  {
    id: "second-statement",
    title: "a second statement after a `SELECT`",
    kind: "accident",
    sql: "SELECT COUNT(*) FROM orders; DELETE FROM orders",
    expected: { mysql: "ran", mcp: "refused", axi: "refused" },
  },
  {
    id: "select-all",
    title: "`SELECT *` on a 10,000-row table",
    kind: "accident",
    sql: "SELECT * FROM orders",
    expected: { mysql: "rows 10000", mcp: "rows 1000", axi: "rows 50" },
    outputChars: { mysql: 705_700, mcp: 212_600, axi: 4_050 },
  },
  {
    id: "outfile-executable-comment",
    title: "`INTO OUTFILE` inside an executable comment `/*! */`",
    kind: "bypass",
    sql: "SELECT id FROM orders /*! INTO OUTFILE '/tmp/safety-a.csv' */",
    expected: { mysql: "ran", mcp: "ran", axi: "refused" },
  },
  {
    id: "outfile-comment-gap",
    title: "`INTO/**/OUTFILE` (a comment instead of a space)",
    kind: "bypass",
    sql: "SELECT id FROM orders INTO/**/OUTFILE '/tmp/safety-b.csv'",
    expected: { mysql: "ran", mcp: "ran", axi: "refused" },
  },
  {
    id: "get-lock",
    title: "`GET_LOCK` - a named lock a deploy or migration waits on",
    kind: "bypass",
    sql: "SELECT GET_LOCK('deploy', 0)",
    expected: { mysql: "ran; released on exit", mcp: "ran", axi: "refused" },
  },
  {
    id: "explain-analyze-function",
    title: "`EXPLAIN ANALYZE` of a stored function that writes - it executes",
    kind: "bypass",
    sql: "EXPLAIN ANALYZE SELECT bump()",
    expected: { mysql: "ran", mcp: "ran", axi: "refused" },
  },
  {
    id: "sleep",
    title: "`SLEEP` - holds a connection",
    kind: "bypass",
    sql: "SELECT SLEEP(3)",
    expected: { mysql: "ran", mcp: "ran", axi: "refused" },
  },
  {
    id: "writing-function",
    title: "a stored function that writes a table",
    kind: "bypass",
    sql: "SELECT bump()",
    expected: { mysql: "ran", mcp: "ran", axi: "failed" },
  },
  {
    id: "set-global-function",
    title: "a definer function that runs `SET GLOBAL`",
    kind: "bypass",
    sql: "SELECT tune()",
    expected: { mysql: "ran", mcp: "ran", axi: "ran" },
  },
];
