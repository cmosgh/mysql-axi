---
name: mysql-rw-axi
description: "WRITE ACCESS to LOCAL MySQL databases through the mysql-rw-axi CLI - run INSERT/UPDATE/DELETE/DDL with exec, load dumps with import, create and drop databases. Use only when a task must change a local dev database; use mysql-axi for reading or for any non-local database."
user-invocable: false
---

# mysql-rw-axi

> **WARNING - this tool can modify and drop data.** It only connects to loopback hosts and unix sockets, but an SSH tunnel to 127.0.0.1 also counts as loopback. Irreversible statements preview until `--confirm`; read the preview before confirming.

WRITE ACCESS - MySQL CLI for agents that CAN MODIFY AND DROP DATA on loopback databases (local dev): exec, import, db create/drop, plus every read-only mysql-axi command. Irreversible statements preview until --confirm. Use mysql-axi for anything that is not local.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- `npx -y mysql-rw-axi` for a live overview of the configured connection
- `npx -y mysql-rw-axi --help` for the command index
- `npx -y mysql-rw-axi <command> --help` for per-command flags and examples

Connecting is a one-time, user-performed step: `printf %s "$DB_PASSWORD" | npx -y mysql-rw-axi auth login --profile <name> --host <host> --user <user> --password-stdin`. Never ask for the password in chat or pass it as an argument.
