---
id: '0641'
title: 'RESEARCH: a backfill must equal live — retire every post-backfill repair pass'
type: RESEARCH
status: backlog
related_adr: ['0052']
related_tasks: ['0640', '0425', '0421', '0497', '0392', '0309', '0564']
tags: [backend, clickhouse, backfill, data-quality, priority-high, effort-large]
links: []
history:
  - date: '2026-10-14'
    status: backlog
    who: karolkow
    note: >
      Asked by the owner after task 0640: no pass should be required after a
      backfill. Indexing itself must give the final result, in any order and
      in parallel. Starts after 0640's code fix.
---

# A backfill must equal live — retire every post-backfill repair pass

## Summary

Goal (owner, 2026-10-14): `backfill-runner run` over any range, in any order,
in parallel, gives the same database as the live indexer, with no pass to run
afterwards. Today it does not. Task 0640 found three losses on testnet, because
nobody ran three passes nobody remembered: contract upgrades (18,136
contracts), contract classification (3 of 691,588 backfilled contracts
classified) and NFT routing (189,770 tokens in `nfts_pending`).

## Context

The backfill path passes empty maps for every cross-ledger lookup the live
writer makes (`crates/backfill-runner/src/sink.rs:256-265`). Each lookup was
then covered by a batch pass. `crates/backfill-runner/README.md` already states
the rule ("If it cannot be expressed as replay live logic over old data, live
has a hole") and marks four survivors as recurring mops. This task finishes
that list.

## Scope — every pass `docs/backfills.md` or a runbook asks for after a backfill

For each: what it restores, why `run` cannot write it, whether live writes it,
the from-scratch shape that makes it unnecessary, and its existing task.

| pass                                               | restores                                             | existing task |
| -------------------------------------------------- | ---------------------------------------------------- | ------------- |
| executable repair (0640 SQL)                       | contract upgrades                                    | 0640          |
| `contract-type-rebuild`                            | classification of code uploaded in an earlier ledger | 0309          |
| `nft-reclassify`                                   | NFT events of contracts classified later             | 0392          |
| `repair-tier1`                                     | `accounts.first_seen_ledger` (MIN)                   | 0421 / 0497   |
| `contract-metadata-backfill`                       | metadata of code uploaded earlier in a partition     | —             |
| `contract-instance-backfill`, `wasm-code-backfill` | RPC reads (state the ledgers may not carry)          | —             |
| `bootstrap`, `balance-seed`                        | RPC snapshots of untouched accounts / holders        | 0421          |
| `enrich` (testnet runbook step 8)                  | asset / NFT enrichment the indexer queues            | —             |

The likely common shape (to prove, not assume): append-only facts written
identically by live and backfill, with the "current" value derived by version
(ledger) at write or read time. No writer reads its own table first.

## Acceptance Criteria

- [ ] Each pass above: kept (with the fact that requires it, e.g. data only in
      an RPC snapshot) or replaced, with its task.
- [ ] A test that backfills a fixture range in two parallel, out-of-order
      halves and compares the result with a sequential live run.
- [ ] "After any backfill" in `docs/backfills.md` holds only the passes kept.

## Out

- Each replacement is its own task and PR; this one decides the list.
