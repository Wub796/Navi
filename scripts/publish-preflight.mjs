#!/usr/bin/env node
// Publish preflight: the checks that must hold before `npm publish` runs, kept in
// this repository rather than in a shell line inside a workflow so they can be run
// and tested the same way locally.
//
// A registry publish is the one action here that cannot be undone: an npm version
// is immutable, and provenance attaches a signed statement to it. So this refuses
// to proceed while a decision is still missing — no license file, no `license`
// field, or a receipt that does not describe this revision — even though those are
// the kind of details a person is tempted to fill in "later".
//
// Usage: node scripts/publish-preflight.mjs [--tag v0.5.0]
// Exit codes: 0 ready to publish, 1 not ready (the reasons are printed), 2 usage.
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Files npm accepts as the license text, in the order npm looks for them. */
const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE'];

/** @param {URL | string} path @returns {Promise<boolean>} */
const exists = async path => stat(path).then(() => true, () => false);

/** @param {string[]} argv @param {string} flag @returns {string | null} */
function option(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
}

/** @typedef {{id: string, ok: boolean, detail: string, blocking: boolean}} PreflightCheck */

/**
 * @param {Record<string, any>} manifest
 * @param {{licenseFile: string | null, receipt: Record<string, any> | null, tag: string | null, artifacts?: {sri: string | null, bundleBytes: number | null, loaderBytes: number | null}}} context
 * @returns {PreflightCheck[]}
 */
export function evaluatePublish(manifest, context) {
  const publishConfig = manifest.publishConfig ?? {};
  const licence = typeof manifest.license === 'string' && manifest.license.trim() ? manifest.license.trim() : null;
  const expectedTag = `v${manifest.version}`;
  const tagMatches = context.tag === null ? null : context.tag === expectedTag;
  return [
    {
      id: 'license-file',
      ok: context.licenseFile !== null,
      detail: context.licenseFile
        ? `${context.licenseFile} is present`
        : `no ${LICENSE_FILES.join('/')} file at the repository root. npm publishes whatever license the package declares; choosing one is the owner's decision, not this pipeline's, so the publish stops here.`,
      blocking: true
    },
    {
      id: 'license-field',
      ok: licence !== null,
      detail: licence ? `package.json declares "license": "${licence}"` : 'package.json declares no `license` field, so the published package would carry no license at all',
      blocking: true
    },
    {
      id: 'not-private',
      ok: manifest.private !== true,
      detail: manifest.private === true ? 'package.json sets "private": true, which makes publishing a mistake rather than a decision' : 'the package is publishable',
      blocking: true
    },
    {
      id: 'public-access',
      ok: publishConfig.access === 'public',
      detail: `publishConfig.access is ${JSON.stringify(publishConfig.access ?? null)}; this repository publishes a public package, and --access public must agree with it`,
      blocking: true
    },
    {
      id: 'provenance',
      ok: publishConfig.provenance === true,
      detail: publishConfig.provenance === true
        ? 'publishConfig.provenance is true, so the workflow passes --provenance (which also requires a public source repository and id-token: write)'
        : 'publishConfig.provenance is not true, so the published tarball would carry no provenance statement',
      blocking: true
    },
    {
      id: 'tag-matches-version',
      ok: tagMatches !== false,
      detail: tagMatches === null ? `no tag supplied; a tag push must be ${expectedTag}` : tagMatches ? `${context.tag} matches package.json version ${manifest.version}` : `tag ${context.tag} does not match package.json version ${manifest.version}`,
      blocking: true
    },
    {
      id: 'verification-receipt',
      ok: context.receipt?.ok === true,
      detail: receiptDetail(context.receipt),
      blocking: true
    },
    {
      // A receipt is only evidence about the bytes it named. This is what stops a
      // stale receipt from authorising a publish of artifacts that changed after it
      // was written, which a timestamp alone would not catch.
      id: 'receipt-matches-artifacts',
      ok: receiptDescribes(context.receipt, context.artifacts),
      detail: receiptArtifactDetail(context.receipt, context.artifacts),
      blocking: true
    }
  ];
}

/** @param {Record<string, any> | null} receipt @returns {string} */
function receiptDetail(receipt) {
  if (!receipt) return 'reports/release-verification.json is missing; run `npm run verify:release` first';
  const checks = Array.isArray(receipt.checks) ? receipt.checks : [];
  const passed = checks.filter(/** @param {{ok?: unknown}} check */ check => check.ok === true).length;
  const revision = typeof receipt.evidence?.revision === 'string' ? receipt.evidence.revision.slice(0, 12) : 'an unrecorded revision';
  return `reports/release-verification.json records ${passed}/${checks.length} checks for ${revision}, ok: ${receipt.ok}`;
}

/**
 * @param {Record<string, any> | null} receipt
 * @param {{sri: string | null, bundleBytes: number | null, loaderBytes: number | null} | undefined} artifacts
 * @returns {boolean}
 */
function receiptDescribes(receipt, artifacts) {
  if (!receipt?.evidence || !artifacts) return false;
  return receipt.evidence.sri === artifacts.sri && receipt.evidence.bundleBytes === artifacts.bundleBytes && receipt.evidence.loaderBytes === artifacts.loaderBytes;
}

/**
 * @param {Record<string, any> | null} receipt
 * @param {{sri: string | null, bundleBytes: number | null, loaderBytes: number | null} | undefined} artifacts
 * @returns {string}
 */
function receiptArtifactDetail(receipt, artifacts) {
  if (!receipt?.evidence) return 'the receipt records no artifact evidence, so it cannot be tied to these bytes; re-run `npm run verify:release`';
  if (!artifacts) return 'the artifacts on disk could not be read';
  const same = receiptDescribes(receipt, artifacts);
  return same
    ? `the receipt describes exactly these bytes (${receipt.evidence.sri.slice(0, 20)}…, ${receipt.evidence.bundleBytes} B bundle, ${receipt.evidence.loaderBytes} B loader)`
    : `the artifacts no longer match the receipt: receipt ${String(receipt.evidence.sri).slice(0, 20)}…/${receipt.evidence.bundleBytes} B/${receipt.evidence.loaderBytes} B versus ${String(artifacts.sri).slice(0, 20)}…/${artifacts.bundleBytes} B/${artifacts.loaderBytes} B`;
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2)) {
  const tag = option(argv, '--tag') ?? (process.env.GITHUB_REF_NAME?.startsWith('v') ? process.env.GITHUB_REF_NAME : null);
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  /** @type {string | null} */
  let licenseFile = null;
  for (const candidate of LICENSE_FILES) {
    if (await exists(new URL(`../${candidate}`, import.meta.url))) { licenseFile = candidate; break; }
  }
  /** @type {Record<string, any> | null} */
  let receipt = null;
  try {
    receipt = JSON.parse(await readFile(new URL('../reports/release-verification.json', import.meta.url), 'utf8'));
  } catch { /* the check below reports the absence */ }

  /** @type {{sri: string | null, bundleBytes: number | null, loaderBytes: number | null}} */
  const artifacts = { sri: null, bundleBytes: null, loaderBytes: null };
  try {
    artifacts.sri = (await readFile(new URL('../dist/sri.txt', import.meta.url), 'utf8')).trim();
    artifacts.bundleBytes = (await stat(new URL('../dist/navi.min.js', import.meta.url))).size;
    artifacts.loaderBytes = (await stat(new URL('../dist/loader.min.js', import.meta.url))).size;
  } catch { /* reported by the check below */ }

  const checks = evaluatePublish(manifest, { licenseFile, receipt, tag, artifacts });
  const blocking = checks.filter(check => !check.ok && check.blocking);
  process.stdout.write(`publish preflight for ${manifest.name}@${manifest.version}${tag ? ` (${tag})` : ''}\n`);
  for (const check of checks) process.stdout.write(`  ${check.ok ? 'ok  ' : 'fail'} ${check.id}: ${check.detail}\n`);
  if (blocking.length) {
    process.stdout.write(`\nNot publishing: ${blocking.length} requirement(s) unmet (${blocking.map(check => check.id).join(', ')}).\n`);
    return 1;
  }
  process.stdout.write('\nReady to publish.\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
