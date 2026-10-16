import { createSkillMarkdown } from "../../core/src/skill.js";
import { DESCRIPTION } from "./cli.js";

export const skillMarkdown = (): string =>
  createSkillMarkdown({
    name: "mysql-rw-axi",
    trigger:
      "WRITE ACCESS to LOCAL MySQL databases through the mysql-rw-axi CLI - run INSERT/UPDATE/DELETE/DDL with exec, load dumps with import, create and drop databases. " +
      "Use only when a task must change a local dev database; use mysql-axi for reading or for any non-local database.",
    description: DESCRIPTION,
    notice:
      "> **WARNING - this tool can modify and drop data.** It only connects to loopback hosts and unix sockets, but an SSH tunnel to 127.0.0.1 also counts as loopback. Irreversible statements preview until `--confirm`; read the preview before confirming.",
  });
