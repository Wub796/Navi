// Telemetry aggregate store.
//
// Aggregates are the only thing the ingestion path writes: no field values, no
// DOM, no user identifiers. Persistence uses the runtime's own facilities so the
// service keeps the repository's zero-runtime-dependency rule:
//
//   * `node:sqlite` when the runtime provides it (Node 22.5+), which is the
//     preferred store and the one `server/telemetry.db` refers to;
//   * otherwise an append-only JSONL log at the same path, so the documented
//     `engines.node: ">=20"` range keeps working.
//
// Both modes answer with the identical summary shape, so callers never branch on
// which one is active.

import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * @typedef {{tenant_id: string, url_origin: string, actions_indexed: number, actions_executed: number, execution_failures: number, received_at: string}} TelemetryRecord
 * @typedef {{actions_indexed: number, actions_executed: number, execution_failures: number}} TelemetryTotals
 * @typedef {{tenant_id: string, events: number, actions_indexed: number, actions_executed: number, execution_failures: number}} TenantBucket
 * @typedef {{url_origin: string, events: number}} OriginBucket
 * @typedef {{events: number, totals: TelemetryTotals, byTenant: TenantBucket[], byOrigin: OriginBucket[]}} TelemetrySummary
 * @typedef {{tenant_id?: string}} SummaryFilter
 * @typedef {{mode: 'sqlite' | 'log', file: string, append(record: TelemetryRecord): Promise<void>, summarize(filter?: SummaryFilter): Promise<TelemetrySummary>, reset(): Promise<void>, close(): Promise<void>}} TelemetryStore
 */

/**
 * Resolve `node:sqlite` without a static import. It exists from Node 22.5 but
 * not on Node 20, and a static import would break the supported engines range at
 * module load rather than degrading to the append-only log.
 * @returns {Promise<any>}
 */
async function loadSqlite() {
  try {
    // Variable specifier on purpose: the module is optional at runtime.
    const specifier = 'node:sqlite';
    const module = await import(specifier);
    return typeof module?.DatabaseSync === 'function' ? module : null;
  } catch {
    return null;
  }
}

/**
 * The one place summary arithmetic lives, so sqlite and log mode cannot drift.
 * @param {TelemetryRecord[]} records
 * @param {SummaryFilter} [filter]
 * @returns {TelemetrySummary}
 */
function summarizeRecords(records, filter = {}) {
  const selected = filter.tenant_id ? records.filter(record => record.tenant_id === filter.tenant_id) : records;
  /** @type {TelemetryTotals} */
  const totals = { actions_indexed: 0, actions_executed: 0, execution_failures: 0 };
  /** @type {Map<string, TenantBucket>} */
  const tenants = new Map();
  /** @type {Map<string, number>} */
  const origins = new Map();
  for (const record of selected) {
    totals.actions_indexed += record.actions_indexed;
    totals.actions_executed += record.actions_executed;
    totals.execution_failures += record.execution_failures;
    const bucket = tenants.get(record.tenant_id) ?? { tenant_id: record.tenant_id, events: 0, actions_indexed: 0, actions_executed: 0, execution_failures: 0 };
    bucket.events += 1;
    bucket.actions_indexed += record.actions_indexed;
    bucket.actions_executed += record.actions_executed;
    bucket.execution_failures += record.execution_failures;
    tenants.set(record.tenant_id, bucket);
    origins.set(record.url_origin, (origins.get(record.url_origin) ?? 0) + 1);
  }
  const byTenant = [...tenants.values()].sort((left, right) => right.events - left.events || left.tenant_id.localeCompare(right.tenant_id));
  const byOrigin = [...origins.entries()]
    .map(([url_origin, events]) => ({ url_origin, events }))
    .sort((left, right) => right.events - left.events || left.url_origin.localeCompare(right.url_origin));
  return { events: selected.length, totals, byTenant, byOrigin };
}

/** @param {any} value @returns {number} */
function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** @param {string} path @param {any} sqlite @returns {TelemetryStore} */
function createSqliteStore(path, sqlite) {
  const db = new sqlite.DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    url_origin TEXT NOT NULL,
    actions_indexed INTEGER NOT NULL,
    actions_executed INTEGER NOT NULL,
    execution_failures INTEGER NOT NULL,
    received_at TEXT NOT NULL
  )`);
  const insert = db.prepare('INSERT INTO telemetry (tenant_id, url_origin, actions_indexed, actions_executed, execution_failures, received_at) VALUES (?, ?, ?, ?, ?, ?)');
  return {
    mode: 'sqlite',
    file: path,
    async append(record) {
      insert.run(record.tenant_id, record.url_origin, record.actions_indexed, record.actions_executed, record.execution_failures, record.received_at);
    },
    async summarize(filter = {}) {
      const where = filter.tenant_id ? 'WHERE tenant_id = ?' : '';
      const args = filter.tenant_id ? [filter.tenant_id] : [];
      const rows = /** @type {any[]} */ (db.prepare(`SELECT tenant_id, url_origin, actions_indexed, actions_executed, execution_failures, received_at FROM telemetry ${where}`).all(...args));
      return summarizeRecords(rows.map(row => ({
        tenant_id: String(row.tenant_id),
        url_origin: String(row.url_origin),
        actions_indexed: asNumber(row.actions_indexed),
        actions_executed: asNumber(row.actions_executed),
        execution_failures: asNumber(row.execution_failures),
        received_at: String(row.received_at)
      })), filter);
    },
    async reset() {
      db.exec('DELETE FROM telemetry');
    },
    async close() {
      db.close();
    }
  };
}

/** @param {string} path @returns {TelemetryStore} */
function createLogStore(path) {
  /** @returns {Promise<TelemetryRecord[]>} */
  const readRecords = async () => {
    let text = '';
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return [];
    }
    /** @type {TelemetryRecord[]} */
    const records = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') {
          // Normalize the shape so a hand-edited or foreign line cannot inject
          // NaN into an aggregate.
          records.push({
            tenant_id: String(parsed.tenant_id ?? ''),
            url_origin: String(parsed.url_origin ?? ''),
            actions_indexed: asNumber(parsed.actions_indexed),
            actions_executed: asNumber(parsed.actions_executed),
            execution_failures: asNumber(parsed.execution_failures),
            received_at: String(parsed.received_at ?? '')
          });
        }
      } catch {
        // A torn final line (crash mid-append) is skipped rather than fatal.
      }
    }
    return records;
  };
  return {
    mode: 'log',
    file: path,
    async append(record) {
      await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
    },
    async summarize(filter = {}) {
      return summarizeRecords(await readRecords(), filter);
    },
    async reset() {
      await rm(path, { force: true });
    },
    async close() {
      // Nothing to release: every append is already durable.
    }
  };
}

/**
 * Open the telemetry store, preferring sqlite and falling back to the log.
 * @param {string} file
 * @returns {Promise<TelemetryStore>}
 */
export async function createStore(file) {
  const path = resolve(file);
  await mkdir(dirname(path), { recursive: true });
  const sqlite = await loadSqlite();
  return sqlite ? createSqliteStore(path, sqlite) : createLogStore(path);
}
