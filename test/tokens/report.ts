// Shared by the token suite (writes results/<suite>/<model>.json) and scripts/tokens-readme.ts (writes the README).
import { readFileSync, writeFileSync } from "node:fs";

export type Arm = "plain" | "axi" | "axi_home";
export type Suite = "efficiency" | "accuracy";

/** One results file per suite and model: test/tokens/results/<suite>/<model>.json. */
export interface Results {
  suite: Suite;
  model: string;
  runs: number;
  date: string;
  /** Versions, prompts and the home view the runs used, so a file explains itself. */
  setup: Record<string, unknown>;
  results: Run[];
}

/** One Bash call of an agent run. */
export interface Call {
  command: string;
  outputChars: number;
  isError: boolean;
  /** First 200 characters of the output. */
  preview: string;
}

export interface Run {
  arm: Arm;
  task: string;
  correct: boolean;
  answer: string;
  turns: number;
  toolCalls: number;
  /** Characters returned by tools into the context; /4 approximates tokens. */
  toolOutputChars: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
  calls: Call[];
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const totalTokens = (r: Run) => r.inputTokens + r.cacheCreationTokens + r.cacheReadTokens + r.outputTokens;
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (value: number, base: number) => (base === 0 ? "" : ` (${value <= base ? "−" : "+"}${Math.abs(Math.round((1 - value / base) * 100))}%)`);

export const ARM_LABELS: Record<Arm, string> = { plain: "plain", axi: "axi", axi_home: "axi+home" };

interface Stat {
  correct: number;
  n: number;
  turns: number;
  tool: number;
  tokens: number;
  cost: number;
}

/** Medians per task for one arm; `total` sums those medians over the tasks. */
function stats(runs: Run[], arm: Arm): { perTask: Map<string, Stat>; total: Stat } {
  const perTask = new Map<string, Stat>();
  const total: Stat = { correct: 0, n: 0, turns: 0, tool: 0, tokens: 0, cost: 0 };
  for (const task of new Set(runs.map((r) => r.task))) {
    const rs = runs.filter((r) => r.task === task && r.arm === arm);
    if (rs.length === 0) continue;
    const s: Stat = {
      correct: rs.filter((r) => r.correct).length,
      n: rs.length,
      turns: median(rs.map((r) => r.turns)),
      tool: median(rs.map((r) => r.toolOutputChars / 4)),
      tokens: median(rs.map(totalTokens)),
      cost: median(rs.map((r) => r.costUsd)),
    };
    perTask.set(task, s);
    for (const key of Object.keys(total) as Array<keyof Stat>) total[key] += s[key];
  }
  return { perTask, total };
}

const armsIn = (runs: Run[]): Arm[] => (Object.keys(ARM_LABELS) as Arm[]).filter((arm) => runs.some((r) => r.arm === arm));
const modelName = (results: Results): string => [...new Set(results.results.map((r) => r.model))].join("; ") || results.model;

/** Per-task medians for one model; cells list the arms in order. */
export function renderTable(results: Results): string {
  const arms = armsIn(results.results);
  const byArm = arms.map((arm) => stats(results.results, arm));
  const lines = [
    `| Task | Correct | Turns | Tool output tokens ≈ | Total tokens | Cost USD |`,
    "|---|---|---|---|---|---|",
  ];
  for (const task of byArm[0]!.perTask.keys()) {
    const cells = byArm.map((a) => a.perTask.get(task)!);
    const col = (f: (s: Stat) => string) => cells.map(f).join(" / ");
    lines.push(`| ${task} | ${col((s) => `${s.correct}/${s.n}`)} | ${col((s) => String(s.turns))} | ${col((s) => fmt(s.tool))} | ${col((s) => fmt(s.tokens))} | ${col((s) => s.cost.toFixed(3))} |`);
  }
  return [`\`${modelName(results)}\`, ${results.runs} runs per task and arm, ${results.date.slice(0, 10)}. Cells: ${arms.map((a) => ARM_LABELS[a]).join(" / ")}.`, "", ...lines].join("\n");
}

const ARMS_TEXT = [
  "- **plain**: the `mysql` command-line client, which the model already knows.",
  "- **axi**: `mysql-axi` with no prior context, so the agent first discovers it (`--help`).",
  "- **axi+home**: `mysql-axi` with its home view in the system prompt, as `mysql-axi setup hooks` does at session start.",
];

const INTRO: Record<Suite, string[]> = {
  efficiency: [
    "Headless Claude Code (Bash only, no MCP servers or user settings), each model in its own run against its own throwaway MySQL with the same seeded data (about 1k customers, 10k orders, long-text articles) and the same account. Totals sum the per-task medians over all tasks; percentages compare with plain for the same model.",
    "",
    ...ARMS_TEXT,
    "",
    "Total tokens include the cached system prompt that every turn re-reads, so a saved turn matters as much as smaller output. Every run (commands, output sizes, answers, versions, prompts) is in `test/tokens/results/efficiency/`. Reproduce with `TOKENS_MODEL=<model> pnpm run test:tokens`, then `pnpm run tokens:readme`.",
  ],
  accuracy: [
    "Same setup as above, with tasks built as traps where a tool's output can lead to a wrong answer: more matching rows than the 50-row cap, the deciding sentence at the end of a long text, the text 'NULL' next to SQL NULL, ids above 2^53 that lose precision as doubles, and an exact money total. Answers are checked strictly against values computed from the database.",
    "",
    "Runs are in `test/tokens/results/accuracy/`. Reproduce with `TOKENS_SUITE=accuracy TOKENS_MODEL=<model> pnpm run test:tokens`, then `pnpm run tokens:readme`.",
  ],
};

/** README section for one suite: one summary row per model and arm, then per-task tables. */
export function renderReadme(suite: Suite, all: Results[]): string {
  const summary = ["| Model | Arm | Correct | Turns | Tool output tokens ≈ | Total tokens | Cost USD |", "|---|---|---|---|---|---|---|"];
  for (const results of all) {
    const arms = armsIn(results.results);
    const base = stats(results.results, arms[0]!).total;
    for (const arm of arms) {
      const t = stats(results.results, arm).total;
      const vs = (value: number, of: number) => (arm === arms[0] ? "" : pct(value, of));
      summary.push(
        `| ${modelName(results)} | ${ARM_LABELS[arm]} | ${t.correct}/${t.n} | ${t.turns} | ${fmt(t.tool)}${vs(t.tool, base.tool)} | ${fmt(t.tokens)}${vs(t.tokens, base.tokens)} | ${t.cost.toFixed(3)}${vs(t.cost, base.cost)} |`,
      );
    }
  }
  return [
    ...INTRO[suite],
    "",
    ...summary,
    ...all.flatMap((results) => ["", `<details><summary>Per task: ${modelName(results)}</summary>`, "", renderTable(results), "", "</details>"]),
  ].join("\n");
}

const MARKER: Record<Suite, string> = { efficiency: "token-usage", accuracy: "accuracy" };

/** Replaces the text between the suite's README markers. */
export function updateReadme(file: string, suite: Suite, content: string): void {
  const text = readFileSync(file, "utf-8");
  const start = `<!-- ${MARKER[suite]}:start -->`;
  const end = `<!-- ${MARKER[suite]}:end -->`;
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1) throw new Error(`${file} has no ${start} ... ${end} markers`);
  writeFileSync(file, `${text.slice(0, from + start.length)}\n${content}\n${text.slice(to)}`);
}