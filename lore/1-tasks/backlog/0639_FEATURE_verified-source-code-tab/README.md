---
id: '0639'
title: 'FEATURE: Verified Code tab — show source code verified by the BlockSmith Query API (testnet first)'
type: FEATURE
status: backlog
related_adr: ['0052']
related_tasks: ['0465', '0553']
tags: [priority-medium, effort-medium, layer-api, layer-frontend, testnet]
links:
  - https://staging.sv.blocksmith.co/api/query/v1/docs
  - https://staging.sv.blocksmith.co/api/query/v1/openapi.json
  - https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0058.md
  - web/src/pages/contracts/ContractCode.tsx
  - crates/api/src/contracts/queries/get_decompiled.rs
history:
  - date: 2026-10-14
    status: backlog
    who: claude
    note: >
      Task created on a team request (2026-10-14). Query API measured on its
      staging host: 33 verified Wasm hashes, all deployed on our testnet
      database; findings in notes/R-blocksmith-query-api-measured.md.
---

# FEATURE: Verified Code tab — source code verified by the BlockSmith Query API

## Summary

BlockSmith runs a Soroban source verification service, similar to Sourcify
on EVM: a contract author submits the source, a verifier rebuilds the Wasm
in a pinned container and compares the hash with the code on chain. Its
**Query API** aggregates the results of several verifiers. The contract
page gets a **Verified Code** tab showing that source when a verifier
confirmed it, and the current **Code** tab (soroban-ret decompilation, task 0465) is renamed **Decompilation**. The two never mix: decompilation is
always available and imperfect; verified code is exact and present only
when the author verified it.

## Stan teraz

- Done: Query API measured read-only (notes/R-…); example contracts for
  every response class found in our testnet database.
- Next: settle the open points below, then the plan and the PR split.
- In force: testnet only — the service runs on a staging host; mainnet is
  not touched until it has a production host.
- In force: we only read results; the submission (Verification) API is the
  contract author's, never called by us.

## Context

Measured facts with commands: [notes/R-blocksmith-query-api-measured.md](notes/R-blocksmith-query-api-measured.md). In short:

- Look up by Wasm hash (`/wasms/{hash}`, 6000 req/60 s); the address route
  is tighter (600). `agreement` classes come from the Query API; SEP-58
  defines the build fields but no display states.
- Verified without public source is the common case (17 of 33 hashes);
  `verified_source_code_uris` is present exactly when `is_public` (49/49).
- Source is a content-addressed `.tar.gz`/`.zip` of the whole Cargo
  project (up to 297 files, 1.46 MB); one archive can verify several
  contracts, each a different package named by `--manifest-path`.
- Coverage: 33 of 49,455 testnet Wasm programs (0.07%).

## Decisions so far

- 2026-10-14 — testnet only while the service runs on its staging host.
- 2026-10-14 — separate tabs: **Decompilation** (soroban-ret, always) and
  **Verified Code** (only with a positive result). Verified without public
  source shows "Contract is verified on BlockSmith, but the source code is
  not made publicly available".
- 2026-10-14 — the explorer backend calls the Query API, the SPA calls our
  backend.
- 2026-10-14 (W16) — two contract sub-resources in the `/decompiled`
  pattern: `GET /v1/contracts/{id}/verification` (small status, fetched with
  the page) and `GET /v1/contracts/{id}/verified-source` (unpacked files,
  fetched when the tab opens), behind a `runtime_enrichment` client like
  `wasm_code.rs`, no persistence, cache headers by hash. A ClickHouse sync of
  the `/wasms` feed is the later step, once the service leaves staging.
- 2026-10-14 (W17a) — the tab shows only for a verified result; a deep link
  to it shows a loading state, not a fallback to Interface.
- 2026-10-14 (W17c) — `mismatched`: the tab with a warning and the
  submitted source behind a "Show submitted source" button, no verified
  styling. `disputed` still open (W21, team).
- 2026-10-14 (W20) — attribution names the verifiers from the API
  (`verifier.name`) plus "aggregated by BlockSmith", in the Decompilation
  footer's style; a logo only when the API supplies `logo_url`.
- 2026-10-14 (W15) — layout: prototype variant D (file tree + code viewer,
  collapsed build details, download), built from the Decompilation tab's
  own parts. Prototype: branch `prototype/0639-verified-code`.

- 2026-10-14 (W23) — the tab is named **Source code** in every state; its
  dot carries the state (emerald verified, amber does-not-match), like
  Decompilation's amber dot. Asked in the team with W17b/W21.
- 2026-10-14 (W22) — file tree and code pane share one height: the taller
  of the two, capped at 640 px.

## Not yet decided

- **W17b** — where "verified" shows outside the tab: a header chip or a
  "Source code" row in Summary (asked in the team).
- **W21** — what `disputed` (verifiers disagree) shows (asked in the team).
- Answers awaited from BlockSmith: production host and timeline, which
  verifiers count as trusted in production, archive formats as a closed
  list and a size cap, attribution (no `logo_url` in any record today).
- How fresh the result must be: cache per Wasm hash, and how long (results
  carry `updated_at`; a verification can appear after deploy).

## Out of scope

- The Verification (submission) API — authors use it, we do not.
- Mainnet, until the service has a production host.
- Indexing verification results into ClickHouse for now (W16: later step) — a read-through call per
  contract page is enough at 33 hashes.

## Acceptance Criteria

- [ ] A testnet contract with public verified source shows the Verified
      Code tab with its file tree and file contents
      (e.g. `CD37GB5NIHBI5EGUNIJXEHDNVDDG23HJAVSJTAKSMDQQVKJMBSK6E5EW`).
- [ ] A verified contract without public source shows the "not made
      publicly available" message
      (e.g. `CCZOTIJCHZLWCOBZMSYNENXTBH6TVTP3LBEAXYVIIL5UCBGARLYM2XMH`).
- [ ] `no_data`, 404 and an unreachable service show no Verified Code tab,
      and the failure is logged with its cause, never shown as "not
      verified".
- [ ] The archive's sha256 is checked against `source_sha256` before it is
      shown; a mismatch is an error, not a fallback.
- [ ] The Code tab is renamed Decompilation; its behaviour is unchanged.
- [ ] The feature is configuration: the Query API URL is set for testnet
      only, mainnet has no value and makes no call (ADR 0052).
- [ ] **Docs updated** — `docs/architecture/**` for the new endpoint and
      the outbound call, per
      [ADR 0032](../../../2-adrs/0032_docs-architecture-evergreen-maintenance.md).
- [ ] **API types regenerated** — the new endpoint touches `crates/api/**`.
