// Shared record shapes and normalization for the telemetry store.
//
// Both backends - SQLite and the append-only JSONL log - answer with the identical
// record shapes, so the validation, clamping and summary arithmetic live here once
// instead of being restated per backend where the two could drift. Nothing in this
// module touches the filesystem or a driver: it is the contract the backends share.
//
// Every normalizer throws on a record that is not what it claims to be rather than
// defaulting a required field, because a stored row with no category or no tenant is
// not a record an operator can act on and would corrupt the audit trail a tenant
// reads back.

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
 * @typedef {{tenant_id: string, api_key: string, allowed_origins: string[], max_events_per_window: number | null, window_seconds: number, status: 'active' | 'suspended', updated_at: string}} TenantDefinitionRecord
 * @typedef {{tenant_id: string, api_key: string, allowed_origins?: string[], max_events_per_window?: number | null, window_seconds?: number, status?: 'active' | 'suspended'}} TenantDefinitionInput
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
export function normalizeLimit(value) {
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
export function normalizeViolation(violation) {
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
 * suspension back into a live plan. An explicit `null` is the unmetered plan and
 * is kept too, because defaulting it would meter a tenant that bought no ceiling.
 * Only a missing or unusable value falls back to the documented default.
 * @param {TenantDefinitionInput} input @returns {TenantDefinitionRecord}
 */
export function normalizeTenantDefinition(input) {
  const tenantId = typeof input?.tenant_id === 'string' ? input.tenant_id.trim() : '';
  const apiKey = typeof input?.api_key === 'string' ? input.api_key.trim() : '';
  if (!tenantId) throw new TypeError('upsertTenantDefinition needs a tenant_id');
  if (!apiKey) throw new TypeError('upsertTenantDefinition needs an api_key');
  const origins = Array.isArray(input?.allowed_origins)
    ? input.allowed_origins.filter((/** @type {unknown} */ item) => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    : [];
  const maxEvents = input?.max_events_per_window === null
    ? null
    : Number.isInteger(input?.max_events_per_window) && Number(input.max_events_per_window) >= 0 ? Number(input.max_events_per_window) : 10000;
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
export function normalizeWebhookEvent(eventId, receivedAtMs) {
  const id = typeof eventId === 'string' ? eventId.trim() : '';
  if (!id) throw new TypeError('recordWebhookEvent needs an event_id');
  const received = Number.isSafeInteger(receivedAtMs) && Number(receivedAtMs) >= 0 ? Number(receivedAtMs) : Date.now();
  return { event_id: id, received_at_ms: received };
}

/**
 * Validate a one-time post-checkout API-key claim.
 * @param {CheckoutClaimInput} input @returns {CheckoutClaimRecord}
 */
export function normalizeCheckoutClaim(input) {
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
export function normalizeRetention(options) {
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
export function retentionCutoff(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

/**
 * The one place summary arithmetic lives, so sqlite and log mode cannot drift.
 * @param {TelemetryRecord[]} records
 * @param {SummaryFilter} [filter]
 * @returns {TelemetrySummary}
 */
export function summarizeRecords(records, filter = {}) {
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
export function asNumber(value) {
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
export function toTenantDefinition(row) {
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
    // `null` is the unmetered plan in both backends; a missing value is read the
    // same way rather than as `0`, which is a suspension.
    max_events_per_window: row.max_events_per_window === null || row.max_events_per_window === undefined
      ? null
      : asNumber(row.max_events_per_window),
    window_seconds: asNumber(row.window_seconds) > 0 ? asNumber(row.window_seconds) : 2592000,
    status: row.status === 'suspended' ? 'suspended' : 'active',
    updated_at: String(row.updated_at ?? '')
  };
}
