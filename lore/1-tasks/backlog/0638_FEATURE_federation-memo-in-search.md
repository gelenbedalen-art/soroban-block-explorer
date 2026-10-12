---
id: '0638'
title: 'Show the SEP-2 federation memo in federated search results'
type: FEATURE
status: backlog
related_adr: []
related_tasks: ['0443']
tags: [frontend, search, federation, sep-2, effort-small, priority-low]
links:
  - 'https://github.com/rumblefishdev/soroban-block-explorer/pull/645'
history:
  - date: 2026-10-12
    status: backlog
    who: karolkow
    note: >
      Created from the review of external PR #645: the federation path reads
      only account_id, so a name whose SEP-2 record carries a required memo
      resolves to an address with the memo silently dropped.
---

# Show the SEP-2 federation memo in federated search results

## Summary

A SEP-2 federation record can carry `memo_type` and `memo` next to
`account_id` — the memo an exchange or custodian needs to credit a payment to
the right customer. Our forward lookup (`name*domain` in search) reads only
`account_id` (`web/src/search/federation.ts`, `resolveFederatedAddress`), so
the memo the domain publishes is dropped. Show it in the federated search
result, attributed to the domain that answered.

## Stan teraz

- Done: nothing; 0443 shipped forward and reverse lookup without the memo.
- Next: parse and validate the two optional fields, render them in the search
  row.
- In force: the memo appears only in the result of a typed `name*domain`
  query — never on an account page and never from a URL parameter, so a page
  cannot be made to show a memo the account owner did not publish.

## Context

SEP-2 response fields (SEP-2 v1.1.0, "Federation Response"): `account_id`,
optional `memo_type` (`text`, `id` or `hash`) and optional `memo`, always a
string (for `hash`, base64). The federation server is run by the domain owner,
so the memo is that domain's claim — the same trust the address already rests
on, and the domain is visible in the query itself.

## Implementation Plan

### Step 1: Parse

Extend the forward lookup's result with an optional memo. Accept it only when
both fields are present and well formed: `id` a decimal u64, `text` at most 28
bytes, `hash` base64 of exactly 32 bytes. Anything else drops the memo and
keeps the address, with no guessing.

### Step 2: Render

In the federated search row: the memo type and value with a copy button,
labelled as published by `<domain>`. Nothing on account pages.

## Acceptance Criteria

- [ ] `name*domain` whose record has a memo shows type, value and the
      publishing domain in the search result, with a copy button.
- [ ] A malformed or partial memo is dropped; the address still resolves.
- [ ] No account page or URL parameter can display a federation memo.
- [ ] Tests in `web/src/search/__tests__/` cover id / text / hash, missing
      fields and malformed values.
- [ ] **Docs updated** — N/A — a display change inside the existing federation
      flow; no endpoint, schema or pipeline change.
- [ ] **API types regenerated** — N/A — frontend only.

## Notes

- Muxed (`M…`) and contract (`C…`) destinations are outside SEP-2, whose
  `account_id` is a classic account; follow the standard if it adds them.
