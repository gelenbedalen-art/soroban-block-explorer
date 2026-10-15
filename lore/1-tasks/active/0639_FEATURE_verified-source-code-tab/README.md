---
id: '0639'
title: 'FEATURE: Verified Code tab — show source code verified via the BlockSmith Query API (testnet first)'
type: FEATURE
status: active
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
  - date: 2026-10-15
    status: active
    who: karolkow
    note: >
      Activated after the design round: endpoints, tab name and states,
      layout (prototype variant D), caching, failure and download behaviour
      settled; three UX audits applied to the prototype. Open: the badge
      outside the tab and the `disputed` state, asked in the team.
---

# FEATURE: Verified Code tab — source verified via the BlockSmith Query API

## Summary

BlockSmith runs a Soroban source verification service, similar to Sourcify
on EVM: a contract author submits the source, a verifier rebuilds the Wasm
in a pinned container and compares the hash with the code on chain. Its
**Query API** aggregates the results of several verifiers. The contract page
gets a **Verified Code** tab showing that source, and the current **Code** tab
(soroban-ret decompilation, task 0465) is renamed **Decompilation**. The two
never mix: decompilation is always available and imperfect; verified source
is exact and present only when a verifier confirmed it.

## Stan teraz

- Done: Query API measured read-only (notes/R-…); design settled (below);
  prototype on local branch `prototype/0639-verified-code`, variant D.
- Done: PR 1 backend, #661 (two endpoints, Query API client, API types,
  docs; testnet only).
- Done: PR 2 frontend, #662 (draft, stacked on #661).
- In force: testnet only — the service runs on a staging host.
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

Backend:

- 2026-10-14 — testnet only while the service runs on its staging host; the
  Query API URL is configuration, set for testnet only (ADR 0052).
- 2026-10-14 — two contract sub-resources in the `/decompiled` pattern:
  `GET /v1/contracts/{id}/verification` (small status, fetched with the
  page) and `GET /v1/contracts/{id}/verified-source` (unpacked files, fetched
  when the tab opens), behind a `runtime_enrichment` client like
  `wasm_code.rs`, no persistence. A ClickHouse sync of the `/wasms` feed is a
  later step, once the service leaves staging.
- 2026-10-15 — cache headers from the existing tiers: status `MEDIUM` (60 s,
  like contract detail), files `LONG` (300 s, like `/decompiled`).
- 2026-10-15 — the archive's sha256 is checked against `source_sha256`;
  a mismatch is an error. Unpacking has size and file-count caps.
- 2026-10-15 — when the Query API fails: no tab, an error logged with its
  cause; a deep link to the tab shows `QueryErrorState` with Retry.
- 2026-10-15 — every verifier the aggregator lists counts (W38 C); an
  archive that cannot be fetched is a 500: no chip, no tab (W40 B); an
  unknown `agreement` value stays a 500, not a guess (W56 C).
- 2026-10-15 — no verifier service on the network: `/verification` answers
  200 `unavailable` under `LONG`, asking neither database nor service (W44 C).

Frontend (built from the Decompilation tab's parts):

- 2026-10-15 — the tab and the header chip show only for `verified` and
  `verified_private`; `mismatched`, `disputed` and everything else show
  nothing, as if no verification existed, and the backend serves no files
  for them. A deep link shows a loading state, never a fallback to
  Interface.
- 2026-10-15 — the tab is named **Verified Code**, with an emerald dot (the
  counterpart of Decompilation's amber "experimental" dot).
- 2026-10-15 — a **header chip** "Verified source" (design-system `Chip`,
  size md, like "Self-upgradeable") for both verified states; it opens the
  tab.
- 2026-10-14 — verified without public source: "Verified by <verifier
  names> — the source code is not published".
- 2026-10-14 — attribution line in the Decompilation footer's style:
  "Source verification by <verifiers from `verifier.name`> · aggregated by
  BlockSmith"; hidden when no verifier answered.
- 2026-10-14 — layout: file tree (WAI-ARIA tree, roving tabindex, filter
  via `DebouncedField`) beside `CodeHighlight` + `CopyButton`; one height
  per archive, the taller of tree and longest file, capped at 640 px; the
  open file in the URL (`?file=`); a stats line; a collapsed "Build recipe"
  box (Binary-features box + `DisclosureRow`) with copyable values.
- 2026-10-15 — Download links straight to the content-addressed archive on
  the verifier's storage.
- 2026-10-15 — below `md` the tree folds under "Files (N)" (W46 A); recipe
  row "Verified at", stats "matches the published sha256", toolbar chip kept
  (W47). "Code" → "Decompilation" on every network, a release note (W48 A).

## Not yet decided

- From BlockSmith: production host and timeline, trusted verifiers in
  production, archive formats as a closed list, `logo_url`.

## Out of scope

- The Verification (submission) API — authors use it, we do not.
- Mainnet, until the service has a production host.
- Indexing verification results into ClickHouse for now (later step above).

## Acceptance Criteria

- [ ] A testnet contract with public verified source shows the Verified Code
      tab with its file tree and file contents
      (e.g. `CD37GB5NIHBI5EGUNIJXEHDNVDDG23HJAVSJTAKSMDQQVKJMBSK6E5EW`).
- [ ] A verified contract without public source shows "the source code is
      not published" (e.g. `CCZOTIJCHZLWCOBZMSYNENXTBH6TVTP3LBEAXYVIIL5UCBGARLYM2XMH`).
- [ ] `no_data`, 404 and an unreachable service show no tab, and the
      failure is logged with its cause, never shown as "not verified".
- [ ] The archive's sha256 is checked against `source_sha256` before it is
      shown; a mismatch is an error, not a fallback.
- [ ] The Code tab is renamed Decompilation; its behaviour is unchanged.
- [ ] Mainnet has no Query API URL and never calls the service (ADR 0052).
- [ ] **Docs updated** — `docs/architecture/**` for the new endpoints and
      the outbound call, per
      [ADR 0032](../../../2-adrs/0032_docs-architecture-evergreen-maintenance.md).
- [ ] **API types regenerated** — the new endpoints touch `crates/api/**`.
