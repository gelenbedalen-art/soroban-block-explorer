---
title: 'Measurements — stale executables on testnet, 2026-10-14'
type: research
status: mature
spawned_from: null
spawns: []
---

# Measurements, 2026-10-14

All reads are `chq` on the shared ClickHouse box (databases `testnet`, `default`)
or the public testnet RPC (`https://soroban-testnet.stellar.org`).

## Which path wrote the row

Testnet history was written by `backfill-runner run` for ledgers 2–4,991,999 and
by the live indexer from 4,992,000 on (0553 `notes/S-launch-2026-10-05.md`,
steps 2 and 8). Per contract with an `executable_update` SYSTEM event, classified
by its LATEST event (kind, ledger) against its `soroban_contracts FINAL` row.
"Row at upgrade" = the row's RMT version `wasm_uploaded_at_ledger` equals the
latest upgrade ledger, i.e. an upgrade row was written at all.

| last update | path            | state     | row at upgrade | contracts |
| ----------- | --------------- | --------- | -------------- | --------: |
| Wasm        | backfill        | stale     | no             |    18,135 |
| Wasm        | backfill        | NULL hash | no             |         1 |
| Wasm        | backfill        | correct   | no             |       792 |
| ExternalRef | backfill        | correct   | no             |         2 |
| Wasm        | live (≥ 4.992M) | correct   | yes            |       357 |

Rule the rows follow: **no contract whose last upgrade was backfilled has an
upgrade row (0 of 18,930); every live one has (357 of 357).** The 792 + 2
"correct" backfilled rows are the deploy row whose executable happens to equal
the latest one (an upgrade back to the original code, or a no-op upgrade). The
NULL-hash row (`CB267H7K…`) was deployed as a CAP-85 reference and later moved
to its own Wasm; its row still holds the deploy-time reference.

## The repair's output

`G-executable-repair-select.sql` on `testnet`: 18,136 rows, all to a Wasm hash,
upgrade ledgers 1,334–4,988,066 (all inside the backfilled range), 0 SACs, 0
with a NULL deployer or deploy ledger. On `default` (mainnet): 0 rows.

## Chain check (existential, stratified)

Instance entry of each contract read from testnet RPC, executable compared with
what the repair writes (or, for untouched rows, what is stored):

| sample                                                      |   n | match |
| ----------------------------------------------------------- | --: | ----: |
| repair rows, 2 per 500k-ledger bucket of the upgrade ledger |  20 |    20 |
| `CBBRUHPO…` (reported) and `CB267H7K…` (reference → Wasm)   |   2 |     2 |
| untouched backfilled Wasm rows                              |   4 |     4 |
| untouched ExternalRef rows (owner + tag from raw XDR)       |   2 |     2 |
| untouched live rows                                         |   6 |     6 |

stellar-cli 26.0.0 cannot decode a CAP-85 instance (`xdr value invalid`); the
two references were read from `--output xdr` by hand (executable discriminant
2, contract owner, tag `pocket`). Not shown: contracts upgraded on chain after
our tip — the live indexer covers those.

## Why an inline fix in `run` would not work

Share of upgrade events in the same 64,000-ledger backfill partition as the
contract's deploy (the partition's inserts are not visible until it commits,
so a prefetch cannot see that deploy row):

| database  | upgrade events | same partition as deploy |
| --------- | -------------: | -----------------------: |
| `testnet` |         24,433 |           19,226 (78.7%) |
| `default` |          6,353 |               504 (7.9%) |

Upgrades in a later partition that runs at the same time (the 8-process queue)
miss the deploy row too.

## Tie-break inside a ledger

0320's invariant orders by `(ledger_sequence, event_index)`, but `event_index`
restarts per operation. Ordering by the full event position
`(ledger, transaction_index, operation_index, event_index)` picks the same
event for every contract on both databases today (19,287 and 1,965 contracts,
0 differ); the repair uses the full position.

## Repair tested on a local ClickHouse 26.3

Real rows of 8 testnet contracts (both CAP-85 owners included) and their 27
upgrade events, copied into a throwaway container: the insert wrote 2 rows
(`CBBRUHPO…` to `0b260ed5…`, `CB267H7K…` to `4817c10d…` with owner and tag
cleared), identity columns carried; the preview then returned 0 rows; a re-run
wrote nothing. A latest event with an unknown kind, a 3-byte hash, or an
owner without a row stopped the statement with `Code: 395` and wrote nothing.
