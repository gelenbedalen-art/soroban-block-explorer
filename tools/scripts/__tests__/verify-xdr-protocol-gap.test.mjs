// Tier matrix for tools/scripts/verify-xdr-protocol-gap.mjs (task 0646, ported
// from stellar-prices-api with its cases), run against a local mock of Horizon and crates.io so it needs no
// network. Every case is relative to the real pin in Cargo.toml, so a
// stellar-xdr bump needs no edit here.
//
// Run: node --test tools/scripts/__tests__/verify-xdr-protocol-gap.test.mjs
// (an explicit FILE argument — `node --test <dir>` fails on Node 22, the CI
// version pinned in .nvmrc). CI runs it in the `XDR protocol lag` job.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '../verify-xdr-protocol-gap.mjs');
// The pin as the script's pinnedMajor() reads it: [workspace.dependencies]
// only, so a stellar-xdr line elsewhere (a [patch], a per-crate override)
// cannot make the test and the script disagree.
const toml = readFileSync(join(here, '../../../Cargo.toml'), 'utf8');
const deps = toml.split(/^\[workspace\.dependencies\]$/m)[1].split(/^\[/m)[0];
const pin = deps.match(/^stellar-xdr\s*=\s*(.+)$/m)[1];
const p = Number(pin.match(/"[=^~]?(\d+)(\.\d+){0,2}"/)[1]);

// What the mock serves for the running case; `null` answers HTTP 500.
let horizon, crate, base;
const server = createServer((req, res) => {
  const body = req.url.startsWith('/horizon') ? horizon : crate;
  res.writeHead(body ? 200 : 500, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body ?? {}));
});
before(async () => {
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const net = (current, supported) => ({
  current_protocol_version: current,
  core_supported_protocol_version: supported,
});
const published = (stable, max = stable) => ({
  crate: { max_stable_version: stable, max_version: max },
  versions: [...new Set([max, stable])].map((num) => ({ num, yanked: false })),
});

// Async, not spawnSync: the mock lives in this process and must keep serving.
const run = (watch, root) =>
  new Promise((ok) =>
    execFile(
      process.execPath,
      [SCRIPT, ...(watch ? ['--watch'] : [])],
      {
        env: {
          ...process.env,
          HORIZON_URL: `${base}/horizon`,
          CRATES_URL: `${base}/crates`,
          ...(root ? { REPO_ROOT: root } : {}),
        },
      },
      (error, stdout, stderr) =>
        ok({ code: error ? error.code : 0, out: stdout + stderr })
    )
  );

// [name, horizon, crates.io, --watch?, expected exit, expected text]
// prettier-ignore
const cases = [
  ['level', net(p, p), published(`${p}.0.1`), true, 0, 'is current with mainnet'],
  ['WAITING before the vote', net(p, p + 1), published(`${p}.0.1`), true, 0, '— WAITING: no stellar-xdr'],
  ['LAGGING, watch', net(p, p + 1), published(`${p + 1}.0.0`), true, 1, 'lags the protocol core'],
  ['LAGGING, PR', net(p, p + 1), published(`${p + 1}.0.0`), false, 0, 'the bump is possible now'],
  ['voted, no crate (P29), watch', net(p + 1, p + 1), published(`${p}.0.1`), true, 0, `is behind mainnet protocol ${p + 1} — WAITING: no stellar-xdr`],
  ['voted, no crate (P29), PR', net(p + 1, p + 1), published(`${p}.0.1`), false, 0, '— WAITING: no stellar-xdr'],
  ['voted, pre-release only', net(p + 1, p + 1), published(`${p}.0.1`, `${p + 1}.0.0-rc.1`), true, 0, 'pre-release'],
  ['BEHIND, crate published, watch', net(p + 1, p + 1), published(`${p + 1}.0.0`), true, 1, 'is BEHIND mainnet protocol'],
  ['BEHIND, crate published, PR', net(p + 1, p + 1), published(`${p + 1}.0.0`), false, 1, 'is BEHIND mainnet protocol'],
  ['BEHIND, crate for mainnet but not core', net(p + 1, p + 2), published(`${p + 1}.0.0`), true, 1, 'is BEHIND mainnet protocol'],
  ['voted, only a later crate (#398), watch', net(p + 1, p + 1), published(`${p + 2}.0.0`), true, 0, `— WAITING: no stellar-xdr ${p + 1}`],
  ['voted, only a later crate (#398), PR', net(p + 1, p + 1), published(`${p + 2}.0.0`), false, 0, 'not\na bump target'],
  ['before the vote, only a later crate', net(p, p + 1), published(`${p + 2}.0.0`), true, 0, '— WAITING: no stellar-xdr'],
  ['voted without a crate, core next with one', net(p + 1, p + 2), published(`${p + 2}.0.0`), true, 1, `${p + 2}.0.0 is published — the bump is possible now`],
  ['crates.io lists no versions, watch', net(p + 1, p + 1), { crate: { max_stable_version: `${p + 1}.0.0` } }, true, 1, 'error: cannot read'],
  ['voted, crates.io down, watch', net(p + 1, p + 1), null, true, 1, 'error: cannot read'],
  ['voted, crates.io down, PR', net(p + 1, p + 1), null, false, 0, 'crate availability not checked'],
  ['Horizon down, watch', null, published(`${p}.0.1`), true, 1, 'error: cannot reach'],
];

for (const [name, h, c, watch, exit, text] of cases)
  test(name, async () => {
    horizon = h;
    crate = c;
    const { code, out } = await run(watch);
    assert.equal(code, exit, out);
    assert.ok(out.includes(text), `expected "${text}" in:\n${out}`);
  });

// Our own readings of Cargo.toml and Cargo.lock, against fixture repos. A lock
// package with no `source` line is one of our crates; a dependency carries a
// version only when the lock holds several `stellar-xdr`s.
const repo = (toml, packages) => {
  const root = mkdtempSync(join(tmpdir(), 'xdr-gap-'));
  writeFileSync(join(root, 'Cargo.toml'), toml);
  writeFileSync(join(root, 'Cargo.lock'), packages.join('\n'));
  return root;
};
const workspace = (...lines) =>
  `[workspace.dependencies]\n${lines.join('\n')}\n\n[profile.release]\n`;
const pkg = (name, version, source, deps = []) =>
  `[[package]]\nname = "${name}"\nversion = "${version}"\n` +
  (source
    ? 'source = "registry+https://github.com/rust-lang/crates.io-index"\n'
    : '') +
  (deps.length
    ? `dependencies = [\n${deps.map((d) => ` "${d}",`).join('\n')}\n]\n`
    : '');
const ours = (version) =>
  pkg('indexer', '0.1.0', false, [
    version ? `stellar-xdr ${version}` : 'stellar-xdr',
  ]);

// [name, Cargo.toml, Cargo.lock packages, expected exit, expected text]
// prettier-ignore
const repos = [
  ['one stellar-xdr, unversioned dependency', workspace('stellar-xdr = { version = "28" }'),
    [pkg('stellar-xdr', '28.0.0', true), ours()],
    0, 'is current with mainnet'],
  ['a third-party crate on an older major is not ours', workspace('stellar-xdr = { version = "28" }'),
    [pkg('stellar-xdr', '26.0.1', true), pkg('stellar-xdr', '28.0.0', true),
     pkg('soroban-spec', '26.1.1', true, ['stellar-xdr 26.0.1']), ours('28.0.0')],
    0, 'is current with mainnet'],
  ['two majors among our crates', workspace('stellar-xdr = { version = "28" }'),
    [pkg('stellar-xdr', '28.0.0', true), pkg('stellar-xdr', '30.0.0', true),
     pkg('xdr-parser', '0.1.0', false, ['stellar-xdr 30.0.0']), ours('28.0.0')],
    1, 'our crates resolve 2 stellar-xdr majors: 28, 30'],
  ['no crate of ours uses stellar-xdr', workspace('stellar-xdr = { version = "28" }'),
    [pkg('stellar-xdr', '28.0.0', true), pkg('indexer', '0.1.0', false, ['serde'])],
    0, 'is current with mainnet'],
  ['pin and lock disagree', workspace('stellar-xdr = { version = "=29.0.0" }'),
    [pkg('stellar-xdr', '28.0.0', true), ours()],
    1, 'Cargo.toml pins stellar-xdr 29 but Cargo.lock resolved 28'],
  ['full version pin', workspace('stellar-xdr = "28.10.1"'),
    [pkg('stellar-xdr', '28.10.1', true), ours()],
    0, 'pinned stellar-xdr 28 |'],
  ['no spaces around =', workspace('stellar-xdr="28"'),
    [pkg('stellar-xdr', '28.0.0', true), ours()],
    0, 'pinned stellar-xdr 28 |'],
  ['a longer key ending in stellar-xdr is not the pin', workspace('soroban-stellar-xdr = "27"', 'stellar-xdr = "28"'),
    [pkg('stellar-xdr', '28.0.0', true), ours()],
    0, 'pinned stellar-xdr 28 |'],
  ['a pin with no version', workspace('stellar-xdr = { workspace = true }'),
    [pkg('stellar-xdr', '28.0.0', true)],
    1, 'cannot read a version out of'],
  ['no stellar-xdr in [workspace.dependencies]', workspace('serde = "1"') + '[patch.crates-io]\nstellar-xdr = "28"\n',
    [pkg('stellar-xdr', '28.0.0', true)],
    1, 'no stellar-xdr entry in [workspace.dependencies]'],
  ['no [workspace.dependencies] section', '[dependencies]\nstellar-xdr = "28"\n',
    [pkg('stellar-xdr', '28.0.0', true)],
    1, 'no [workspace.dependencies] section'],
];

for (const [name, toml, packages, exit, text] of repos)
  test(name, async () => {
    horizon = net(28, 28);
    crate = published('28.0.1');
    const { code, out } = await run(true, repo(toml, packages));
    assert.equal(code, exit, out);
    assert.ok(out.includes(text), `expected "${text}" in:\n${out}`);
  });
