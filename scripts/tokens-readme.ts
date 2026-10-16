// Writes the token tables from test/tokens/results/*.json into the mysql-axi README. Run after test:tokens.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderReadme, updateReadme, type Results } from "../test/tokens/report.js";

const dir = "test/tokens/results";
const ORDER = ["haiku", "sonnet", "opus"];
const rank = (model: string) => (ORDER.indexOf(model) + ORDER.length + 1) % (ORDER.length + 1);
const all = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as Results)
  .sort((a, b) => rank(a.model) - rank(b.model));
updateReadme("packages/mysql-axi/README.md", renderReadme(all));
console.log(`README updated from ${all.map((r) => `${r.model} (${r.results.length} runs)`).join(", ")}`);
