import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
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

/**
 * The rules a committed receipt must satisfy on its own terms, with no dependence on
 * which run wrote the file or how that run ended.
 *
 * Pure, with its inputs injected, so one implementation is asserted against the
 * committed receipt, against the shapes a failing run leaves behind, and against
 * fixtures. That is the whole point: `scripts/verify-release.mjs` rewrites
 * `reports/release-verification.json` only *after* the suite has finished, so a rule
 * that depends on a run's outcome makes one failing run fail every run that follows,
 * and the gate that would write a healthy receipt can never reach the end of a run.
 * @param {Record<string, any>} receipt
 * @param {{artifacts: {sri: string, bundleBytes: number, loaderBytes: number}, floor: number}} context
 * @returns {string[]} one description per violated rule; empty when the receipt is sound
 */
const receiptViolations = (receipt, { artifacts, floor }) => {
  const violations = [];
  const evidence = receipt.evidence ?? {};
  if (typeof evidence !== 'object' || evidence === null) violations.push('the receipt records no evidence');
  if (evidence.sri !== artifacts.sri) violations.push(`evidence.sri is ${JSON.stringify(evidence.sri)}, but dist/sri.txt is ${artifacts.sri}`);
  if (evidence.bundleBytes !== artifacts.bundleBytes) violations.push(`evidence.bundleBytes is ${JSON.stringify(evidence.bundleBytes)}, but the bundle is ${artifacts.bundleBytes} bytes`);
  if (evidence.loaderBytes !== artifacts.loaderBytes) violations.push(`evidence.loaderBytes is ${JSON.stringify(evidence.loaderBytes)}, but the loader is ${artifacts.loaderBytes} bytes`);
  if (!/^[0-9a-f]{7,40}$/.test(String(evidence.revision))) violations.push(`evidence.revision is ${JSON.stringify(evidence.revision)}, which does not name a revision`);
  // A coverage floor that goes backwards is a regression, and unlike a pass count the
  // floor is a property of the source rather than of whichever run wrote the file.
  if (!(Number(evidence.floor ?? 0) <= floor)) violations.push(`the recorded floor ${JSON.stringify(evidence.floor)} is above the published floor ${floor}`);
  const checks = Array.isArray(receipt.checks) ? receipt.checks : [];
  // Which checks ran is deliberately not asserted: a `--skip-tests` run records no
  // test-suite check at all, and assuming one is present is what wedged this suite.
  // That the recorded checks are well-formed verdicts is always assertable.
  if (!checks.length) violations.push('the receipt records no checks');
  for (const check of checks) {
    if (typeof check?.id !== 'string' || typeof check?.ok !== 'boolean') violations.push(`recorded check ${JSON.stringify(check)} is not a named verdict`);
  }
  // Internal consistency, for a receipt that claims both a passing run and a suite run:
  // a pass cannot be recorded as fewer passes than the floor it was measured against.
  // A failed run and a `--skip-tests` run record no count, and are tolerated here - the
  // preflight refuses the former on its verdict instead, which the test below pins down.
  if (receipt.ok === true && checks.some(check => check?.id === 'test-suite') && !(Number(evidence.tests?.[0] ?? 0) >= Number(evidence.floor ?? 0))) {
    violations.push(`a passing run recorded ${JSON.stringify(evidence.tests)} against floor ${JSON.stringify(evidence.floor)}`);
  }
  return violations;
};

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
  //
  // Only the coupling between the receipt and the bytes is asserted here, because
  // that is a property of the committed files. The pass count the receipt recorded
  // is not: it is a property of whichever run happened to write the file, the gate
  // rewrites the file after the suite has run, and an assertion on it turns one
  // failing run into a permanently failing suite. Do not reintroduce one - use the
  // in-memory rules above, which read a verdict without depending on a run outcome.
  const receipt = JSON.parse(await readFile(join(root, 'reports/release-verification.json'), 'utf8'));
  const sri = (await readFile(join(root, 'dist/sri.txt'), 'utf8')).trim();
  const bundle = await readFile(join(root, 'dist/navi.min.js'));
  const loader = await readFile(join(root, 'dist/loader.min.js'));
  const verifySource = await readFile(join(root, 'scripts/verify-release.mjs'), 'utf8');
  const floor = Number(/MIN_PASSING_TESTS = (\d+)/.exec(verifySource)?.[1]);
  const artifacts = { sri, bundleBytes: bundle.length, loaderBytes: loader.length };

  // Every rule this file holds a committed receipt to, evaluated by the same pure
  // function the fixtures below use, so the committed file and the in-memory cases
  // cannot drift apart. The list names the rule that failed instead of a bare false.
  expect(receiptViolations(receipt, { artifacts, floor })).toEqual([]);

  // The artifact coupling is also asserted through the rule the publish preflight
  // itself applies, rather than only through a second hand-written comparison that
  // could drift from it. It holds whatever the run's verdict was, which is what makes
  // it safe to assert against a file that a failing run may have rewritten.
  const coupling = evaluatePublish(readyManifest, { licenseFile: 'LICENSE', receipt, tag: null, artifacts });
  expect(coupling.find(check => check.id === 'receipt-matches-artifacts')?.ok).toBe(true);
});

test('a failing gate run cannot wedge the suite through the receipt it leaves behind', () => {
  // Regression for a real deadlock, hit while making the license decision.
  //
  // A gate run under the wrong Node version wrote reports/release-verification.json
  // with `ok: false` and `tests: null`. The committed-receipt test above used to
  // assert the recorded pass count straight off disk, so `null >= 88` was false - and
  // because the gate writes that file only *after* the suite has finished, every
  // later run read the same poisoned receipt and failed the same way. `npm test`
  // could not pass from a poisoned tree, which meant the gate that would have written
  // a healthy receipt could never reach the end of a run. Restoring the file by hand
  // was the only way out, which is a test that fails closed on nothing real.
  //
  // The rules that read a recorded verdict are pure, so they are tested in memory
  // here and in the committed-receipt test above, and never against the live file.
  const poisoned = {
    ok: false,
    node: 'v24.21.0',
    checks: [
      { id: 'node-runtime', ok: false, detail: 'v24.21.0; release verification requires Node 22.x and engines >=22.0.0' },
      { id: 'test-suite', ok: true, detail: '88 passed, 0 failed (floor 88)' }
    ],
    evidence: { revision: '245f0850517c1351101b0d3bf6ef7916c87b0cef', branch: 'main', ...readyArtifacts, floor: 88, tests: null }
  };
  const checks = evaluatePublish(readyManifest, { licenseFile: 'LICENSE', receipt: poisoned, tag: 'v0.5.0', artifacts: readyArtifacts });
  // The bytes still match, so the artifact coupling is not what refused it...
  expect(checks.find(check => check.id === 'receipt-matches-artifacts')?.ok).toBe(true);
  // ...the run's own verdict is, and it is the only thing that blocks. Tolerating a
  // poisoned receipt on disk therefore does not let a failed run authorise a
  // publish: the preflight still refuses on the verdict alone.
  expect(blockedBy(checks)).toEqual(['verification-receipt']);

  // The second shape a failing run leaves behind - the one that actually wedged this
  // repository. It is a `--skip-tests` run under a runtime mismatch: seven checks, no
  // test-suite check at all, and no recorded count. Any rule that assumes a test-suite
  // check is present fails on a file the suite is required to tolerate.
  const skipped = { ...poisoned, checks: poisoned.checks.filter(check => check.id !== 'test-suite'), evidence: { ...poisoned.evidence, tests: null } };
  expect(receiptViolations(skipped, { artifacts: readyArtifacts, floor: 88 }), 'a skipped run must be tolerable, not a defect').toEqual([]);
  // A *passing* skip-tests receipt has the same shape, so the tolerance is a property
  // of the shape rather than a loophole that happens to cover failures.
  expect(receiptViolations({ ...skipped, ok: true }, { artifacts: readyArtifacts, floor: 88 })).toEqual([]);
  // Tolerance is not blindness: a receipt that disagrees with the artifacts, claims a
  // pass on fewer passes than its own floor, or records an unnamed verdict is refused.
  expect(receiptViolations(poisoned, { artifacts: { ...readyArtifacts, sri: 'sha384-BBBB' }, floor: 88 })).toHaveLength(1);
  expect(receiptViolations(poisoned, { artifacts: { ...readyArtifacts, loaderBytes: 690 }, floor: 88 })).toHaveLength(1);
  expect(receiptViolations({ ...poisoned, ok: true, evidence: { ...poisoned.evidence, tests: [12, 0] } }, { artifacts: readyArtifacts, floor: 88 })).toHaveLength(1);
  expect(receiptViolations({ ...poisoned, evidence: { ...poisoned.evidence, floor: 99 } }, { artifacts: readyArtifacts, floor: 88 })).toHaveLength(1);
  expect(receiptViolations({ ...poisoned, checks: [{ id: 'test-suite' }] }, { artifacts: readyArtifacts, floor: 88 })).toHaveLength(1);
});

test('the pipeline cannot publish without container verification on both architectures', async () => {
  // The published runtime is the image, so the gate that exercises it is asserted as a
  // shape of the workflow rather than trusted: the publish job depends on the container
  // gate by job id, and a rename on either side would leave a pipeline that still looks
  // gated while publishing past the runtime checks.
  const release = parse(await readFile(join(root, '.github/workflows/release.yml'), 'utf8'));
  const ci = parse(await readFile(join(root, '.github/workflows/ci.yml'), 'utf8'));
  expect(Object.keys(release.jobs)).toEqual(expect.arrayContaining(['verify-release', 'verify-containers', 'publish']));
  expect(release.jobs.publish.needs).toEqual(expect.arrayContaining(['verify-release', 'verify-containers']));
  // The gates run the documented entry points, not a copy of what they expand to.
  expect(release.jobs['verify-release'].steps.some(step => String(step.run ?? '').includes('npm run verify:release'))).toBe(true);
  const containerGate = release.jobs['verify-containers'];
  expect(containerGate.steps.some(step => step.run === 'npm run test:containers')).toBe(true);
  // Both released architectures, each built and verified on its own hardware: an
  // emulated leg refuses at the renderer sandbox, so it would prove nothing about the
  // architecture it claims to cover.
  const expected = [
    { runner: 'ubuntu-latest', platform: 'linux/amd64', arch: 'amd64' },
    { runner: 'ubuntu-24.04-arm', platform: 'linux/arm64', arch: 'arm64' }
  ];
  for (const job of [containerGate, ci.jobs.containers]) {
    expect(job.strategy.matrix.include).toEqual(expected);
    // The runner comes from the matrix, so a leg cannot silently run on the wrong host.
    expect(String(job['runs-on'])).toContain('matrix.runner');
    expect(job.steps.some(step => String(step.run ?? '').includes("docker build --platform '${{ matrix.platform }}'"))).toBe(true);
  }
  // The container receipts are evidence for the release, not a job-local file.
  expect(containerGate.steps.some(step => String(step.with?.name ?? '').startsWith('release-container-receipt-'))).toBe(true);
  expect(release.jobs.publish.steps.some(step => String(step.with?.pattern ?? '').startsWith('release-container-receipt-'))).toBe(true);
});
