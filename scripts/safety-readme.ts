// Renders the safety matrix that test/integration/safety.test.ts verifies into the mysql-axi README.
//
//   pnpm run safety:readme            # write the table
//   pnpm run safety:readme -- --check # exit 1 if the README table is stale
import { readFileSync, writeFileSync } from "node:fs";
import { ARM_TITLES, SAFETY_CASES, type Arm, type Outcome } from "../test/integration/safety-cases.js";

const FILE = "packages/mysql-axi/README.md";
const START = "<!-- safety:start -->";
const END = "<!-- safety:end -->";
const ARMS = Object.keys(ARM_TITLES) as Arm[];

function label(arm: Arm, outcome: Outcome, chars: number | undefined, hint: string | undefined, read: boolean): string {
  if (hint) return hint;
  if (read && outcome === "refused") return "refused";
  if (outcome === "answered") return "works";
  if (outcome === "ran") return "**ran**";
  if (outcome === "refused") return "blocked by the tool";
  if (outcome === "failed") return arm === "axi" ? "blocked by the read-only transaction" : "blocked by the server";
  if (outcome === "ran; released on exit") return "ran; released when the client exits";
  const rows = Number(outcome.slice("rows ".length)).toLocaleString("en-US");
  return chars === undefined ? `${rows} rows` : `${rows} rows; ≈${Math.round(chars / 4000).toLocaleString("en-US")}k tokens`;
}

const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
const table = (kind: "read" | "accident" | "bypass") =>
  SAFETY_CASES.filter((c) => c.kind === kind).map((c) =>
    row([c.title, ...ARMS.map((arm) => label(arm, c.expected[arm], c.outputChars?.[arm], c.hint?.[arm]?.label, kind === "read"))]),
  );

const content = [
  row(["Statement from the agent", ...ARMS.map((arm) => ARM_TITLES[arm])]),
  row(["---", ...ARMS.map(() => "---")]),
  row(["*Reads an agent needs*", ...ARMS.map(() => "")]),
  ...table("read"),
  row(["*Mistakes*", ...ARMS.map(() => "")]),
  ...table("accident"),
  row(["*Ways around a keyword filter*", ...ARMS.map(() => "")]),
  ...table("bypass"),
].join("\n");

const text = readFileSync(FILE, "utf-8");
const from = text.indexOf(START);
const to = text.indexOf(END);
if (from === -1 || to === -1) throw new Error(`${FILE} has no ${START} ... ${END} markers`);
const next = `${text.slice(0, from + START.length)}\n${content}\n${text.slice(to)}`;
if (process.argv.includes("--check")) {
  if (next !== text) {
    console.error(`The safety table in ${FILE} is out of date. Run \`pnpm run safety:readme\` and commit the result.`);
    process.exit(1);
  }
  console.log("Safety table is up to date.");
} else {
  writeFileSync(FILE, next);
  console.log(`${FILE}: safety table written (${SAFETY_CASES.length} statements)`);
}
