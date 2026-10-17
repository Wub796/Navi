#!/usr/bin/env node
/**
 * Release gate for Navi.
 *
 * Every check reads the artifact or the command it is about to trust — none of
 * them take a report's word for it:
 *
 *   git      the worktree is clean except for build output and generated reports,
 *            and the version tag matches the package version at HEAD;
 *   artifact dist/sri.txt and reports/build.json describe the exact bytes of
 *            dist/navi.min.js, and the loader stays inside its byte budget;
 *   tests    the suite runs, reports zero failures, and clears the published
 *            floor of passing tests;
 *   gates    scripts/ci-gates.mjs re-checks the recorded measurements;
 *   pack     scripts/pack-check.mjs proves what a publish would upload;
 *   --tag    create the annotated v<version> tag once everything above passed.
 *
 * Every run also writes its receipt to reports/release-verification.json: the
 * check ids, their detail lines and the verdict, plus the evidence the verdict was
 * about — the revision, the source-tree digest, the SRI and artifact sizes, and the
 * container verification receipts found on this revision. The receipt is a generated
 * report, so GENERATED_PATHS tolerates it exactly as it tolerates dist/ and
 * reports/build.json — a fresh run rewrites it, and that is expected. That container
 * evidence is what the publish preflight requires: a release whose receipt cites no
 * green container run cannot be published from this checkout.
 *
 * The receipt cannot name the commit that carries it. The gate writes the receipt, the
 * receipt is committed, and that commit is by definition one the gate has never seen —
 * so a released revision is always "the revision this receipt names, plus generated
 * reports". evidence.sourceTree narrows that gap to nothing: it digests every tracked
 * path outside reports/, so the publish preflight can show that the tree a tag points at
 * is byte-identical to the tree this gate verified, report refreshes aside.
 *
 * Usage:
 *   node scripts/verify-release.mjs             # verify a candidate release
 *   node scripts/verify-release.mjs --tag       # verify, then tag HEAD
 *   node scripts/verify-release.mjs --skip-tests
 *   node scripts/verify-release.mjs --json
 *
 * Exit codes: 0 verified, 1 a check failed, 2 usage error.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readContainerReceipts, summarizeContainer } from './container-evidence.mjs';
import { main as refreshReleaseNotes } from './release-notes.mjs';
import { verifyCleanRoomPackage } from './verify-registry-package.mjs';

/**
 * Published floor for the suite: the release must not shrink its own coverage. It is
 * stated in README.md, docs/ACCEPTANCE.md, docs/CONTAINERS.md and the release note beside
 * them, and tests/release-pipeline.spec.mjs pins those documents together, so raising it
 * is a deliberate change to all of them rather than a silent drift in one.
 */
export const MIN_PASSING_TESTS = 245;
/** Strict byte budgets, identical to the build and the CI gates. */
export const SDK_BUDGET_BYTES = 15000;
export const LOADER_BUDGET_BYTES = 700;
/**
 * The only paths a release may leave modified or untracked. Everything else must
 * be committed: a release must be reproducible from the tag.
 */
export const GENERATED_PATHS = [/^dist\//, /^reports\//, /^test-results\//, /^playwright-report\//];
/** Repository root, so the git commands below answer the same way from any cwd. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The one directory the release process rewrites after the gate has run. */
const GENERATED_REPORT_DIR = 'reports/';

/** @typedef {{id: string, ok: boolean, detail: string}} Check */

/** @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv} [env] @returns {string} */
function run(command, args, env = process.env) {
  return execFileSync(command, args, { encoding: 'utf8', env, maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv} [env] @returns {{ok: boolean, output: string}} */
function attempt(command, args, env = process.env) {
  try {
    return { ok: true, output: run(command, args, env) };
  } catch (error) {
    const captured = /** @type {{stdout?: string, stderr?: string}} */ (error);
    return { ok: false, output: `${captured.stdout ?? ''}${captured.stderr ?? ''}` };
  }
}

/**
 * The last few non-empty lines of a command's output, for a failure report.
 * @param {string} output
 * @param {number} [lines]
 * @returns {string}
 */
function tail(output, lines = 6) {
  return output.trim().split('\n').filter(line => line.trim()).slice(-lines).join('\n');
}

/**
 * The lines in a test run that name what broke.
 *
 * A gate that blocks a release on "1 failed" without naming the test costs a whole
 * cycle to diagnose, and the surrounding output is thousands of lines of unrelated
 * test logs — so the failures are lifted out by their own shape: Playwright prints
 * each one as `N) file:line › name` followed by the assertion it made.
 * @param {string} output
 * @returns {string}
 */
export function failureDigest(output) {
  const lines = output.split('\n').map(line => line.trimEnd());
  const named = lines.filter(line => /^\s{0,4}\d+\)\s+\S/.test(line) || /^\s*(Error:|expect\()/.test(line));
  return (named.length > 0 ? named : lines.filter(line => line.trim().length > 0)).slice(0, 12).join('\n');
}

/**
 * A content digest of the tracked tree at `revision`, excluding generated reports.
 *
 * This is the attestation that closes the receipt-versus-tag gap. A receipt is committed
 * by a later commit than the one it names, so `evidence.revision` always points one step
 * behind the released tag; the digest of the tracked paths says the thing that actually
 * matters — that outside `reports/`, the tagged tree is byte-for-byte the tree the gate
 * verified — and it is deliberately blind to the report refresh that follows every gate
 * run, because a digest that moved whenever a JSON file was rewritten would attest to
 * nothing at all.
 *
 * `git ls-tree` does not accept exclude pathspec magic, so the exclusion is applied to
 * the listed paths here, where it is visible and unit-tested, rather than left to git.
 * @param {string} [revision]
 * @param {string} [root] repository to read; overridable so a test can drive a fixture
 * @returns {string | null} `sha256:<hex>`, or null when git cannot answer
 */
export function sourceTreeDigest(revision = 'HEAD', root = REPO_ROOT) {
  const listed = attempt('git', ['-C', root, 'ls-tree', '-r', revision]);
  if (!listed.ok) return null;
  const lines = listed.output
    .split('\n')
    .filter(line => line.trim().length > 0)
    .filter(line => !line.slice(line.indexOf('\t') + 1).startsWith(GENERATED_REPORT_DIR));
  return `sha256:${createHash('sha256').update(lines.join('\n')).digest('hex')}`;
}

/**
 * @param {string} id
 * @param {() => Promise<{ok: boolean, detail: string}>} check
 * @returns {Promise<Check>}
 */
async function evaluate(id, check) {
  try {
    const result = await check();
    return { id, ok: result.ok, detail: result.detail };
  } catch (error) {
    return { id, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * @param {{skipTests: boolean, tag: boolean}} options
 * @returns {Promise<Check[]>}
 */
export async function verifyRelease(options) {
  /** @type {Check[]} */
  const checks = [];
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const version = /** @type {string} */ (packageJson.version);
  const tagName = `v${version}`;
  const root = fileURLToPath(new URL('..', import.meta.url));
  checks.push(await evaluate('node-runtime', async () => ({
    ok: Number(process.versions.node.split('.')[0]) === 22 && packageJson.engines.node === '>=22.0.0',
    detail: `${process.version}; release verification requires Node 22.x and engines >=22.0.0`
  })));

  checks.push(await evaluate('git-repository', async () => {
    const inside = run('git', ['rev-parse', '--is-inside-work-tree']).trim();
    return { ok: inside === 'true', detail: inside === 'true' ? `on ${run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim()}` : 'not a Git worktree' };
  }));

  /** @type {{path: string}[]} */
  let dirty = [];
  checks.push(await evaluate('git-clean', async () => {
    const status = run('git', ['status', '--porcelain']);
    dirty = status.split('\n').filter(Boolean).map((/** @type {string} */ line) => ({ path: line.slice(3).trim() }));
    const unexpected = dirty.filter(entry => !GENERATED_PATHS.some(pattern => pattern.test(entry.path)));
    return unexpected.length === 0
      ? { ok: true, detail: `clean apart from ${dirty.length} generated path(s)` }
      : { ok: false, detail: `uncommitted: ${unexpected.map(entry => entry.path).join(', ')}` };
  }));

  checks.push(await evaluate('version-tag', async () => {
    const tagRef = attempt('git', ['rev-parse', '-q', '--verify', `refs/tags/${tagName}`]);
    if (!tagRef.ok) {
      // A tag that does not exist yet is a release that has not happened, not a
      // broken one: an existing tag is what must agree with package.json (and a
      // tag push re-runs this in that mode). `--tag` creates it once every other
      // check has passed, so the tag can never point at an unverified revision.
      return { ok: true, detail: `${tagName} does not exist yet${options.tag ? '; it will be created after all checks pass' : ' (create it with --tag once this gate is green)'}` };
    }
    const tagCommit = run('git', ['rev-list', '-n', '1', tagName]).trim();
    const head = run('git', ['rev-parse', 'HEAD']).trim();
    return { ok: tagCommit === head, detail: tagCommit === head ? `${tagName} points at HEAD` : `${tagName} points at ${tagCommit.slice(0, 12)}, HEAD is ${head.slice(0, 12)}` };
  }));

  const sdkPath = new URL('../dist/navi.min.js', import.meta.url);
  const loaderPath = new URL('../dist/loader.min.js', import.meta.url);
  const sriPath = new URL('../dist/sri.txt', import.meta.url);
  const buildReportPath = new URL('../reports/build.json', import.meta.url);

  checks.push(await evaluate('artifact-budget', async () => {
    const sdk = await readFile(sdkPath);
    const loader = await stat(loaderPath);
    const withinSdk = sdk.length < SDK_BUDGET_BYTES;
    const withinLoader = loader.size < LOADER_BUDGET_BYTES;
    return {
      ok: withinSdk && withinLoader,
      detail: `navi.min.js ${sdk.length} B (<${SDK_BUDGET_BYTES}), loader.min.js ${loader.size} B (<${LOADER_BUDGET_BYTES})`
    };
  }));

  checks.push(await evaluate('subresource-integrity', async () => {
    const sdk = await readFile(sdkPath);
    const expected = `sha384-${createHash('sha384').update(sdk).digest('base64')}`;
    const published = (await readFile(sriPath, 'utf8')).trim();
    const build = JSON.parse(await readFile(buildReportPath, 'utf8'));
    const mismatches = [
      published === expected ? null : `dist/sri.txt is ${published}, bytes hash to ${expected}`,
      build.integrity === expected ? null : `reports/build.json records ${build.integrity}`,
      build.rawBytes === sdk.length ? null : `reports/build.json records ${build.rawBytes} bytes, artifact is ${sdk.length}`,
      build.loaderBytes === (await stat(loaderPath)).size ? null : 'reports/build.json loaderBytes does not match the artifact'
    ].filter(Boolean);
    return mismatches.length === 0
      ? { ok: true, detail: `${expected.slice(0, 24)}… matches dist/sri.txt and reports/build.json` }
      : { ok: false, detail: mismatches.join('; ') };
  }));

  if (!options.skipTests) {
    checks.push(await evaluate('test-suite', async () => {
      const result = attempt('npm', ['test', '--silent'], { ...process.env, VERIFY_RELEASE_ACTIVE: '1' });
      const passed = Number(/(\d+) passed/.exec(result.output)?.[1] ?? 0);
      const failed = Number(/(\d+) failed/.exec(result.output)?.[1] ?? 0);
      // A skipped test is a test that did not run, and the floor is a promise about
      // tests that did: recording the count makes a skipped suite legible instead of
      // looking like an unexplained shortfall.
      const skipped = Number(/(\d+) skipped/.exec(result.output)?.[1] ?? 0);
      const summary = `${passed} passed, ${failed} failed, ${skipped} skipped (floor ${MIN_PASSING_TESTS})`;
      if (!result.ok || failed > 0 || passed < MIN_PASSING_TESTS) {
        return { ok: false, detail: `${summary}\n${failureDigest(result.output)}` };
      }
      return { ok: true, detail: summary };
    }));

    checks.push(await evaluate('ci-gates', async () => {
      const result = attempt(process.execPath, [fileURLToPath(new URL('./ci-gates.mjs', import.meta.url)), '--all']);
      return { ok: result.ok, detail: result.ok ? tail(result.output, 1) : `${tail(result.output)}\n${'gates failed'}` };
    }));

    checks.push(await evaluate('pack-check', async () => {
      const result = attempt('npm', ['run', 'pack:check', '--silent']);
      return { ok: result.ok, detail: result.ok ? 'every published path is an intended release artifact' : tail(result.output) };
    }));
  }

  const canary = await verifyCleanRoomPackage({ mode: 'tarball' });
  const canarySummary = {
    ok: canary.ok,
    mode: canary.mode,
    source: canary.source,
    passed: canary.checks.filter(check => check.ok).length,
    total: canary.checks.length,
    checks: canary.checks
  };
  checks.push(await evaluate('cleanroom-package-canary', async () => {
    if (!canary.ok) {
      const failed = canary.checks.filter(check => !check.ok).map(check => `${check.id}: ${check.detail}`).join('; ');
      return { ok: false, detail: `${canarySummary.passed}/${canarySummary.total} clean-room canary checks passed (${failed})` };
    }
    return {
      ok: true,
      detail: `${canarySummary.passed}/${canarySummary.total} clean-room canary checks passed (manifest exports, SRI match, zero leaks, stdio JSON-RPC handshake)`
    };
  }));

  checks.push(await evaluate('rebuild-stable', async () => {
    // The tagged artifacts must be exactly what this source tree builds. A rebuild
    // that moves the bundle hash means the committed dist/ cannot be reproduced
    // from the tagged sources.
    const before = await readFile(sdkPath);
    const beforeLoader = await readFile(loaderPath);
    const result = attempt('npm', ['run', 'build', '--silent']);
    if (!result.ok) return { ok: false, detail: `npm run build failed\n${tail(result.output)}` };
    const after = await readFile(sdkPath);
    const afterLoader = await readFile(loaderPath);
    const same = before.equals(after) && beforeLoader.equals(afterLoader);
    return {
      ok: same,
      detail: same
        ? `rebuilt to identical bytes (${after.length} B bundle, ${afterLoader.length} B loader)`
        : `rebuild changed the artifacts: bundle ${before.length} -> ${after.length} B, loader ${beforeLoader.length} -> ${afterLoader.length} B`
    };
  }));

  if (options.tag && checks.every(check => check.ok)) {
    checks.push(await evaluate('create-tag', async () => {
      const existing = attempt('git', ['rev-parse', '-q', '--verify', `refs/tags/${tagName}`]);
      if (existing.ok) {
        const at = run('git', ['rev-list', '-n', '1', tagName]).trim();
        const head = run('git', ['rev-parse', 'HEAD']).trim();
        return at === head ? { ok: true, detail: `${tagName} already points at HEAD` } : { ok: false, detail: `${tagName} already exists at ${at.slice(0, 12)}` };
      }
      run('git', ['tag', '-a', tagName, '-m', `Navi ${version}`]);
      return { ok: true, detail: `created ${tagName} at ${run('git', ['rev-parse', '--short', 'HEAD']).trim()}` };
    }));
  }

  Object.defineProperty(checks, 'canary', { value: canarySummary, enumerable: false });
  return checks;
}

/** @param {string[]} argv */
export async function main(argv) {
  const wants = (/** @type {string} */ flag) => argv.includes(flag);
  if (wants('--help')) {
    process.stdout.write('Usage: node scripts/verify-release.mjs [--tag] [--skip-tests] [--json]\n');
    return 0;
  }
  const unknown = argv.filter(flag => !['--tag', '--skip-tests', '--json'].includes(flag));
  if (unknown.length) {
    process.stderr.write(`verify-release: unknown flag(s) ${unknown.join(', ')}\n`);
    return 2;
  }

  const checks = await verifyRelease({ skipTests: wants('--skip-tests'), tag: wants('--tag') });
  const ok = checks.every(check => check.ok);
  // Structured evidence beside the prose details: the exact bytes this receipt is
  // about, and the revision that produced them. Anything that acts on the receipt
  // — the publish preflight, a human, release notes — can then check that it still
  // describes the artifacts in front of it instead of trusting a timestamp.
  /** @param {string} command @param {string[]} args @returns {string | null} */
  const revisionOf = (command, args) => {
    const result = attempt(command, args);
    return result.ok ? result.output.trim() : null;
  };
  /** @type {{sri: string | null, bundleBytes: number | null, loaderBytes: number | null}} */
  const artifacts = { sri: null, bundleBytes: null, loaderBytes: null };
  try {
    artifacts.sri = (await readFile(new URL('../dist/sri.txt', import.meta.url), 'utf8')).trim();
    artifacts.bundleBytes = (await stat(new URL('../dist/navi.min.js', import.meta.url))).size;
    artifacts.loaderBytes = (await stat(new URL('../dist/loader.min.js', import.meta.url))).size;
  } catch { /* the artifact-budget check already reports a missing dist/ */ }
  const evidence = {
    revision: revisionOf('git', ['rev-parse', 'HEAD']),
    branch: revisionOf('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    // What this receipt is about, in a form that survives the report commit that will
    // carry it: the digest of every tracked path outside reports/.
    sourceTree: sourceTreeDigest('HEAD'),
    ...artifacts,
    // The floor this run was actually measured against. It travels with the
    // measurement so a later reader can tell whether the floor has moved since,
    // instead of comparing a recorded count to whatever the floor is today.
    floor: MIN_PASSING_TESTS,
    tests: /(\d+) passed, (\d+) failed/.exec(checks.find(check => check.id === 'test-suite')?.detail ?? '')?.slice(1).map(Number) ?? null,
    // Container verification runs in its own jobs on its own hardware and writes its own
    // receipts, so it is recorded here as evidence beside the artifacts rather than turned
    // into a check this gate would have to be able to run: a verification without a Docker
    // daemon still writes a complete receipt, and the container receipts themselves stay
    // the authority a reader can open.
    containers: (await readContainerReceipts(fileURLToPath(new URL('..', import.meta.url)))).map(summarizeContainer),
    canary: /** @type {any} */ (checks).canary ?? null
  };
  // The receipt is written on failure too: a release gate that only records its
  // successes cannot be audited when it blocks a release.
  const receiptPath = fileURLToPath(new URL('../reports/release-verification.json', import.meta.url));
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify({ ok, node: process.version, recordedAt: new Date().toISOString(), evidence, checks }, null, 2)}\n`);
  if (ok) {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const notesPath = fileURLToPath(new URL('../reports/release-notes.md', import.meta.url));
    await refreshReleaseNotes(['--tag', `v${packageJson.version}`, '--out', notesPath]);
  }
  if (wants('--json')) {
    process.stdout.write(`${JSON.stringify({ ok, evidence, checks, recordedAt: new Date().toISOString() }, null, 2)}\n`);
  } else {
    process.stdout.write('Navi release verification\n');
    for (const check of checks) process.stdout.write(`${check.ok ? '  ok  ' : ' FAIL '} ${check.id}: ${check.detail}\n`);
    for (const check of checks) {
      if (!check.ok && process.env.GITHUB_ACTIONS) process.stdout.write(`::error title=Navi release ${check.id}::${check.detail}\n`);
    }
    process.stdout.write(ok ? 'Release verified.\n' : 'Release verification failed.\n');
  }
  return ok ? 0 : 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
}
