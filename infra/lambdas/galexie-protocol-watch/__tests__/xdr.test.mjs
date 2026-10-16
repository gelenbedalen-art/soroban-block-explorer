import { describe, expect, it } from 'vitest';

import { networkProtocol, xdrVerdict } from '../xdr.mjs';

// The tier matrix of stellar-prices-api's verify-xdr-protocol-gap test, on
// plain values. `p` is a pin; every case is relative to it.
const p = 28;
const net = (current, supported) => ({ current, supported });
const published = (stable, max = stable, extra = []) => ({
  crate: { max_stable_version: stable, max_version: max },
  versions: [...new Set([max, stable]), ...extra].map((num) => ({
    num,
    yanked: false,
  })),
});

// [name, network, crates.io, ok, text]
// prettier-ignore
const cases = [
  ['level', net(p, p), null, true, `OK: our indexer's stellar-xdr ${p} | mainnet protocol ${p} | core supports ${p}`],
  ['ahead of core', net(p - 1, p - 1), null, true, 'OK:'],
  ['WAITING before the vote', net(p, p + 1), published(`${p}.0.1`), true, `WAITING: no stable stellar-xdr ${p + 1} is published yet`],
  ['LAGGING', net(p, p + 1), published(`${p + 1}.0.0`), false, `LAGGING: core supports protocol ${p + 1} and stellar-xdr ${p + 1}.0.0 is published`],
  ['voted, no crate (P29)', net(p + 1, p + 1), published(`${p}.0.1`), true, `WAITING: no stable stellar-xdr ${p + 1}`],
  ['voted, pre-release only', net(p + 1, p + 1), published(`${p}.0.1`, `${p + 1}.0.0-rc.1`), true, `(pre-release ${p + 1}.0.0-rc.1)`],
  ['BEHIND, crate published', net(p + 1, p + 1), published(`${p + 1}.0.0`), false, `BEHIND: mainnet runs protocol ${p + 1} and stellar-xdr ${p + 1}.0.0 is published`],
  ['BEHIND, crate for mainnet but not core', net(p + 1, p + 2), published(`${p + 1}.0.0`), false, 'BEHIND:'],
  ['voted, only a later crate', net(p + 1, p + 1), published(`${p + 2}.0.0`), true, `WAITING: no stable stellar-xdr ${p + 1}`],
  ['before the vote, only a later crate', net(p, p + 1), published(`${p + 2}.0.0`), true, `WAITING: no stable stellar-xdr ${p + 1}`],
  ['voted without a crate, core next with one (today)', net(p + 1, p + 2), published(`${p + 2}.0.0`), false, `LAGGING: core supports protocol ${p + 2} and stellar-xdr ${p + 2}.0.0 is published`],
  ['the newest fitting release is named', net(p, p + 2), published(`${p + 2}.0.0`, `${p + 2}.0.0`, [`${p + 1}.0.9`, `${p + 1}.0.10`]), false, `stellar-xdr ${p + 2}.0.0 is published`],
  ['the newest fitting minor is named', net(p, p + 1), published(`${p + 1}.0.9`, `${p + 1}.0.9`, [`${p + 1}.0.10`]), false, `stellar-xdr ${p + 1}.0.10 is published`],
];

describe('xdrVerdict', () => {
  it.each(cases)('%s', (_name, network, crate, ok, text) => {
    const result = xdrVerdict({ pinned: p, network, crate });
    expect(result.ok).toBe(ok);
    expect(result.message).toContain(text);
  });

  it('names the runbook when it pages', () => {
    const { message } = xdrVerdict({
      pinned: p,
      network: net(p, p + 1),
      crate: published(`${p + 1}.0.0`),
    });
    expect(message).toContain(
      'Runbook: docs/runbooks/galexie-protocol-watch.md'
    );
  });

  it('writes the whole page: verdict, readings, runbook', () => {
    expect(
      xdrVerdict({
        pinned: p,
        network: net(p + 1, p + 1),
        crate: published(`${p + 1}.0.0`),
      }).message
    ).toBe(
      `BEHIND: mainnet runs protocol ${p + 1} and stellar-xdr ${
        p + 1
      }.0.0 is published - the indexer may stop at the next ledger. Bump it with soroban-env-host and deploy now.\n` +
        `our indexer's stellar-xdr ${p} | mainnet protocol ${
          p + 1
        } | core supports ${p + 1} | newest stellar-xdr on crates.io ${
          p + 1
        }.0.0\n` +
        'Runbook: docs/runbooks/galexie-protocol-watch.md'
    );
  });

  it('reads multi-digit minor and patch versions', () => {
    for (const num of [`${p + 1}.10.0`, `${p + 1}.0.10`]) {
      const result = xdrVerdict({
        pinned: p,
        network: net(p, p + 1),
        crate: published(num),
      });
      expect(result.message).toContain(`stellar-xdr ${num} is published`);
      expect(result.message).not.toContain('pre-release');
    }
  });

  it('does not count a yanked release', () => {
    const crate = published(`${p}.0.1`);
    crate.versions.push({ num: `${p + 1}.0.0`, yanked: true });
    const result = xdrVerdict({ pinned: p, network: net(p, p + 1), crate });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('WAITING:');
  });

  it('throws on a crates.io document it cannot read', () => {
    for (const crate of [
      null,
      { crate: { max_stable_version: `${p + 1}.0.0` } },
      { crate: { max_stable_version: 'x' }, versions: [] },
      { versions: [] },
      { crate: { max_stable_version: `x${p + 1}.0.0` }, versions: [] },
      { crate: { max_stable_version: `${p + 1}.0.0-rc.1` }, versions: [] },
    ]) {
      expect(() =>
        xdrVerdict({ pinned: p, network: net(p, p + 1), crate })
      ).toThrow(/^cannot determine: crates.io reports/);
    }
  });
});

describe('networkProtocol', () => {
  it('reads both protocols', () => {
    expect(
      networkProtocol({
        current_protocol_version: 29,
        core_supported_protocol_version: 30,
      })
    ).toEqual({ current: 29, supported: 30 });
  });

  it('throws when either is missing', () => {
    expect(() => networkProtocol({ current_protocol_version: 29 })).toThrow(
      /^cannot determine: Horizon reports/
    );
    expect(() =>
      networkProtocol({ core_supported_protocol_version: 30 })
    ).toThrow(/^cannot determine: Horizon reports/);
  });
});
