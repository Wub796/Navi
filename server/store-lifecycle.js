// Process lifecycle sentinels.
//
// One process must own each state path. A clean marker published at teardown is
// what tells the next boot that the previous owner stopped on purpose, so start-up
// consumes the marker and a crash leaves it absent. Both the host and the SSE
// transport use these helpers, which is why they live beside the store rather than
// inside either entrypoint.

import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Suffix that names the successful-teardown marker in the default layout. */
const CLEAN_SUFFIX = '.clean';
/** Companion suffix the normalized layout uses for dirty evidence. */
const DIRTY_SUFFIX = '.dirty';
/** The exact payload a published marker carries. Anything else is not teardown evidence. */
const CLEAN_MARKER = 'clean\n';

/**
 * Resolve the two paths one lifecycle owner uses.
 *
 * A configured path that already names the marker - the shipped
 * `NAVI_MCP_STATE_FILE="/var/lib/navi/mcp/state.clean"` is one - *is* that marker,
 * and dirty evidence moves to the sibling `state.dirty`. Without this, the
 * configured name would be read as the dirty file and a completed shutdown would
 * publish the doubly-suffixed `state.clean.clean`, so neither name would mean what
 * it says. Any other path keeps the long-standing pairing: the configured file is
 * the dirty evidence and the marker is `<file>.clean`, which is what the default
 * `/tmp/navi-mcp-state` and the host's store file both use.
 * @param {string} file
 * @returns {{stateFile: string, cleanFile: string, normalized: boolean}}
 */
export function lifecyclePaths(file) {
  const path = resolve(file);
  if (path.length > CLEAN_SUFFIX.length && path.endsWith(CLEAN_SUFFIX)) {
    return { stateFile: `${path.slice(0, -CLEAN_SUFFIX.length)}${DIRTY_SUFFIX}`, cleanFile: path, normalized: true };
  }
  return { stateFile: path, cleanFile: `${path}${CLEAN_SUFFIX}`, normalized: false };
}

/**
 * Consume the previous owner's clean marker before accepting work. One process
 * must own each state path. Only ENOENT means first boot; I/O failures abort startup.
 * MCP creates a dirty file because it has no telemetry database to prove a boot.
 * @param {string} file
 * @param {{createState?: boolean}} [options]
 * @returns {Promise<{uncleanShutdowns: number, stateFile: string, cleanFile: string, markClean(): Promise<void>}>}
 */
export async function beginProcessLifecycle(file, options = {}) {
  const { stateFile, cleanFile, normalized } = lifecyclePaths(file);
  await mkdir(dirname(stateFile), { recursive: true });
  const exists = async (/** @type {string} */ target) => {
    try { await stat(target); return true; }
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false;
      throw error;
    }
  };
  /** Whether the file is the marker this module publishes, not merely a file with that name. @param {string} target */
  const published = async (target) => {
    try { return (await readFile(target, 'utf8')) === CLEAN_MARKER; }
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false;
      throw error;
    }
  };
  let existed = await exists(stateFile);
  let clean = await exists(cleanFile);
  if (normalized && clean && !(await published(cleanFile))) {
    // Pre-normalization residue. That build wrote its *dirty* evidence at this exact
    // name and published the doubled `<cleanFile>.clean`, so the file itself is not
    // teardown evidence and reading it as such would hide a crash. The doubled marker
    // it left beside it is the real verdict; an upgraded volume is then classified
    // correctly once, and the residue is removed rather than trusted.
    const legacyMarker = `${cleanFile}${CLEAN_SUFFIX}`;
    existed = true;
    clean = await published(legacyMarker);
    await rm(legacyMarker, { force: true });
  }
  await rm(cleanFile, { force: true });
  if (options.createState) {
    const handle = await open(stateFile, 'a', 0o600);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  return {
    stateFile,
    cleanFile,
    uncleanShutdowns: existed && !clean ? 1 : 0,
    async markClean() {
      // Publish only a complete, flushed marker. SIGKILL during its write must
      // not leave a partially-written marker that the next boot trusts.
      const temporary = `${cleanFile}.tmp`;
      const handle = await open(temporary, 'w', 0o600);
      try {
        try { await handle.writeFile(CLEAN_MARKER); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, cleanFile);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    }
  };
}
