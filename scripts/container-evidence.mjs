// The container receipts a release may cite.
//
// Container verification runs in its own jobs, on its own hardware, and writes its own
// receipts; this module is how the release gate and the release notes read them. A
// receipt is evidence only if it says which deployment configuration and which platform
// it proves, so both are read from the file rather than inferred from the path it happens
// to sit in — and a platform with no receipt is reported as unverified rather than left
// out, because an omission reads as a pass.

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** Where the release workflow's per-architecture artifacts are downloaded. */
export const RECEIPT_DIRECTORY = 'reports/container-verification';
/** The receipts a local or CI run of the verifier leaves directly in reports/. */
export const LOCAL_RECEIPTS = ['reports/container-verification.json', 'reports/production-container-verification.json'];

/**
 * @typedef {{check: string, ok: boolean, detail: string}} ContainerCheck
 * @typedef {{path: string, architecture: string | null, compose: string | null, imageId: string | null, recordedAt: string | null, ok: boolean, checks: ContainerCheck[]}} ContainerReceipt
 */

/**
 * Read one receipt. Malformed JSON is an error rather than a skipped file: a broken
 * receipt must not silently reduce the number of architectures a release claims.
 * @param {string} path
 * @returns {Promise<ContainerReceipt | null>} null when the file is not a receipt at all
 */
export async function readContainerReceipt(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (typeof parsed?.ok !== 'boolean' || !Array.isArray(parsed?.checks)) return null;
  return {
    path,
    architecture: typeof parsed.architecture === 'string' ? parsed.architecture : null,
    compose: typeof parsed.compose === 'string' ? parsed.compose : null,
    // The image digest is carried through as recorded, and a receipt written before the
    // field existed is read as unstamped rather than rejected: the verdicts it holds are
    // still evidence, and the missing digest is visible as `null` instead of implied.
    imageId: typeof parsed.imageId === 'string' && parsed.imageId ? parsed.imageId : null,
    recordedAt: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : null,
    ok: parsed.ok,
    checks: parsed.checks.filter((/** @type {unknown} */ check) => typeof (/** @type {ContainerCheck} */ (check))?.check === 'string')
  };
}

/**
 * Every container receipt in the workspace: the per-architecture artifacts the release
 * workflow downloads, plus whatever a local run left in reports/. One platform and
 * configuration appears once — the most recently recorded — so a downloaded artifact and
 * a local receipt for the same target do not become two rows saying the same thing.
 * @param {string} [root]
 * @returns {Promise<ContainerReceipt[]>}
 */
export async function readContainerReceipts(root = '.') {
  /** Workspace-relative, so the receipt can record where it was read from. @type {string[]} */
  const paths = [];
  const artifacts = join(root, RECEIPT_DIRECTORY);
  try {
    for (const entry of await readdir(artifacts, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      paths.push(join(RECEIPT_DIRECTORY, relative(artifacts, join(entry.parentPath, entry.name))));
    }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
  }
  for (const path of LOCAL_RECEIPTS) if (existsSync(join(root, path))) paths.push(path);
  /** @type {ContainerReceipt[]} */
  const receipts = [];
  for (const path of paths) {
    const receipt = await readContainerReceipt(join(root, path));
    if (receipt) receipts.push({ ...receipt, path });
  }
  /** @type {Map<string, ContainerReceipt>} */
  const newest = new Map();
  for (const receipt of receipts) {
    const identity = `${receipt.architecture ?? '?'}::${receipt.compose ?? '?'}`;
    const existing = newest.get(identity);
    if (!existing || (receipt.recordedAt ?? '') > (existing.recordedAt ?? '')) newest.set(identity, receipt);
  }
  return [...newest.values()].sort((a, b) => `${a.architecture ?? ''}${a.compose ?? ''}`.localeCompare(`${b.architecture ?? ''}${b.compose ?? ''}`));
}

/**
 * The compact form a release receipt records: which platform and configuration were
 * verified, and the verdict, without copying every check detail into a second file.
 * @param {ContainerReceipt} receipt
 * @returns {{architecture: string | null, compose: string | null, imageId: string | null, recordedAt: string | null, ok: boolean, passed: number, checks: number}}
 */
export function summarizeContainer(receipt) {
  return {
    architecture: receipt.architecture,
    compose: receipt.compose,
    imageId: receipt.imageId,
    recordedAt: receipt.recordedAt,
    ok: receipt.ok,
    passed: receipt.checks.filter(check => check.ok).length,
    checks: receipt.checks.length
  };
}
