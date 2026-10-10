#!/usr/bin/env node
// Release notes, assembled from what the release gate actually recorded.
//
// Nothing here is retyped by hand: the byte budgets, the SRI hash, the gate verdicts
// and the rebuild result are read out of reports/build.json and
// reports/release-verification.json, which the verification job wrote on this exact
// revision. A release note therefore cannot describe a different artifact than the
// one being published, and it fails rather than inventing a note for a revision no
// gate has passed.
//
// Usage: node scripts/release-notes.mjs [--tag v0.5.0] [--out reports/release-notes.md]
// Exit codes: 0 written, 1 the receipts do not describe a verified release, 2 usage.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** @param {string[]} argv @param {string} flag @returns {string | null} */
function option(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
}

/**
 * @param {{build: Record<string, any>, receipt: Record<string, any>, version: string, tag: string, protocol: string}} input
 * @returns {string} markdown
 */
export function renderReleaseNotes(input) {
  const { build, receipt, version, tag, protocol } = input;
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

### Verification

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
linux/amd64 sandboxing is verified on a native runner rather than through emulation. See
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
  const notes = renderReleaseNotes({ build, receipt, version: manifest.version, tag, protocol });
  if (out) {
    await writeFile(out, notes);
    process.stdout.write(`release-notes: wrote ${out} (${Buffer.byteLength(notes)} bytes) for ${tag}\n`);
  } else {
    process.stdout.write(notes);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
