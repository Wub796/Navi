// Prometheus exposition for the Navi host service.
//
// Metrics state is held per host rather than per process: two hosts in one process
// must not report each other's traffic, and a test that starts a second host should
// see a fresh scrape. Request keys are `route|status`, built only from the closed
// route set in `endpoints.js`, so no label can come from a request path.

import { stat } from 'node:fs/promises';

/** Process boot timestamp, shared by every listener in this process. */
const START_TIME_SECONDS = Math.floor(Date.now() / 1000);

/** A Prometheus label value escapes backslash, quote and newline: a tenant id is
 * operator-supplied text, and one unescaped quote would corrupt the exposition.
 * @param {string} value @returns {string} */
function escapeLabel(value) {
  const backslash = String.fromCharCode(92);
  return String(value).split(backslash).join(backslash + backslash).split('"').join(backslash + '"').split('\n').join(backslash + 'n');
}

/**
 * @param {{store: {file: string, readQuota?: (tenantId: string) => Promise<any>}, limiter: {size: number}, lifecycle: {uncleanShutdowns: number}, quota: {meteredTenants(): {config: {id: string}, quota: {limit: number}}[]}}} options
 */
export function createHostMetrics(options) {
  const { store, limiter, lifecycle, quota } = options;
  /** @type {Map<string, number>} */
  const requestCounts = new Map();
  /** @type {Map<string, number>} */
  const rateLimitedByTenant = new Map();
  /** @type {Map<string, number>} */
  const quotaExceededByTenant = new Map();
  let pruneEvents = 0;
  let prunedRecords = 0;

  /**
   * Size of the active store file. A missing file is zero rather than an error:
   * nothing has been written yet, which is a state and not a fault.
   * @returns {Promise<number>}
   */
  async function storeBytes() {
    try {
      return (await stat(store.file)).size;
    } catch {
      return 0;
    }
  }

  return {
    /** @param {string} route @param {number} status */
    count(route, status) {
      const key = `${route}|${status}`;
      requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
    },
    /** @param {string} tenantId */
    rateLimited(tenantId) {
      rateLimitedByTenant.set(tenantId, (rateLimitedByTenant.get(tenantId) ?? 0) + 1);
    },
    /** @param {string} tenantId */
    quotaExceeded(tenantId) {
      quotaExceededByTenant.set(tenantId, (quotaExceededByTenant.get(tenantId) ?? 0) + 1);
    },
    /** One prune attempt, counted before the store is asked, as it always has been. */
    pruneAttempt() {
      pruneEvents += 1;
    },
    /** Records a completed prune removed. @param {number} removed */
    prunedRecords(removed) {
      prunedRecords += removed;
    },
    /**
     * The Prometheus exposition. Labeled series appear once they have been observed,
     * while the label-free aggregates and the gauges are always present, so a scrape
     * of a freshly started host is a valid document rather than an empty one.
     * @returns {Promise<string>}
     */
    async render() {
      const lines = [
        '# HELP navi_host_requests_total HTTP requests answered, by route and status.',
        '# TYPE navi_host_requests_total counter'
      ];
      for (const key of [...requestCounts.keys()].sort()) {
        const [route, status] = key.split('|');
        lines.push(`navi_host_requests_total{route="${route}",status="${status}"} ${requestCounts.get(key)}`);
      }
      lines.push(
        '# HELP navi_host_rate_limited_total Ingest requests refused by the per-tenant token bucket.',
        '# TYPE navi_host_rate_limited_total counter'
      );
      for (const tenant of [...rateLimitedByTenant.keys()].sort()) {
        lines.push(`navi_host_rate_limited_total{tenant_id="${escapeLabel(tenant)}"} ${rateLimitedByTenant.get(tenant)}`);
      }
      lines.push(
        '# HELP process_start_time_seconds Process start time in Unix seconds.',
        '# TYPE process_start_time_seconds gauge',
        `process_start_time_seconds ${START_TIME_SECONDS}`,
        '# HELP navi_host_unclean_shutdowns_total Previous store owner did not complete graceful teardown (0 or 1 per boot).',
        '# TYPE navi_host_unclean_shutdowns_total counter',
        `navi_host_unclean_shutdowns_total ${lifecycle.uncleanShutdowns}`,
        '# HELP navi_host_prune_events_total Retention prunes executed, scheduled and on demand.',
        '# TYPE navi_host_prune_events_total counter',
        `navi_host_prune_events_total ${pruneEvents}`,
        '# HELP navi_host_pruned_records_total Expired violation records removed by those prunes.',
        '# TYPE navi_host_pruned_records_total counter',
        `navi_host_pruned_records_total ${prunedRecords}`,
        '# HELP navi_host_active_tenants Tenants currently holding a rate-limit bucket.',
        '# TYPE navi_host_active_tenants gauge',
        `navi_host_active_tenants ${limiter.size}`,
        '# HELP navi_host_store_bytes Size of the active store file on disk, in bytes.',
        '# TYPE navi_host_store_bytes gauge',
        `navi_host_store_bytes ${await storeBytes()}`,
        '# HELP navi_host_tenant_quota_limit Ingest events allowed per quota window, by tenant.',
        '# TYPE navi_host_tenant_quota_limit gauge',
        '# HELP navi_host_tenant_quota_events Ingest events consumed in the tenant\'s active quota window.',
        '# TYPE navi_host_tenant_quota_events gauge',
        '# HELP navi_host_tenant_quota_window_start_seconds Start of the tenant\'s active quota window in Unix seconds, 0 when no window has been opened.',
        '# TYPE navi_host_tenant_quota_window_start_seconds gauge',
        '# HELP navi_host_quota_exceeded_total Ingest requests refused because the tenant exhausted its quota window.',
        '# TYPE navi_host_quota_exceeded_total counter'
      );
      // Quota state is the tenant's own persisted window, read per scrape: a gauge
      // fed by process memory would report a ceiling that survived a restart beside a
      // count that did not. `readQuota` is optional on a store injected by a caller.
      for (const { config, quota: limits } of quota.meteredTenants()) {
        const state = typeof store.readQuota === 'function' ? await store.readQuota(config.id) : null;
        const label = escapeLabel(config.id);
        const windowStart = state && state.window_start_ms > 0 ? Math.floor(state.window_start_ms / 1000) : 0;
        lines.push(`navi_host_tenant_quota_limit{tenant_id="${label}"} ${limits.limit}`);
        lines.push(`navi_host_tenant_quota_events{tenant_id="${label}"} ${state?.event_count ?? 0}`);
        lines.push(`navi_host_tenant_quota_window_start_seconds{tenant_id="${label}"} ${windowStart}`);
        lines.push(`navi_host_quota_exceeded_total{tenant_id="${label}"} ${quotaExceededByTenant.get(config.id) ?? 0}`);
      }
      return `${lines.join('\n')}\n`;
    }
  };
}
