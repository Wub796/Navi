#!/usr/bin/env node
// Publish preflight: the checks that must hold before `npm publish` runs, kept in
// this repository rather than in a shell line inside a workflow so they can be run
// and tested the same way locally.
//
// A registry publish is the one action here that cannot be undone: an npm version
// is immutable, and provenance attaches a signed statement to it. So this refuses
// to proceed while a decision is still missing — no license file, no `license`
// field, no `repository.url` for the provenance statement to agree with, a receipt that
// does not describe this revision, a receipt whose code is not
// the code the tag points at, or a receipt that cites no green container verification
// of a configuration this repository deploys — even though those are the kind of details
// a person is tempted to fill in "later".
//
// Usage: node scripts/publish-preflight.mjs [--tag v0.5.0]
// Exit codes: 0 ready to publish, 1 not ready (the reasons are printed), 2 usage.
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceTreeDigest } from './verify-release.mjs';

/** Files npm accepts as the license text, in the order npm looks for them. */
const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE'];

/**
 * The deployment configurations whose container verification may authorise a publish:
 * the file an operator runs in production, and the local Compose file the repository
 * ships beside it. A receipt for any other file proves something about that file, not
 * about the runtime this release ships.
 */
export const RELEASE_COMPOSE_TARGETS = ['deploy/docker-compose.prod.yml', 'docker-compose.yml'];

/**
 * The number of checks a green container receipt must have recorded. A floor rather
 * than an exact count, so a requirement cannot silently shrink what it demands while
 * a verifier that checks more is not punished for the extra coverage.
 */
export const CONTAINER_CHECKS_FLOOR = 18;

/**
 * The number of checks a green clean-room package canary must have recorded.
 */
export const CANARY_CHECKS_FLOOR = 6;

/** Repository root, so every git command below answers the same way from any cwd. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The one directory a release rewrites after the gate has run. */
const GENERATED_REPORT_DIR = 'reports/';

/**
 * @param {string[]} args
 * @returns {{status: number, output: string}}
 */
function git(args) {
  const result = spawnSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' });
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

/**
 * The git facts the provenance check is about, resolved once so the rule itself stays pure
 * and a test can hand it shapes no repository would produce.
 *
 * `evidence.revision` cannot be the commit that carries the receipt — that commit does not
 * exist yet when the gate writes it — so a released revision is always "the revision the
 * receipt names, plus generated reports". These facts are what turn that sentence from an
 * excuse into a checkable property: ancestry, the changed paths outside `reports/`, and the
 * source-tree digest the receipt recorded, against the same digest taken at HEAD.
 * @param {Record<string, any> | null} receipt
 * @returns {{head: string | null, ancestor: boolean | null, changedPaths: string[] | null, digest: string | null, error: string | null}}
 */
export function resolveProvenance(receipt) {
  /** @type {{head: string | null, ancestor: boolean | null, changedPaths: string[] | null, digest: string | null, error: string | null}} */
  const facts = { head: null, ancestor: null, changedPaths: null, digest: null, error: null };
  const revision = typeof receipt?.evidence?.revision === 'string' ? receipt.evidence.revision : null;
  if (!revision) return facts;
  const head = git(['rev-parse', 'HEAD']);
  if (head.status !== 0 || !head.output) {
    facts.error = `git rev-parse HEAD failed${head.output ? `: ${head.output}` : ''}`;
    return facts;
  }
  facts.head = head.output;
  facts.digest = sourceTreeDigest('HEAD');
  if (facts.head === revision) return facts;
  const ancestry = git(['merge-base', '--is-ancestor', revision, 'HEAD']);
  if (ancestry.status !== 0 && ancestry.status !== 1) {
    facts.error = `${revision} cannot be compared with HEAD${ancestry.output ? `: ${ancestry.output}` : ''}`;
    return facts;
  }
  facts.ancestor = ancestry.status === 0;
  if (!facts.ancestor) return facts;
  const diff = git(['diff', '--name-only', revision, 'HEAD', '--', '.', `:!${GENERATED_REPORT_DIR.replace(/\/$/, '')}`]);
  if (diff.status !== 0) {
    facts.error = `git diff ${revision}..HEAD failed${diff.output ? `: ${diff.output}` : ''}`;
    return facts;
  }
  facts.changedPaths = diff.output.split('\n').filter(line => line.trim().length > 0);
  return facts;
}

/**
 * The repository this publish belongs to, as `owner/name` where one can be resolved.
 *
 * npm binds a provenance statement to the repository the workflow ran in, and GitHub states
 * that repository in the environment. `origin` is the fallback so the check is meaningful in a
 * local run too, and both are normalised through the same `repositorySlug` the manifest is, so
 * the two are compared in the form npm compares them in rather than as raw strings.
 * @returns {string | null} the expected repository, or null when neither source names one
 */
export function resolveRepository() {
  const fromEnvironment = process.env.GITHUB_REPOSITORY?.trim();
  if (fromEnvironment) return fromEnvironment;
  const remote = git(['remote', 'get-url', 'origin']);
  return remote.status === 0 && remote.output ? remote.output : null;
}

/**
 * Reduce a repository reference to `host/owner/name` in lower case.
 *
 * npm accepts a good many spellings for one repository — `git+https://`, a bare `owner/name`
 * shorthand, an `ssh://git@…` clone URL, each with or without a trailing `.git` — and compares
 * the manifest against the provenance statement after normalising them. A check that spelled
 * the comparison differently would either refuse a publish npm accepts or wave through the one
 * npm rejects, which is how an empty `repository.url` cost a signed attestation and a run.
 * @param {unknown} value
 * @returns {string | null} the canonical slug, or null when the value names no repository
 */
export function repositorySlug(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  // The `owner/name` shorthand. The owner is required to be dot-free so a hostname cannot be
  // mistaken for one and prefixes itself to the slug.
  const shorthand = /^([\w-]+)\/([\w.-]+?)(?:\.git)?$/.exec(text);
  if (shorthand) return `github.com/${shorthand[1]}/${shorthand[2]}`.toLowerCase();
  const candidate = text
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:/]+):/, 'https://$1/')
    .replace(/^github:/, 'https://github.com/');
  let url;
  try { url = new URL(candidate); } catch { return null; }
  const path = url.pathname.replace(/\.git$/, '').replace(/\/+$/, '').replace(/^\/+/, '');
  if (!path) return null;
  return `${url.hostname}${url.port ? `:${url.port}` : ''}/${path}`.toLowerCase();
}

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
 * @param {{licenseFile: string | null, receipt: Record<string, any> | null, tag: string | null, artifacts?: {sri: string | null, bundleBytes: number | null, loaderBytes: number | null}, provenance?: {head: string | null, ancestor: boolean | null, changedPaths: string[] | null, digest: string | null, error: string | null}, repository?: string | null}} context
 * @returns {PreflightCheck[]}
 */
export function evaluatePublish(manifest, context) {
  const publishConfig = manifest.publishConfig ?? {};
  const licence = typeof manifest.license === 'string' && manifest.license.trim() ? manifest.license.trim() : null;
  const expectedTag = `v${manifest.version}`;
  const tagMatches = context.tag === null ? null : context.tag === expectedTag;
  const containers = containerEvidence(context.receipt);
  const canary = canaryEvidence(context.receipt);
  const provenance = provenanceEvidence(context.receipt, context.provenance);
  const repository = repositoryEvidence(manifest, context.repository);
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
      // npm checks the manifest's `repository.url` against the repository in the signed
      // provenance statement and rejects the upload with a 422 when it names another — or none
      // at all, which is how an empty url reached the registry with a validly signed bundle
      // behind it. That check happens after the token is spent, so it is made here instead,
      // where it costs nothing and can be read before the run. Required only under provenance:
      // without a statement there is nothing for npm to compare against.
      id: 'repository-url',
      ok: repository.ok,
      detail: repository.detail,
      blocking: publishConfig.provenance === true
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
      // was written, which a timestamp would not catch either.
      id: 'receipt-matches-artifacts',
      ok: receiptDescribes(context.receipt, context.artifacts),
      detail: receiptArtifactDetail(context.receipt, context.artifacts),
      blocking: true
    },
    {
      // The receipt is written before the commit that carries it exists, so its
      // `evidence.revision` is one step behind the tag by construction. That is a
      // scheduling fact, not a licence: outside `reports/`, the tagged tree must be the
      // tree the gate verified, and this is where that is proved rather than assumed.
      id: 'provenance-parity',
      ok: provenance.ok,
      detail: provenance.detail,
      blocking: true
    },
    {
      // The runtime this release ships is the image, and the properties that matter are
      // only visible in a running container. The release pipeline already depends on the
      // container job by id; this is the same requirement stated where the publish is
      // actually authorised, so a receipt that cites no container verification — or one
      // whose runs were not green — cannot carry a publish across the line on its own.
      id: 'container-evidence',
      ok: containers.ok,
      detail: containers.detail,
      blocking: true
    },
    {
      // The clean-room tarball canary proves that the packed archive contains every
      // manifest export, hashes to the published SRI, leaks zero dev/test/source files,
      // and passes a live stdio JSON-RPC handshake and SIGTERM teardown.
      id: 'canary-evidence',
      ok: canary.ok,
      detail: canary.detail,
      blocking: true
    }
  ];
}

/**
 * @param {Record<string, any>} record a summarized container receipt from the verification run
 * @returns {string}
 */
function describeContainerRecord(record) {
  const platform = typeof record.architecture === 'string' ? record.architecture : 'an unstamped platform';
  const verdict = record.ok === true ? `${record.passed}/${record.checks}` : 'not green';
  return `${record.compose} on ${platform} is ${verdict}`;
}

/**
 * Whether the manifest's `repository.url` is the repository the provenance statement will
 * name. The declaration is read from either the string or the object form npm accepts, and
 * compared as a normalised slug so the spellings npm itself accepts are not read as a
 * disagreement.
 * @param {Record<string, any>} manifest
 * @param {string | null | undefined} expected
 * @returns {{ok: boolean, detail: string}}
 */
function repositoryEvidence(manifest, expected) {
  const declared = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  const declaration = typeof declared === 'string' && declared.trim() ? `"${declared.trim()}"` : 'nothing';
  const expectedSlug = repositorySlug(expected);
  if (!expectedSlug) {
    return {
      ok: false,
      detail: `package.json declares repository.url ${declaration}, but the repository this publish belongs to could not be resolved — neither GITHUB_REPOSITORY nor \`git remote get-url origin\` named one — so the two cannot be compared`
    };
  }
  const declaredSlug = repositorySlug(declared);
  if (!declaredSlug) {
    return {
      ok: false,
      detail: `package.json declares repository.url ${declaration}, which names no repository. A provenance publish must declare the repository it is built from (${expectedSlug}), because npm validates the manifest against the signed statement and refuses the upload with 422 "Failed to validate repository information"`
    };
  }
  if (declaredSlug !== expectedSlug) {
    return {
      ok: false,
      detail: `package.json repository.url is ${declaration}, which is ${declaredSlug}, but this release is built from ${expectedSlug}; npm refuses a provenance publish whose manifest names another repository`
    };
  }
  return { ok: true, detail: `package.json declares repository.url ${declaration}, which is the repository this release is built from (${expectedSlug})` };
}

/**
 * The container verification a publish must cite: at least one green run against a
 * configuration this repository deploys. Absent and empty evidence are reported as the
 * different unknowns they are, and a record that verified something else is named rather
 * than counted as a pass.
 * @param {Record<string, any> | null} receipt
 * @returns {{ok: boolean, detail: string}}
 */
function containerEvidence(receipt) {
  const cited = receipt?.evidence?.containers;
  const records = Array.isArray(cited) ? cited : [];
  if (records.length === 0) {
    return {
      ok: false,
      detail: `${Array.isArray(cited) ? 'evidence.containers is empty' : 'evidence.containers is absent'} in reports/release-verification.json. The image is the runtime this release ships, so a publish with no container verification has no evidence that it runs with the privileges, storage and lifecycle it claims; run \`npm run test:containers -- --compose deploy/docker-compose.prod.yml\` and re-run \`npm run verify:release\` so the receipt cites the result.`
    };
  }
  const shipped = records.filter(record => RELEASE_COMPOSE_TARGETS.includes(record?.compose));
  if (shipped.length === 0) {
    const named = [...new Set(records.map(record => JSON.stringify(record?.compose ?? null)))].join(', ');
    return { ok: false, detail: `evidence.containers names ${named}, none of which is a configuration this repository deploys (${RELEASE_COMPOSE_TARGETS.join(' or ')})` };
  }
  const green = shipped.find(record => record.ok === true && Number(record.passed) === Number(record.checks) && Number(record.checks) >= CONTAINER_CHECKS_FLOOR);
  if (!green) {
    return {
      ok: false,
      detail: `${shipped.length} cited record(s) name a deployment configuration (${shipped.map(describeContainerRecord).join('; ')}) and none is green: a publish needs one record whose every check passed, over at least ${CONTAINER_CHECKS_FLOOR} checks`
    };
  }
  return { ok: true, detail: `${describeContainerRecord(green)}; the shipped image was verified against a configuration this repository deploys` };
}

/**
 * The parity a publish must show between the code the receipt describes and the code the tag
 * points at. Naming HEAD outright passes; so does a source-tree attestation that matches
 * HEAD's; otherwise the receipt's revision must be an ancestor of HEAD with every non-report
 * path identical across the two — which is exactly the shape a release has, where the
 * receipt is committed by the generated-reports commit that follows the gate run.
 *
 * Anything else is a refusal, because a receipt that cannot be tied to the tagged tree is
 * evidence about some other revision, and publishing it would attach provenance to code no
 * gate has seen.
 * @param {Record<string, any> | null} receipt
 * @param {{head: string | null, ancestor: boolean | null, changedPaths: string[] | null, digest: string | null, error: string | null} | undefined} facts
 * @returns {{ok: boolean, detail: string}}
 */
function provenanceEvidence(receipt, facts) {
  /** @param {string} sha @returns {string} */
  const short = sha => sha.slice(0, 12);
  const revision = typeof receipt?.evidence?.revision === 'string' ? receipt.evidence.revision : null;
  const recorded = typeof receipt?.evidence?.sourceTree === 'string' ? receipt.evidence.sourceTree : null;
  if (!revision) {
    return {
      ok: false,
      detail: 'reports/release-verification.json records no evidence.revision, so the receipt cannot be tied to a revision at all; run `npm run verify:release` on the revision being released.'
    };
  }
  if (!facts || facts.error) {
    return {
      ok: false,
      detail: `${short(revision)} could not be compared with the current HEAD${facts?.error ? ` (${facts.error})` : ''}, so a publish cannot show that the tagged code is the verified code`
    };
  }
  if (facts.head === revision) {
    return { ok: true, detail: `the receipt names HEAD (${short(revision)}), so the tagged code is the code the gate verified` };
  }
  if (recorded && facts.digest && recorded === facts.digest) {
    return {
      ok: true,
      detail: `the receipt's source-tree attestation (${recorded.slice(0, 14)}…) matches the tracked tree at HEAD, so the receipt and the tag describe the same code`
    };
  }
  if (facts.ancestor === true) {
    const changed = facts.changedPaths ?? [];
    if (changed.length) {
      return {
        ok: false,
        detail: `${short(revision)}..HEAD changes ${changed.length} path(s) outside ${GENERATED_REPORT_DIR} (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', …' : ''}), so the tagged tree is not the tree the gate verified; re-run \`npm run verify:release\` on the revision being released`
      };
    }
    if (recorded && facts.digest && recorded !== facts.digest) {
      return {
        ok: false,
        detail: `the receipt's source-tree attestation (${recorded.slice(0, 14)}…) does not match the tracked tree at HEAD (${facts.digest.slice(0, 14)}…), so the receipt describes code other than the code being published`
      };
    }
    return {
      ok: true,
      detail: `${short(revision)} is an ancestor of HEAD (${short(facts.head ?? '')}) and no path outside ${GENERATED_REPORT_DIR} differs, so HEAD is the gate's revision plus generated reports`
    };
  }
  return {
    ok: false,
    detail: `${short(revision)} is not an ancestor of HEAD and the receipt's source-tree attestation ${recorded ? 'does not match the tracked tree at HEAD' : 'is absent'}, so the receipt cannot be shown to describe the code this tag points at`
  };
}

/**
 * The clean-room package canary verification a publish must cite: `evidence.canary`
 * with `ok: true` and all 6 checks passing.
 *
 * Exported because the generated release notes describe the same evidence, and a note
 * that called a record verified while this gate called it incomplete — or the reverse —
 * would be two answers to one question.
 * @param {Record<string, any> | null} receipt
 * @returns {{ok: boolean, detail: string}}
 */
export function canaryEvidence(receipt) {
  const cited = receipt?.evidence?.canary;
  if (!cited || typeof cited !== 'object') {
    return {
      ok: false,
      detail: 'evidence.canary is absent in reports/release-verification.json. A publish requires clean-room tarball verification (manifest layout, SRI byte parity, zero leaks, and stdio JSON-RPC handshake); run `npm run verify:release` so the receipt records `evidence.canary`.'
    };
  }
  const checks = Array.isArray(cited.checks) ? cited.checks : [];
  const passed = checks.length > 0
    ? checks.filter((/** @type {{ok?: unknown}} */ c) => c?.ok === true).length
    : Number(cited.passed ?? 0);
  const total = checks.length > 0 ? checks.length : Number(cited.total ?? 0);
  const allChecksGreen = checks.length === 0 || checks.every((/** @type {{ok?: unknown}} */ c) => c?.ok === true);
  if (cited.ok !== true || !allChecksGreen || passed !== total || total < CANARY_CHECKS_FLOOR) {
    const failedIds = checks.filter((/** @type {{ok?: unknown}} */ c) => c?.ok !== true).map((/** @type {{id?: unknown}} */ c) => String(c?.id ?? 'unknown'));
    const suffix = failedIds.length ? ` (failed: ${failedIds.join(', ')})` : '';
    return {
      ok: false,
      detail: `evidence.canary is not green (ok: ${Boolean(cited.ok)}, ${passed}/${total} checks passed${suffix}); a publish requires ok: true with all ${CANARY_CHECKS_FLOOR}/${CANARY_CHECKS_FLOOR} clean-room canary checks passing`
    };
  }
  return {
    ok: true,
    detail: `clean-room tarball canary passed ${passed}/${total} checks (${cited.source ?? 'local npm pack'})`
  };
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

  const checks = evaluatePublish(manifest, { licenseFile, receipt, tag, artifacts, provenance: resolveProvenance(receipt), repository: resolveRepository() });
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
