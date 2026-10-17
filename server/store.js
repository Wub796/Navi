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
 * @typedef {{tenant_id: string, window_start_ms: number, event_count: number}} QuotaState
 * @typedef {{tenant_id: string, api_key: string, allowed_origins: string[], max_events_per_window: number, window_seconds: number, status: 'active' | 'suspended', updated_at: string}} TenantDefinitionRecord
 * @typedef {{tenant_id: string, api_key: string, allowed_origins?: string[], max_events_per_window?: number, window_seconds?: number, status?: 'active' | 'suspended'}} TenantDefinitionInput
 * @typedef {{session_id: string, tenant_id: string, api_key: string, expires_at_ms?: number}} CheckoutClaimInput
 * @typedef {{session_id: string, tenant_id: string, api_key: string, expires_at_ms: number}} CheckoutClaimRecord
 * @typedef {{event_id?: string | null, received_at_ms?: number, definition?: TenantDefinitionInput | null, checkout_claim?: CheckoutClaimInput | null}} WebhookMutationInput
 * @typedef {{duplicate: boolean, record: TenantDefinitionRecord | null}} WebhookMutationResult
 * @typedef {{mode: 'sqlite' | 'log', file: string, pragmas: StorePragmas | null, append(record: TelemetryRecord): Promise<void>, summarize(filter?: SummaryFilter): Promise<TelemetrySummary>, upsertNavigationMap(siteId: string, url: string, payload: object): Promise<void>, readNavigationMap(siteId: string, url: string): Promise<NavigationMapRecord | null>, consumeQuota(options: QuotaOptions): Promise<QuotaVerdict>, readQuota(tenantId: string): Promise<QuotaState | null>, upsertTenantDefinition(definition: TenantDefinitionInput): Promise<TenantDefinitionRecord>, readTenantDefinition(tenantId: string): Promise<TenantDefinitionRecord | null>, readTenantDefinitions(): Promise<TenantDefinitionRecord[]>, recordWebhookEvent(eventId: string, receivedAtMs?: number): Promise<boolean>, releaseWebhookEvent(eventId: string): Promise<void>, applyWebhookEvent(mutation: WebhookMutationInput): Promise<WebhookMutationResult>, recordCheckoutClaim(claim: CheckoutClaimInput): Promise<CheckoutClaimRecord>, consumeCheckoutClaim(sessionId: string, nowMs?: number): Promise<{tenant_id: string, api_key: string} | null>, recordViolation(violation: ViolationInput): Promise<ContainmentViolation>, queryViolations(filter: ViolationFilter): Promise<ContainmentViolation[]>, pruneViolations(options: RetentionOptions): Promise<PruneResult>, checkpoint(options?: CheckpointOptions): Promise<CheckpointResult>, reset(): Promise<void>, close(): Promise<void>}} TelemetryStore
 */

/** Default number of violation rows one query returns. */
export const DEFAULT_VIOLATION_LIMIT = 50;
/** Hard ceiling on violation rows per query, so an audit read stays bounded. */
export const MAX_VIOLATION_LIMIT = 200;
/** Discriminator that separates a violation line from an aggregate line. */
export const VIOLATION_KIND = 'containment_violation';
/**
 * Discriminator for one processed billing event. Stripe retries a delivery it did
 * not see acknowledged, and a retry must not provision or suspend a tenant twice;
 * this line is the ledger that makes a second delivery answer `duplicate`.
 */
export const WEBHOOK_EVENT_KIND = 'webhook_event';
/**
 * Withdraws a claim made by `recordWebhookEvent`.
 *
 * A claim is taken before the event is acted on, because two simultaneous
 * deliveries must not both act. That ordering owes a compensation: a delivery that
 * ended in an error is one Stripe will resend, and leaving the claim behind would
 * turn the resend into a silent no-op. The append-only log needs an explicit
 * release line; SQLite deletes the row.
 */
export const WEBHOOK_EVENT_RELEASE_KIND = 'webhook_event_release';
/**
 * Retention window for the webhook event-id ledger, in milliseconds (24 hours).
 * Well beyond the 300-second `Stripe-Signature` replay window, so any replay
 * past this horizon is already rejected at HMAC timestamp verification.
 */
export const WEBHOOK_EVENT_TTL_MS = 86_400_000;
/**
 * Default validity window for a one-time post-checkout API-key claim, in
 * milliseconds (15 minutes).
 */
export const CHECKOUT_CLAIM_TTL_MS = 900_000;
/** Discriminator for a stored post-checkout claim in the log backend. */
export const CHECKOUT_CLAIM_KIND = 'checkout_claim';
/** Discriminator that marks a post-checkout claim consumed in the log backend. */
export const CHECKOUT_CLAIM_CONSUMED_KIND = 'checkout_claim_consumed';
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
 * Validate a provisioned tenant definition and give it a timestamp.
 *
 * A ceiling of `0` is kept rather than defaulted away: it is how a revoked
 * subscription is represented, and normalizing it to the default would turn a
 * suspension back into a live plan. Only a missing or unusable value falls back
 * to the documented default.
 * @param {TenantDefinitionInput} input @returns {TenantDefinitionRecord}
 */
function normalizeTenantDefinition(input) {
  const tenantId = typeof input?.tenant_id === 'string' ? input.tenant_id.trim() : '';
  const apiKey = typeof input?.api_key === 'string' ? input.api_key.trim() : '';
  if (!tenantId) throw new TypeError('upsertTenantDefinition needs a tenant_id');
  if (!apiKey) throw new TypeError('upsertTenantDefinition needs an api_key');
  const origins = Array.isArray(input?.allowed_origins)
    ? input.allowed_origins.filter((/** @type {unknown} */ item) => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    : [];
  const maxEvents = Number.isInteger(input?.max_events_per_window) && Number(input.max_events_per_window) >= 0 ? Number(input.max_events_per_window) : 10000;
  const windowSeconds = Number.isInteger(input?.window_seconds) && Number(input.window_seconds) > 0 ? Number(input.window_seconds) : 2592000;
  return {
    tenant_id: tenantId,
    api_key: apiKey,
    allowed_origins: origins.length > 0 ? origins : ['*'],
    max_events_per_window: maxEvents,
    window_seconds: windowSeconds,
    status: input?.status === 'suspended' ? 'suspended' : 'active',
    updated_at: new Date().toISOString()
  };
}

/**
 * Validate one event id for the billing ledger. An empty id is refused rather
 * than silently treated as "new": every retry would then re-run the event.
 * @param {unknown} eventId @param {unknown} [receivedAtMs] @returns {{event_id: string, received_at_ms: number}}
 */
function normalizeWebhookEvent(eventId, receivedAtMs) {
  const id = typeof eventId === 'string' ? eventId.trim() : '';
  if (!id) throw new TypeError('recordWebhookEvent needs an event_id');
  const received = Number.isSafeInteger(receivedAtMs) && Number(receivedAtMs) >= 0 ? Number(receivedAtMs) : Date.now();
  return { event_id: id, received_at_ms: received };
}

/**
 * Validate a one-time post-checkout API-key claim.
 * @param {CheckoutClaimInput} input @returns {CheckoutClaimRecord}
 */
function normalizeCheckoutClaim(input) {
  const sessionId = typeof input?.session_id === 'string' ? input.session_id.trim() : '';
  const tenantId = typeof input?.tenant_id === 'string' ? input.tenant_id.trim() : '';
  const apiKey = typeof input?.api_key === 'string' ? input.api_key.trim() : '';
  if (!sessionId) throw new TypeError('recordCheckoutClaim needs a session_id');
  if (!tenantId) throw new TypeError('recordCheckoutClaim needs a tenant_id');
  if (!apiKey) throw new TypeError('recordCheckoutClaim needs an api_key');
  const expiresAtMs = Number.isSafeInteger(input?.expires_at_ms) && Number(input.expires_at_ms) > 0
    ? Number(input.expires_at_ms)
    : Date.now() + CHECKOUT_CLAIM_TTL_MS;
  return { session_id: sessionId, tenant_id: tenantId, api_key: apiKey, expires_at_ms: expiresAtMs };
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

/**
 * Map one stored tenant-definition row into the record every caller sees, so the
 * SQLite rows and the JSONL lines cannot drift in shape. `allowed_origins` is
 * stored as JSON text in both backends, because it is a list and neither store
 * has an array type.
 * @param {any} row @returns {TenantDefinitionRecord}
 */
function toTenantDefinition(row) {
  /** @type {unknown} */
  let origins = row.allowed_origins;
  if (typeof origins === 'string') {
    try { origins = JSON.parse(origins); }
    catch { origins = null; }
  }
  const list = Array.isArray(origins)
    ? origins.filter((/** @type {unknown} */ item) => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    : [];
  return {
    tenant_id: String(row.tenant_id ?? ''),
    api_key: String(row.api_key ?? ''),
    allowed_origins: list.length > 0 ? list : ['*'],
    max_events_per_window: asNumber(row.max_events_per_window),
    window_seconds: asNumber(row.window_seconds) > 0 ? asNumber(row.window_seconds) : 2592000,
    status: row.status === 'suspended' ? 'suspended' : 'active',
    updated_at: String(row.updated_at ?? '')
  };
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
  // Provisioned tenants are configuration, not telemetry: a row here is what makes
  // a key bought through the billing webhook survive a restart. The key is unique
  // because it is the lookup the ingest routes perform; two tenants sharing one
  // would silently hand each other's quota to whichever was read first.
  db.exec(`CREATE TABLE IF NOT EXISTS tenant_definitions (
    tenant_id TEXT PRIMARY KEY,
    api_key TEXT NOT NULL,
    allowed_origins TEXT NOT NULL,
    max_events_per_window INTEGER NOT NULL,
    window_seconds INTEGER NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_definitions_key ON tenant_definitions(api_key)');
  // The billing ledger. The primary key is what makes "first delivery wins" a
  // database decision: `DO NOTHING` reports zero changed rows for a retry, so two
  // concurrent deliveries of one event cannot both be told they were first.
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY,
    received_at_ms INTEGER NOT NULL
  )`);
  const insertWebhookEvent = db.prepare('INSERT INTO webhook_events (event_id, received_at_ms) VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING');
  const deleteWebhookEvent = db.prepare('DELETE FROM webhook_events WHERE event_id = ?');
  const deleteExpiredWebhookEvents = db.prepare('DELETE FROM webhook_events WHERE received_at_ms < ?');
  db.exec(`CREATE TABLE IF NOT EXISTS checkout_claims (
    session_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    api_key TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )`);
  const upsertCheckoutClaim = db.prepare('INSERT INTO checkout_claims (session_id, tenant_id, api_key, expires_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET tenant_id = excluded.tenant_id, api_key = excluded.api_key, expires_at_ms = excluded.expires_at_ms');
  const selectCheckoutClaim = db.prepare('SELECT session_id, tenant_id, api_key, expires_at_ms FROM checkout_claims WHERE session_id = ?');
  const deleteCheckoutClaim = db.prepare('DELETE FROM checkout_claims WHERE session_id = ?');
  const deleteExpiredCheckoutClaims = db.prepare('DELETE FROM checkout_claims WHERE expires_at_ms <= ?');
  const upsertNavigationMap = db.prepare('INSERT INTO navigation_maps (site_id, url, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(site_id, url) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at');
  const selectNavigationMap = db.prepare('SELECT site_id, url, payload, updated_at FROM navigation_maps WHERE site_id = ? AND url = ?');
  const selectTenantQuota = db.prepare('SELECT window_start_ms, event_count FROM tenant_quotas WHERE tenant_id = ?');
  const upsertTenantQuota = db.prepare('INSERT INTO tenant_quotas (tenant_id, window_start_ms, event_count) VALUES (?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET window_start_ms = excluded.window_start_ms, event_count = excluded.event_count');
  const upsertTenantDefinition = db.prepare('INSERT INTO tenant_definitions (tenant_id, api_key, allowed_origins, max_events_per_window, window_seconds, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET api_key = excluded.api_key, allowed_origins = excluded.allowed_origins, max_events_per_window = excluded.max_events_per_window, window_seconds = excluded.window_seconds, status = excluded.status, updated_at = excluded.updated_at');
  const selectTenantDefinition = db.prepare('SELECT tenant_id, api_key, allowed_origins, max_events_per_window, window_seconds, status, updated_at FROM tenant_definitions WHERE tenant_id = ?');
  const selectTenantDefinitions = db.prepare('SELECT tenant_id, api_key, allowed_origins, max_events_per_window, window_seconds, status, updated_at FROM tenant_definitions ORDER BY tenant_id');
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
    async readQuota(tenantId) {
      const row = /** @type {{window_start_ms?: unknown, event_count?: unknown} | undefined} */ (selectTenantQuota.get(String(tenantId)));
      if (!row) return null;
      return { tenant_id: String(tenantId), window_start_ms: asNumber(row.window_start_ms), event_count: asNumber(row.event_count) };
    },
    async upsertTenantDefinition(definition) {
      const record = normalizeTenantDefinition(definition);
      upsertTenantDefinition.run(record.tenant_id, record.api_key, JSON.stringify(record.allowed_origins), record.max_events_per_window, record.window_seconds, record.status, record.updated_at);
      return record;
    },
    async readTenantDefinition(tenantId) {
      const row = /** @type {any} */ (selectTenantDefinition.get(String(tenantId)));
      return row ? /** @type {TenantDefinitionRecord} */ (toTenantDefinition(row)) : null;
    },
    async readTenantDefinitions() {
      return /** @type {any[]} */ (selectTenantDefinitions.all()).map(row => /** @type {TenantDefinitionRecord} */ (toTenantDefinition(row)));
    },
    async recordWebhookEvent(eventId, receivedAtMs) {
      const record = normalizeWebhookEvent(eventId, receivedAtMs);
      deleteExpiredWebhookEvents.run(Date.now() - WEBHOOK_EVENT_TTL_MS);
      const result = /** @type {{changes?: unknown}} */ (insertWebhookEvent.run(record.event_id, record.received_at_ms));
      return asNumber(result?.changes) > 0;
    },
    async releaseWebhookEvent(eventId) {
      deleteWebhookEvent.run(normalizeWebhookEvent(eventId).event_id);
    },
    async applyWebhookEvent(mutation) {
      const eventId = typeof mutation?.event_id === 'string' && mutation.event_id.trim().length > 0
        ? normalizeWebhookEvent(mutation.event_id, mutation.received_at_ms)
        : null;
      const definition = mutation?.definition ? normalizeTenantDefinition(mutation.definition) : null;
      const claim = mutation?.checkout_claim ? normalizeCheckoutClaim(mutation.checkout_claim) : null;
      db.exec('BEGIN IMMEDIATE');
      try {
        deleteExpiredWebhookEvents.run(Date.now() - WEBHOOK_EVENT_TTL_MS);
        if (eventId) {
          const inserted = /** @type {{changes?: unknown}} */ (insertWebhookEvent.run(eventId.event_id, eventId.received_at_ms));
          if (asNumber(inserted?.changes) === 0) {
            db.exec('COMMIT');
            return { duplicate: true, record: null };
          }
        }
        if (definition) {
          upsertTenantDefinition.run(
            definition.tenant_id,
            definition.api_key,
            JSON.stringify(definition.allowed_origins),
            definition.max_events_per_window,
            definition.window_seconds,
            definition.status,
            definition.updated_at
          );
        }
        if (claim) {
          deleteExpiredCheckoutClaims.run(Date.now());
          upsertCheckoutClaim.run(claim.session_id, claim.tenant_id, claim.api_key, claim.expires_at_ms);
        }
        db.exec('COMMIT');
        return { duplicate: false, record: definition };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* ignore rollback error */ }
        throw error;
      }
    },
    async recordCheckoutClaim(claimInput) {
      const claim = normalizeCheckoutClaim(claimInput);
      deleteExpiredCheckoutClaims.run(Date.now());
      upsertCheckoutClaim.run(claim.session_id, claim.tenant_id, claim.api_key, claim.expires_at_ms);
      return claim;
    },
    async consumeCheckoutClaim(sessionId, nowMs = Date.now()) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!id) return null;
      const now = Number.isFinite(nowMs) ? Math.trunc(nowMs) : Date.now();
      db.exec('BEGIN IMMEDIATE');
      try {
        deleteExpiredCheckoutClaims.run(now);
        const row = /** @type {{session_id?: unknown, tenant_id?: unknown, api_key?: unknown, expires_at_ms?: unknown} | undefined} */ (selectCheckoutClaim.get(id));
        if (!row) {
          db.exec('COMMIT');
          return null;
        }
        deleteCheckoutClaim.run(id);
        db.exec('COMMIT');
        if (asNumber(row.expires_at_ms) <= now) return null;
        return { tenant_id: String(row.tenant_id), api_key: String(row.api_key) };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* ignore rollback error */ }
        throw error;
      }
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
      db.exec('DELETE FROM tenant_definitions');
      db.exec('DELETE FROM webhook_events');
      db.exec('DELETE FROM checkout_claims');
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
   * @returns {Promise<{records: TelemetryRecord[], violations: ContainmentViolation[], definitions: Map<string, TenantDefinitionRecord>, sequence: number}>}
   */
  const scanLog = async () => {
    let text = '';
    /** @type {Map<string, TenantDefinitionRecord>} */
    const definitions = new Map();
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return { records: [], violations: [], definitions, sequence: 0 };
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
      // The ledger is read on demand by `recordWebhookEvent` and never counts as a
      // beacon: falling through here would add a phantom event per delivery.
      if (
        parsed.kind === WEBHOOK_EVENT_KIND
        || parsed.kind === WEBHOOK_EVENT_RELEASE_KIND
        || parsed.kind === CHECKOUT_CLAIM_KIND
        || parsed.kind === CHECKOUT_CLAIM_CONSUMED_KIND
      ) continue;
      if (parsed.kind === 'tenant_definition') {
        // Last line wins, exactly like the SQLite upsert: a revocation appends a
        // new definition rather than rewriting the old one.
        const definition = toTenantDefinition(parsed);
        if (definition.tenant_id) definitions.set(definition.tenant_id, definition);
        continue;
      }
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
    return { records, violations, definitions, sequence };
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
    async upsertTenantDefinition(definition) {
      const record = normalizeTenantDefinition(definition);
      await serial(() => appendFile(path, `${JSON.stringify({ kind: 'tenant_definition', ...record })}\n`, 'utf8'));
      return record;
    },
    async readTenantDefinition(tenantId) {
      return (await scanLog()).definitions.get(String(tenantId)) ?? null;
    },
    async readTenantDefinitions() {
      return [...(await scanLog()).definitions.values()].sort((left, right) => left.tenant_id.localeCompare(right.tenant_id));
    },
    async recordWebhookEvent(eventId, receivedAtMs) {
      const record = normalizeWebhookEvent(eventId, receivedAtMs);
      // Queued with the appends so a concurrent delivery of the same event cannot
      // read the file before the other one's line has landed.
      return serial(async () => {
        const cutoffMs = Date.now() - WEBHOOK_EVENT_TTL_MS;
        const text = await readFile(path, 'utf8').catch(() => '');
        // The newest line for this id decides: a release withdraws the claim that
        // preceded it, and a claim older than the 24-hour TTL is expired.
        for (const line of text.split('\n').reverse()) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed?.event_id !== record.event_id) continue;
            if (parsed.kind === WEBHOOK_EVENT_KIND) {
              if (asNumber(parsed.received_at_ms) >= cutoffMs) return false;
              break;
            }
            if (parsed.kind === WEBHOOK_EVENT_RELEASE_KIND) break;
          } catch { /* ignore torn and malformed lines */ }
        }
        await appendFile(path, `${JSON.stringify({ kind: WEBHOOK_EVENT_KIND, ...record })}\n`, 'utf8');
        return true;
      });
    },
    async releaseWebhookEvent(eventId) {
      const { event_id: id } = normalizeWebhookEvent(eventId);
      await serial(() => appendFile(path, `${JSON.stringify({ kind: WEBHOOK_EVENT_RELEASE_KIND, event_id: id })}\n`, 'utf8'));
    },
    async applyWebhookEvent(mutation) {
      const eventId = typeof mutation?.event_id === 'string' && mutation.event_id.trim().length > 0
        ? normalizeWebhookEvent(mutation.event_id, mutation.received_at_ms)
        : null;
      const definition = mutation?.definition ? normalizeTenantDefinition(mutation.definition) : null;
      const claim = mutation?.checkout_claim ? normalizeCheckoutClaim(mutation.checkout_claim) : null;
      return serial(async () => {
        const cutoffMs = Date.now() - WEBHOOK_EVENT_TTL_MS;
        if (eventId) {
          const text = await readFile(path, 'utf8').catch(() => '');
          for (const line of text.split('\n').reverse()) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed?.event_id !== eventId.event_id) continue;
              if (parsed.kind === WEBHOOK_EVENT_KIND) {
                if (asNumber(parsed.received_at_ms) >= cutoffMs) return { duplicate: true, record: null };
                break;
              }
              if (parsed.kind === WEBHOOK_EVENT_RELEASE_KIND) break;
            } catch { /* ignore torn and malformed lines */ }
          }
        }
        /** @type {string[]} */
        const batch = [];
        if (eventId) batch.push(JSON.stringify({ kind: WEBHOOK_EVENT_KIND, ...eventId }));
        if (definition) batch.push(JSON.stringify({ kind: 'tenant_definition', ...definition }));
        if (claim) batch.push(JSON.stringify({ kind: CHECKOUT_CLAIM_KIND, ...claim }));
        if (batch.length > 0) await appendFile(path, `${batch.join('\n')}\n`, 'utf8');
        return { duplicate: false, record: definition };
      });
    },
    async recordCheckoutClaim(claimInput) {
      const claim = normalizeCheckoutClaim(claimInput);
      await serial(() => appendFile(path, `${JSON.stringify({ kind: CHECKOUT_CLAIM_KIND, ...claim })}\n`, 'utf8'));
      return claim;
    },
    async consumeCheckoutClaim(sessionId, nowMs = Date.now()) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!id) return null;
      const now = Number.isFinite(nowMs) ? Math.trunc(nowMs) : Date.now();
      return serial(async () => {
        const text = await readFile(path, 'utf8').catch(() => '');
        for (const line of text.split('\n').reverse()) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed?.session_id !== id) continue;
            if (parsed.kind === CHECKOUT_CLAIM_CONSUMED_KIND) return null;
            if (parsed.kind === CHECKOUT_CLAIM_KIND) {
              if (asNumber(parsed.expires_at_ms) <= now) return null;
              await appendFile(path, `${JSON.stringify({ kind: CHECKOUT_CLAIM_CONSUMED_KIND, session_id: id })}\n`, 'utf8');
              return { tenant_id: String(parsed.tenant_id), api_key: String(parsed.api_key) };
            }
          } catch { /* ignore torn and malformed lines */ }
        }
        return null;
      });
    },
    async readQuota(tenantId) {
      // The last line for this tenant is the current window: every accepted ingest
      // appends one, so the newest occurrence is the state a scrape or a summary
      // must report. Reading back to front stops at it instead of scanning the file.
      const text = await readFile(path, 'utf8').catch(() => '');
      for (const line of text.split('\n').reverse()) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.kind === 'tenant_quota' && record.tenant_id === tenantId) {
            return { tenant_id: String(tenantId), window_start_ms: asNumber(record.window_start_ms), event_count: asNumber(record.event_count) };
          }
        } catch { /* ignore torn lines */ }
      }
      return null;
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
        /** @type {Map<string, TenantDefinitionRecord>} */
        const definitions = new Map();
        /** @type {Map<string, number>} */
        const webhookEvents = new Map();
        /** @type {Map<string, CheckoutClaimRecord>} */
        const checkoutClaims = new Map();
        const webhookCutoffMs = Date.now() - WEBHOOK_EVENT_TTL_MS;
        const claimNowMs = Date.now();
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
            if (parsed.kind === WEBHOOK_EVENT_KIND) {
              const id = typeof parsed.event_id === 'string' ? parsed.event_id.trim() : '';
              const receivedAt = asNumber(parsed.received_at_ms);
              if (id && receivedAt >= webhookCutoffMs) webhookEvents.set(id, receivedAt);
              else if (id) webhookEvents.delete(id);
              continue;
            }
            if (parsed.kind === WEBHOOK_EVENT_RELEASE_KIND) {
              const id = typeof parsed.event_id === 'string' ? parsed.event_id.trim() : '';
              if (id) webhookEvents.delete(id);
              continue;
            }
            if (parsed.kind === CHECKOUT_CLAIM_KIND) {
              const id = typeof parsed.session_id === 'string' ? parsed.session_id.trim() : '';
              const expiresAt = asNumber(parsed.expires_at_ms);
              if (id && expiresAt > claimNowMs) {
                checkoutClaims.set(id, {
                  session_id: id,
                  tenant_id: String(parsed.tenant_id ?? ''),
                  api_key: String(parsed.api_key ?? ''),
                  expires_at_ms: expiresAt
                });
              } else if (id) {
                checkoutClaims.delete(id);
              }
              continue;
            }
            if (parsed.kind === CHECKOUT_CLAIM_CONSUMED_KIND) {
              const id = typeof parsed.session_id === 'string' ? parsed.session_id.trim() : '';
              if (id) checkoutClaims.delete(id);
              continue;
            }
            if (parsed.kind === 'tenant_definition') {
              // Carried into the map and written back below: a prune prunes
              // violations, not the tenants an operator provisioned.
              const definition = toTenantDefinition(parsed);
              if (definition.tenant_id) definitions.set(definition.tenant_id, definition);
              continue;
            }
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
          // Definitions come before the meta line because that line describes the
          // file: a crash between the two leaves an unmarked but complete set.
          for (const definition of definitions.values()) {
            await write(JSON.stringify({ kind: 'tenant_definition', ...definition }));
          }
          for (const [event_id, received_at_ms] of webhookEvents.entries()) {
            await write(JSON.stringify({ kind: WEBHOOK_EVENT_KIND, event_id, received_at_ms }));
          }
          for (const claim of checkoutClaims.values()) {
            await write(JSON.stringify({ kind: CHECKOUT_CLAIM_KIND, ...claim }));
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
