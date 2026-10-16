// The stellar-xdr half of the protocol watch (task 0646), kept free of I/O so
// the test can run it on plain values. `index.mjs` feeds it the major the
// running indexer was built with, Horizon's root document and the crates.io
// listing of `stellar-xdr`.
//
// The Galexie half (check.mjs) compares captive cores; this one compares the
// XDR our indexer decodes with. Protocol 29 changed no XDR and stopped only
// Galexie; a protocol that changes XDR stops the indexer even with a current
// Galexie, and only this half sees it coming. Ported from stellar-prices-api's
// `verify-xdr-protocol-gap.mjs`, whose tiers it keeps.
//
// `stellar-xdr`'s MAJOR is the protocol it decodes (28 decodes 28). Horizon
// publishes the protocol mainnet runs and the one core supports; the second
// rises weeks before the vote, which is the lead time:
//
//   OK       pin >= core supports
//   WAITING  pin behind, but no stable stellar-xdr for that protocol is on
//            crates.io: nothing to bump to (29 had none — it kept 28's XDR)
//   LAGGING  pin < core supports and a stable crate for it is published
//   BEHIND   pin < mainnet current and a stable crate for it is published
//
// WAITING is green: a page is for something someone can act on. A crate for
// protocol N is a stable major above the pin and NOT above N — upstream went
// 28.0.1 → 30.0.0, and 30.0.0 carries protocol 30's XDR, not 29's.
// ponytail: compares protocol numbers; comparing the crate's XDR commit with
// core's is the exact check if this ever misfires.

/**
 * The newest stable, unyanked release a bump for `protocol` could use: a
 * major above `pinned` and not above `protocol`.
 */
function bumpTarget(versions, pinned, protocol) {
  return versions
    .filter((v) => !v.yanked && /^\d+\.\d+\.\d+$/.test(v.num))
    .map((v) => v.num)
    .filter((num) => {
      const major = Number(num.split('.')[0]);
      return major > pinned && major <= protocol;
    })
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0];
}

/** The protocols from Horizon's root document; anything else is an error. */
export function networkProtocol(root) {
  const current = root.current_protocol_version;
  const supported = root.core_supported_protocol_version;
  if (!Number.isInteger(current) || !Number.isInteger(supported)) {
    throw new Error(
      `cannot determine: Horizon reports current_protocol_version=${current}, core_supported_protocol_version=${supported}`
    );
  }
  return { current, supported };
}

/**
 * `crate` is the crates.io document, read only when the pin lags (pass null
 * otherwise). Returns `{ ok, message }`; not ok pages.
 */
export function xdrVerdict({ pinned, network, crate }) {
  const summary = `our indexer's stellar-xdr ${pinned} | mainnet protocol ${network.current} | core supports ${network.supported}`;
  const behind = pinned < network.current;
  if (!behind && pinned >= network.supported) {
    return { ok: true, message: `OK: ${summary}` };
  }

  const stable = crate?.crate?.max_stable_version;
  if (
    !/^\d+\.\d+\.\d+$/.test(String(stable)) ||
    !Array.isArray(crate?.versions)
  ) {
    throw new Error(
      `cannot determine: crates.io reports max_stable_version=${stable}, versions=${crate?.versions?.length}`
    );
  }
  const newest = crate.crate.max_version;
  const crates = `newest stellar-xdr on crates.io ${stable}${
    newest && newest !== stable ? ` (pre-release ${newest})` : ''
  }`;

  const forMainnet =
    behind && bumpTarget(crate.versions, pinned, network.current);
  const forCore = bumpTarget(crate.versions, pinned, network.supported);

  if (forMainnet) {
    return {
      ok: false,
      message:
        `BEHIND: mainnet runs protocol ${network.current} and stellar-xdr ${forMainnet} is published - the indexer may stop at the next ledger. Bump it with soroban-env-host and deploy now.\n` +
        `${summary} | ${crates}\nRunbook: docs/runbooks/galexie-protocol-watch.md`,
    };
  }
  if (forCore) {
    return {
      ok: false,
      message:
        `LAGGING: core supports protocol ${network.supported} and stellar-xdr ${forCore} is published - bump it with soroban-env-host before the vote, testnet first.\n` +
        `${summary} | ${crates}\nRunbook: docs/runbooks/galexie-protocol-watch.md`,
    };
  }
  const needed = behind ? network.current : network.supported;
  return {
    ok: true,
    message: `WAITING: no stable stellar-xdr ${needed} is published yet - nothing to bump to. ${summary} | ${crates}`,
  };
}
