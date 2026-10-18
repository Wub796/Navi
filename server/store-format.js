// Backend resolution for the telemetry store.
//
// Which backend serves an existing path is decided by the file's own bytes and not
// by the runtime that happens to be running: both backends share one path, so a
// runtime that gains `node:sqlite` must not reopen an operator's JSONL log as a
// database, and one that lacks it must not read a database as an empty log.
//
// `node:sqlite` is resolved without a static import because it only exists from
// Node 22.5; a static import would break the documented `engines.node` range at
// module load instead of degrading to the log backend.

import { open } from 'node:fs/promises';

/**
 * Resolve `node:sqlite` without a static import. It only exists from Node 22.5, so
 * it is absent across part of the supported engines range, and a static import
 * would break that range at module load rather than degrading to the log.
 *
 * The runtime's version is deliberately not consulted. The module was unflagged in
 * Node 22.13 (nodejs/node#55890), so refusing it on the Node 22 line - which this
 * store did - meant the preferred backend was unreachable on the exact runtime the
 * image pins. Nothing about the version tells us whether the module will import;
 * only the import does, and it degrades to the log when it fails. The import does
 * emit an ExperimentalWarning wherever it succeeds, which is accurate rather than
 * noise: the module is Stability 1 across the Node 22 line. A runtime that wants
 * the log backend can say so with `--no-experimental-sqlite`, which makes this
 * import fail exactly as it does on a runtime that never had the module.
 * @returns {Promise<any>}
 */
export async function loadSqlite() {
  try {
    // Variable specifier on purpose: the module is optional at runtime.
    const specifier = 'node:sqlite';
    const module = await import(specifier);
    return typeof module?.DatabaseSync === 'function' ? module : null;
  } catch {
    return null;
  }
}

/** The sixteen bytes every SQLite database file starts with. */
const SQLITE_HEADER = 'SQLite format 3\u0000';

/**
 * Which backend may serve a store path, decided by its bytes rather than its name.
 *
 * The two backends share one path - there is no `.log` suffix to go by - so a
 * runtime that gains `node:sqlite` would otherwise open an existing JSONL log as a
 * database, which fails on the first statement (SQLITE_NOTADB), and the reverse
 * would read a database as a log and report an empty audit trail as though it were
 * real. Both are silent-wrong-answer failures, which is why the file itself is the
 * only trustworthy input here. An empty file is not a format: SQLite opens a
 * zero-length file as an empty database, and a log that has never been appended to
 * is a log, so either backend may claim it without losing anything.
 * @param {string} path
 * @returns {Promise<'missing' | 'empty' | 'sqlite' | 'jsonl'>}
 */
export async function storeFormat(path) {
  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code === 'ENOENT') return 'missing';
    throw error;
  }
  try {
    const bytes = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead === 0) return 'empty';
    // A short file is never a database: a real one carries a 100-byte header.
    if (bytesRead < SQLITE_HEADER.length) return 'jsonl';
    return bytes.toString('utf8') === SQLITE_HEADER ? 'sqlite' : 'jsonl';
  } finally {
    await handle.close();
  }
}
