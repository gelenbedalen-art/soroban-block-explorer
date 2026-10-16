# XDR protocol watch — what to do when it opens an issue

**Audience:** anyone who gets a notification from the issue
**"stellar-xdr lags the mainnet protocol"**, or who changes the watch itself.

|          |                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------ |
| Workflow | `.github/workflows/xdr-protocol-watch.yml` — daily at 06:17 UTC, plus manual `workflow_dispatch` |
| CI job   | `XDR protocol lag` in `ci.yml` — the soft check and its tests, on every PR                       |
| Script   | `tools/scripts/verify-xdr-protocol-gap.mjs` (`pnpm run xdr:watch-protocol-gap`)                  |
| Output   | one tracking issue, titled exactly `stellar-xdr lags the mainnet protocol`                       |
| Origin   | a port of stellar-prices-api's watch of the same name (task 0646)                                |

## What it guards against

The indexer decodes every ledger with the `stellar-xdr` Rust crate. The
crate's **major version is the protocol it understands**: `stellar-xdr` 28
decodes protocol 28. When mainnet votes in a protocol whose XDR the crate cannot
read, the indexer stops writing ledgers; the `production-ingestion-stall` alarm
then fires, after the fact.

Nothing in our repository changes when that happens, so a check on push or pull
request cannot see it. The watch runs on a clock instead.

It is the second half of the protocol-upgrade guard. The
[Galexie protocol watch](galexie-protocol-watch.md) (task 0610) compares the
captive core of our Galexie image with Docker Hub's — that is what stopped
ingestion at protocol 29, whose XDR did not change. This watch reads our
crate, which Galexie's check never does.

## What it checks

| Reading             | Source                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **our pin**         | `stellar-xdr` in `[workspace.dependencies]` of `Cargo.toml`; `Cargo.lock` must agree, one major among our own crates     |
| **mainnet current** | `current_protocol_version` from `https://horizon.stellar.org/`                                                           |
| **core supports**   | `core_supported_protocol_version` from the same page — rises **weeks before** the vote, once validators run the new core |
| **published crate** | `https://crates.io/api/v1/crates/stellar-xdr` — only read when our pin lags                                              |

"Our own crates" are the `Cargo.lock` entries with no `source` line.
`soroban-spec` brings an older `stellar-xdr` into the lock for its own use; it
is not counted.

## The tiers

**The rule: a red run, the failure email and an issue appear only when someone
can do something.**

| Tier         | Condition                                                                                 | Run       | Issue                                                          |
| ------------ | ----------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------- |
| **OK**       | pin ≥ core supports                                                                       | green     | an open one is commented "Resolved" and **closed**             |
| **WAITING**  | pin < core supports or mainnet current, **no** stable `stellar-xdr` for that protocol yet | **green** | **none opened**; an open one is closed as "not actionable yet" |
| **LAGGING**  | pin < core supports, a stable crate for it **is** published                               | red       | **opened**, body says _bump now_                               |
| **BEHIND**   | pin < mainnet current — mainnet already voted — and a stable crate for it is published    | red       | opened, or the LAGGING one gets an "Escalated" comment         |
| **NO CHECK** | Horizon or crates.io could not be read                                                    | red       | **untouched**; GitHub's failure email is the signal            |

- **A later major is not a crate for this protocol.** A bump target for
  protocol N is a stable major above our pin and not above N. Upstream skipped
  29 (crates.io went 28.0.1 → 30.0.0), so on mainnet 29 with core on 29 the
  watch is WAITING.
- **A pre-release does not count.** It is named in the report; the tier stays
  WAITING.
- **Unchanged tier = silent.** The issue body is rewritten every run, with no
  comment. The tier lives in its first line, `<!-- xdr-protocol-watch
tier=LAGGING -->`; don't edit it by hand.

## What to do, per tier

**WAITING** — nothing.

**NO CHECK** — re-run later (`gh workflow run xdr-protocol-watch.yml`). If it
keeps failing, check whether Horizon's root or the crates.io document changed
shape.

**LAGGING** — the crate is published and mainnet has not voted:

1. Check that a `soroban-env-host` on the new XDR is published.
   `crates/contract-executor` hands our XDR types to it, and it pins
   `stellar-xdr` exactly, so both move in one PR (see the comment in
   `crates/contract-executor/Cargo.toml`). Until it exists the bump cannot be
   built; say so on the issue.
2. Check the new crate's XDR, not only its number: the XDR commit it pins must
   be the one core uses for that protocol.
3. Bump, run the parser and the CH e2e tests, and deploy to **testnet first**:
   testnet votes 15–20 days before mainnet, so the testnet indexer meets the
   new protocol first. Then mainnet, before the vote (`docs/deployment.md`).

**BEHIND** — mainnet has voted and a crate for it is published. Same steps,
immediately, then confirm the indexer moves again (`production-ingestion-stall`
clears).

## Running it by hand

```bash
pnpm run xdr:watch-protocol-gap   # strict, like the schedule
pnpm run xdr:verify-protocol-gap  # the PR-mode check
node --test tools/scripts/__tests__/verify-xdr-protocol-gap.test.mjs  # every tier, no network
```

`HORIZON_URL` and `CRATES_URL` point the script at other endpoints, e.g.
`HORIZON_URL=https://horizon-testnet.stellar.org/` for testnet.

## Which branch runs what

A `schedule` trigger fires only from the default branch, `master`, and the
workflow checks out `master`. A release here is a `production-*` tag on
`master`, so `master`'s pin is the one that ships. Consequences:

- a change to the workflow **or** the script takes effect once it reaches
  `master`, i.e. with the next release;
- a bump merged to `develop` keeps the issue open until it is released, which
  is correct: until then production still runs the old crate.

stellar-prices-api checks out `develop` instead, because there `develop` is
what deploys. If our deploy source ever moves off `master`, change the
checkout `ref:` in the same PR.
