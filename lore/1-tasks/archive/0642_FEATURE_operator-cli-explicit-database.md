---
id: '0642'
title: 'Operator CLIs require an explicit ClickHouse database'
type: FEATURE
status: completed
related_adr: ['0052']
related_tasks: ['0640', '0641', '0553']
tags: [backend, clickhouse, security, ops, priority-medium, effort-small]
links: []
history:
  - date: '2026-10-15'
    status: active
    who: karolkow
    note: >
      Asked by the owner after the testnet repairs of task 0640 ran with the
      operator write certificate, whose ClickHouse user reads and writes every
      database. Chosen: a guard in the tools, not a new testnet-only user.
---

# Operator CLIs require an explicit ClickHouse database

## Summary

`backfill-runner` and `enrich` fall back to mainnet's `default` database when
`CLICKHOUSE_DATABASE` is unset. The operator's write certificate maps to
`dev_shared`, which holds READ and WRITE on every database
(`system.grants`, measured 2026-10-15), so a testnet command that forgets the
variable writes to mainnet. Both CLIs build their client in one function,
`db_clickhouse::mtls::client_from_cli_flags`; it now requires the variable,
prints the database it will use, and stops with a message when it is unset.
Lambdas keep `database_from_env`'s default (mainnet sets nothing, ADR 0052).

## Stan teraz

- Done: merged in #664 (2026-10-15).
- Next: nothing; raw SQL through the write client stays uncovered.
- In force: raw SQL through the operator's write client is not covered; a
  testnet-only admin user was weighed and not chosen.

## Acceptance Criteria

- [x] Unset `CLICKHOUSE_DATABASE`: `backfill-runner` and `enrich` stop at
      startup with a message naming both databases.
- [x] Set: the run prints `ClickHouse database: <name>` and proceeds.
- [x] Operator docs say the variable is required (`docs/backfills.md`, both
      crate READMEs, both crate docs).
- [x] **Docs updated** — `docs/backfills.md`: updated.
      `docs/architecture/**`: N/A — no shape of the system changes.
