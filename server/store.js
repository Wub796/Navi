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
//
// Neither record type grows forever: `pruneViolations` drops audit rows past a
// retention window, deleting them in SQLite and compacting the log by streaming
// it to a temporary file and renaming over the original. Compaction is the one
// place the log is rewritten, so it is also the one place an id is made explicit:
// a pruned row must not renumber the rows around it.

import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

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
 * @typedef {{max_age_days: number, tenant_id?: string}} RetentionOptions
 * @typedef {{pruned_count: number, remaining_count: number}} PruneResult
 * @typedef {{mode: 'sqlite' | 'log', file: string, append(record: TelemetryRecord): Promise<void>, summarize(filter?: SummaryFilter): Promise<TelemetrySummary>, recordViolation(violation: ViolationInput): Promise<ContainmentViolation>, queryViolations(filter: ViolationFilter): Promise<ContainmentViolation[]>, pruneViolations(options: RetentionOptions): Promise<PruneResult>, reset(): Promise<void>, close(): Promise<void>}} TelemetryStore
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
  // Incremental auto-vacuum has to be chosen before the first table exists, so a
  // database this code creates reclaims the pages a prune frees; a file created
  // earlier keeps its own mode, and an operator reclaims it with VACUUM.
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
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
  // Compared as Julian days rather than as text: `created_at` is ISO-8601 with a
  // `T` separator and a `Z`, while `datetime()` renders a space and no zone, and
  // 'T' sorts above ' ' — so a text comparison would spare every row on the day
  // the cutoff falls in. julianday() parses both forms correctly.
  const deleteExpired = db.prepare("DELETE FROM containment_violations WHERE julianday(created_at) < julianday('now', '-' || ? || ' days')");
  const deleteExpiredForTenant = db.prepare("DELETE FROM containment_violations WHERE tenant_id = ? AND julianday(created_at) < julianday('now', '-' || ? || ' days')");
  const countViolations = db.prepare('SELECT COUNT(*) AS count FROM containment_violations');
  const countTenantViolations = db.prepare('SELECT COUNT(*) AS count FROM containment_violations WHERE tenant_id = ?');
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
    async append(record) {
      await serial(() => appendFile(path, `${JSON.stringify(record)}\n`, 'utf8'));
    },
    async summarize(filter = {}) {
      return summarizeRecords(await readRecords(), filter);
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
    async reset() {
      await serial(async () => {
        await rm(path, { force: true });
        violationSequence = null;
      });
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
