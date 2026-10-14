---
title: 'Inventory of post-backfill passes vs the live indexer, 2026-10-14'
type: research
status: developing
spawned_from: null
spawns: []
---

# Post-backfill passes vs live, 2026-10-14

Read-only: code on `develop` and `chq` reads (`testnet`: backfill 2–4,991,999,
live from 4,992,000; `default` = mainnet). Root mechanism: `run` passes empty
maps for the cross-ledger lookups live makes
(`crates/backfill-runner/src/sink.rs:259-265`), and the lookups it does make
(SAC map, contract metadata) cannot see rows written earlier in the same
64k-ledger partition, whose inserts commit at its end. Live looks up and
commits per ledger (`crates/db-clickhouse/src/persist.rs:113-134`,
`crates/indexer/src/handler/mod.rs:399`).

Classes: **a** spent · **b** covers a backfill-vs-live gap · **c** needs data
the ledgers do not carry (RPC, snapshot, internet) · **d** a defect live shares.

| pass                                                                                                       | writes                           | live covers?                               | when needed                                      | indexer stop   | task     | class           |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------ | ------------------------------------------------ | -------------- | -------- | --------------- |
| executable repair SQL (0640)                                                                               | `soroban_contracts` executable   | yes                                        | after every `run`                                | no             | 0640     | b               |
| `contract-type-rebuild`                                                                                    | `contract_type`, type-3 `assets` | partly (no reclass on upgrade, 0325)       | after every `run`, after the executable repair   | yes (EXCHANGE) | 0309     | b               |
| `nft-reclassify`                                                                                           | pending → `nfts`, deletes        | partly (routes new events, never promotes) | after every `run`, after the rebuild             | grey (DELETE)  | 0392     | b               |
| `contract-metadata-backfill`                                                                               | `soroban_contract_metadata`      | yes; `run` misses same-partition uploads   | after every `run`                                | no             | —        | b               |
| `repair-tier1`                                                                                             | `accounts.first_seen_ledger`     | no, live has the same bug                  | after any ingest                                 | yes (EXCHANGE) | 0421     | d               |
| `bootstrap`                                                                                                | account seq / home domain        | no, live writes `seq = 0` skeletons too    | always; `run` calls it when an RPC URL is set    | grey           | 0421     | d / c           |
| `balance-seed`                                                                                             | holder balances                  | only on an observed change                 | DB not starting at genesis                       | no             | 0502     | c               |
| `wasm-code-backfill`                                                                                       | `wasm_programs.code`             | yes since c18ba8805                        | programs before the writer / first ledger        | no             | —        | c               |
| `contract-instance-backfill`                                                                               | `contract_instances`             | yes since b5b97b79b                        | instances before the writer / first ledger       | no             | —        | c               |
| `snapshot-seed`                                                                                            | state from the checkpoint        | no (absences never stream)                 | after a re-parse with changed code; mainnet only | —              | 0503     | c               |
| `enrich` (SEP-1, NFT metadata)                                                                             | enrichment tables                | yes, live queues it; `run` queues nothing  | after every `run`                                | no             | —        | c (queueing: b) |
| in-DB migrations 0517, 0541, 0575, 0372, 0586, 0580; pool passes 0374 / 0518; `enrich nft-collection-name` | their tables                     | yes, same writer                           | spent                                            | —              | archived | a               |

## Measured gaps no pass covers or nobody ran

| gap                                                    |                                                testnet |                        mainnet |
| ------------------------------------------------------ | -----------------------------------------------------: | -----------------------------: |
| balance rows keyed under a SAC's own id (SAC map miss) | 22,498 rows, 6,187 SACs (22,489 rows before 4,992,000) | 580 rows, 144 SACs (task 0571) |
| `wasm_programs` without code (`FINAL`)                 |                                       47,419 of 49,506 |                              0 |
| `contract_instances` rows                              |                               14,607 (≈ live era only) |                     backfilled |

- `run` queues no enrichment; only the testnet runbook says to run `enrich`.
- `run` logs a bootstrap failure as a warning and carries on
  (`crates/backfill-runner/src/run.rs:242-247`), against the loud-errors rule.
- Unverified: `docs/backups.md` says a restore gap must be filled with `run`,
  but the indexer reconciles from `max(sequence) + 1`
  (`crates/indexer/src/handler/mod.rs:244-311`), so it may refill a gap at the
  top itself, with live semantics. Depends on the lake still holding the files.

## Stale claims found

- `repair-tier1` column count: README says 4, `docs/backfills.md` says 10, code
  rebuilds 1.
- README "What survives" omits five passes; its `stage.rs:699` reference moved.
- `docs/backfills.md` "After any backfill" omits `contract-type-rebuild`,
  `nft-reclassify`, `contract-metadata-backfill`, `enrich`; lines 283-293 list
  `nft-reclassify` both as "no stop" and in the grey zone.
