-- G — Read-only preview of the `soroban_contracts` executable repair (task 0640).
--
-- Lists every contract whose stored executable is not the one named by its
-- LATEST `executable_update` SYSTEM event, together with the full row the
-- repair would write. Run it before and after `G-executable-repair-insert.sql`:
-- PASS after the repair = 0 rows. This is also the post-backfill invariant,
-- covering both executable kinds (0320's file covers Wasm only).
--
-- Database: `testnet.` is written into every table name. For mainnet replace it
-- with `default.` (measured 2026-10-14: 0 rows on `default`).
--
--   chq "$(cat G-executable-repair-select.sql)"
--
-- That prints full rows; `wasm_hash` is raw bytes, so it looks like noise. To
-- count instead (the check before and after the repair):
--
--   chq "SELECT count() FROM ($(sed -n '/^WITH latest/,$p' G-executable-repair-select.sql))"
--
-- Topic 3 of `["executable_update", old_exec, new_exec]` is the new executable:
--   Wasm         → vec[Symbol("Wasm"), Bytes(hash)]
--   ExternalRef  → vec[Symbol("ExternalRef"), Map{owner: Address, tag: String}]  (CAP-85)
-- The row it must produce mirrors `build_wasm_upgrade_rows`
-- (crates/db-clickhouse/src/persist/stage.rs): each kind clears the other's
-- columns; identity columns ride along from the current row; the RMT version
-- `wasm_uploaded_at_ledger` is the upgrade ledger, so the row wins the merge.
--
-- The owner surrogate cannot be computed in SQL (`ids::contract_id` is the
-- lower half of CityHash v1.0.2 128-bit, not ClickHouse's `cityHash64`), so it
-- is read from the owner's own `soroban_contracts` row.

WITH latest AS (
  SELECT contract_id AS id,
         -- execution order inside a ledger: transaction, operation, event
         argMax(JSONExtractRaw(topics_xdr, 3), (ledger_sequence, transaction_index, operation_index, event_index)) AS new_exec,
         max(ledger_sequence) AS upgrade_ledger
  FROM testnet.soroban_events
  WHERE signature = 'executable_update' AND event_type = 0
  GROUP BY contract_id
),
target AS (
  SELECT id, upgrade_ledger,
         JSONExtractString(new_exec, 'value', 1, 'value') AS kind,
         tryBase64Decode(JSONExtractString(new_exec, 'value', 2, 'value')) AS hash_bytes,
         JSONExtractRaw(new_exec, 'value', 2, 'value') AS ref_map,
         JSONExtractString(ref_map, 1, 'key', 'value') AS ref_key1,
         JSONExtractString(ref_map, 1, 'value', 'value') AS owner_strkey,
         JSONExtractString(ref_map, 2, 'key', 'value') AS ref_key2,
         JSONExtractString(ref_map, 2, 'value', 'value') AS tag
  FROM latest
)
SELECT sc.id AS id,
       sc.contract_id AS contract_id,
       CAST(if(t.kind = 'Wasm', t.hash_bytes, NULL) AS Nullable(FixedString(32))) AS wasm_hash,
       t.upgrade_ledger AS wasm_uploaded_at_ledger,
       sc.deployer_id AS deployer_id,
       sc.deployed_at_ledger AS deployed_at_ledger,
       sc.contract_type AS contract_type,
       sc.is_sac AS is_sac,
       if(t.kind = 'ExternalRef', o.owner_id, NULL) AS executable_owner_id,
       if(t.kind = 'ExternalRef', t.tag, NULL) AS executable_tag
FROM target AS t
INNER JOIN (SELECT * FROM testnet.soroban_contracts FINAL) AS sc ON sc.id = t.id
LEFT JOIN (SELECT id AS owner_id, contract_id AS owner_strkey, toUInt8(1) AS owner_found
           FROM testnet.soroban_contracts FINAL) AS o ON o.owner_strkey = t.owner_strkey
-- Loud on anything this statement does not understand: one bad event stops the
-- whole statement instead of writing a wrong row.
WHERE throwIf(t.kind NOT IN ('Wasm', 'ExternalRef'), 'executable_update with an unknown executable kind') = 0
  AND throwIf(t.kind = 'Wasm' AND length(t.hash_bytes) != 32, 'Wasm executable_update whose hash is not 32 bytes') = 0
  AND throwIf(t.kind = 'ExternalRef' AND (t.ref_key1 != 'owner' OR t.ref_key2 != 'tag'), 'ExternalRef map not {owner, tag}') = 0
  AND throwIf(t.kind = 'ExternalRef' AND o.owner_found = 0, 'ExternalRef owner has no soroban_contracts row') = 0
  -- only rows whose executable differs from the latest event
  AND if(t.kind = 'Wasm',
         sc.wasm_hash IS NULL OR sc.wasm_hash != t.hash_bytes
           OR sc.executable_owner_id IS NOT NULL OR sc.executable_tag IS NOT NULL,
         sc.wasm_hash IS NOT NULL OR sc.executable_owner_id IS NULL OR sc.executable_tag IS NULL
           OR sc.executable_owner_id != o.owner_id OR sc.executable_tag != t.tag)
