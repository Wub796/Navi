#!/usr/bin/env node
// Release notes, assembled from what the release gate actually recorded.
//
// Nothing here is retyped by hand: the byte budgets, the SRI hash, the gate verdicts
// and the rebuild result are read out of reports/build.json and
// reports/release-verification.json, which the verification job wrote on this exact
// revision. The same standard applies to the container receipts: the runtime identity,
// the capabilities the process actually held, the store backend and the lifecycle
// verdicts are read out of them, so a note cannot claim a platform whose verification
// never ran. The clean-room canary attestation is held to it too — the packed tarball's
// checks are printed from `evidence.canary`, and whether that record counts as
// verification at all is decided by the same rule the publish preflight applies, so the
// note and the gate cannot disagree about whether the tarball was proven. It also fails
// rather than inventing a note for a revision no gate has passed.
//
// Usage: node scripts/release-notes.mjs [--tag v0.5.0] [--out reports/release-notes.md]
// Exit codes: 0 written, 1 the receipts do not describe a verified release, 2 usage.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readContainerReceipts } from './container-evidence.mjs';
import { canaryEvidence } from './publish-preflight.mjs';

/** @param {string[]} argv @param {string} flag @returns {string | null} */
function option(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
}

/** @param {Array<Record<string, any>>} checks @param {string} id @returns {Record<string, any> | undefined} */
const checkNamed = (checks, id) => checks.find(check => check?.check === id);

/**
 * The container attestation table: one row per verified container, read out of the
 * receipts. A value a receipt does not record is printed as not recorded rather than
 * guessed, and a platform with no receipt is not claimed at all - an omission that read
 * as a pass would be worse than an empty table.
 * @param {Array<Record<string, any>>} containers
 * @returns {string}
 */
export function containerAttestation(containers) {
  if (!containers.length) {
    return 'No container receipt was found on this revision, so these notes claim no container verification.';
  }
  const rows = containers.map(container => {
    const checks = /** @type {Array<Record<string, any>>} */ (Array.isArray(container.checks) ? container.checks : []);
    /** @type {Record<string, any> | null} */
    let posture = null;
    try { posture = JSON.parse(String(checkNamed(checks, 'runtime-posture')?.detail ?? '')); }
    catch { posture = null; }
    const proc = Array.isArray(posture?.proc) ? posture.proc.map((/** @type {unknown} */ line) => String(line).replace(/\t/g, ' ')) : [];
    const noNewPrivileges = proc.some(line => /NoNewPrivs:\s+1$/.test(line));
    const capabilities = /CapEff:\s+0+$/.test(proc.find(line => line.startsWith('CapEff')) ?? '')
      ? `dropped (\`CapEff 0\`${noNewPrivileges ? ', `NoNewPrivs 1`' : ''})`
      : 'not recorded';
    const store = checkNamed(checks, 'sqlite-store');
    const lifecycle = checks.filter(check => /-crash-recovery$/.test(String(check.check)));
    const recovered = lifecycle.length === 2 && lifecycle.every(check => check.ok);
    const passed = checks.filter(check => check.ok).length;
    return `| ${container.architecture ?? 'not recorded'} | \`${container.compose ?? 'not recorded'}\` | ${typeof posture?.uid === 'number' ? `uid ${posture.uid} (${posture.node ?? 'node not recorded'})` : 'not recorded'} | ${capabilities} | ${store?.ok ? 'sqlite, `-wal` sidecar present' : 'not recorded'} | ${recovered ? 'SIGKILL 137 → counter 1; graceful stop → 0' : 'not recorded'} | ${passed}/${checks.length} ${container.ok ? 'pass' : 'FAIL'} |`;
  });
  return [
    '| Platform | Compose file | Runtime identity | Capabilities | Store | Lifecycle recovery | Checks |',
    '|---|---|---|---|---|---|---:|',
    ...rows
  ].join('\n');
}

/**
 * The clean-room package canary attestation: one row per check the tarball verifier ran,
 * with the status read out of the receipt and the description taken from what that very
 * check recorded. The measured values — the hash it matched, the files it counted, the
 * handshake it negotiated — therefore travel with the row that claims them, instead of
 * sitting beside a label that could quietly stop matching the check it names.
 *
 * A record that is absent, empty, incomplete or not green is never rendered as a pass:
 * the same rule the publish preflight applies decides that, and a warning block naming
 * the shortfall is printed above whatever rows do exist.
 * @param {Record<string, any> | null | undefined} canary `evidence.canary`
 * @returns {string}
 */
export function canaryAttestation(canary) {
  const checks = Array.isArray(canary?.checks) ? canary.checks : [];
  const verdict = canaryEvidence({ evidence: { canary } });
  const warning = verdict.ok ? '' : `> [!WARNING]\n> \`evidence.canary\` is not a complete green run on this revision: ${verdict.detail}\n`;
  if (!checks.length) {
    return `${warning}\nNo clean-room canary check result is recorded, so these notes claim no verification of the packed tarball.`;
  }
  const rows = checks.map(check => `| \`${check.id}\` | ${String(check.detail ?? 'not recorded').replace(/\|/g, '\\|')} | ${check.ok === true ? 'Passed' : 'Failed'} |`);
  const table = ['| Check | Description | Status |', '| :--- | :--- | :--- |', ...rows].join('\n');
  return warning ? `${warning}\n${table}` : table;
}

/**
 * The provenance the verification section opens with: the revision the receipt names and the
 * digest of the source tree it verified.
 *
 * The second half is the one that carries weight. A receipt cannot name the commit that
 * publishes it — that commit does not exist when the gate writes the file — so
 * `evidence.revision` always names the revision one step behind the tag. `evidence.sourceTree`
 * digests every tracked path outside `reports/`, which is what lets a reader check the thing
 * that actually matters: that the tagged commit carries exactly the source tree the gate
 * verified, with the report refresh that followed it the only permitted difference.
 *
 * A receipt that records no digest is said to be missing one rather than quietly described by
 * its revision alone, because the revision on its own proves nothing about the tagged tree.
 * @param {Record<string, any> | null | undefined} receipt
 * @returns {string}
 */
export function sourceTreeAttestation(receipt) {
  const revision = typeof receipt?.evidence?.revision === 'string' ? receipt.evidence.revision : null;
  const sourceTree = typeof receipt?.evidence?.sourceTree === 'string' ? receipt.evidence.sourceTree : null;
  if (!sourceTree) {
    return '> [!WARNING]\n> This receipt records no `evidence.sourceTree`, so the tagged commit cannot be shown to carry the source tree the gate verified; re-run `npm run verify:release` on the revision being released.';
  }
  const named = revision ? `\`evidence.revision\` is \`${revision}\`` : 'no revision is recorded';
  return [
    `Provenance: ${named} and \`evidence.sourceTree\` is \`${sourceTree}\` — a digest of every tracked`,
    'path outside `reports/`. This receipt is published by the generated-reports commit that follows the',
    'gate run, so the revision it names is one step behind the tag; the digest is what shows the tagged',
    'commit carries exactly the source tree the gate verified, allowing a rewrite under `reports/` and',
    'nothing else. The publish preflight refuses on any other difference, and on a recorded digest that',
    'does not match the tagged tree.'
  ].join('\n');
}

/**
 * @param {{build: Record<string, any>, receipt: Record<string, any>, version: string, tag: string, protocol: string, containers?: Array<Record<string, any>>, canary?: Record<string, any>}} input
 * @returns {string} markdown
 */
export function renderReleaseNotes(input) {
  const { build, receipt, version, tag, protocol, containers = [] } = input;
  const canary = input.canary ?? receipt.evidence?.canary ?? null;
  const bundleBytes = Number(build.rawBytes ?? 0);
  const loaderBytes = Number(build.loaderBytes ?? 0);
  const sdkBudget = Number(build.budgetBytes ?? 15000);
  const loaderBudget = Number(build.loaderBudgetBytes ?? 700);
  const checks = Array.isArray(receipt.checks) ? receipt.checks : [];
  const verifiedAt = typeof receipt.recordedAt === 'string' ? receipt.recordedAt : null;
  const host = typeof build.integrity === 'string' ? build.integrity : '(missing)';
  return `## Navi ${version}

Distributed browser runtime for agent-driven pages: deterministic action maps, differential
updates, guarded execution and settlement receipts. Protocol version \`${protocol}\` — read out of
the shipped \`dist/navi.min.js\` below, not retyped here, so a protocol bump cannot leave these
notes describing the previous one.

### Artifacts

| Artifact | Bytes | Budget | Integrity |
|---|---:|---:|---|
| \`dist/navi.min.js\` | ${bundleBytes} | < ${sdkBudget} | \`${host}\` |
| \`dist/loader.min.js\` | ${loaderBytes} | < ${loaderBudget} | — |

\`dist/navi.min.js\` is self-executing and dependency-free; it makes no network request of its
own. The tenant embed is the loader, served from the same host:

\`\`\`html
<script src="https://YOUR-ASSET-HOST/v1/loader.js"
        data-key="YOUR_TENANT_KEY"
        data-sri="${host}"></script>
\`\`\`

The loader resolves \`/v1/navi.js\` against its own origin, appends the key, verifies the
bundle against \`data-sri\` in CORS mode, and publishes the \`agent-bridge\` marker agents
auto-discover on. Anything embedding the bundle directly must pin the SRI above.

### Container verification

The image is the deployed runtime, and the properties that matter are only visible inside a
running container under the deployment's own restrictions. Each released architecture is
built and exercised natively on its own runner, and every value below is read from those
container receipts rather than restated here.

${containerAttestation(containers)}

### Clean-Room Package Canary Attestation

The image is not the only artifact a consumer installs: the packed tarball is the other, and
packing can drop a manifest export, ship a stale hash or sweep a source file into the archive
without a single source file changing. This is that artifact's verification — the tarball
unpacked into an empty directory with no \`node_modules\` and no link back to this checkout,
its layout, hash and leak boundary checked on the extracted files, and the packed
\`bin/navi-mcp.js\` then driven through a live stdio JSON-RPC handshake and a \`SIGTERM\`
teardown. Every row is read out of \`evidence.canary\` in the verification receipt.

${canaryAttestation(canary)}

### Verification

${sourceTreeAttestation(receipt)}

${checks.length ? `Recorded by \`npm run verify:release\`${verifiedAt ? ` at ${verifiedAt}` : ''}: **${checks.filter(/** @returns {boolean} */ (check) => check.ok).length}/${checks.length} checks passed**, receipt \`ok: ${receipt.ok}\`.

| Check | Result | Detail |
|---|---|---:|
${checks.map(/** @returns {string} */ (check) => `| \`${check.id}\` | ${check.ok ? 'pass' : 'FAIL'} | ${String(check.detail ?? '').replace(/\|/g, '\\|')} |`).join('\n')}` : 'No verification receipt was found for this revision.'}

### Discovery

A host that serves this runtime publishes \`GET /.well-known/navi.json\` and advertises it from
every response with \`Link: </.well-known/navi.json>; rel="agent-bridge"\`, so an agent handed
only a URL can find the runtime, bind to the instance the host already runs, and inject the
host's own designated asset — verifying a declared subresource integrity hash first. Client
configuration for Claude Desktop, Cursor and page embeds: [docs/INTEGRATION-MATRIX.md](docs/INTEGRATION-MATRIX.md).

### Honest limits

These notes are generated from this repository's own gate receipts on ${tag}. The npm publish
is verified by the workflow, not by a hosted CI run reproduced here; the remote SSE transport
is exercised against this repository's own SSE tests rather than a third-party client; and
each architecture's container verification is recorded only where a receipt exists — a
platform absent from the table above is unverified, not implied, and the canary table is only
as green as the record it reads. See
[reports/PHASE5-VERIFICATION.md](reports/PHASE5-VERIFICATION.md) for the phase record.
`;
}

/**
 * The protocol version as the shipped bundle actually reports it. The bundle is the
 * authority — it is the only copy a tenant's browser will run — so the notes read it
 * from there rather than from a constant that could drift away from the artifact.
 * @returns {Promise<string>}
 */
async function shippedProtocol() {
  const bundle = await readFile(new URL('../dist/navi.min.js', import.meta.url), 'utf8');
  const found = [...new Set(bundle.match(/\b\d+\.\d+\.\d+\b/g) ?? [])];
  if (found.length !== 1) {
    throw new Error(`dist/navi.min.js reports ${found.length} version literal(s) (${found.join(', ') || 'none'}), so the protocol version in these notes would be a guess`);
  }
  return found[0];
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2)) {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const tag = option(argv, '--tag') ?? `v${manifest.version}`;
  const out = option(argv, '--out');
  /** @type {Record<string, any>} */
  const build = JSON.parse(await readFile(new URL('../reports/build.json', import.meta.url), 'utf8'));
  /** @type {Record<string, any> | null} */
  let receipt = null;
  try {
    receipt = JSON.parse(await readFile(new URL('../reports/release-verification.json', import.meta.url), 'utf8'));
  } catch { /* reported below */ }
  if (!receipt || receipt.ok !== true) {
    process.stderr.write(`release-notes: ${receipt ? 'reports/release-verification.json does not record a passing release' : 'reports/release-verification.json is missing'}. Run \`npm run verify:release\` on the tagged revision first, so a note cannot describe an unverified release.\n`);
    return 1;
  }
  /** @type {string} */
  let protocol;
  try {
    protocol = await shippedProtocol();
  } catch (error) {
    process.stderr.write(`release-notes: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const containers = await readContainerReceipts(fileURLToPath(new URL('..', import.meta.url)));
  const notes = renderReleaseNotes({ build, receipt, version: manifest.version, tag, protocol, containers });
  if (out) {
    await writeFile(out, notes);
    process.stdout.write(`release-notes: wrote ${out} (${Buffer.byteLength(notes)} bytes) for ${tag}\n`);
  } else {
    process.stdout.write(notes);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
