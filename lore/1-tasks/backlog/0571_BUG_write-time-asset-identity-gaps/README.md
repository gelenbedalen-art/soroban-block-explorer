---
id: '0571'
title: 'BUG: contract-held SAC balances and pool legs keyed on the SAC contract instead of the asset it wraps'
type: BUG
status: backlog
related_adr: ['0051', '0058']
related_tasks: ['0374', '0530', '0503', '0640', '0641', '0647', '0648']
tags:
  [
    'clickhouse',
    'indexer',
    'data-integrity',
    'priority-medium',
    'effort-medium',
  ]
links: []
history:
  - date: '2026-09-22'
    status: backlog
    who: karolkow
    note: >
      Filed from the 0530 review of PR #455. Two write paths store an asset
      surrogate for which no `assets` row is ever written. Both measured on
      production and traced to their cause; the two orphaned pool legs were
      repaired by hand the same day, the balances are not.
  - date: '2026-10-16'
    status: backlog
    who: karolkow
    note: >
      Part 1 (issuer-only classic pool legs) split out to 0648. Both roots of
      the SAC half found and measured on both networks
      (notes/R-sac-identity-2026-10-16.md). Fix decided: keep the write-time
      translation, take SAC identity from the instance entry, drop the
      deployed filter, fail loudly on an unresolved SAC, repair both
      networks. The read-time shape is filed as 0647.
---

# BUG: SAC balances and pool legs keyed on the SAC contract

## Summary

A contract that holds a classic asset through its Stellar Asset Contract
(SAC) gets its balance stored under the SAC contract's surrogate instead of
the asset the SAC wraps. A SAC has no `assets` row (ADR 0051), so the row
joins to nothing: the asset page misses the holder, and supply is short by
the amount. Soroban pool legs and pool movements are keyed by the same
function and break the same way.

Two independent causes, one per network — see "Root causes" below.

## Root causes (measured 2026-10-16)

Full numbers, queries and the deploy classification:
[notes/R-sac-identity-2026-10-16.md](notes/R-sac-identity-2026-10-16.md).

**1. Mainnet — SAC identity read from the transaction, not the entry.**
The parser learns what a SAC wraps only from the transaction envelope: a
top-level `CreateContract` from an asset, or a `CreateContractHostFn` in the
auth tree (`extract_sac_identities`, task 0160). A SAC deployed by another
contract leaves neither — the envelope only says "invoke contract X", and a
SAC deploy needs no authorization. Such a deployment lands with
`sac_asset: None` (`crates/xdr-parser/src/state.rs:95`); the facet is later
written by the event override path (task 0323) with `sac_deployed = 0`, and
`fetch_sac_classic_map` drops every facet with `sac_deployed = 0`
(`HAVING max(sac_deployed) = 1`). The balance then falls through to the
type-3 fallback in `contract_token_asset_id` silently.

Measured: 148 of 4,065 mainnet SACs carry `sac_deployed = 0`. Of the 147
whose deploy transaction Horizon still serves, 147 were deployed by another
contract (`coin_it` 80, `coin_them` 56, `create` 8,
`create_stellar_asset_contract` 3). Control: 53 of 53 checkable SACs with
`sac_deployed = 1` were deployed by a top-level `CreateContract` from an asset.

The identity is in the instance entry the parser already reads to decide
"this is a SAC": its storage carries `AssetInfo` (code + issuer) and
`METADATA` (`name = "CODE:ISSUER"`). 4,043 of 4,043 mainnet SAC instances in
`contract_instances` carry `AssetInfo`.

**2. Testnet — write-time translation depends on backfill order.**
The SAC → asset map is read from ClickHouse per ledger. `backfill-runner run`
commits a 64,000-ledger partition only at its end and runs partitions in
parallel, so a balance written before its SAC's facet is visible falls
through. Measured: 22,141 of 22,166 SAC-keyed `balances` pairs on testnet sit
on SACs whose facet is correct today; every one was last written below ledger
4,992,000 (the backfilled range), none from 5,000,000. 9,686 are in the same
partition as the SAC's deploy, 12,455 in another. Same class as 0640.

## Decisions so far

| situation                                            | what happens                                                                                                                                                                                                                                                                                                                                                                                            | date       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| choice of fix                                        | keep translation at write time (option "B"); superseded 2026-10-19 by the order of work below                                                                                                                                                                                                                                                                                                           | 2026-10-16 |
| order of work                                        | (1) now: SAC identity from `AssetInfo` + map without the `sac_deployed` filter, right under any later direction; (2) task 0641 decides one direction for every backfill-vs-live class, as an ADR; (3) 0647 as its first application, or dropped if the ADR says so; (4) in parallel, the invariant runner of 0564. Write-time event seeding, partition memory and the SAC-to-asset re-key are not built | 2026-10-19 |
| a SAC instance entry is created or changes           | its identity (code + issuer, or native) comes from the entry's `AssetInfo` storage, not from the envelope                                                                                                                                                                                                                                                                                               | 2026-10-16 |
| the SAC → asset map is read                          | every facet with a SAC contract, regardless of `sac_deployed` — the mapping is a property of the address, deployed or not                                                                                                                                                                                                                                                                               | 2026-10-16 |
| a contract known to be a SAC has no entry in the map | error with the contract named, never a type-3 key                                                                                                                                                                                                                                                                                                                                                       | 2026-10-16 |
| repair                                               | one statement set per network, testnet first, run by the owner; `balances`, `liquidity_pools.legs`, `pool_movements`, the `sac_deployed` facets                                                                                                                                                                                                                                                         | 2026-10-16 |
| both networks                                        | every fix and repair covers `testnet` and `default`                                                                                                                                                                                                                                                                                                                                                     | 2026-10-16 |

## Not yet decided

- Where a backfill into a database without the SAC facets (testnet reset,
  fresh environment) gets the full map before its partitions run. Measured
  2026-10-16: the checkpoint seed does not decode `ContractData`
  (`snapshot/seed.rs`, "deliberately NOT seeded"), so a snapshot source is
  new code.
- How "known to be a SAC" is decided for a pool-leg token address, which
  carries no entry of its own in the ledger being staged.

## Out of scope

- Issuer-only classic pool legs: 0648.
- Storing the raw holding contract and resolving at read time: 0647.
- Other post-backfill passes: 0641.

## History

The state as first filed, the cases ruled out and the notes from the pool-leg
repair: [notes/R-first-filing-2026-09-22.md](notes/R-first-filing-2026-09-22.md).
Measurement queries: [notes/R-sac-identity-2026-10-16.md](notes/R-sac-identity-2026-10-16.md).

## Acceptance Criteria

- [x] Root cause of `sac_deployed = 0` on a deployed SAC found (2026-10-16)
- [ ] A SAC deployed by another contract gets its identity from its instance
      entry — parser test on a real contract-deployed SAC instance
- [ ] `fetch_sac_classic_map` returns facets with `sac_deployed = 0`
- [ ] Neither `build_balance_rows` nor `contract_token_asset_id` keys a known
      SAC as a type-3 token; an unresolved SAC is an error naming it
- [ ] A backfill into a database without the facets ends with no SAC-keyed
      rows, with no manual step
- [ ] Repair run on `testnet`, then `default`: no `balances`,
      `liquidity_pools.legs` or `pool_movements` row keyed on a SAC contract;
      `sac_deployed = 1` for every SAC in `soroban_contracts`
- [ ] **Docs updated** — `docs/architecture/**` on where SAC identity comes
      from; `docs/backfills.md` if the backfill gains a step; or `N/A — reason`
- [ ] **API types regenerated** — `N/A` unless `crates/api/**` changes
