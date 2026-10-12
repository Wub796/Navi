import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NaviSession } from '../src/mcp/server.js';
import { createSseServer } from '../src/mcp/sse.js';
import { containmentMetrics, resetContainmentMetrics, resolveDestination } from '../src/mcp/containment.js';

/** @param {any} result */
const body = result => JSON.parse(result.content[0].text);
const root = fileURLToPath(new URL('..', import.meta.url));

/** A session whose private-network policy is active, whatever the ambient env
 * holds: a refusal is only counted when the policy is enforced. */
function containedSession() {
  const before = process.env.NAVI_ALLOW_LOCAL_NETWORK;
  delete process.env.NAVI_ALLOW_LOCAL_NETWORK;
  try { return new NaviSession(); }
  finally {
    if (before === undefined) delete process.env.NAVI_ALLOW_LOCAL_NETWORK;
    else process.env.NAVI_ALLOW_LOCAL_NETWORK = before;
  }
}

/** @returns {Record<string, number>} */
const categories = () => containmentMetrics().containment.violations_by_category;

test.beforeEach(() => { resetContainmentMetrics(); });

test('a metadata destination increments metadata_endpoint and the total', async () => {
  const s = containedSession();
  try {
    expect(body(await s.navigate({ url: 'http://169.254.169.254/latest/meta-data/?ami-id=i-1234#creds' })).error.code).toBe('ERR_BLOCKED_BY_CONTAINMENT');
    // The guard runs before Playwright is touched, so nothing was launched and
    // no download directory was created for a session that never browsed.
    expect(s.browser).toBeNull();
    expect(s.downloadDirectory).toBeNull();
    const metrics = containmentMetrics().containment;
    expect(metrics.enforced).toBe(true);
    expect(metrics.violations_by_category.metadata_endpoint, JSON.stringify(metrics)).toBe(1);
    expect(metrics.violations_total).toBe(1);
    expect(metrics.violations_by_category.private_ipv4).toBe(0);
  } finally { await s.close(); }
});

test('loopback and localhost destinations increment loopback_or_local', async () => {
  const s = containedSession();
  try {
    for (const url of ['http://127.0.0.1:3001/healthz?token=leak', 'http://localhost:3001/']) {
      expect(body(await s.navigate({ url })).error.code, url).toBe('ERR_BLOCKED_BY_CONTAINMENT');
    }
    expect(categories().loopback_or_local).toBe(2);
    expect(containmentMetrics().containment.violations_total).toBe(2);
    expect(s.browser).toBeNull();
  } finally { await s.close(); }
});

test('every refusal lands in the category an audit reader triages by', async () => {
  /** @type {[string, string][]} */
  const cases = [
    ['http://169.254.1.1/', 'metadata_endpoint'],
    ['http://[fe80::1]/', 'metadata_endpoint'],
    ['http://10.1.2.3/', 'private_ipv4'],
    ['http://172.20.0.1/', 'private_ipv4'],
    ['http://192.168.5.5/', 'private_ipv4'],
    ['http://127.9.8.7/', 'loopback_or_local'],
    ['http://[::1]/', 'loopback_or_local'],
    ['http://100.64.0.1/', 'cgnat_or_multicast'],
    ['http://224.0.0.1/', 'cgnat_or_multicast'],
    ['http://[fc00::1]/', 'ipv6_special'],
    ['http://[2002:7f00:1::]/', 'ipv6_special'],
    ['http://[::ffff:10.0.0.1]/', 'ipv6_special']
  ];
  for (const [url, category] of cases) {
    await expect(resolveDestination(url, false), url).rejects.toMatchObject({ code: 'ERR_BLOCKED_BY_CONTAINMENT' });
    expect(categories()[category], url).toBeGreaterThan(0);
  }
  // One counter per refusal, so the totals an operator scrapes stay additive.
  const counts = categories();
  const total = containmentMetrics().containment.violations_total;
  expect(total).toBe(cases.length);
  expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(total);
});

// The audit line is the artifact an incident is reconstructed from, so it is
// captured from a real child process's stderr rather than from a patched writer.
test('every refusal emits one structured audit line to stderr with the destination sanitized', async () => {
  const moduleUrl = new URL('../src/mcp/containment.js', import.meta.url).href;
  const script = `
    const { resolveDestination, containmentMetrics } = await import(${JSON.stringify(moduleUrl)});
    const targets = ['http://169.254.169.254/latest/meta-data/?ami-id=SECRET#frag', 'http://user:pass@10.0.0.5/private?token=SECRET'];
    for (const target of targets) {
      try { await resolveDestination(target, false, { sessionId: 'session-abc' }); }
      catch (error) { if (error.code !== 'ERR_BLOCKED_BY_CONTAINMENT') throw error; }
    }
    console.log(JSON.stringify(containmentMetrics()));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
  expect(child.error).toBeUndefined();
  expect(child.status, String(child.stderr)).toBe(0);
  const stderr = String(child.stderr);
  const lines = stderr.trim().split('\n').filter(Boolean);
  expect(lines, stderr).toHaveLength(2);
  /** @type {any[]} */
  const records = lines.map(line => JSON.parse(line));
  // Exact shape: an added or renamed field would change what a log pipeline indexes.
  expect(records[0]).toEqual({
    level: 'WARN',
    type: 'SECURITY_CONTAINMENT_VIOLATION',
    timestamp: expect.any(String),
    session_id: 'session-abc',
    target_url: 'http://169.254.169.254/latest/meta-data/',
    resolved_ip: '169.254.169.254',
    category: 'metadata_endpoint',
    action: 'BLOCKED'
  });
  expect(Number.isNaN(Date.parse(records[0].timestamp))).toBe(false);
  expect(records[1]).toMatchObject({ session_id: 'session-abc', target_url: 'http://10.0.0.5/private', resolved_ip: null, category: 'unclassified', action: 'BLOCKED' });
  // No query string, fragment or credential survives into the log.
  for (const secret of ['SECRET', 'ami-id', 'token', 'pass', '@']) expect(stderr).not.toContain(secret);
  // The audit trail never contaminates stdout: the stdio transport speaks there.
  const stdout = String(child.stdout).trim().split('\n');
  expect(stdout).toHaveLength(1);
  const metrics = JSON.parse(stdout[0]).containment;
  expect(metrics).toMatchObject({ enforced: true, violations_total: 2, violations_by_category: { metadata_endpoint: 1 } });
});

test('the SSE server publishes live counters on /healthz and in Prometheus text on /metrics', async () => {
  const s = containedSession();
  const server = await createSseServer({
    port: 0,
    createSession: () => ({ close: async () => {} }),
    handleMessage: async () => null
  });
  try {
    expect(body(await s.navigate({ url: 'http://169.254.169.254/' })).error.code).toBe('ERR_BLOCKED_BY_CONTAINMENT');
    const base = `http://127.0.0.1:${server.port}`;
    const health = await (await fetch(`${base}/healthz`)).json();
    expect(health.containment).toEqual({ enforced: true, violations_total: 1, violations_by_category: { ...categories() } });
    expect(health.containment.violations_by_category.metadata_endpoint).toBe(1);
    // Liveness fields stay intact, so existing probes keep working.
    expect(health).toMatchObject({ ok: true, transport: 'sse', sessions: 0, maxPendingMessages: 16 });

    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(String(response.headers.get('content-type'))).toContain('text/plain');
    const text = await response.text();
    expect(text).toContain('# TYPE navi_containment_violations_total counter');
    expect(text).toContain('navi_containment_violations_total 1');
    expect(text).toContain('navi_containment_violations{category="metadata_endpoint"} 1');
    expect(text).toContain('navi_containment_violations{category="loopback_or_local"} 0');
    expect(text).toContain('navi_containment_enforced 1');
    expect(text).toContain('navi_mcp_sessions 0');
    expect(text.endsWith('\n')).toBe(true);
  } finally {
    await server.close();
    await s.close();
  }
});

test('the fixture override reports enforcement off and records nothing', async () => {
  process.env.NAVI_ALLOW_LOCAL_NETWORK = '1';
  try {
    expect(containmentMetrics().containment.enforced).toBe(false);
    await expect(resolveDestination('http://127.0.0.1/', true)).resolves.toMatchObject({ address: '127.0.0.1' });
    expect(containmentMetrics().containment.violations_total).toBe(0);
  } finally { delete process.env.NAVI_ALLOW_LOCAL_NETWORK; }
});
