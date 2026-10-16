---
id: '0646'
title: 'XDR protocol watch: open an issue when our stellar-xdr lags the protocol core supports'
type: FEATURE
status: active
related_adr: []
related_tasks: ['0610', '0548', '0368']
tags: [xdr, ingestion, ci, resilience, priority-high, effort-small]
links:
  - https://github.com/rumblefishdev/stellar-prices-api/issues/404
  - https://github.com/rumblefishdev/stellar-prices-api/blob/develop/tools/scripts/verify-xdr-protocol-gap.mjs
  - https://github.com/rumblefishdev/stellar-prices-api/blob/develop/.github/workflows/xdr-protocol-watch.yml
  - https://github.com/rumblefishdev/stellar-prices-api/blob/develop/docs/runbooks/xdr-protocol-watch.md
history:
  - date: '2026-10-16'
    status: active
    who: karolkow
    note: >
      Created after stellar-prices-api issue #404 (stellar-xdr 28 lags core
      30) reached us by hand: our Galexie watch (0610) stayed green, correctly,
      because it reads only the Galexie image, and nothing here reads the
      stellar-xdr pin. Decided: port the prices-api watch as it is.
---

# XDR protocol watch

## Summary

Port the stellar-prices-api XDR protocol watch: a script that compares our
`stellar-xdr` pin with Horizon's `current_protocol_version` /
`core_supported_protocol_version` and with crates.io, a soft CI job on every
PR, and a daily workflow that keeps one tracking issue open while a bump is
possible. Same tiers (OK, WAITING, LAGGING, BEHIND, NO CHECK), same issue
title, same test matrix.

## Context

The indexer decodes every ledger with `stellar-xdr` (workspace pin `28`).
The Galexie watch (0610) only compares captive-core versions of images, so a
protocol whose XDR our crate cannot decode would surface first as an
`ingestion-stall`. On 2026-10-16 Horizon reported core `30.0.0` while mainnet
runs 29, and `stellar-xdr 30.0.0` is on crates.io; prices-api opened its issue
on 2026-10-15, we had nothing.

## Differences from the prices-api copy

- **Pin format.** Ours is `{ version = "28" }`; the script reads the first
  number on the line instead of requiring `N.N.N`.
- **Two majors in `Cargo.lock`.** `soroban-spec 26` brings `stellar-xdr 26`
  into the lock for its own use, so counting every `stellar-xdr` package
  would always fail. The check counts the majors our own crates (lock entries
  without `source`) depend on.
- **Branch.** A release here is a `production-*` tag on `master`, so `master`
  is what ships: the workflow checks out the default branch, without
  prices-api's `ref: develop`.
- **Bump note.** `contract-executor` pins `soroban-env-host`, which pins
  `stellar-xdr` exactly; the bump moves both together, so the issue and the
  runbook say to look for a `soroban-env-host` on the new XDR first.

## Acceptance Criteria

- [ ] `tools/scripts/verify-xdr-protocol-gap.mjs` + its tier matrix test pass
      locally against a mock (no network).
- [ ] CI job `XDR protocol lag` runs the soft check and the test on every PR.
- [ ] `.github/workflows/xdr-protocol-watch.yml` runs daily and by hand;
      opens / refreshes / closes the issue like prices-api's.
- [ ] Runbook `docs/runbooks/xdr-protocol-watch.md`.
- [ ] **Docs updated** — N/A — CI and a runbook, no change to the described
      architecture.
- [ ] **API types regenerated** — N/A — no `crates/api/**` or Cargo change.

## Notes

- The schedule fires only from `master`: the watch starts after the next
  release.
