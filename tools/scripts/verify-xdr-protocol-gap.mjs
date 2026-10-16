#!/usr/bin/env node
//
// Surface when our pinned `stellar-xdr` lags the Stellar mainnet protocol,
// BEFORE the lag stalls the indexer at an XDR decode wall (task 0646).
//
// A port of stellar-prices-api's `tools/scripts/verify-xdr-protocol-gap.mjs`
// (their tasks 0098, 0319, 0325, 0330). The tiers, the wording the workflow
// matches and the test matrix are theirs; only the readings of our own
// Cargo.toml and Cargo.lock differ (see "OUR PIN" below).
//
// WHY THIS EXISTS
// ---------------
// The indexer decodes every ledger with the `stellar-xdr` Rust crate. When
// mainnet votes in a protocol whose XDR our crate cannot read, decoding
// stops. The Galexie protocol watch (task 0610) cannot see it: it compares
// the captive core of Galexie images, never our crate. Protocol 27 froze the
// mainnet indexer that way (task 0368, 2026-07-09).
//
// THE MAPPING THIS ENCODES
// ------------------------
// `stellar-xdr`'s MAJOR version tracks the protocol version: 26 decodes
// protocol 26, 27 decodes 27, 28 decodes 28. That is the whole comparison.
// If upstream ever breaks that correspondence this check goes wrong in the
// safe direction — it compares two integers and says which is larger — but the
// assumption is stated here so a future reader can test it rather than infer
// it.
//
// Protocol 29 broke it. stellar-core v29 pins the same XDR commit as v28.0.1:
// the vote changed apply rules, not the format, so `stellar-xdr 28` decodes
// P29 ledgers and no `stellar-xdr 29` was published. What stopped ingestion
// on 2026-10-01 was Galexie, whose captive core must match the protocol
// whatever the XDR does — the failure task 0610 watches, not this script.
//
// TWO TIERS, AND WHY THE WARNING ONE IS THE VALUABLE ONE
// ------------------------------------------------------
// Horizon's root document publishes both numbers:
//
//   current_protocol_version        what mainnet is running RIGHT NOW
//   core_supported_protocol_version what core is ready to run
//
// `core_supported` rises WEEKS BEFORE the vote. That gap is the entire lead
// time this script exists to buy, so it is the tier that does the real work:
//
//   BEHIND   ours < current         mainnet has moved past us. The decode wall
//                                   is live or one empty-tx-set ledger away.
//                                   Fatal in both modes when a crate for it
//                                   is published (WAITING otherwise, below).
//   LAGGING  ours < core_supported  an upgrade is announced and available.
//                                   Fatal only under --watch (see below).
//
// LAGGING IS SPLIT BY WHETHER THERE IS ANYTHING TO BUMP TO
// --------------------------------------------------------
// Core runs a new protocol before the Rust crate for it is published: SDF
// builds core from the XDR definitions in git, and core's own Rust takes
// rs-stellar-xdr by git too. On 2026-09-29 Horizon reported core 29 while
// crates.io's newest `stellar-xdr` was 28.0.1 — there was nothing to bump to.
// So a LAGGING reading also asks crates.io:
//
//   WAITING  no published stable major in (ours, core_supported]. The protocol is
//            announced, there is nothing to bump to yet. NOT fatal, even under
//            --watch: a red run and an issue are for something someone can
//            act on, and here nobody can. The report says so and exits 0.
//   LAGGING  a stable major in (ours, core_supported] is on crates.io. Bump
//            now. Fatal under --watch.
//
// BEHIND asks crates.io the same way: mainnet on a protocol with no published
// stable crate is WAITING, not BEHIND. There is nothing to bump to, and the
// protocol may not have changed XDR at all (29 did not). A protocol that DOES
// change XDR and is voted before its crate ships stays green here; that stall
// shows as the `production-ingestion-stall` alarm.
//
// "A crate for protocol N" means a major ABOVE ours and NOT ABOVE N. Upstream
// skipped 29: crates.io went 28.0.1 → 30.0.0, and 30.0.0 carries protocol
// 30's XDR. Each protocol is asked separately: mainnet on crate-less 29 with
// core on 30 and a crate 30 published is LAGGING.
// ponytail: compares protocol numbers; comparing the crate's XDR commit with
// core's (`src/protocol-curr/xdr`) is the exact check if this misfires again.
//
// crates.io unreadable → fatal under --watch, but reported as a check that
// could not complete (`cannot read … crates.io`), not as LAGGING: the watch
// failing to look is worth a red run, not an issue asking for a bump. A
// pre-release (`29.0.0-rc.1`) does not count as published; it is named in the
// report so the wait is visible.
//
// Operator guide: docs/runbooks/xdr-protocol-watch.md
//
// WHY --watch EXISTS
// ------------------
// On a pull request this script must never fail the build because the Stellar
// Foundation announced something or because Horizon had a bad minute. A
// developer cannot fix either, and a gate that red-lights unrelated PRs gets
// disabled within a week.
//
// But a PR-only guard cannot see the condition at all: no code changes on our
// side — mainnet moves and we stand still. So the real guard is the SCHEDULED
// run, and `--watch` is what makes it strict: there, LAGGING is a failure
// (that is the point — it is the early warning) and an unreachable Horizon is
// a failure too, because a watch that silently checks nothing is the exact
// failure mode this script is about.
//
// THE THIRD CHECK: TWO MAJORS AMONG OUR CRATES
// --------------------------------------------
// `contract-executor` hands our `stellar-xdr` types to `soroban-env-host`,
// which pins `stellar-xdr` exactly. If one side moves without the other, Cargo
// resolves both majors and the types stop matching — a compile error rather
// than a silent freeze, but worth naming precisely instead of leaving someone
// to read a wall of trait errors. Only our own crates count: `soroban-spec`
// brings an older `stellar-xdr` into the lock for its own use, and nothing of
// ours passes its types across.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// REPO_ROOT lets the test point the script at a fixture Cargo.toml / Cargo.lock.
const repoRoot =
  process.env.REPO_ROOT ??
  join(dirname(fileURLToPath(import.meta.url)), '../..');
const watch = process.argv.includes('--watch');
const horizonUrl = process.env.HORIZON_URL ?? 'https://horizon.stellar.org/';
const cratesUrl =
  process.env.CRATES_URL ?? 'https://crates.io/api/v1/crates/stellar-xdr';

const die = (...lines) => {
  console.error(lines.join('\n'));
  process.exit(1);
};

// ---------------------------------------------------------------- our pin --

/**
 * The `[workspace.dependencies]` pin — our stated intent. Read by regex rather
 * than a TOML parser so this script stays dependency-free; the pattern is
 * anchored to the section so a same-named key elsewhere cannot match. Our pin
 * is a bare major (`{ version = "28" }`), so the first number is the major.
 */
const pinnedMajor = () => {
  const toml = readFileSync(join(repoRoot, 'Cargo.toml'), 'utf8');
  const section = toml.split(/^\[workspace\.dependencies\]$/m)[1];
  if (!section) die('error: no [workspace.dependencies] section in Cargo.toml');

  const line = section.split(/^\[/m)[0].match(/^stellar-xdr\s*=\s*(.+)$/m);
  if (!line) die('error: no stellar-xdr entry in [workspace.dependencies]');

  const version = line[1].match(/"[=^~]?(\d+)(\.\d+){0,2}"/);
  if (!version)
    die(`error: cannot read a version out of: stellar-xdr = ${line[1]}`);

  return Number(version[1]);
};

/**
 * The `stellar-xdr` majors our own crates resolve to. Our crates are the lock
 * entries with no `source` line; a dependency is written `"stellar-xdr"` when
 * the lock holds one version and `"stellar-xdr 28.0.0"` when it holds several.
 * More than one major here is the skew described in the header.
 */
const resolvedMajors = () => {
  const lock = readFileSync(join(repoRoot, 'Cargo.lock'), 'utf8');
  const blocks = lock.split('[[package]]');
  // Used only when the lock holds a single stellar-xdr.
  const onlyMajor = lock.match(
    /^name = "stellar-xdr"\nversion = "(\d+)\./m
  )?.[1];

  const majors = new Set();
  for (const block of blocks) {
    if (block.includes('\nsource = ')) continue;
    for (const dep of block.matchAll(/"stellar-xdr(?: (\d+)\.[^"]*)?"/g))
      majors.add(Number(dep[1] ?? onlyMajor));
  }
  return [...majors].sort((a, b) => a - b);
};

// ------------------------------------------------------------- the network --

const networkProtocol = async () => {
  const response = await fetch(horizonUrl, {
    signal: AbortSignal.timeout(15000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const root = await response.json();
  const current = root.current_protocol_version;
  const supported =
    root.core_supported_protocol_version ?? root.supported_protocol_version;

  if (!Number.isInteger(current) || !Number.isInteger(supported))
    throw new Error(
      `unexpected root document: current_protocol_version=${current}, ` +
        `core_supported_protocol_version=${supported}`
    );

  return { current, supported };
};

/**
 * What crates.io has published: the newest stable version, and the newest
 * version of any kind when that is a pre-release ahead of it. crates.io
 * rejects requests without a User-Agent.
 */
const publishedCrate = async () => {
  const response = await fetch(cratesUrl, {
    signal: AbortSignal.timeout(15000),
    headers: {
      accept: 'application/json',
      'user-agent':
        'soroban-block-explorer xdr-protocol-watch (github.com/rumblefishdev/soroban-block-explorer)',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const { crate, versions } = await response.json();
  const stable = crate?.max_stable_version;
  if (!/^\d+\.\d+\.\d+$/.test(String(stable)) || !Array.isArray(versions))
    throw new Error(
      `unexpected crate document: max_stable_version=${stable}, ` +
        `versions=${Array.isArray(versions) ? versions.length : versions}`
    );

  const newest = crate.max_version;
  return {
    stable,
    preRelease: newest && newest !== stable ? newest : null,
    releases: versions
      .filter((v) => !v.yanked && /^\d+\.\d+\.\d+$/.test(v.num))
      .map((v) => v.num),
  };
};

/**
 * The newest stable release a bump for `protocol` could use: a major above
 * our pin and NOT above `protocol`. A later major carries a later protocol's
 * XDR (upstream skipped 29, and 30.0.0 is protocol 30, not 29).
 */
const bumpTarget = (crate, protocol) =>
  crate.releases
    .filter((v) => {
      const major = Number(v.split('.')[0]);
      return major > pinned && major <= protocol;
    })
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0];

// -------------------------------------------------------------------- run --

const pinned = pinnedMajor();
const resolved = resolvedMajors();

if (resolved.length > 1)
  die(
    `error: our crates resolve ${
      resolved.length
    } stellar-xdr majors: ${resolved.join(', ')}.`,
    '',
    'contract-executor passes our XDR types to soroban-env-host, so two majors',
    'among our crates is a type mismatch, not a warning. The workspace pin and',
    "soroban-env-host's stellar-xdr pin must move together."
  );

if (resolved.length === 1 && resolved[0] !== pinned)
  die(
    `error: Cargo.toml pins stellar-xdr ${pinned} but Cargo.lock resolved ${resolved[0]}.`,
    '',
    'Run `cargo update -p stellar-xdr` (or re-pin) so the lockfile and the',
    'stated pin agree before trusting any protocol comparison.'
  );

let network;
try {
  network = await networkProtocol();
} catch (error) {
  const message = `cannot reach ${horizonUrl}: ${error.message}`;
  if (watch)
    die(
      `error: ${message}`,
      '',
      'A scheduled watch that checks nothing is the failure this guard exists',
      'to prevent, so an unreachable Horizon fails here rather than passing',
      'quietly. On a pull request the same condition is only a notice.'
    );
  console.log(`notice: ${message} — protocol comparison skipped`);
  process.exit(0);
}

const summary =
  `pinned stellar-xdr ${pinned} | mainnet current ${network.current} | ` +
  `core supports ${network.supported}`;

const behind = pinned < network.current;

if (behind || pinned < network.supported) {
  // The crate a bump would need: mainnet's protocol once it has voted, the one
  // core supports while the vote is still ahead.
  const needed = behind ? network.current : network.supported;

  let crate;
  try {
    crate = await publishedCrate();
  } catch (error) {
    const message = `cannot read ${cratesUrl}: ${error.message}`;
    if (watch)
      die(
        `error: ${message}`,
        '',
        `  ${summary}`,
        '',
        `Whether a stellar-xdr ${needed} is published could not be checked.`,
        'The watch could not complete, so the run fails; no bump is being',
        'asked for. The next run checks again.'
      );
    console.log(`notice: ${message} — crate availability not checked`);
    process.exit(0);
  }

  // Asked per protocol: mainnet can sit on one with no crate (29) while core
  // already supports the next one, which has a crate (30). That is LAGGING.
  const forMainnet = behind && bumpTarget(crate, network.current);
  const forCore = bumpTarget(crate, network.supported);

  // The `— WAITING: no stellar-xdr` wording is matched by
  // xdr-protocol-watch.yml to close an open issue as "not actionable yet".
  if (!forMainnet && !forCore) {
    console.log(
      [
        behind
          ? `notice: stellar-xdr ${pinned} is behind mainnet protocol ${network.current} — WAITING: no stellar-xdr ${needed} is published yet.`
          : `notice: stellar-xdr ${pinned} lags the protocol core already supports (${network.supported}) — WAITING: no stellar-xdr ${needed} is published yet.`,
        '',
        `  ${summary} | newest on crates.io ${crate.stable}` +
          (crate.preRelease ? ` (pre-release ${crate.preRelease})` : ''),
        '',
        ...(Number(crate.stable.split('.')[0]) > needed
          ? [
              `stellar-xdr ${crate.stable} carries a later protocol's XDR, so it is not`,
              `a bump target for ${needed}.`,
              '',
            ]
          : []),
        ...(behind
          ? [
              'Mainnet has voted, but there is no crate to bump to: either the',
              'protocol changed no XDR (29 kept the XDR of 28) or the crate is late.',
              'A real decode wall shows as the production-ingestion-stall alarm.',
              'The watch fails and opens an issue the day a stable',
              `stellar-xdr ${needed}.x appears on crates.io, or core supports a`,
              'protocol whose crate is published.',
            ]
          : [
              'Nothing to do yet: there is no crate to bump to, and mainnet has not',
              'voted. The watch fails and opens an issue the day a stable',
              `stellar-xdr ${needed}.x appears on crates.io.`,
            ]),
      ].join('\n')
    );
    process.exit(0);
  }

  if (forMainnet)
    die(
      `error: stellar-xdr ${pinned} is BEHIND mainnet protocol ${network.current}.`,
      '',
      `  ${summary} | newest on crates.io ${crate.stable} | bump to ${forMainnet}`,
      '',
      'The decode wall is live or one ledger away: the indexer stops writing',
      'ledgers, which the production-ingestion-stall alarm reports.',
      '',
      'Bump the pin together with soroban-env-host, then DEPLOY it — a merged',
      'bump does nothing until the indexer ships. Runbook:',
      'docs/runbooks/xdr-protocol-watch.md'
    );

  const lines = [
    `stellar-xdr ${pinned} lags the protocol core already supports (${network.supported}).`,
    '',
    `  ${summary} | newest on crates.io ${crate.stable}`,
    '',
    `stellar-xdr ${forCore} is published — the bump is possible now.`,
    `Mainnet has not voted ${network.supported} yet, so nothing is broken — this is the lead time.`,
    'Open the bump before the vote, testnet first. It moves with',
    "soroban-env-host (contract-executor), and check the crate's XDR commit,",
    'not only its version number.',
  ];
  if (watch) die(`error: ${lines[0]}`, ...lines.slice(1));
  console.log(`notice: ${lines.join('\n')}`);
  process.exit(0);
}

console.log(`stellar-xdr is current with mainnet — ${summary}`);
