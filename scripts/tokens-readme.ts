// Writes the tables from test/tokens/results/<suite>/*.json into the mysql-axi README. Run after test:tokens.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderReadme, updateReadme, type Results, type Suite } from "../test/tokens/report.js";

const ORDER = ["haiku", "sonnet", "opus"];
const rank = (model: string) => (ORDER.indexOf(model) + ORDER.length + 1) % (ORDER.length + 1);
for (const suite of ["efficiency", "accuracy", "large"] as Suite[]) {
  const dir = join("test/tokens/results", suite);
  if (!existsSync(dir)) continue;
  const all = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "smoke.json")
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as Results)
    .sort((a, b) => rank(a.model) - rank(b.model));
  if (all.length === 0) continue;
  updateReadme("packages/mysql-axi/README.md", suite, renderReadme(suite, all));
  console.log(`${suite}: README updated from ${all.map((r) => `${r.model} (${r.results.length} runs)`).join(", ")}`);
}
