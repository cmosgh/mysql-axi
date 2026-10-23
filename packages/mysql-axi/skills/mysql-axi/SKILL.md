---
name: mysql-axi
description: "Read-only MySQL access through the mysql-axi CLI - list databases and tables, describe columns, indexes and foreign keys, sample rows, run capped SELECT/SHOW/EXPLAIN queries. Use whenever a task needs to look at data or schema in a MySQL database. It cannot change data."
user-invocable: false
---

# mysql-axi

READ-ONLY MySQL CLI for agents - explore schemas and run capped read queries, with TOON output. Writes are refused by a client-side guard plus a read-only session (not a grant check).

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- `npx -y mysql-axi` for a live overview of the configured connection
- `npx -y mysql-axi --help` for the command index
- `npx -y mysql-axi <command> --help` for per-command flags and examples

Connecting is a one-time, user-performed step: `printf %s "$DB_PASSWORD" | npx -y mysql-axi auth login --profile <name> --host <host> --user <user> --password-stdin`. Never ask for the password in chat or pass it as an argument.
