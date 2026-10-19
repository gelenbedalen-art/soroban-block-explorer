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
- Done: PR 1 (#673, bump + executor) merged 2026-10-19; CI green.
- Done: PR 2 branch `feat/0649-muxed-contract-addresses` (`W…` support,
  Soroban recipient id, #673 review fixes); not opened, the PR queue is full.
- Next: review and merge #674; deploy to testnet before its vote.
- Evidence: [notes/R-protocol-30-facts.md](notes/R-protocol-30-facts.md).

## Decisions so far

| Situation                                                                                                                  | What happens                                                                                                                                                                                                                       | Date       |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A `W…` (muxed contract) address reaches the parser, DB or API                                                              | Full support: treated as its `C…` contract plus the muxed id wherever `M…` is treated as `G…` plus id; API path, filters and search accept `W…`; the UI links it to the contract page; `stellar-strkey` moves to 1.0               | 2026-10-19 |
| stellar-prices-api builds on our `xdr-parser` from `develop`                                                               | Merge after review, no waiting; its team is told before the merge that its next `xdr-parser` update must move it to `stellar-xdr` 30                                                                                               | 2026-10-19 |
| The executor runs a contract function for a ledger of any protocol (live before or after a vote, or a backfill of history) | One `soroban-env-host` (30); every run states the host's own protocol, since the host refuses any other so as never to replay a contract with another protocol's execution costs, which a read-only call is not charged for        | 2026-10-19 |
| A Soroban transfer names the recipient's sub-account in its event (`G…`/`C…` topic, `u64` `to_muxed_id` in data)           | `asset_transfers.to_muxed_id` takes it for a Soroban call; a classic operation keeps the envelope, since its `u64` may be an id memo (CAP-67 rule 2). Covers `W…` and `M…` alike: the owner kept the `M…` case (same rule, CAP-67) | 2026-10-19 |

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

## Tests per decision row

| Row                      | Tests                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `W…` full support        | `value_flow/tests.rs` `a_w_address_in_the_topic_is_split_into_its_contract_and_id`; `api` `common/path/tests.rs` `contract_id_*`, `common/filters.rs` `contract_id_opt_accepts_c_and_w_and_rejects_the_rest`, `search/classifier.rs` `classifies_a_w_strkey_as_its_contract`, `common/strkey/tests.rs`; web `strkeyDecode.test.ts`, `ExecutionTrace.test.ts` `shows a W-address as itself…` |
| Soroban recipient id     | `value_flow/tests.rs` `a_soroban_transfer_takes_the_recipients_id_from_its_event`, `a_classic_transfer_ignores_the_event_id_which_may_be_the_memo`; `asset_transfers/tests.rs` `a_text_to_muxed_id_is_not_an_id`                                                                                                                                                                            |
| Executor on any protocol | `contract-executor` `a_real_token_answers_like_the_network` (entries of protocol-29 ledger 64,818,615 on host 30); the type has no protocol field left to pass                                                                                                                                                                                                                              |
| prices-api merge timing  | process, no test                                                                                                                                                                                                                                                                                                                                                                            |

## `M…` recipients lost their id (measured 2026-10-19)

Read-only, production mainnet, ledgers ≥ 64,500,000: 587,150 operations
carry a token event with a `u64` `to_muxed_id`. 31,025 already had the id
in `asset_transfers`; of the other 556,125, 556,112 are classic payments
whose transaction has an id memo (CAP-67 forwards it; `transaction_memos`
holds it). The remaining 13 have no id in `asset_transfers` and no id memo:
2 burns; 9 transfers from a claimable balance (`B…`, a classic claim, which
this change leaves as it was — CAP-67 adds `to_muxed_id` there only from a
memo, so why these carry one is unexplained); and 2 Soroban transfers to an
`M…` — from a contract (ledger 64,830,229) and from a `G…` (ledger
65,023,735) — whose id this change now keeps (owner: keep). Measured by
running `parse_ledger` + `build_value_flow_rows` on those archive ledgers
with `develop` and with this branch: exactly these 2 ids are new, every
other row is identical. Rows already written stay as they are until a
re-ingest of their range.

**Who emits a `u64` `to_muxed_id`** (production, ledgers ≥ 58,000,000,
2026-10-19): 2,458,236 events from SACs (44 deployed, 67 undeployed —
asset-shaped topics), 3 from one custom SEP-41 token (`CBJ4…24KZ`).
SEP-41 v0.4.0 defines `to_muxed_id` for every SEP-41 token, not only the
SAC.

## Out of scope

- Galexie protocol-30 image: task 0650 (follows 0605).
- Storing `closeTimeMs`: nobody asked for it; `closed_at` stays seconds.

## Acceptance Criteria

- [x] Workspace on `stellar-xdr` 30; the executor answers on protocol-29 and
      protocol-30 ledgers.
- [x] Workspace tests and clippy green (one failure also on `develop`:
      `pool_reserves_reconciliation`, pool `CAZ6W4WH…`, data not code).
- [x] Decode check of recent mainnet and testnet ledgers recorded above.
- [x] Each decision row has a test (table above).
- [x] **Docs updated** — PR 1: `xdr-parsing-overview.md` (executor runs at
      the host's protocol), `infrastructure-overview.md` (upgrade bumps
      `soroban-env-host` too); PR 2: `backend-overview.md` (`W…` accepted),
      `database-schema-overview.md` and `xdr-parsing-overview.md`
      (recipient id from the event).
- [x] **API types regenerated** — PR 1: no diff; PR 2: parameter
      descriptions.
