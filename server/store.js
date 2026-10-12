// Telemetry aggregate store.
//
// Aggregates are the only thing the ingestion path writes: no field values, no
// DOM, no user identifiers. Containment violations are the deliberate second
// record type: a refused destination is the one thing this service must be able
// to show a tenant afterwards, and a sanitized URL that was *not* visited is not
// page data. Persistence uses the runtime's own facilities so the service keeps
// the repository's zero-runtime-dependency rule:
//
//   * `node:sqlite` when the runtime provides it (Node 22.5+), which is the
//     preferred store and the one `server/telemetry.db` refers to;
//   * otherwise an append-only JSONL log at the same path, so the documented
//     `engines.node: ">=22.0.0"` range keeps working.
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
 * @typedef {{tenant_id: string, session_id?: string | null, category: string, target_url: string, resolved_ip?: string | null, created_at?: string}} ViolationInput
 * @typedef {{id: number, tenant_id: string, session_id: string | null, category: string, target_url: string, resolved_ip: string | null, created_at: string}} ContainmentViolation
 * @typedef {{tenant_id: string, limit?: number, since?: string}} ViolationFilter
 * @typedef {{mode: 'sqlite' | 'log', file: string, append(record: TelemetryRecord): Promise<void>, summarize(filter?: SummaryFilter): Promise<TelemetrySummary>, recordViolation(violation: ViolationInput): Promise<ContainmentViolation>, queryViolations(filter: ViolationFilter): Promise<ContainmentViolation[]>, reset(): Promise<void>, close(): Promise<void>}} TelemetryStore
 */

/** Default number of violation rows one query returns. */
export const DEFAULT_VIOLATION_LIMIT = 50;
/** Hard ceiling on violation rows per query, so an audit read stays bounded. */
export const MAX_VIOLATION_LIMIT = 200;
/** Discriminator that separates a violation line from an aggregate line. */
export const VIOLATION_KIND = 'containment_violation';

/**
 * Clamp a caller-supplied row limit. The route rejects an out-of-range limit
 * with a named error, so this only guards a direct store caller.
 * @param {unknown} value @returns {number}
 */
function normalizeLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_VIOLATION_LIMIT;
  return Math.min(MAX_VIOLATION_LIMIT, Math.max(1, Math.trunc(number)));
}

/**
 * Validate one violation and give it a timestamp. Required fields throw rather
 * than being defaulted: a row with no category is not a containment record, and
 * silently storing one would corrupt the audit a tenant reads back.
 * @param {ViolationInput} violation @returns {Required<ViolationInput>}
 */
function normalizeViolation(violation) {
  const tenantId = typeof violation?.tenant_id === 'string' ? violation.tenant_id.trim() : '';
  const category = typeof violation?.category === 'string' ? violation.category.trim() : '';
  const targetUrl = typeof violation?.target_url === 'string' ? violation.target_url.trim() : '';
  if (!tenantId) throw new TypeError('recordViolation needs a tenant_id');
  if (!category) throw new TypeError('recordViolation needs a category');
  if (!targetUrl) throw new TypeError('recordViolation needs a target_url');
  const sessionId = typeof violation.session_id === 'string' && violation.session_id.length ? violation.session_id : null;
  const resolvedIp = typeof violation.resolved_ip === 'string' && violation.resolved_ip.length ? violation.resolved_ip : null;
  const createdAt = typeof violation.created_at === 'string' && violation.created_at.length ? violation.created_at : new Date().toISOString();
  return { tenant_id: tenantId, session_id: sessionId, category, target_url: targetUrl, resolved_ip: resolvedIp, created_at: createdAt };
}

/**
 * Resolve `node:sqlite` without a static import. It only exists from Node 22.5,
 * so it is absent across part of the supported engines range, and a static import
 * would break that range at module load rather than degrading to the log.
 * @returns {Promise<any>}
 */
async function loadSqlite() {
  // node:sqlite emits an ExperimentalWarning throughout Node 22. Select the
  // existing durable log backend on this supported runtime, without suppressing
  // warnings; newer runtimes may use SQLite once the module is stable.
  if (Number(process.versions.node.split('.')[0]) === 22) return null;
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
  // Refusals live in their own table rather than in the aggregate table: an
  // audit question ("what did this tenant try to reach?") and a metric question
  // ("how many controls were indexed?") must not be able to skew each other.
  db.exec(`CREATE TABLE IF NOT EXISTS containment_violations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    session_id TEXT,
    category TEXT NOT NULL,
    target_url TEXT NOT NULL,
    resolved_ip TEXT,
    created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_violations_tenant_created ON containment_violations(tenant_id, created_at)');
  const insert = db.prepare('INSERT INTO telemetry (tenant_id, url_origin, actions_indexed, actions_executed, execution_failures, received_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insertViolation = db.prepare('INSERT INTO containment_violations (tenant_id, session_id, category, target_url, resolved_ip, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const lastViolationId = db.prepare('SELECT last_insert_rowid() AS id');
  // An empty `since` sorts before every ISO-8601 timestamp, so one prepared
  // statement serves both the bounded and the unbounded read.
  const selectViolations = db.prepare('SELECT id, tenant_id, session_id, category, target_url, resolved_ip, created_at FROM containment_violations WHERE tenant_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?');
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
    async recordViolation(violation) {
      const record = normalizeViolation(violation);
      insertViolation.run(record.tenant_id, record.session_id, record.category, record.target_url, record.resolved_ip, record.created_at);
      const row = /** @type {{id?: unknown}} */ (lastViolationId.get());
      return { id: asNumber(row?.id), ...record };
    },
    async queryViolations(filter) {
      const rows = /** @type {any[]} */ (selectViolations.all(filter.tenant_id, filter.since ?? '', normalizeLimit(filter.limit)));
      return rows.map(row => ({
        id: asNumber(row.id),
        tenant_id: String(row.tenant_id),
        session_id: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
        category: String(row.category),
        target_url: String(row.target_url),
        resolved_ip: row.resolved_ip === null || row.resolved_ip === undefined ? null : String(row.resolved_ip),
        created_at: String(row.created_at)
      }));
    },
    async reset() {
      db.exec('DELETE FROM telemetry');
      db.exec('DELETE FROM containment_violations');
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
          // Violation lines share the file but not the shape: counting one as a
          // beacon would add a phantom event with zero actions to every summary.
          if (parsed.kind === VIOLATION_KIND) continue;
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
  /** Violations in append order, numbered the way the file's id column would be.
   * @returns {Promise<ContainmentViolation[]>} */
  const readViolations = async () => {
    let text = '';
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return [];
    }
    /** @type {ContainmentViolation[]} */
    const violations = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object' || parsed.kind !== VIOLATION_KIND) continue;
        violations.push({
          id: violations.length + 1,
          tenant_id: String(parsed.tenant_id ?? ''),
          session_id: typeof parsed.session_id === 'string' && parsed.session_id.length ? parsed.session_id : null,
          category: String(parsed.category ?? ''),
          target_url: String(parsed.target_url ?? ''),
          resolved_ip: typeof parsed.resolved_ip === 'string' && parsed.resolved_ip.length ? parsed.resolved_ip : null,
          created_at: String(parsed.created_at ?? '')
        });
      } catch {
        // A torn final line is skipped rather than fatal, as for aggregates.
      }
    }
    return violations;
  };
  /** Ids continue from what the file already holds, so a restart does not reuse
   * the position a reader already ordered by. One process owns the file, which is
   * how this backend is deployed; a second writer is not supported.
   * @type {number | null} */
  let violationSequence = null;
  const nextViolationId = async () => {
    if (violationSequence === null) violationSequence = (await readViolations()).length;
    violationSequence += 1;
    return violationSequence;
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
    async recordViolation(violation) {
      const record = normalizeViolation(violation);
      // The id is claimed before the append, because the seed reads the file: the
      // id returned here must be the one a later read assigns to this line.
      const id = await nextViolationId();
      // The line is the durable write: it is appended before this resolves, so
      // the caller's 202 means the record survived the process.
      await appendFile(path, `${JSON.stringify({ kind: VIOLATION_KIND, ...record })}\n`, 'utf8');
      return { id, ...record };
    },
    async queryViolations(filter) {
      const selected = (await readViolations()).filter(violation => violation.tenant_id === filter.tenant_id && violation.created_at >= (filter.since ?? ''));
      const ordered = selected.sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id - left.id);
      return ordered.slice(0, normalizeLimit(filter.limit));
    },
    async reset() {
      await rm(path, { force: true });
      violationSequence = null;
    },
    async close() {
      // Nothing to release: every append is already durable.
    }
  };
}

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
 * @returns {Promise<TelemetryStore>}
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
  return sqlite ? createSqliteStore(path, sqlite) : createLogStore(path);
}
