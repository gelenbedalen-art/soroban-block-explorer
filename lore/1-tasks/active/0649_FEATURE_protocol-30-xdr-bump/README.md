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
- Done: every protocol-30 change checked against our code
  ([notes/R-protocol-30-impact.md](notes/R-protocol-30-impact.md)).
- Done: executor on host 30 measured on production (below).
- Next: PR 1 (bump + executor); PR 2 (`W…` support) after it.
- Evidence: [notes/R-protocol-30-facts.md](notes/R-protocol-30-facts.md).

## Decisions so far

| Situation                                                                                                                  | What happens                                                                                                                                                                                                         | Date       |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A `W…` (muxed contract) address reaches the parser, DB or API                                                              | Full support: treated as its `C…` contract plus the muxed id wherever `M…` is treated as `G…` plus id; API path, filters and search accept `W…`; the UI links it to the contract page; `stellar-strkey` moves to 1.0 | 2026-10-19 |
| stellar-prices-api builds on our `xdr-parser` from `develop`                                                               | Merge after review, no waiting; its team is told before the merge that its next `xdr-parser` update must move it to `stellar-xdr` 30                                                                                 | 2026-10-19 |
| The executor runs a contract function for a ledger of any protocol (live before or after a vote, or a backfill of history) | One `soroban-env-host` (30); every run states the host's own protocol, since the host refuses any other and a read-only call pays no fee                                                                             | 2026-10-19 |

## Not yet decided

- Nothing open.

## Executor check

`backfill-runner contract-metadata-backfill --dry-run` on production
(mainnet, read-only user), 2026-10-19, built from `develop` (host 29, the
latest ledger's protocol 29) and from this branch (host 30, protocol 30):

| Build   | contracts | same as stored | different | failed | needs contract data |
| ------- | --------- | -------------- | --------- | ------ | ------------------- |
| host 29 | 4,552     | 4,378          | 0         | 115    | 59                  |
| host 30 | 4,552     | 4,378          | 0         | 115    | 59                  |

Every stored row was written by host 29, so host 30 reproduces all 4,378.
The tool logs no contract ids for `failed` / `needs contract data`; equal
counts, not proven equal sets.

## Out of scope

- Galexie protocol-30 image: task 0650 (follows 0605).
- Storing `closeTimeMs`: nobody asked for it; `closed_at` stays seconds.

## Acceptance Criteria

- [x] Workspace on `stellar-xdr` 30; the executor answers on protocol-29 and
      protocol-30 ledgers.
- [x] Workspace tests and clippy green (one failure also on `develop`:
      `pool_reserves_reconciliation`, pool `CAZ6W4WH…`, data not code).
- [x] Decode check of recent mainnet and testnet ledgers recorded above.
- [ ] Each decision row has a test.
- [ ] **Docs updated** — PR 1: `xdr-parsing-overview.md` (executor runs at
      the host's protocol), `infrastructure-overview.md` (upgrade bumps
      `soroban-env-host` too); PR 2: API address forms.
- [x] **API types regenerated** — PR 1: generator run, no diff.
