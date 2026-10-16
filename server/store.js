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
// which one is active.
//
// Which one serves an existing path is decided by the file's own bytes and not by
// the runtime that happens to be running: both backends share one path, so a
// runtime that gains `node:sqlite` must not reopen an operator's JSONL log as a
// database, and one that lacks it must not read a database as an empty log. See
// `storeFormat`.
//
// Neither record type grows forever: `pruneViolations` drops audit rows past a
// retention window, deleting them in SQLite and compacting the log by streaming
// it to a temporary file and renaming over the original. Compaction is the one
// place the log is rewritten, so it is also the one place an id is made explicit:
// a pruned row must not renumber the rows around it.

import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * @typedef {{tenant_id: string, url_origin: string, actions_indexed: number, actions_executed: number, execution_failures: number, received_at: string}} TelemetryRecord
 * @typedef {{actions_indexed: number, actions_executed: number, execution_failures: number}} TelemetryTotals
 * @typedef {{tenant_id: string, events: number, actions_indexed: number, actions_executed: number, execution_failures: number}} TenantBucket
 * @typedef {{url_origin: string, events: number}} OriginBucket
 * @typedef {{events: number, totals: TelemetryTotals, byTenant: TenantBucket[], byOrigin: OriginBucket[]}} TelemetrySummary
 * @typedef {{tenant_id?: string}} SummaryFilter
 * @typedef {{site_id: string, url: string, payload: object, updated_at: string}} NavigationMapRecord
 * @typedef {{tenant_id: string, session_id?: string | null, category: string, target_url: string, resolved_ip?: string | null, created_at?: string}} ViolationInput
 * @typedef {{id: number, tenant_id: string, session_id: string | null, category: string, target_url: string, resolved_ip: string | null, created_at: string}} ContainmentViolation
 * @typedef {{tenant_id: string, limit?: number, since?: string}} ViolationFilter
 * @typedef {{max_age_days: number, tenant_id?: string}} RetentionOptions
 * @typedef {{pruned_count: number, remaining_count: number}} PruneResult
 * @typedef {{busy: number, log: number, checkpointed: number}} CheckpointResult
 * @typedef {{truncate?: boolean}} CheckpointOptions
 * @typedef {{journal_mode: string, synchronous: number, auto_vacuum: number}} StorePragmas
 * @typedef {{tenant_id: string, max_events_per_window: number, window_seconds?: number}} QuotaOptions
 * @typedef {{allowed: boolean, count: number, remaining: number, retry_after_seconds: number}} QuotaVerdict
 * @typedef {{mode: 'sqlite' | 'log', file: string, pragmas: StorePragmas | null, append(record: TelemetryRecord): Promise<void>, summarize(filter?: SummaryFilter): Promise<TelemetrySummary>, upsertNavigationMap(siteId: string, url: string, payload: object): Promise<void>, readNavigationMap(siteId: string, url: string): Promise<NavigationMapRecord | null>, consumeQuota(options: QuotaOptions): Promise<QuotaVerdict>, recordViolation(violation: ViolationInput): Promise<ContainmentViolation>, queryViolations(filter: ViolationFilter): Promise<ContainmentViolation[]>, pruneViolations(options: RetentionOptions): Promise<PruneResult>, checkpoint(options?: CheckpointOptions): Promise<CheckpointResult>, reset(): Promise<void>, close(): Promise<void>}} TelemetryStore
 */

/** Default number of violation rows one query returns. */
export const DEFAULT_VIOLATION_LIMIT = 50;
/** Hard ceiling on violation rows per query, so an audit read stays bounded. */
export const MAX_VIOLATION_LIMIT = 200;
/** Discriminator that separates a violation line from an aggregate line. */
export const VIOLATION_KIND = 'containment_violation';
/**
 * Discriminator for the single log-mode line that records the highest violation
 * id the file has ever carried. Without it, compacting away the newest rows
 * would let the next append reuse an id a reader had already been handed.
 */
export const STORE_META_KIND = 'navi_store_meta';
/** Default retention window for containment violations, in days. */
export const DEFAULT_RETENTION_DAYS = 30;
/**
 * Longest retention window a caller may name, in days. Bounded because SQLite's
 * date modifier returns NULL for a value it cannot parse, and a NULL comparison
 * deletes nothing at all — a silent no-op is worse than a refusal.
 */
export const MAX_RETENTION_DAYS = 36500;

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
 * Validate a retention window. It is a duration, not a request: a caller that
 * asks to delete everything by passing zero or a negative number is refused
 * rather than obeyed, because "prune everything" is never what was meant.
 * @param {RetentionOptions} options @returns {{days: number, tenant_id: string | null}}
 */
function normalizeRetention(options) {
  const days = Number(options?.max_age_days);
  if (!Number.isFinite(days) || days <= 0) throw new TypeError('pruneViolations needs a positive max_age_days');
  if (days > MAX_RETENTION_DAYS) throw new TypeError(`pruneViolations accepts at most ${MAX_RETENTION_DAYS} days`);
  const tenantId = typeof options?.tenant_id === 'string' && options.tenant_id.length ? options.tenant_id : null;
  return { days, tenant_id: tenantId };
}

/**
 * The instant a retention window starts at, as the ISO-8601 string the log
 * backend stores. Both the log's comparison and SQLite's `julianday()` measure
 * the same window; only the representation differs.
 * @param {number} days @returns {string}
 */
function retentionCutoff(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

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
  // Write-ahead logging is the mode this store is built around: an append, a
  // prune and a checkpoint stop serializing behind a rollback journal, and a
  // reader never blocks the writer. `synchronous = NORMAL` is the documented
  // pairing for it - a process crash is still survivable without paying for a
  // file sync on every commit, which is what an ingestion route cannot afford.
  // Incremental auto-vacuum has to be chosen before the first table exists, and it
  // has to be chosen before the journal switches to WAL as well: with WAL already
  // on, this pragma is accepted and ignored, and a store that quietly stopped
  // reclaiming the pages a prune frees is a leak no operator can see. The order of
  // the two statements is the difference, so `tests/host-metrics-lifecycle.spec.mjs`
  // reads the mode back rather than trusting it. A file created by an earlier
  // version keeps the mode it was created with; VACUUM is the operator's tool.
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  // Read back rather than restated, because the two pragmas have different
  // scopes: `journal_mode` is recorded in the file, while `synchronous` is a
  // property of *this* connection and cannot be observed from any other one. An
  // operator asking a store how durable its writes are has to ask here.
  const pragmas = Object.freeze({
    journal_mode: String(db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '').toLowerCase(),
    synchronous: asNumber(db.prepare('PRAGMA synchronous').get()?.synchronous),
    auto_vacuum: asNumber(db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum)
  });
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
  db.exec(`CREATE TABLE IF NOT EXISTS navigation_maps (
    site_id TEXT NOT NULL,
    url TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (site_id, url)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS tenant_quotas (
    tenant_id TEXT PRIMARY KEY,
    window_start_ms INTEGER NOT NULL,
    event_count INTEGER NOT NULL
  )`);
  const upsertNavigationMap = db.prepare('INSERT INTO navigation_maps (site_id, url, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(site_id, url) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at');
  const selectNavigationMap = db.prepare('SELECT site_id, url, payload, updated_at FROM navigation_maps WHERE site_id = ? AND url = ?');
  const selectTenantQuota = db.prepare('SELECT window_start_ms, event_count FROM tenant_quotas WHERE tenant_id = ?');
  const upsertTenantQuota = db.prepare('INSERT INTO tenant_quotas (tenant_id, window_start_ms, event_count) VALUES (?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET window_start_ms = excluded.window_start_ms, event_count = excluded.event_count');
  const insert = db.prepare('INSERT INTO telemetry (tenant_id, url_origin, actions_indexed, actions_executed, execution_failures, received_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insertViolation = db.prepare('INSERT INTO containment_violations (tenant_id, session_id, category, target_url, resolved_ip, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const lastViolationId = db.prepare('SELECT last_insert_rowid() AS id');
  // An empty `since` sorts before every ISO-8601 timestamp, so one prepared
  // statement serves both the bounded and the unbounded read.
  const selectViolations = db.prepare('SELECT id, tenant_id, session_id, category, target_url, resolved_ip, created_at FROM containment_violations WHERE tenant_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?');
  // Compared as Julian days rather than as text: `created_at` is ISO-8601 with a
  // `T` separator and a `Z`, while `datetime()` renders a space and no zone, and
  // 'T' sorts above ' ' — so a text comparison would spare every row on the day
  // the cutoff falls in. julianday() parses both forms correctly.
  const deleteExpired = db.prepare("DELETE FROM containment_violations WHERE julianday(created_at) < julianday('now', '-' || ? || ' days')");
  const deleteExpiredForTenant = db.prepare("DELETE FROM containment_violations WHERE tenant_id = ? AND julianday(created_at) < julianday('now', '-' || ? || ' days')");
  const countViolations = db.prepare('SELECT COUNT(*) AS count FROM containment_violations');
  const countTenantViolations = db.prepare('SELECT COUNT(*) AS count FROM containment_violations WHERE tenant_id = ?');
  let closed = false;
  return {
    mode: 'sqlite',
    file: path,
    pragmas,
    async append(record) {
      insert.run(record.tenant_id, record.url_origin, record.actions_indexed, record.actions_executed, record.execution_failures, record.received_at);
    },
    async upsertNavigationMap(siteId, url, payload) {
      upsertNavigationMap.run(siteId, url, JSON.stringify(payload), new Date().toISOString());
    },
    async readNavigationMap(siteId, url) {
      const row = /** @type {{site_id?: unknown, url?: unknown, payload?: unknown, updated_at?: unknown} | undefined} */ (selectNavigationMap.get(siteId, url));
      if (!row) return null;
      return { site_id: String(row.site_id), url: String(row.url), payload: JSON.parse(String(row.payload)), updated_at: String(row.updated_at) };
    },
    async consumeQuota(options) {
      const tenantId = String(options.tenant_id);
      const maxEvents = Math.max(1, Math.trunc(Number(options.max_events_per_window)));
      const windowMs = Math.max(1000, Math.trunc(Number(options.window_seconds ?? 3600)) * 1000);
      const now = Date.now();
      const row = /** @type {{window_start_ms?: unknown, event_count?: unknown} | undefined} */ (selectTenantQuota.get(tenantId));
      const prevStart = row ? asNumber(row.window_start_ms) : 0;
      const prevCount = row ? asNumber(row.event_count) : 0;
      const expired = !row || now - prevStart >= windowMs;
      const windowStart = expired ? now : prevStart;
      const currentCount = expired ? 0 : prevCount;
      if (currentCount >= maxEvents) {
        const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
        return { allowed: false, count: currentCount, remaining: 0, retry_after_seconds: retryAfterSeconds };
      }
      const nextCount = currentCount + 1;
      upsertTenantQuota.run(tenantId, windowStart, nextCount);
      return { allowed: true, count: nextCount, remaining: Math.max(0, maxEvents - nextCount), retry_after_seconds: 0 };
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
    async pruneViolations(options) {
      const { days, tenant_id } = normalizeRetention(options);
      const removed = tenant_id ? deleteExpiredForTenant.run(tenant_id, days) : deleteExpired.run(days);
      const pruned = asNumber(/** @type {{changes?: unknown}} */ (removed)?.changes);
      if (pruned > 0) {
        // Best effort: the delete has already committed, so a database that cannot
        // vacuum must not turn a successful prune into an error. On a database whose
        // auto-vacuum is not incremental this is a no-op, and VACUUM is the
        // operator's tool.
        try { db.exec('PRAGMA incremental_vacuum'); } catch { /* pages stay on the freelist for reuse */ }
      }
      const row = /** @type {{count?: unknown}} */ ((tenant_id ? countTenantViolations.get(tenant_id) : countViolations.get()));
      return { pruned_count: pruned, remaining_count: asNumber(row?.count) };
    },
    async checkpoint(options = {}) {
      // The mode is chosen by a switch rather than interpolated from the caller: a
      // PRAGMA argument cannot be bound, so anything caller-supplied would be SQL.
      const statement = db.prepare(options?.truncate === false ? 'PRAGMA wal_checkpoint(PASSIVE)' : 'PRAGMA wal_checkpoint(TRUNCATE)');
      const row = /** @type {{busy?: unknown, log?: unknown, checkpointed?: unknown} | undefined} */ (statement.get()) ?? {};
      return { busy: asNumber(row.busy), log: asNumber(row.log), checkpointed: asNumber(row.checkpointed) };
    },
    async reset() {
      db.exec('DELETE FROM telemetry');
      db.exec('DELETE FROM containment_violations');
      db.exec('DELETE FROM navigation_maps');
      db.exec('DELETE FROM tenant_quotas');
    },
    async close() {
      if (closed) return;
      closed = true;
      // Always release the connection, but a failed/busy checkpoint must remain
      // visible to the owner: swallowing it would permit a false clean marker.
      try {
        const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (asNumber(row?.busy) !== 0) throw new Error('store close checkpoint was busy');
      } finally {
        db.close();
      }
    }
  };
}

/** @param {string} path @returns {TelemetryStore} */
function createLogStore(path) {
  /**
   * One pass over the whole file. Aggregates, violations and the id high-water
   * mark are read together because a rewrite has to know about all three at once.
   * @returns {Promise<{records: TelemetryRecord[], violations: ContainmentViolation[], sequence: number}>}
   */
  const scanLog = async () => {
    let text = '';
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return { records: [], violations: [], sequence: 0 };
    }
    /** @type {TelemetryRecord[]} */
    const records = [];
    /** @type {ContainmentViolation[]} */
    const violations = [];
    let sequence = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      /** @type {any} */
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A torn final line (crash mid-append) is skipped rather than fatal.
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.kind === 'navigation_map' || parsed.kind === 'tenant_quota') continue;
      if (parsed.kind === STORE_META_KIND) {
        sequence = Math.max(sequence, asNumber(parsed.violation_sequence));
        continue;
      }
      if (parsed.kind === VIOLATION_KIND) {
        // Position is the id of a line written before ids were made explicit; an
        // explicit id wins, which is what lets a compaction preserve them.
        const id = Number.isSafeInteger(parsed.id) && parsed.id > 0 ? Number(parsed.id) : violations.length + 1;
        sequence = Math.max(sequence, id);
        violations.push({
          id,
          tenant_id: String(parsed.tenant_id ?? ''),
          session_id: typeof parsed.session_id === 'string' && parsed.session_id.length ? parsed.session_id : null,
          category: String(parsed.category ?? ''),
          target_url: String(parsed.target_url ?? ''),
          resolved_ip: typeof parsed.resolved_ip === 'string' && parsed.resolved_ip.length ? parsed.resolved_ip : null,
          created_at: String(parsed.created_at ?? '')
        });
        continue;
      }
      // Normalize the shape so a hand-edited or foreign line cannot inject NaN
      // into an aggregate. A violation line is separated above rather than here:
      // counting one as a beacon would add a phantom event with zero actions.
      records.push({
        tenant_id: String(parsed.tenant_id ?? ''),
        url_origin: String(parsed.url_origin ?? ''),
        actions_indexed: asNumber(parsed.actions_indexed),
        actions_executed: asNumber(parsed.actions_executed),
        execution_failures: asNumber(parsed.execution_failures),
        received_at: String(parsed.received_at ?? '')
      });
    }
    return { records, violations, sequence };
  };
  /** @returns {Promise<TelemetryRecord[]>} */
  const readRecords = async () => (await scanLog()).records;
  /** Violations in append order, each carrying the id it was written under.
   * @returns {Promise<ContainmentViolation[]>} */
  const readViolations = async () => (await scanLog()).violations;
  /** Ids continue from what the file already holds, so a restart does not reuse
   * the position a reader already ordered by — and after a compaction the mark
   * comes from the metadata line, so it does not reuse the id of a pruned row
   * either. One process owns the file, which is how this backend is deployed; a
   * second writer is not supported.
   * @type {number | null} */
  let violationSequence = null;
  const nextViolationId = async () => {
    if (violationSequence === null) violationSequence = (await scanLog()).sequence;
    violationSequence += 1;
    return violationSequence;
  };
  /**
   * Mutations run one at a time. Compaction replaces the file with a renamed
   * temporary, so an append that interleaved with it could be written to a file
   * the rename discards; serializing is what makes "an append lands either before
   * the rewrite or after it" true. Reads are deliberately not queued: the original
   * is untouched until the rename, so a reader sees the old file or the new one
   * whole, never a mixture.
   */
  let tail = Promise.resolve();
  /** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
  const serial = task => {
    const next = tail.then(task, task);
    tail = next.then(() => {}, () => {});
    return next;
  };
  return {
    mode: 'log',
    file: path,
    // A log has no connection and no journal, so there is no durability posture to
    // report; the field is present so a caller never has to branch on the backend.
    pragmas: null,
    async append(record) {
      await serial(() => appendFile(path, `${JSON.stringify(record)}\n`, 'utf8'));
    },
    async summarize(filter = {}) {
      return summarizeRecords(await readRecords(), filter);
    },
    async upsertNavigationMap(siteId, url, payload) {
      const record = { kind: 'navigation_map', site_id: siteId, url, payload, updated_at: new Date().toISOString() };
      await serial(() => appendFile(path, `${JSON.stringify(record)}\n`, 'utf8'));
    },
    async readNavigationMap(siteId, url) {
      const text = await readFile(path, 'utf8').catch(() => '');
      for (const line of text.split('\n').reverse()) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.kind === 'navigation_map' && record.site_id === siteId && record.url === url) {
            return { site_id: siteId, url, payload: record.payload, updated_at: record.updated_at };
          }
        } catch { /* ignore torn and malformed lines */ }
      }
      return null;
    },
    async consumeQuota(options) {
      const tenantId = String(options.tenant_id);
      const maxEvents = Math.max(1, Math.trunc(Number(options.max_events_per_window)));
      const windowMs = Math.max(1000, Math.trunc(Number(options.window_seconds ?? 3600)) * 1000);
      return serial(async () => {
        const now = Date.now();
        const text = await readFile(path, 'utf8').catch(() => '');
        let prevStart = 0;
        let prevCount = 0;
        let found = false;
        for (const line of text.split('\n').reverse()) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            if (record.kind === 'tenant_quota' && record.tenant_id === tenantId) {
              prevStart = asNumber(record.window_start_ms);
              prevCount = asNumber(record.event_count);
              found = true;
              break;
            }
          } catch { /* ignore torn lines */ }
        }
        const expired = !found || now - prevStart >= windowMs;
        const windowStart = expired ? now : prevStart;
        const currentCount = expired ? 0 : prevCount;
        if (currentCount >= maxEvents) {
          const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
          return { allowed: false, count: currentCount, remaining: 0, retry_after_seconds: retryAfterSeconds };
        }
        const nextCount = currentCount + 1;
        await appendFile(path, `${JSON.stringify({ kind: 'tenant_quota', tenant_id: tenantId, window_start_ms: windowStart, event_count: nextCount })}\n`, 'utf8');
        return { allowed: true, count: nextCount, remaining: Math.max(0, maxEvents - nextCount), retry_after_seconds: 0 };
      });
    },
    async recordViolation(violation) {
      const record = normalizeViolation(violation);
      return serial(async () => {
        // The id is claimed before the append, because the seed reads the file: the
        // id returned here must be the one a later read assigns to this line.
        const id = await nextViolationId();
        // The line is the durable write: it is appended before this resolves, so
        // the caller's 202 means the record survived the process. The id travels in
        // the line so that compaction can keep it.
        await appendFile(path, `${JSON.stringify({ kind: VIOLATION_KIND, id, ...record })}\n`, 'utf8');
        return { id, ...record };
      });
    },
    async queryViolations(filter) {
      const selected = (await readViolations()).filter(violation => violation.tenant_id === filter.tenant_id && violation.created_at >= (filter.since ?? ''));
      const ordered = selected.sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id - left.id);
      return ordered.slice(0, normalizeLimit(filter.limit));
    },
    async pruneViolations(options) {
      const { days, tenant_id } = normalizeRetention(options);
      return serial(async () => {
        try {
          await stat(path);
        } catch {
          // Nothing has been written yet, so there is nothing to compact and no
          // file to create for the sake of a prune.
          return { pruned_count: 0, remaining_count: 0 };
        }
        const cutoff = retentionCutoff(days);
        const temporary = `${path}.compacting`;
        const output = createWriteStream(temporary);
        /** @type {Error | null} */
        let failure = null;
        /** The one pending wait, released by 'drain', 'finish' or 'error'.
         * @type {(() => void) | null} */
        let notify = null;
        const release = () => { const done = notify; notify = null; done?.(); };
        for (const event of ['drain', 'finish']) output.on(event, release);
        output.on('error', error => { failure = error; release(); });
        const wait = () => new Promise(/** @param {(value?: unknown) => void} resolve */ resolve => { notify = () => resolve(); });
        /** @param {string} line */
        const write = async line => {
          if (failure) throw failure;
          if (!output.write(`${line}\n`)) {
            await wait();
            if (failure) throw failure;
          }
        };
        let pruned = 0;
        let kept = 0;
        let keptForTenant = 0;
        let seen = 0;
        let sequence = 0;
        try {
          const input = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
          for await (const line of input) {
            if (!line.trim()) continue;
            /** @type {any} */
            let parsed;
            try {
              parsed = JSON.parse(line);
            } catch {
              // Compaction is where a torn line stops being re-read forever.
              continue;
            }
            if (!parsed || typeof parsed !== 'object') continue;
            if (parsed.kind === 'navigation_map' || parsed.kind === 'tenant_quota') continue;
            if (parsed.kind === STORE_META_KIND) {
              // The old mark is superseded by the one written at the end, which
              // carries whatever this file has seen since.
              sequence = Math.max(sequence, asNumber(parsed.violation_sequence));
              continue;
            }
            if (parsed.kind === VIOLATION_KIND) {
              seen += 1;
              const id = Number.isSafeInteger(parsed.id) && parsed.id > 0 ? Number(parsed.id) : seen;
              sequence = Math.max(sequence, id);
              const expired = String(parsed.created_at ?? '') < cutoff;
              const inScope = tenant_id === null || String(parsed.tenant_id ?? '') === tenant_id;
              if (expired && inScope) { pruned += 1; continue; }
              kept += 1;
              if (inScope) keptForTenant += 1;
              // The id becomes explicit here, so the rows that survive a prune keep
              // the id a reader already holds for them.
              await write(JSON.stringify({ ...parsed, kind: VIOLATION_KIND, id }));
              continue;
            }
            // Aggregates are copied verbatim: compaction prunes violations, not events.
            await write(line);
          }
          // Written last because it describes everything above it, and only when
          // there is a mark worth keeping: a file of aggregates alone stays as it is.
          if (sequence > 0) await write(JSON.stringify({ kind: STORE_META_KIND, violation_sequence: sequence }));
          const finished = wait();
          output.end();
          await finished;
          if (failure) throw failure;
          // The rename is the commit: a reader sees the old file or the new one.
          await rename(temporary, path);
        } catch (error) {
          output.destroy();
          await rm(temporary, { force: true });
          throw error;
        }
        violationSequence = sequence;
        return { pruned_count: pruned, remaining_count: tenant_id === null ? kept : keptForTenant };
      });
    },
    async checkpoint() {
      // A log has no journal to checkpoint. The shape is answered with zeros so a
      // caller never has to branch on which backend resolved.
      return { busy: 0, log: 0, checkpointed: 0 };
    },
    async reset() {
      await serial(async () => {
        await rm(path, { force: true });
        violationSequence = null;
      });
    },
    async close() {
      // Join queued writes/compaction before the owner can mark its stop clean.
      await tail;
    }
  };
}

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
