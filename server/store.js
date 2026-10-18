// Telemetry aggregate store.
//
// Aggregates are the only thing the ingestion path writes: no field values, no
// DOM, no user identifiers. Containment violations are the deliberate second
// record type: a refused destination is the one thing this service must be able
// to show a tenant afterwards, and a sanitized URL that was *not* visited is not
// page data. Persistence uses the runtime's own facilities so the service keeps
// the repository's zero-runtime-dependency rule:
//
//   * `node:sqlite` when the runtime provides it (Node 22.5+, importable without a
//     flag from 22.13), which is the preferred store and the one
//     `server/telemetry.db` refers to;
//   * otherwise an append-only JSONL log at the same path, so the documented
//     `engines.node: ">=22.0.0"` range keeps working.
//
// Both modes answer with the identical summary shape, so callers never branch on
// which one is active. The two backends live in `store-sqlite.js` and
// `store-log.js`; the record shapes and normalization they share are in
// `store-schema.js`, and backend detection is in `store-format.js`. This module is
// the single entrypoint the host imports, and it re-exports the surface that was
// historically defined here so no caller changed when the layers were separated.
//
// Which one serves an existing path is decided by the file's own bytes and not by
// the runtime that happens to be running: both backends share one path, so a
// runtime that gains `node:sqlite` must not reopen an operator's JSONL log as a
// database, and one that lacks it must not read a database as an empty log. See
// `storeFormat`.

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createLogStore } from './store-log.js';
import { createSqliteStore } from './store-sqlite.js';
import { loadSqlite, storeFormat } from './store-format.js';

export {
  CHECKOUT_CLAIM_CONSUMED_KIND,
  CHECKOUT_CLAIM_KIND,
  CHECKOUT_CLAIM_TTL_MS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_VIOLATION_LIMIT,
  MAX_RETENTION_DAYS,
  MAX_VIOLATION_LIMIT,
  STORE_META_KIND,
  VIOLATION_KIND,
  WEBHOOK_EVENT_KIND,
  WEBHOOK_EVENT_RELEASE_KIND,
  WEBHOOK_EVENT_TTL_MS
} from './store-schema.js';
export { storeFormat } from './store-format.js';
export { beginProcessLifecycle, lifecyclePaths } from './store-lifecycle.js';

/** Whether this runtime can serve the preferred sqlite backend. @returns {Promise<boolean>} */
export async function sqliteAvailable() {
  return Boolean(await loadSqlite());
}

/**
 * Open the telemetry store, preferring sqlite and falling back to the log.
 * `options.mode` pins a backend instead of following that preference: the host
 * never does, but a test or an operator comparing the two should not have to.
 * @param {string} file
 * @param {{mode?: 'sqlite' | 'log'}} [options]
 * @returns {Promise<import('./store-schema.js').TelemetryStore>}
 */
export async function createStore(file, options = {}) {
  const path = resolve(file);
  await mkdir(dirname(path), { recursive: true });
  if (options.mode === 'log') return createLogStore(path);
  const sqlite = await loadSqlite();
  if (options.mode === 'sqlite') {
    if (!sqlite) throw new Error(`The sqlite backend needs a runtime that provides node:sqlite; node ${process.versions.node} does not, and was asked for it explicitly, so no fallback was used.`);
    return createSqliteStore(path, sqlite);
  }
  // An existing log keeps its backend even where SQLite is available: a store an
  // operator already holds records in must not change format because the runtime
  // changed underneath it. Everything else - a new path, an empty file, and a file
  // that is already a database - is served by whichever backend can serve it.
  const format = await storeFormat(path);
  if (format === 'jsonl') return createLogStore(path);
  if (sqlite) return createSqliteStore(path, sqlite);
  if (format === 'sqlite') {
    throw new Error(`The store at ${path} is a SQLite database and node ${process.versions.node} cannot read it: node:sqlite needs Node 22.5 or newer, and a runtime that disabled the module with --no-experimental-sqlite reports the import as absent without saying why. Refusing to open it as a log, which would answer with an empty audit trail instead of an error; run the service on a runtime that provides node:sqlite, or move this database aside and start a fresh log.`);
  }
  return createLogStore(path);
}
