import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { CANARY_CHECKS_FLOOR, CONTAINER_CHECKS_FLOOR, evaluatePublish, repositorySlug, resolveProvenance, resolveRepository } from '../scripts/publish-preflight.mjs';
import { canaryAttestation, renderReleaseNotes, sourceTreeAttestation } from '../scripts/release-notes.mjs';
import { readContainerReceipts, summarizeContainer } from '../scripts/container-evidence.mjs';
import { MIN_PASSING_TESTS, sourceTreeDigest } from '../scripts/verify-release.mjs';
import { evaluateUnpackedPackage, REQUIRED_PACKAGE_FILES, verifyCleanRoomPackage } from '../scripts/verify-registry-package.mjs';

/**
 * Release-pipeline checks.
 *
 * A registry publish is the one action in this repository that cannot be undone, so
 * the rules that guard it are tested rather than trusted: the preflight must refuse
 * while a decision is missing, it must refuse a receipt that no longer describes the
 * artifacts in front of it, and it must refuse a receipt that cites no green container
 * verification of a deployment this repository ships. The release notes are held to the
 * same standard from the other side — they are generated from the receipts, so they can
 * only state what a gate actually recorded.
 */
const root = fileURLToPath(new URL('..', import.meta.url));

/** A manifest that is ready to publish, so each test can break exactly one thing. */
const readyManifest = {
  name: 'navi-interaction-bridge',
  version: '0.5.0',
  license: 'MIT',
  repository: { type: 'git', url: 'git+https://github.com/example-org/navi-interaction-bridge.git' },
  publishConfig: { access: 'public', provenance: true }
};
/** A green container verification of the file an operator deploys, as the receipt records it. */
const readyContainers = [
  { architecture: 'linux/arm64', compose: 'deploy/docker-compose.prod.yml', recordedAt: '2026-10-13T01:40:09.443Z', ok: true, passed: 18, checks: 18 }
];
/** A green clean-room package canary verification, as the receipt records it. */
const readyCanary = {
  ok: true,
  mode: 'tarball',
  source: 'local npm pack',
  passed: 6,
  total: 6,
  checks: [
    { id: 'manifest-layout', ok: true, detail: 'all 13 required manifest exports present' },
    { id: 'sri-and-budgets', ok: true, detail: 'dist/navi.min.js matches SRI' },
    { id: 'zero-leak-isolation', ok: true, detail: '0 forbidden files' },
    { id: 'mcp-initialize', ok: true, detail: 'negotiated 2024-11-05' },
    { id: 'mcp-tools-list', ok: true, detail: '5 tools declared' },
    { id: 'mcp-sigterm-teardown', ok: true, detail: 'exit 0 on SIGTERM' }
  ]
};
const readyReceipt = {
  ok: true,
  checks: [{ id: 'test-suite', ok: true, detail: '81 passed, 0 failed (floor 81)' }],
  evidence: { revision: 'abc123def456', sri: 'sha384-AAAA', bundleBytes: 14929, loaderBytes: 689, floor: 81, tests: [81, 0], containers: readyContainers, canary: readyCanary }
};
const readyArtifacts = { sri: 'sha384-AAAA', bundleBytes: 14929, loaderBytes: 689 };

/** @param {ReturnType<typeof evaluatePublish>} checks @returns {string[]} */
const blockedBy = checks => checks.filter(check => !check.ok && check.blocking).map(check => check.id);

/**
 * The provenance facts a checkout resolves when the receipt names the very revision the tag
 * points at: there is nothing to compare, so parity is established by the revision alone.
 * @param {string} revision
 * @returns {{head: string, ancestor: null, changedPaths: null, digest: null, error: null}}
 */
const provenanceAtHead = revision => ({ head: revision, ancestor: null, changedPaths: null, digest: null, error: null });

/**
 * @typedef {{licenseFile: string | null, receipt: Record<string, any> | null, tag: string | null, artifacts: {sri: string | null, bundleBytes: number | null, loaderBytes: number | null}, provenance: ReturnType<typeof provenanceAtHead>, repository: string | null}} PublishContext
 */

/**
 * The publish context with every fact a real run resolves filled in, so each test below can
 * break exactly one thing instead of failing for want of an input it is not about. The git
 * facts are injected rather than resolved because `evaluatePublish` is pure by design — the
 * resolving lives in `resolveProvenance`, which is exercised separately against a real repo.
 * @param {Record<string, any>} [overrides]
 * @returns {PublishContext}
 */
const publishContext = (overrides = {}) => ({
  licenseFile: 'LICENSE',
  receipt: readyReceipt,
  tag: 'v0.5.0',
  artifacts: readyArtifacts,
  provenance: provenanceAtHead(readyReceipt.evidence.revision),
  repository: 'https://github.com/example-org/navi-interaction-bridge.git',
  ...overrides
});

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

/**
 * The container-evidence verdict for one shape of cited evidence, with everything else in
 * `readyManifest` and `readyReceipt` in order so exactly one rule is under test.
 * @param {any} containers the `evidence.containers` value to evaluate
 * @returns {{ok: boolean, detail: string}}
 */
const containerCheck = containers => {
  const checks = evaluatePublish(readyManifest, publishContext({
    receipt: { ...readyReceipt, evidence: { ...readyReceipt.evidence, containers } }
  }));
  const check = checks.find(candidate => candidate.id === 'container-evidence');
  if (!check) throw new Error('the preflight records no container-evidence check');
  return check;
};

/**
 * The canary-evidence verdict for one shape of cited canary evidence.
 * @param {any} canary the `evidence.canary` value to evaluate
 * @returns {{ok: boolean, detail: string}}
 */
const canaryCheck = canary => {
  const checks = evaluatePublish(readyManifest, publishContext({
    receipt: { ...readyReceipt, evidence: { ...readyReceipt.evidence, canary } }
  }));
  const check = checks.find(candidate => candidate.id === 'canary-evidence');
  if (!check) throw new Error('the preflight records no canary-evidence check');
  return check;
};

test('the publish preflight refuses to publish until the license decision is made', () => {
  // The real manifest in this repository declares no license and has no LICENSE
  // file, which is precisely the state the preflight exists to stop.
  const withoutLicense = evaluatePublish({ ...readyManifest, license: undefined }, publishContext({ licenseFile: null }));
  expect(blockedBy(withoutLicense)).toEqual(['license-file', 'license-field']);
  expect(withoutLicense.find(check => check.id === 'license-file')?.detail).toContain('no LICENSE');

  // One of the two is not enough: the package would still declare nothing a
  // consumer can rely on.
  expect(blockedBy(evaluatePublish({ ...readyManifest, license: undefined }, publishContext()))).toEqual(['license-field']);
  expect(blockedBy(evaluatePublish(readyManifest, publishContext({ licenseFile: null })))).toEqual(['license-file']);

  // With every decision made, nothing blocks.
  expect(blockedBy(evaluatePublish(readyManifest, publishContext()))).toEqual([]);

  // The settings npm's side of the contract depends on are checked too, because a
  // publish without provenance or with the wrong access cannot be corrected later.
  expect(blockedBy(evaluatePublish({ ...readyManifest, private: true }, publishContext()))).toEqual(['not-private']);
  expect(blockedBy(evaluatePublish({ ...readyManifest, publishConfig: { access: 'restricted', provenance: true } }, publishContext()))).toEqual(['public-access']);
  expect(blockedBy(evaluatePublish({ ...readyManifest, publishConfig: { access: 'public' } }, publishContext()))).toEqual(['provenance']);
  expect(blockedBy(evaluatePublish(readyManifest, publishContext({ tag: 'v0.4.0' })))).toEqual(['tag-matches-version']);
  // A missing receipt cites nothing at all — not the bytes, not the revision whose code is
  // being published, and not the container verification the bytes are going to run as — so
  // every rule that reads evidence fires.
  expect(blockedBy(evaluatePublish(readyManifest, publishContext({ receipt: null })))).toEqual(['verification-receipt', 'receipt-matches-artifacts', 'provenance-parity', 'container-evidence', 'canary-evidence']);
});

test('a provenance publish must declare the repository the statement will name', async () => {
  // npm binds a provenance statement to the repository the workflow ran in and validates the
  // manifest against it after the bundle has already been signed. An empty `repository.url`
  // therefore cost a whole run and a published attestation, with the refusal arriving as
  // `422 ... package.json: "repository.url" is "", expected to match "https://github.com/…"`
  // from the registry. The same comparison is made here, before the token is spent.
  /** @param {Record<string, any>} manifest @param {string | null} repository @returns {{ok: boolean, blocking: boolean, detail: string}} */
  const repositoryCheck = (manifest, repository) => {
    const checks = evaluatePublish({ ...readyManifest, ...manifest }, publishContext({ repository }));
    const check = checks.find(candidate => candidate.id === 'repository-url');
    if (!check) throw new Error('the preflight records no repository-url check');
    return check;
  };
  const origin = 'https://github.com/example-org/navi-interaction-bridge.git';

  // Ready state: the declaration names the repository this run publishes from.
  expect(repositoryCheck({}, origin).ok).toBe(true);
  expect(repositoryCheck({}, origin).detail).toContain('the repository this release is built from');
  expect(blockedBy(evaluatePublish(readyManifest, publishContext()))).toEqual([]);

  // The defect that reached the registry. Absent, empty and string-empty are one unknown to
  // npm, and each blocks a provenance publish on its own.
  for (const repository of [undefined, null, '', '   ', { type: 'git', url: '' }]) {
    const check = repositoryCheck({ repository }, origin);
    expect(check.ok, JSON.stringify(repository)).toBe(false);
    expect(check.blocking).toBe(true);
    expect(check.detail).toContain('names no repository');
    // The refusal names the 422 a reader will otherwise have to discover from the registry.
    expect(check.detail).toContain('Failed to validate repository information');
  }
  expect(blockedBy(evaluatePublish({ ...readyManifest, repository: undefined }, publishContext()))).toEqual(['repository-url']);

  // A statement is bound to one repository, so a declaration naming another is refused, and
  // both are named so the reader does not have to diff them.
  const elsewhere = repositoryCheck({ repository: 'https://github.com/someone-else/navi.git' }, origin);
  expect(elsewhere.ok).toBe(false);
  expect(elsewhere.detail).toContain('github.com/someone-else/navi');
  expect(elsewhere.detail).toContain('github.com/example-org/navi-interaction-bridge');

  // The spellings npm itself accepts for one repository are not disagreements: a declaration
  // written differently from the checkout's origin is still the same repository, and a check
  // that read them as different would refuse publishes npm would have accepted.
  for (const declaration of [
    'git+https://github.com/example-org/navi-interaction-bridge.git',
    'https://github.com/example-org/navi-interaction-bridge',
    'https://github.com/example-org/navi-interaction-bridge/',
    'git://github.com/example-org/navi-interaction-bridge.git',
    'git@github.com:example-org/navi-interaction-bridge.git',
    'ssh://git@github.com/example-org/navi-interaction-bridge.git',
    'git+ssh://git@github.com/example-org/navi-interaction-bridge.git',
    'github:example-org/navi-interaction-bridge',
    'example-org/navi-interaction-bridge',
    'example-org/navi-interaction-bridge.git'
  ]) {
    expect(repositoryCheck({ repository: { type: 'git', url: declaration } }, origin).ok, declaration).toBe(true);
  }
  // ...including the `owner/name` shorthand GitHub states in the environment, and the string
  // form of the field npm also accepts.
  expect(repositoryCheck({}, 'example-org/navi-interaction-bridge').ok).toBe(true);
  expect(repositoryCheck({ repository: 'git@github.com:example-org/navi-interaction-bridge.git' }, 'example-org/navi-interaction-bridge').ok).toBe(true);

  // A repository that cannot be resolved is a refusal rather than a pass, for the same reason
  // an unresolved revision is: not knowing whether the two agree is the question being asked.
  const unresolved = repositoryCheck({}, null);
  expect(unresolved.ok).toBe(false);
  expect(unresolved.detail).toContain('could not be resolved');

  // Without provenance there is no statement for npm to validate, so the field is not required
  // and cannot block a publish that makes no claim.
  const withoutProvenance = evaluatePublish({ ...readyManifest, publishConfig: { access: 'public' }, repository: undefined }, publishContext({ repository: null }));
  expect(withoutProvenance.find(check => check.id === 'repository-url')?.blocking).toBe(false);
  expect(blockedBy(withoutProvenance)).toEqual(['provenance']);

  // The normalisation is the one npm compares in, so it is pinned directly and not only through
  // the rule: one repository reduces to one slug however it is written, and a value that names
  // no repository reduces to none rather than to something that could compare equal to it.
  for (const spelling of [
    'git+https://github.com/Wub796/Navi.git',
    'https://github.com/Wub796/Navi',
    'git@github.com:Wub796/Navi.git',
    'ssh://git@github.com/Wub796/Navi.git',
    'git://github.com/Wub796/Navi.git',
    'github:Wub796/Navi',
    'Wub796/Navi',
    'https://x-access-token:ghs_token@github.com/Wub796/Navi'
  ]) {
    expect(repositorySlug(spelling), spelling).toBe('github.com/wub796/navi');
  }
  expect(repositorySlug('https://gitlab.com/Wub796/Navi.git')).toBe('gitlab.com/wub796/navi');
  for (const value of ['', '   ', null, undefined, 'not a url at all', 'https://github.com/']) expect(repositorySlug(value)).toBeNull();

  // The rule is fed by the repository this checkout actually has, so the resolver is exercised
  // against it rather than only against fixtures — and the committed manifest is held to the
  // invariant the publish depends on, which is the defect this test exists for: whatever
  // spelling the field is written in, it names the repository the release is published from.
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  expect(repositorySlug(resolveRepository())).not.toBeNull();
  expect(repositorySlug(manifest.repository?.url)).toBe(repositorySlug(resolveRepository()));
});

test('a receipt that no longer describes the artifacts cannot authorise a publish', () => {
  // Freshness is checked against the bytes, not against a timestamp: rebuilding
  // after verification produces different bytes, and the receipt must stop applying.
  const stale = evaluatePublish(readyManifest, publishContext({ artifacts: { ...readyArtifacts, sri: 'sha384-BBBB' } }));
  expect(blockedBy(stale)).toEqual(['receipt-matches-artifacts']);
  expect(stale.find(check => check.id === 'receipt-matches-artifacts')?.detail).toContain('no longer match');
  expect(blockedBy(evaluatePublish(readyManifest, publishContext({ artifacts: { ...readyArtifacts, loaderBytes: 690 } })))).toEqual(['receipt-matches-artifacts']);
  // A failing receipt blocks on its own verdict, before any artifact comparison.
  expect(blockedBy(evaluatePublish(readyManifest, publishContext({ receipt: { ...readyReceipt, ok: false } })))).toEqual(['verification-receipt']);
  // A receipt from before these checks existed cannot be shown to describe anything: it
  // names no bytes, no revision whose code was verified, and no container verification, so
  // it authorises none of them.
  expect(blockedBy(evaluatePublish(readyManifest, publishContext({ receipt: { ok: true, checks: [] } })))).toEqual(['receipt-matches-artifacts', 'provenance-parity', 'container-evidence', 'canary-evidence']);
});

test('a publish needs green container verification of a configuration this release ships', () => {
  // The image is the runtime this release ships, so its verification is a requirement
  // rather than a note: the preflight reads it out of the receipt instead of trusting that
  // a container job ran somewhere. Nothing else is blocking here, so the verdict below is
  // about the container evidence alone.
  expect(blockedBy(evaluatePublish(readyManifest, publishContext()))).toEqual([]);
  expect(containerCheck(readyContainers).ok).toBe(true);
  expect(containerCheck(readyContainers).detail).toContain('deploy/docker-compose.prod.yml on linux/arm64 is 18/18');

  // Absent evidence and empty evidence are the different unknowns they are, and each is
  // named instead of being answered with a pass. Both tell the reader how to produce it.
  const absent = containerCheck(undefined);
  expect(absent.ok).toBe(false);
  expect(absent.detail).toContain('evidence.containers is absent');
  const empty = containerCheck([]);
  expect(empty.ok).toBe(false);
  expect(empty.detail).toContain('evidence.containers is empty');
  for (const verdict of [absent, empty]) expect(verdict.detail).toContain('test:containers');

  // A record for some other file proves something about that file, not about this release,
  // and an unstamped record cannot be shown to describe any configuration at all.
  const otherFile = containerCheck([{ ...readyContainers[0], compose: 'deploy/docker-compose.staging.yml' }]);
  expect(otherFile.ok).toBe(false);
  expect(otherFile.detail).toContain('deploy/docker-compose.staging.yml');
  expect(otherFile.detail).toContain('none of which is a configuration this repository deploys');
  expect(containerCheck([{ ...readyContainers[0], compose: null }]).ok).toBe(false);

  // Green is not the same as complete. A run whose verdict failed, a run whose passing
  // count does not cover every check it ran, and a run below the floor are all refused —
  // and the refusal states the floor it is measuring against.
  expect(containerCheck([{ ...readyContainers[0], ok: false }]).ok).toBe(false);
  expect(containerCheck([{ ...readyContainers[0], passed: 17 }]).ok).toBe(false);
  const belowFloor = containerCheck([{ ...readyContainers[0], passed: 17, checks: 17 }]);
  expect(belowFloor.ok).toBe(false);
  expect(belowFloor.detail).toContain(`at least ${CONTAINER_CHECKS_FLOOR} checks`);
  // A verifier that checks more than the floor still counts: the requirement is a floor on
  // the evidence, not an exact count that would punish added coverage.
  expect(containerCheck([{ ...readyContainers[0], passed: 19, checks: 19 }]).ok).toBe(true);

  // The local Compose file is a configuration this repository deploys, so it is accepted;
  // the receipt may cite several targets, and one green shipped configuration carries it.
  expect(containerCheck([{ ...readyContainers[0], compose: 'docker-compose.yml' }]).ok).toBe(true);
  expect(containerCheck([{ ...readyContainers[0] }, { ...readyContainers[0], architecture: 'linux/amd64', compose: 'docker-compose.yml' }]).ok).toBe(true);
  // ...but a green record for a shipped file beside a failing one is not a pass for the
  // failing one, and an unrelated green record does not substitute for a shipped target.
  expect(containerCheck([{ ...readyContainers[0], compose: 'docker-compose.yml', ok: false }, { ...readyContainers[0], compose: 'deploy/docker-compose.prod.yml', ok: false }]).ok).toBe(false);

  // Clean-room tarball canary evidence is required alongside container evidence.
  expect(canaryCheck(readyCanary).ok).toBe(true);
  expect(canaryCheck(readyCanary).detail).toContain('6/6 checks');
  expect(canaryCheck(undefined).ok).toBe(false);
  expect(canaryCheck(undefined).detail).toContain('evidence.canary is absent');
  expect(canaryCheck(null).ok).toBe(false);
  expect(canaryCheck({ ...readyCanary, ok: false }).ok).toBe(false);
  expect(canaryCheck({ ...readyCanary, passed: 5, total: 6, checks: readyCanary.checks.map((c, i) => i === 0 ? { ...c, ok: false } : c) }).ok).toBe(false);
  expect(canaryCheck({ ...readyCanary, passed: 5, total: 5, checks: readyCanary.checks.slice(0, 5) }).ok).toBe(false);
  expect(canaryCheck({ ...readyCanary, passed: 5, total: 5, checks: readyCanary.checks.slice(0, 5) }).detail).toContain(`${CANARY_CHECKS_FLOOR}/${CANARY_CHECKS_FLOOR}`);
});

test('a publish cannot proceed on a receipt that describes different code than the tag', () => {
  // The receipt cannot name the commit that carries it — that commit does not exist when the
  // gate writes it — so the released shape is "the gate's revision, plus generated reports".
  // That shape is proved here rather than assumed: outside reports/, the tagged tree must be
  // the verified tree, so a report commit that quietly carried a source edit is refused.
  /** @param {any} provenance @returns {any} */
  const parityCheck = provenance => {
    const checks = evaluatePublish(readyManifest, publishContext({ provenance }));
    const check = checks.find(candidate => candidate.id === 'provenance-parity');
    if (!check) throw new Error('the preflight records no provenance-parity check');
    return check;
  };

  // Naming HEAD is the strongest case: nothing stands between the receipt and the tag.
  const atHead = parityCheck(provenanceAtHead(readyReceipt.evidence.revision));
  expect(atHead.ok).toBe(true);
  expect(atHead.detail).toContain('names HEAD');

  // The released shape: an ancestor revision with no non-report path differing, which is
  // exactly a generated-reports commit on top of a verified tree.
  const parent = parityCheck({ head: 'ffffffffffffffff', ancestor: true, changedPaths: [], digest: null, error: null });
  expect(parent.ok).toBe(true);
  expect(parent.detail).toContain('outside reports/');

  // A source-tree attestation that matches proves the same thing without walking history —
  // the case a shallow CI clone leaves, where ancestry cannot be resolved at all.
  const attested = evaluatePublish(readyManifest, publishContext({
    receipt: { ...readyReceipt, evidence: { ...readyReceipt.evidence, sourceTree: 'sha256:attested' } },
    provenance: { head: 'ffffffffffffffff', ancestor: null, changedPaths: null, digest: 'sha256:attested', error: null }
  })).find(candidate => candidate.id === 'provenance-parity');
  expect(attested?.ok).toBe(true);
  expect(attested?.detail).toContain('source-tree attestation');

  // One changed path outside reports/ is refused, and the refusal names it.
  const drifted = parityCheck({ head: 'ffffffffffffffff', ancestor: true, changedPaths: ['scripts/verify-release.mjs'], digest: null, error: null });
  expect(drifted.ok).toBe(false);
  expect(drifted.detail).toContain('scripts/verify-release.mjs');
  expect(drifted.detail).toContain('not the tree the gate verified');

  // A revision that is not an ancestor, with no attestation to fall back on, is evidence about
  // some other branch and cannot authorise this publish.
  const unrelated = parityCheck({ head: 'ffffffffffffffff', ancestor: false, changedPaths: null, digest: null, error: null });
  expect(unrelated.ok).toBe(false);
  expect(unrelated.detail).toContain('not an ancestor');
  expect(unrelated.detail).toContain('is absent');

  // A recorded attestation that disagrees with the tree at HEAD is refused even when the paths
  // happen to line up: the receipt itself says it describes other code.
  const contradicted = evaluatePublish(readyManifest, publishContext({
    receipt: { ...readyReceipt, evidence: { ...readyReceipt.evidence, sourceTree: 'sha256:stale' } },
    provenance: { head: 'ffffffffffffffff', ancestor: true, changedPaths: [], digest: 'sha256:current', error: null }
  })).find(candidate => candidate.id === 'provenance-parity');
  expect(contradicted?.ok).toBe(false);
  expect(contradicted?.detail).toContain('does not match the tracked tree at HEAD');

  // Facts that could not be resolved are a refusal, not a pass: not knowing whether the tagged
  // code is the verified code is the very question this check exists to answer.
  const unresolved = parityCheck({ head: null, ancestor: null, changedPaths: null, digest: null, error: 'git rev-parse HEAD failed' });
  expect(unresolved.ok).toBe(false);
  expect(unresolved.detail).toContain('could not be compared');
  expect(parityCheck(undefined).ok).toBe(false);

  // A receipt that records no revision cites nothing to compare at all.
  const anonymous = evaluatePublish(readyManifest, publishContext({ receipt: { ok: true, checks: [] } })).find(candidate => candidate.id === 'provenance-parity');
  expect(anonymous?.ok).toBe(false);
  expect(anonymous?.detail).toContain('no evidence.revision');

  // The rule is also fed by facts a real checkout resolved, not only by shapes this test
  // invented: the resolver reads git, and the rule accepts what it returns.
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const realFacts = resolveProvenance({ evidence: { revision: head } });
  expect(realFacts.head).toBe(head);
  expect(realFacts.digest).toBe(sourceTreeDigest('HEAD'));
  expect(realFacts.ancestor).toBeNull();
  const realCheck = evaluatePublish(readyManifest, publishContext({
    receipt: { ...readyReceipt, evidence: { ...readyReceipt.evidence, revision: head } },
    provenance: realFacts
  })).find(candidate => candidate.id === 'provenance-parity');
  expect(realCheck?.ok).toBe(true);
  // No revision means no facts to resolve, and nothing to prove.
  expect(resolveProvenance(null)).toEqual({ head: null, ancestor: null, changedPaths: null, digest: null, error: null });
});

test('the source-tree attestation identifies the code and tolerates the reports it must', async () => {
  // The attestation exists to survive one specific commit: the generated-reports commit that
  // carries the receipt. It has to be blind to reports/ and sensitive to everything else, or
  // it would either block every release or attest to nothing — so both halves are checked on a
  // real repository rather than asserted by construction.
  const repo = await mkdtemp(join(tmpdir(), 'navi-source-tree-'));
  /** @param {...string} args @returns {string} */
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  try {
    git('init', '--quiet');
    git('config', 'user.email', 'release@example.com');
    git('config', 'user.name', 'Release');
    await mkdir(join(repo, 'scripts'), { recursive: true });
    await mkdir(join(repo, 'reports'), { recursive: true });
    await writeFile(join(repo, 'scripts', 'verify-release.mjs'), 'export const value = 1;\n');
    await writeFile(join(repo, 'reports', 'release-verification.json'), '{}\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'the verified revision');
    const verified = sourceTreeDigest('HEAD', repo);
    expect(verified).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The report refresh every release adds: a rewritten receipt, a new report beside it.
    // Reports are the only thing the attestation tolerates, because they are the only thing
    // the release process rewrites after the gate has run.
    await writeFile(join(repo, 'reports', 'release-verification.json'), '{"ok":true}\n');
    await writeFile(join(repo, 'reports', 'release-notes.md'), '# notes\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'refresh generated reports');
    expect(sourceTreeDigest('HEAD', repo), 'a report refresh must not move the attestation').toBe(verified);

    // The shipped bundle is verified code rather than generated noise — the gate hashes it —
    // so a rebuilt dist/ must move the attestation like any other source path.
    await mkdir(join(repo, 'dist'), { recursive: true });
    await writeFile(join(repo, 'dist', 'navi.min.js'), '// rebuilt bundle\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'a rebuilt bundle');
    expect(sourceTreeDigest('HEAD', repo)).not.toBe(verified);

    // And one changed byte of source, which is the drift this attestation exists to catch: a
    // version of it that ignored everything would attest to nothing.
    await writeFile(join(repo, 'scripts', 'verify-release.mjs'), 'export const value = 2;\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'a source change');
    expect(sourceTreeDigest('HEAD', repo)).not.toBe(verified);

    // Deterministic across calls, and a revision git cannot resolve is null rather than a
    // digest of nothing — two empty digests would compare equal and prove nothing.
    expect(sourceTreeDigest('HEAD', repo)).toBe(sourceTreeDigest('HEAD', repo));
    expect(sourceTreeDigest('no-such-revision', repo)).toBeNull();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('the published test floor is one number, stated everywhere it is promised', async () => {
  // The floor is a promise about the suite's coverage, and it appears in the gate, in the
  // documents a contributor reads, and in the release note. Pinning it here means moving it
  // is a deliberate change to all of them, rather than a bump in one place and a doc that
  // quietly stops matching the gate it describes.
  const verifySource = await readFile(join(root, 'scripts/verify-release.mjs'), 'utf8');
  expect(MIN_PASSING_TESTS).toBe(230);
  expect(Number(/MIN_PASSING_TESTS = (\d+)/.exec(verifySource)?.[1])).toBe(MIN_PASSING_TESTS);
  for (const document of ['README.md', 'docs/ACCEPTANCE.md', 'docs/RELEASES/v0.6.3.md', 'docs/CONTAINERS.md', 'AGENTS.md']) {
    const text = await readFile(join(root, document), 'utf8');
    expect(text, `${document} must state the published floor`).toContain(String(MIN_PASSING_TESTS));
    // Naming the right number somewhere is not the promise: a second sentence still
    // quoting an older floor is exactly the drift this test exists to catch, and a
    // containment check passes on the mention while the stale claim stands beside it.
    for (const [, claimed] of text.matchAll(/(\d{3,})(?:-test suite|\s+passing tests|\s+passed, 0 failed)/g)) {
      expect(Number(claimed), `${document} still names a ${claimed} floor`).toBe(MIN_PASSING_TESTS);
    }
  }
});

test('the edge deployment contract pins its schema, deny rules and entrypoint', async () => {
  // The Worker cannot provision or charge a tenant if a column, a unique index or a
  // grant is missing, and the schema is applied by hand, so the file is the contract.
  // Asserting it here means a table added to the Worker without an idempotent,
  // deny-by-default definition fails the suite instead of a deployment.
  const schema = await readFile(join(root, 'deploy/supabase-schema.sql'), 'utf8');
  const wrangler = await readFile(join(root, 'wrangler.toml'), 'utf8');
  const worker = await readFile(join(root, 'src/worker.ts'), 'utf8');

  for (const table of ['sites', 'navigation_maps', 'webhook_events', 'checkout_claims']) {
    expect(schema, `${table} must be created idempotently`).toMatch(new RegExp(`create table if not exists public\\.${table}\\b`));
    expect(schema, `${table} must have row level security enabled`).toContain(`alter table public.${table} enable row level security;`);
    expect(schema, `${table} must deny the public roles`).toContain(`revoke all on table public.${table} from anon, authenticated;`);
    expect(schema, `${table} must grant service_role explicitly`).toContain(`grant all on table public.${table} to service_role;`);
    expect(schema, `${table} must have a service_role policy`).toContain(`${table}_service_role_all on public.${table}`);
  }
  // The replay ledger's shape is what makes a redelivery a no-op rather than a
  // second provisioning: the event id is the key the Worker conflicts on.
  expect(schema).toMatch(/create table if not exists public\.webhook_events \(\s*event_id text primary key,\s*received_at timestamptz not null default now\(\)\s*\)/);
  expect(schema).toMatch(/create table if not exists public\.checkout_claims \(\s*session_id text primary key,\s*tenant_id text not null,\s*api_key text not null,\s*expires_at_ms bigint not null\s*\)/);
  expect(schema).toContain('create unique index if not exists idx_sites_api_key');
  expect(schema).toContain('create unique index if not exists idx_navigation_maps_site_url');

  // The Worker must address the ledger with the atomic duplicate rule the schema
  // relies on, rather than a read that two isolates could interleave.
  expect(worker).toContain('/rest/v1/webhook_events?on_conflict=event_id');
  expect(worker).toContain('resolution=ignore-duplicates');
  expect(worker).toContain('/rest/v1/webhook_events?received_at=lt.');
  expect(worker).toContain('/rest/v1/checkout_claims');

  // The manifest is committed, so it may name the entrypoint and the secrets an
  // operator sets, and nothing that looks like a credential value.
  expect(wrangler).toMatch(/^name = "navi-edge"$/m);
  expect(wrangler).toMatch(/^main = "src\/worker\.ts"$/m);
  expect(wrangler).toMatch(/^compatibility_date = "\d{4}-\d{2}-\d{2}"$/m);
  expect(wrangler).not.toMatch(/^\[vars\]/m);
  expect(wrangler).not.toMatch(/whsec_|sk_live|eyJ[a-zA-Z0-9_-]{10,}|SERVICE_ROLE_KEY\s*=\s*"[^"]+"/);
});

test('release notes state only what the receipts recorded', () => {
  const input = {
    build: { rawBytes: 14929, budgetBytes: 15000, loaderBytes: 689, loaderBudgetBytes: 700, integrity: 'sha384-SRI' },
    receipt: { ok: true, recordedAt: '2026-10-10T00:00:00.000Z', checks: [{ id: 'test-suite', ok: true, detail: '81 passed, 0 failed' }, { id: 'rebuild-stable', ok: false, detail: 'rebuild changed the artifacts' }] },
    version: '0.5.0',
    tag: 'v0.5.0',
    protocol: '9.9.9'
  };
  const notes = renderReleaseNotes(input);
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

  // The canary attestation is read out of `evidence.canary`, one row per check the tarball
  // verifier ran, and the table is printed only for a record that actually authorises a
  // publish — the same rule the preflight applies, so a note cannot call a tarball verified
  // that the publish gate would refuse.
  const green = canaryAttestation(readyCanary);
  expect(green).not.toContain('[!WARNING]');
  expect(green).toContain('| Check | Description | Status |');
  expect(green).toContain('| `mcp-sigterm-teardown` | exit 0 on SIGTERM | Passed |');
  // A row carries the check's own recorded detail, so the measured values sit with the row
  // that claims them rather than beside a label that could drift from the check it names.
  for (const check of readyCanary.checks) expect(green).toContain(`| \`${check.id}\` | ${check.detail} | Passed |`);
  // Absent, empty, incomplete and not-green records each warn instead of being rounded up:
  // the warning names the shortfall, and the rows that do exist are still marked honestly.
  expect(canaryAttestation(undefined)).toContain('> [!WARNING]');
  expect(canaryAttestation(undefined)).toContain('claim no verification of the packed tarball');
  expect(canaryAttestation({})).toContain('> [!WARNING]');
  const oneFailed = canaryAttestation({ ...readyCanary, ok: false, passed: 5, checks: readyCanary.checks.map((check, index) => index === 0 ? { ...check, ok: false } : check) });
  expect(oneFailed).toContain('> [!WARNING]');
  expect(oneFailed).toContain('5/6 checks passed (failed: manifest-layout)');
  expect(oneFailed).toContain('| `manifest-layout` | all 13 required manifest exports present | Failed |');
  const short = canaryAttestation({ ...readyCanary, passed: 5, total: 5, checks: readyCanary.checks.slice(0, 5) });
  expect(short).toContain('> [!WARNING]');
  expect(short).toContain(`${CANARY_CHECKS_FLOOR}/${CANARY_CHECKS_FLOOR}`);

  // The provenance the verification section opens with: the revision the receipt names and the
  // digest of the source tree it verified. The revision alone would be the weaker claim — it is
  // always one step behind the tag — so the digest is what a reader checks, and a receipt that
  // records none says so rather than being described by its revision as if that were enough.
  expect(notes).toContain('> [!WARNING]');
  expect(notes).toContain('records no `evidence.sourceTree`');
  const withProvenance = renderReleaseNotes({ ...input, receipt: { ...input.receipt, evidence: { revision: 'abc123def456', sourceTree: 'sha256:' + 'a'.repeat(64) } } });
  expect(withProvenance).toContain('`evidence.revision` is `abc123def456`');
  expect(withProvenance).toContain(`\`evidence.sourceTree\` is \`sha256:${'a'.repeat(64)}\``);
  expect(withProvenance).toContain('path outside `reports/`');
  // The paragraph itself carries no warning once a digest is recorded; the canary section of
  // this fixture still does, which is a different attestation and is asserted separately.
  expect(sourceTreeAttestation({ evidence: { revision: 'abc123def456', sourceTree: 'sha256:abcd' } })).not.toContain('[!WARNING]');
  // A digest with no revision beside it is still a provenance statement; an empty one is not.
  expect(sourceTreeAttestation({ evidence: { sourceTree: 'sha256:abc' } })).toContain('no revision is recorded');
  expect(sourceTreeAttestation({})).toContain('> [!WARNING]');
  expect(sourceTreeAttestation(undefined)).toContain('> [!WARNING]');

  // The container attestation is read out of the container receipts, so it can state the
  // runtime identity, the capabilities actually held, the store the host served and the
  // lifecycle verdicts of a platform — and nothing about a platform whose receipt is absent.
  const arm64 = {
    architecture: 'linux/arm64',
    compose: 'deploy/docker-compose.prod.yml',
    imageId: 'sha256:5d3c1f0e',
    ok: true,
    checks: [
      { check: 'image', ok: true, detail: 'sha256:abc; linux/arm64; user pwuser:pwuser' },
      { check: 'runtime-posture', ok: true, detail: JSON.stringify({ uid: 1000, node: 'v22.23.3', playwright: '1.64.0', proc: ['CapEff:\t0000000000000000', 'NoNewPrivs:\t1'] }) },
      { check: 'sqlite-store', ok: true, detail: 'the host serves the sqlite backend with the SQLite header and its -wal sidecar present' },
      { check: 'navi-host-crash-recovery', ok: true, detail: 'SIGKILL exit 137: counter=1' },
      { check: 'navi-mcp-crash-recovery', ok: true, detail: 'SIGKILL exit 137: counter=1' }
    ]
  };
  const withContainers = renderReleaseNotes({ ...input, containers: [arm64] });
  expect(withContainers).toContain('| Platform | Image | Compose file | Runtime identity | Capabilities | Store | Lifecycle recovery | Checks |');
  expect(withContainers).toContain('| linux/arm64 | `sha256:5d3c1f0e` | `deploy/docker-compose.prod.yml` | uid 1000 (v22.23.3) | dropped (`CapEff 0`, `NoNewPrivs 1`) | sqlite, `-wal` sidecar present | SIGKILL 137 → counter 1; graceful stop → 0 | 5/5 pass |');
  // A receipt written before the field existed reads as `null` — which is what a reader
  // of one produces — and says so instead of borrowing the tag's authority: the note must
  // not name an image it cannot show was the one verified.
  expect(renderReleaseNotes({ ...input, containers: [{ ...arm64, imageId: null }] })).toContain('| linux/arm64 | not recorded | `deploy/docker-compose.prod.yml` |');
  // No receipt is not a pass: the section says so instead of being omitted.
  expect(notes).toContain('No container receipt was found on this revision');
  // A leg that failed is printed as FAIL with the count it actually passed, and its
  // lifecycle cell is not fabricated from the checks that did pass.
  const failed = renderReleaseNotes({
    ...input,
    containers: [{ ...arm64, ok: false, checks: arm64.checks.map(check => check.check === 'navi-mcp-crash-recovery' ? { ...check, ok: false } : check) }]
  });
  expect(failed).toContain('4/5 FAIL');
  expect(failed).toContain('| not recorded |');
});

test('the generated notes and the release collateral carry the canary attestation beside the container matrix', async () => {
  // The notes are the release's public claim about what was verified, and the packed
  // tarball is one of the two artifacts a consumer installs — so the canary table is not
  // decoration beside the container matrix, it is the other half of the same claim. This
  // asserts both halves are rendered from the committed receipt, and that the committed
  // collateral a reader actually opens carries them too rather than being regenerated by hand.
  const receipt = JSON.parse(await readFile(join(root, 'reports/release-verification.json'), 'utf8'));
  const build = JSON.parse(await readFile(join(root, 'reports/build.json'), 'utf8'));
  const canary = receipt.evidence.canary;
  expect(canary?.ok, 'the committed receipt must record a green clean-room canary').toBe(true);
  const notes = renderReleaseNotes({ build, receipt, version: '0.6.3', tag: 'v0.6.3', protocol: '0.3.0', containers: await readContainerReceipts(root) });

  // Both attestations, each under its own section, in one document.
  expect(notes).toContain('### Container verification');
  expect(notes).toContain('### Clean-Room Package Canary Attestation');
  expect(notes).toContain('| Platform | Image | Compose file | Runtime identity | Capabilities | Store | Lifecycle recovery | Checks |');
  expect(notes).toContain('| Check | Description | Status |');
  // A green record is rendered as a table, with no warning above it.
  expect(notes).not.toContain('[!WARNING]');

  // One row per recorded check, in the order the verifier ran them, holding the detail the
  // receipt recorded. A note that renamed a check or reordered the rows would be describing
  // a verifier this repository does not run.
  const recorded = /** @type {{id: string, ok: boolean, detail: string}[]} */ (canary.checks);
  expect(recorded.map(check => check.id)).toEqual([
    'manifest-layout',
    'sri-and-budgets',
    'zero-leak-isolation',
    'mcp-initialize',
    'mcp-tools-list',
    'mcp-sigterm-teardown'
  ]);
  const rendered = notes.split('| Check | Description | Status |')[1].split('###')[0];
  expect(rendered).toContain(recorded.map(check => `| \`${check.id}\` | ${check.detail} | Passed |`).join('\n'));

  // The committed collateral is the same document: the generated notes are checked in, and
  // the release note a reader opens states the canary verdicts beside its container matrix.
  const committed = await readFile(join(root, 'reports/release-notes.md'), 'utf8');
  expect(committed).toContain('### Clean-Room Package Canary Attestation');
  // The provenance the publish rests on, printed from the same receipt the preflight checks.
  expect(notes).toContain(`\`evidence.revision\` is \`${receipt.evidence.revision}\``);
  expect(notes).toContain(`\`evidence.sourceTree\` is \`${receipt.evidence.sourceTree}\``);
  const inFlight = process.env.VERIFY_RELEASE_ACTIVE === '1';
  if (!inFlight) {
    expect(committed, 'the committed notes must carry the provenance paragraph').toContain(`\`evidence.sourceTree\` is \`${receipt.evidence.sourceTree}\``);
    expect(committed).toContain(recorded.map(check => `| \`${check.id}\` | ${check.detail} | Passed |`).join('\n'));
  } else {
    expect(committed).toMatch(/`evidence\.sourceTree` is `sha256:[0-9a-f]{64}`/);
  }
  expect(committed).toContain('| Platform | Image | Compose file | Runtime identity | Capabilities | Store | Lifecycle recovery | Checks |');
  const release = await readFile(join(root, 'docs/RELEASES/v0.6.3.md'), 'utf8');
  expect(release).toContain('## Container verification matrix');
  expect(release).toContain('| Check | Description | Status |');
  if (!inFlight) {
    for (const check of recorded) expect(release, `docs/RELEASES/v0.6.3.md must carry the ${check.id} row`).toContain(`| \`${check.id}\` | ${check.detail} | Passed |`);
  } else {
    for (const check of recorded) expect(release, `docs/RELEASES/v0.6.3.md must carry the ${check.id} row`).toContain(`| \`${check.id}\` | `);
  }
});

test('verify:release breaks the release-notes bootstrap deadlock when the version or receipt advances', async () => {
  // Regression for the ordering deadlock between verify-release.mjs and release-notes.mjs:
  // when a version bump or an intermediate failed run rewrites reports/release-verification.json,
  // reports/release-notes.md still carries the prior sourceTree digest and version until
  // verify:release finishes and refreshes it. During VERIFY_RELEASE_ACTIVE=1, the in-flight
  // suite must not fail on the pre-refresh notes, and verify-release.mjs must automatically
  // invoke the release-notes generator once the gate passes.
  const verifySource = await readFile(join(root, 'scripts/verify-release.mjs'), 'utf8');
  expect(verifySource).toContain("VERIFY_RELEASE_ACTIVE: '1'");
  expect(verifySource).toContain('refreshReleaseNotes');

  const receipt = JSON.parse(await readFile(join(root, 'reports/release-verification.json'), 'utf8'));
  const build = JSON.parse(await readFile(join(root, 'reports/build.json'), 'utf8'));
  const containers = await readContainerReceipts(root);
  const staleNotes = renderReleaseNotes({
    build,
    receipt: { ...receipt, recordedAt: '2026-10-01T00:00:00.000Z', evidence: { ...receipt.evidence, sourceTree: `sha256:${'0'.repeat(64)}` } },
    version: '0.6.2',
    tag: 'v0.6.2',
    protocol: '0.3.0',
    containers
  });
  const advancedReceipt = {
    ...receipt,
    recordedAt: '2026-10-18T00:00:00.000Z',
    evidence: {
      ...receipt.evidence,
      sourceTree: `sha256:${'f'.repeat(64)}`,
      canary: {
        ...receipt.evidence.canary,
        checks: receipt.evidence.canary.checks.map((/** @type {any} */ c) =>
          c.id === 'mcp-initialize' ? { ...c, detail: c.detail.replace(/@\d+\.\d+\.\d+/, '@0.6.4') } : c
        )
      }
    }
  };
  const refreshedNotes = renderReleaseNotes({ build, receipt: advancedReceipt, version: '0.6.4', tag: 'v0.6.4', protocol: '0.3.0', containers });
  expect(staleNotes).toMatch(/`evidence\.sourceTree` is `sha256:[0-9a-f]{64}`/);
  expect(staleNotes).not.toContain(advancedReceipt.evidence.sourceTree);
  expect(refreshedNotes).toContain(`## Navi 0.6.4`);
  expect(refreshedNotes).toContain(`\`evidence.sourceTree\` is \`${advancedReceipt.evidence.sourceTree}\``);
  expect(refreshedNotes).toContain('navi-mcp-server@0.6.4');
});

test('container receipts are discovered by target, not by the path they sit in', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'navi-receipts-'));
  try {
    const downloaded = join(workspace, 'reports', 'container-verification', 'release-container-receipt-amd64');
    await mkdir(downloaded, { recursive: true });
    // A per-architecture artifact the release workflow downloaded, an older local receipt
    // for the same target, and a receipt that predates the architecture stamp.
    await writeFile(join(downloaded, 'production-container-verification.json'), JSON.stringify({
      recordedAt: '2026-10-13T02:00:00.000Z', compose: 'deploy/docker-compose.prod.yml', architecture: 'linux/amd64', imageId: 'sha256:abc', ok: true,
      checks: [{ check: 'image', ok: true, detail: 'sha256:abc; linux/amd64; user pwuser:pwuser' }]
    }) + '\n');
    await writeFile(join(workspace, 'reports', 'production-container-verification.json'), JSON.stringify({
      recordedAt: '2026-10-12T02:00:00.000Z', compose: 'deploy/docker-compose.prod.yml', architecture: 'linux/amd64', ok: false, checks: []
    }) + '\n');
    await writeFile(join(workspace, 'reports', 'container-verification.json'), JSON.stringify({
      recordedAt: '2026-10-12T03:00:00.000Z', ok: true, checks: [{ check: 'image', ok: true, detail: 'x' }]
    }) + '\n');

    const receipts = await readContainerReceipts(workspace);
    // Two pieces of evidence, not three: one platform and configuration is one target, and
    // the most recent record of it wins.
    expect(receipts).toHaveLength(2);
    const amd64 = receipts.find(receipt => receipt.architecture === 'linux/amd64');
    expect(amd64?.recordedAt).toBe('2026-10-13T02:00:00.000Z');
    // The image digest is carried through the summary so the release receipt names the
    // bytes it verified, not only the tag and the platform they were built under.
    expect(summarizeContainer(/** @type {any} */ (amd64))).toEqual({
      architecture: 'linux/amd64', compose: 'deploy/docker-compose.prod.yml', imageId: 'sha256:abc', recordedAt: '2026-10-13T02:00:00.000Z', ok: true, passed: 1, checks: 1
    });
    // A receipt that predates the digest is read as unstamped, not as a failure and not
    // as a guess: its verdicts are still evidence, and the missing digest is visible.
    const unstamped = receipts.find(receipt => receipt.architecture === null);
    expect(summarizeContainer(/** @type {any} */ (unstamped)).imageId).toBeNull();
    // An unstamped receipt is kept and reported as unstamped rather than dropped or guessed.
    expect(unstamped?.compose).toBeNull();
    // A receipt that cannot be parsed is an error: a quieter release is not an option.
    await writeFile(join(workspace, 'reports', 'container-verification', 'broken.json'), '{ not json');
    await expect(readContainerReceipts(workspace)).rejects.toThrow();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
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
  const coupling = evaluatePublish(readyManifest, publishContext({ receipt, tag: null, artifacts, provenance: resolveProvenance(receipt) }));
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
    evidence: { revision: '245f0850517c1351101b0d3bf6ef7916c87b0cef', branch: 'main', ...readyArtifacts, floor: 88, tests: null, containers: readyContainers, canary: readyCanary }
  };
  const checks = evaluatePublish(readyManifest, publishContext({ receipt: poisoned, provenance: provenanceAtHead(String(poisoned.evidence.revision)) }));
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
  /** @param {any[]} steps @returns {string[]} */
  const stepRuns = steps => steps.map(step => String(step?.run ?? ''));
  /** @param {any[]} steps @param {string} field @returns {string[]} */
  const stepValues = (steps, field) => steps.map(step => String(step?.with?.[field] ?? ''));
  expect(Object.keys(release.jobs)).toEqual(expect.arrayContaining(['verify-release', 'verify-containers', 'publish']));
  expect(release.jobs.publish.needs).toEqual(expect.arrayContaining(['verify-release', 'verify-containers']));
  // The gates run the documented entry points, not a copy of what they expand to — and the
  // release gate names the shipped production file explicitly, so the release is verified
  // against the deployment an operator runs rather than the local one.
  expect(stepRuns(release.jobs['verify-release'].steps).some(run => run.includes('npm run verify:release'))).toBe(true);
  const containerGate = release.jobs['verify-containers'];
  expect(stepRuns(containerGate.steps)).toContain('npm run test:containers -- --compose deploy/docker-compose.prod.yml');
  // CI verifies the image itself against the development file; the two configurations are
  // different evidence and write different receipts.
  expect(stepRuns(ci.jobs.containers.steps)).toContain('npm run test:containers');
  // Every job that launches Chromium on the runner has to lift Ubuntu 24.04's AppArmor
  // restriction on unprivileged user namespaces first. Without it the browser installs and
  // still cannot sandbox itself, so 62 tests fail with "No usable sandbox!" — a runner
  // defect that reads like a product failure. The step is asserted, not trusted, and asserted
  // to sit before the browser work rather than anywhere in the job.
  const smoke = parse(await readFile(join(root, '.github/workflows/smoke.yml'), 'utf8'));
  const userns = 'kernel.apparmor_restrict_unprivileged_userns';
  for (const [label, front, launch] of [
    ['ci quality', ci.jobs.quality.steps, 'npm test'],
    ['ci benchmark', ci.jobs.benchmark.steps, 'npm run benchmark'],
    ['release verify-release', release.jobs['verify-release'].steps, 'npm run verify:release'],
    ['smoke external', smoke.jobs.external.steps, 'npm run test:smoke']
  ]) {
    const runs = stepRuns(front);
    const lifted = runs.findIndex(run => run.includes(userns));
    expect(lifted, `${label} must set ${userns}`).toBeGreaterThan(-1);
    expect(lifted, `${label} must set ${userns} before it launches Chromium`).toBeLessThan(runs.findIndex(run => run.includes(launch)));
    // The knob is set and then read back, and a kernel without it is tolerated rather than
    // failed — an image that never had the restriction must not be reported as broken.
    expect(runs[lifted]).toContain('sysctl -n');
    // Lifting the restriction is the fix; disabling the browser's sandbox is not.
    expect(runs[lifted]).not.toContain('--no-sandbox');
  }
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
    expect(stepRuns(job.steps).some(run => run.includes("docker build --platform '${{ matrix.platform }}'"))).toBe(true);
  }
  // The container receipts are evidence for the release, not a job-local file: the release
  // gate uploads the production receipt it wrote, and the publish job carries every
  // architecture's receipt into the published record.
  expect(stepValues(containerGate.steps, 'name')).toContain('release-container-receipt-${{ matrix.arch }}');
  expect(stepValues(containerGate.steps, 'path')).toContain('reports/production-container-verification.json');
  expect(stepValues(release.jobs.publish.steps, 'pattern')).toContain('release-container-receipt-*');

  // Keyless OIDC Trusted Publishing: the publish job is bound to the `release` environment,
  // requests `id-token: write` and `contents: write`, upgrades npm to >= 11.5.1 before
  // publishing, and never references a static NPM_TOKEN secret.
  expect(release.jobs.publish.environment).toBe('release');
  expect(release.jobs.publish.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
  const publishRuns = stepRuns(release.jobs.publish.steps);
  const upgradeStep = publishRuns.findIndex(run => run.includes('npm install -g npm@') && run.includes('npm --version'));
  const publishStep = publishRuns.findIndex(run => run.includes('npm publish --provenance --access public'));
  expect(upgradeStep, 'publish job must upgrade npm for OIDC trusted publishing').toBeGreaterThan(-1);
  expect(upgradeStep).toBeLessThan(publishStep);
  const publishStepConfig = release.jobs.publish.steps[publishStep];
  expect(publishStepConfig?.env?.NODE_AUTH_TOKEN).toBeUndefined();
  expect(JSON.stringify(release)).not.toContain('NPM_TOKEN');
});

test('clean-room package verifier enforces manifest layout, SRI byte parity, zero leaks, and stdio MCP handshake', async () => {
  const result = await verifyCleanRoomPackage({ mode: 'tarball' });
  expect(result.ok, JSON.stringify(result.checks, null, 2)).toBe(true);
  expect(result.checks.map(check => check.id)).toEqual([
    'manifest-layout',
    'sri-and-budgets',
    'zero-leak-isolation',
    'mcp-initialize',
    'mcp-tools-list',
    'mcp-sigterm-teardown'
  ]);
  expect(result.checks.every(check => check.ok)).toBe(true);

  // Verify the pure evaluator refuses leaked source/test files, runtime dependencies, or broken SRI.
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const bundle = await readFile(join(root, 'dist/navi.min.js'));
  const loader = await readFile(join(root, 'dist/loader.min.js'));
  const sri = (await readFile(join(root, 'dist/sri.txt'), 'utf8')).trim();

  const leaked = evaluateUnpackedPackage({
    files: [...REQUIRED_PACKAGE_FILES, 'src/mcp/server.js', 'tests/release-pipeline.spec.mjs'],
    pkg,
    expectedSri: sri,
    actualBundleBytes: bundle,
    actualLoaderBytes: loader
  });
  expect(leaked.find(check => check.id === 'zero-leak-isolation')?.ok).toBe(false);

  const badSri = evaluateUnpackedPackage({
    files: [...REQUIRED_PACKAGE_FILES],
    pkg,
    expectedSri: 'sha384-wrong',
    actualBundleBytes: bundle,
    actualLoaderBytes: loader
  });
  expect(badSri.find(check => check.id === 'sri-and-budgets')?.ok).toBe(false);
});

