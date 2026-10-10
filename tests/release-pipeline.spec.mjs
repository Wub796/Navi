import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePublish } from '../scripts/publish-preflight.mjs';
import { renderReleaseNotes } from '../scripts/release-notes.mjs';

/**
 * Release-pipeline checks.
 *
 * A registry publish is the one action in this repository that cannot be undone, so
 * the rules that guard it are tested rather than trusted: the preflight must refuse
 * while a decision is missing, and it must refuse a receipt that no longer describes
 * the artifacts in front of it. The release notes are held to the same standard from
 * the other side — they are generated from the receipts, so they can only state what
 * a gate actually recorded.
 */
const root = fileURLToPath(new URL('..', import.meta.url));

/** A manifest that is ready to publish, so each test can break exactly one thing. */
const readyManifest = {
  name: 'navi-interaction-bridge',
  version: '0.5.0',
  license: 'MIT',
  publishConfig: { access: 'public', provenance: true }
};
const readyReceipt = {
  ok: true,
  checks: [{ id: 'test-suite', ok: true, detail: '81 passed, 0 failed (floor 81)' }],
  evidence: { revision: 'abc123def456', sri: 'sha384-AAAA', bundleBytes: 14929, loaderBytes: 689, floor: 81, tests: [81, 0] }
};
const readyArtifacts = { sri: 'sha384-AAAA', bundleBytes: 14929, loaderBytes: 689 };

/** @param {ReturnType<typeof evaluatePublish>} checks @returns {string[]} */
const blockedBy = checks => checks.filter(check => !check.ok && check.blocking).map(check => check.id);

test('the publish preflight refuses to publish until the license decision is made', () => {
  // The real manifest in this repository declares no license and has no LICENSE
  // file, which is precisely the state the preflight exists to stop.
  const withoutLicense = evaluatePublish({ ...readyManifest, license: undefined }, { licenseFile: null, receipt: readyReceipt, tag: 'v0.5.0', artifacts: readyArtifacts });
  expect(blockedBy(withoutLicense)).toEqual(['license-file', 'license-field']);
  expect(withoutLicense.find(check => check.id === 'license-file')?.detail).toContain('no LICENSE');

  // One of the two is not enough: the package would still declare nothing a
  // consumer can rely on.
  expect(blockedBy(evaluatePublish({ ...readyManifest, license: undefined }, { licenseFile: 'LICENSE', receipt: readyReceipt, tag: 'v0.5.0', artifacts: readyArtifacts }))).toEqual(['license-field']);
  expect(blockedBy(evaluatePublish(readyManifest, { licenseFile: null, receipt: readyReceipt, tag: 'v0.5.0', artifacts: readyArtifacts }))).toEqual(['license-file']);

  // With every decision made, nothing blocks.
  expect(blockedBy(evaluatePublish(readyManifest, { licenseFile: 'LICENSE', receipt: readyReceipt, tag: 'v0.5.0', artifacts: readyArtifacts }))).toEqual([]);

  // The settings npm's side of the contract depends on are checked too, because a
  // publish without provenance or with the wrong access cannot be corrected later.
  expect(blockedBy(evaluatePublish({ ...readyManifest, private: true }, { licenseFile: 'LICENSE', receipt: readyReceipt, tag: 'v0.5.0', artifacts: readyArtifacts }))).toEqual(['not-private']);
  expect(blockedBy(evaluatePublish({ ...readyManifest, publishConfig: { access: 'restricted', provenance: true } }, { licenseFile: 'LICENSE', receipt: readyReceipt, tag: 'v0.5.0', artifacts: readyArtifacts }))).toEqual(['public-access']);
  expect(blockedBy(evaluatePublish({ ...readyManifest, publishConfig: { access: 'public' } }, { licenseFile: 'LICENSE', receipt: readyReceipt, tag: 'v0.5.0', artifacts: readyArtifacts }))).toEqual(['provenance']);
  expect(blockedBy(evaluatePublish(readyManifest, { licenseFile: 'LICENSE', receipt: readyReceipt, tag: 'v0.4.0', artifacts: readyArtifacts }))).toEqual(['tag-matches-version']);
  expect(blockedBy(evaluatePublish(readyManifest, { licenseFile: 'LICENSE', receipt: null, tag: 'v0.5.0', artifacts: readyArtifacts }))).toEqual(['verification-receipt', 'receipt-matches-artifacts']);
});

test('a receipt that no longer describes the artifacts cannot authorise a publish', () => {
  // Freshness is checked against the bytes, not against a timestamp: rebuilding
  // after verification produces different bytes, and the receipt must stop applying.
  const stale = evaluatePublish(readyManifest, { licenseFile: 'LICENSE', receipt: readyReceipt, tag: 'v0.5.0', artifacts: { ...readyArtifacts, sri: 'sha384-BBBB' } });
  expect(blockedBy(stale)).toEqual(['receipt-matches-artifacts']);
  expect(stale.find(check => check.id === 'receipt-matches-artifacts')?.detail).toContain('no longer match');
  expect(blockedBy(evaluatePublish(readyManifest, { licenseFile: 'LICENSE', receipt: readyReceipt, tag: 'v0.5.0', artifacts: { ...readyArtifacts, loaderBytes: 690 } }))).toEqual(['receipt-matches-artifacts']);
  // A failing receipt blocks on its own verdict, before any artifact comparison.
  expect(blockedBy(evaluatePublish(readyManifest, { licenseFile: 'LICENSE', receipt: { ...readyReceipt, ok: false }, tag: 'v0.5.0', artifacts: readyArtifacts }))).toEqual(['verification-receipt']);
  // A receipt from before this check existed cannot be shown to describe anything.
  expect(blockedBy(evaluatePublish(readyManifest, { licenseFile: 'LICENSE', receipt: { ok: true, checks: [] }, tag: 'v0.5.0', artifacts: readyArtifacts }))).toEqual(['receipt-matches-artifacts']);
});

test('release notes state only what the receipts recorded', () => {
  const notes = renderReleaseNotes({
    build: { rawBytes: 14929, budgetBytes: 15000, loaderBytes: 689, loaderBudgetBytes: 700, integrity: 'sha384-SRI' },
    receipt: { ok: true, recordedAt: '2026-10-10T00:00:00.000Z', checks: [{ id: 'test-suite', ok: true, detail: '81 passed, 0 failed' }, { id: 'rebuild-stable', ok: false, detail: 'rebuild changed the artifacts' }] },
    version: '0.5.0',
    tag: 'v0.5.0',
    protocol: '9.9.9'
  });
  // The protocol version is the shipped bundle's, not a constant typed into the
  // template: this fixture proves the note prints what it is given.
  expect(notes).toContain('`9.9.9`');
  // The SRI hash and the embed tag a tenant needs, taken from the build record.
  expect(notes).toContain('sha384-SRI');
  expect(notes).toContain('data-sri="sha384-SRI"');
  expect(notes).toContain('| 14929 | < 15000 |');
  expect(notes).toContain('| 689 | < 700 |');
  // 1/2, because one recorded check failed: a note never rounds up.
  expect(notes).toContain('**1/2 checks passed**');
  expect(notes).toContain('| `rebuild-stable` | FAIL |');
});

test('the committed receipt describes the committed artifacts', async () => {
  // The receipt and dist/ are committed together and the publish preflight compares
  // them, so a receipt left behind by an older revision is a real defect rather than
  // a cosmetic one. This is that invariant, asserted on the tree itself.
  const receipt = JSON.parse(await readFile(join(root, 'reports/release-verification.json'), 'utf8'));
  const sri = (await readFile(join(root, 'dist/sri.txt'), 'utf8')).trim();
  const bundle = await readFile(join(root, 'dist/navi.min.js'));
  const loader = await readFile(join(root, 'dist/loader.min.js'));
  expect(receipt.evidence, 'the receipt records the bytes it verified').toBeTruthy();
  expect(receipt.evidence.sri).toBe(sri);
  expect(receipt.evidence.bundleBytes).toBe(bundle.length);
  expect(receipt.evidence.loaderBytes).toBe(loader.length);
  expect(receipt.evidence.revision, 'the receipt names the revision it verified').toMatch(/^[0-9a-f]{7,40}$/);
  // The floor is compared the other way round on purpose. A receipt is written
  // *after* the suite it summarises, so a run that raises the floor can never
  // satisfy a comparison between its own recorded count and the floor it is
  // raising — nor can a later reader expect an older receipt to clear a newer
  // floor. What can be checked is that the two numbers agree with each other and
  // that the published floor has not been lowered under a receipt that was
  // measured against more: a coverage floor that goes backwards is a regression
  // this file exists to catch.
  const verifySource = await readFile(join(root, 'scripts/verify-release.mjs'), 'utf8');
  const floor = Number(/MIN_PASSING_TESTS = (\d+)/.exec(verifySource)?.[1]);
  const recordedFloor = receipt.evidence.floor ?? 0;
  expect(recordedFloor, 'the receipt records the floor it was measured against').toBeLessThanOrEqual(floor);
  expect(receipt.evidence.tests?.[0]).toBeGreaterThanOrEqual(recordedFloor);
  /** @type {{id: string}[]} */
  const recordedChecks = receipt.checks ?? [];
  expect(recordedChecks.some(entry => entry.id === 'test-suite'), 'and which checks it ran').toBe(true);
});
