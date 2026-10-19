---
id: '0649'
title: 'Protocol 30: bump stellar-xdr 28 → 30 and soroban-env-host 29 → 30 before the vote'
type: FEATURE
status: active
related_adr: ['0026', '0061']
related_tasks: ['0646', '0605', '0548', '0620']
tags: [xdr, ingestion, protocol-30, priority-high, effort-small]
links:
  - https://github.com/stellar/stellar-protocol/blob/master/core/cap-0084.md
  - https://github.com/stellar/stellar-protocol/blob/master/core/cap-0087.md
  - https://github.com/stellar/stellar-protocol/blob/master/core/cap-0088.md
  - https://github.com/stellar/stellar-horizon/pull/237
  - https://crates.io/crates/stellar-xdr/30.0.0
  - https://crates.io/crates/soroban-env-host/30.0.0
history:
  - date: '2026-10-19'
    status: active
    who: karolkow
    note: >
      Created after the 0646 watch logic reported LAGGING against live data:
      core 30.0.0 supports protocol 30, mainnet and testnet run 29, and
      soroban-env-host 30.0.0 on stellar-xdr 30.0.0 is on crates.io.
---

# Protocol 30: stellar-xdr and soroban-env-host bump

## Summary

Protocol 30 changes the XDR (CAP-0084, CAP-0087, CAP-0088). CAP-0088 makes the
new millisecond `StellarValueExt` arms mandatory from the first ledger after
the upgrade, so a parser on `stellar-xdr` 28 cannot decode any protocol-30
ledger: ingestion stops at the vote, on testnet first, then on mainnet. This
task moves the workspace to `stellar-xdr` 30 and makes the contract executor
work on both sides of the vote.

## Stan teraz

- Done: facts gathered (below); trial bump compiles with one match arm added;
  800 real ledgers parse identically on 28 and 30; clippy green.
- Found: `soroban-env-host` 30 runs only protocol-30 ledgers, so a plain bump
  breaks token metadata until the vote.
- Next: owner decisions in "Not yet decided", then the PR.
- Evidence: [notes/R-protocol-30-facts.md](notes/R-protocol-30-facts.md).

## Decisions so far

| Situation | What happens | Date |
| --------- | ------------ | ---- |

## Not yet decided

- How the contract executor runs on both sides of the vote.
- Scope of `W…` handling.
- When to merge, given stellar-prices-api.

## Out of scope

- Galexie protocol-30 image (follows 0605).
- Storing `closeTimeMs`: nobody asked for it; `closed_at` stays seconds.

## Acceptance Criteria

- [ ] Workspace on `stellar-xdr` 30; the executor answers on protocol-29 and
      protocol-30 ledgers.
- [ ] Workspace tests and clippy green.
- [ ] Decode check of recent mainnet and testnet ledgers recorded above.
- [ ] Each decision row has a test.
- [ ] **Docs updated** — `N/A` unless a decision changes the schema or API.
- [ ] **API types regenerated** — `Cargo.toml`/`Cargo.lock` change, so run
      `pnpm nx run @rumblefish/api-types:generate` and commit any diff.
