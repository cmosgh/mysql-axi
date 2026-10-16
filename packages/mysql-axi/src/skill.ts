import { createSkillMarkdown } from "../../core/src/skill.js";
import { DESCRIPTION } from "./cli.js";

export const skillMarkdown = (): string =>
  createSkillMarkdown({
    name: "mysql-axi",
    trigger:
      "Read-only MySQL access through the mysql-axi CLI - list databases and tables, describe columns, indexes and foreign keys, sample rows, run capped SELECT/SHOW/EXPLAIN queries. " +
      "Use whenever a task needs to look at data or schema in a MySQL database. It cannot change data.",
    description: DESCRIPTION,
  });
