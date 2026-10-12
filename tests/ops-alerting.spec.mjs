import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createNaviHostServer } from '../server/index.js';
import { createSseServer } from '../src/mcp/sse.js';
import { NaviSession } from '../src/mcp/server.js';

/**
 * Operational alerting and dashboards.
 *
 * A rules file and a dashboard are code that only runs in an incident, so they are
 * checked the way any other artifact here is: parsed as the tool that will read them
 * parses them, and held against the metric names the services actually serve. A
 * typo'd series name is invisible until the alert that was supposed to page nobody
 * fails to fire, which is exactly the failure this file exists to prevent.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const alertsPath = join(root, 'deploy/prometheus/alerts.yml');
const dashboardPath = join(root, 'deploy/grafana/dashboard.json');
/** Metric names Prometheus synthesizes itself; no service has to export them. */
const PROMETHEUS_BUILTINS = ['up'];

/** The rule names the runbook refers to, so a rewrite cannot quietly drop one. */
const REQUIRED_ALERTS = ['NaviContainmentBreachAttempt', 'NaviForwarderQueueSaturated', 'NaviTenantRateLimitSpike', 'NaviUngracefulShutdown'];
/** The panel intents the operations section documents. */
const REQUIRED_PANELS = ['navi_mcp_sessions', 'navi_containment_violations', 'navi_host_requests_total', 'navi_host_store_bytes'];

/**
 * Every metric name both services declare, read from their live expositions rather
 * than from a list in this file: the exposition is the authority, and a rule that
 * references a renamed series has to fail here rather than in an incident.
 * @returns {Promise<Set<string>>}
 */
async function exportedMetricNames() {
  const names = new Set();
  const collect = (/** @type {string} */ text) => {
    for (const match of text.matchAll(/^# TYPE ([a-z0-9_]+) /gm)) names.add(match[1]);
  };
  const host = await createNaviHostServer({
    port: 0,
    tenants: new Map([['key-alpha', 'tenant-alpha']]),
    storeFile: join(tmpdir(), `navi-alerts-${process.pid}-${Date.now()}.db`),
    retentionDays: 0
  });
  let remote;
  try {
    collect(await (await fetch(`http://127.0.0.1:${host.port}/metrics`)).text());
    remote = await createSseServer({
      host: '127.0.0.1',
      port: 0,
      log: () => {},
      handleMessage: async () => null,
      authToken: '',
      maxSessions: 1,
      idleTimeoutMs: 1000,
      createSession: () => new NaviSession()
    });
    collect(await (await fetch(`http://127.0.0.1:${remote.port}/metrics`)).text());
  } finally {
    await remote?.close();
    await host.close();
  }
  expect(names.size, 'both expositions must declare their series').toBeGreaterThan(10);
  return names;
}

/** The `navi_*` identifiers an expression or a panel query references.
 * @param {string} expression @returns {string[]} */
const referenced = expression => [...expression.matchAll(/\bnavi_[a-z0-9_]+/g)].map(match => match[0]);

/** @param {string[]} expressions @param {Set<string>} exported @param {string} where */
function assertKnownSeries(expressions, exported, where) {
  for (const expression of expressions) {
    for (const name of referenced(expression)) {
      expect(exported.has(name), `${where} references ${name}, which no service declares in its exposition: ${expression}`).toBe(true);
    }
  }
}

/**
 * A counter compared against a bare threshold is the classic alert that fires
 * forever: `some_total > 0` stays true months after the single event it describes.
 * Every counter an alert reads therefore has to pass through a function that
 * windows it - rate, increase or resets - and `up` is the one non-`navi_*` series
 * the rules use.
 * @param {string} expression
 * @returns {string[]} counter names read without a window
 */
function unwindowedCounters(expression) {
  return [...expression.matchAll(/\bnavi_[a-z0-9_]+_total\b/g)]
    .filter(match => !/increase\(|rate\(|resets\(/.test(expression.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0)))
    .map(match => match[0]);
}

test('every alert rule is well formed and reads series the services export', async () => {
  const exported = await exportedMetricNames();
  const document = parse(await readFile(alertsPath, 'utf8'));
  expect(Array.isArray(document?.groups), 'the rules file must define groups').toBe(true);
  expect(document.groups.length).toBeGreaterThan(0);

  /** @type {{name: string, expr: string}[]} */
  const rules = [];
  for (const group of document.groups) {
    expect(typeof group?.name, 'every group needs a name').toBe('string');
    expect(Array.isArray(group?.rules), `group ${group?.name} must hold rules`).toBe(true);
    expect(group.rules.length).toBeGreaterThan(0);
    for (const rule of group.rules) {
      expect(typeof rule?.alert, `${group.name} has a rule without an alert name`).toBe('string');
      expect(typeof rule?.expr, `${rule.alert} has no expression`).toBe('string');
      expect(rule.expr.trim().length, `${rule.alert} has an empty expression`).toBeGreaterThan(0);
      // A severity the runbook routes on, and an annotation a responder can act on.
      expect(['critical', 'warning', 'info'], `${rule.alert} has an unroutable severity`).toContain(rule?.labels?.severity);
      expect(typeof rule?.annotations?.summary, `${rule.alert} has no summary`).toBe('string');
      expect(rule.annotations.summary.length, `${rule.alert}'s summary is empty`).toBeGreaterThan(0);
      expect(typeof rule?.annotations?.description, `${rule.alert} has no description`).toBe('string');
      if (rule.for !== undefined) expect(String(rule.for), `${rule.alert} has a malformed for`).toMatch(/^\d+(ms|s|m|h|d)$/);
      rules.push({ name: rule.alert, expr: rule.expr });
    }
  }

  const names = rules.map(rule => rule.name);
  expect(new Set(names).size, `alert names must be unique: ${names.join(', ')}`).toBe(names.length);
  for (const required of REQUIRED_ALERTS) expect(names, `the runbook names ${required}`).toContain(required);

  assertKnownSeries(rules.map(rule => rule.expr), exported, 'the alert rules');
  // And the property that makes them fire on events rather than on history.
  for (const rule of rules) {
    expect(unwindowedCounters(rule.expr), `${rule.name} compares a counter without rate/increase/resets, which stays true forever after one event`).toEqual([]);
  }
});

test('the containment rules carry the category breakdown, not just a total', async () => {
  const document = parse(await readFile(alertsPath, 'utf8'));
  /** @type {any[]} */
  const rules = document.groups.flatMap((/** @type {any} */ group) => group.rules);
  const breach = rules.find(rule => rule.alert === 'NaviContainmentBreachAttempt');
  // One alert instance per category is what turns an annotation into a breakdown;
  // a summed rule could only report that something, somewhere, was refused.
  expect(breach.expr).toMatch(/by \(category\)/);
  expect(breach.expr).toContain('navi_containment_violations');
  expect(breach.annotations.description).toContain('{{ $labels.category }}');
});

test('the forwarder saturation rule is the one the queue actually needs', async () => {
  const document = parse(await readFile(alertsPath, 'utf8'));
  /** @type {any[]} */
  const rules = document.groups.flatMap((/** @type {any} */ group) => group.rules);
  const saturated = rules.find(rule => rule.alert === 'NaviForwarderQueueSaturated');
  // Dropping and queue depth are different faults, and only one of them is a
  // counter: the dropped counter has to be windowed, the gauge must not be.
  expect(saturated.expr).toContain('navi_containment_forward_queued');
  expect(saturated.expr).toContain('increase(navi_containment_forward_dropped_total[5m])');
  expect(saturated.labels.severity).toBe('critical');
  // 200 of the forwarder's 256-event queue: a threshold that is reachable but not
  // permanently true, which a value at or above the capacity would be.
  expect(saturated.expr).toMatch(/navi_containment_forward_queued > 200\b/);
  const { MAX_FORWARD_QUEUE } = await import('../src/mcp/containment.js');
  expect(200).toBeLessThan(MAX_FORWARD_QUEUE);
});

test('the dashboard imports without per-panel editing and reads only real series', async () => {
  const exported = await exportedMetricNames();
  const dashboard = JSON.parse(await readFile(dashboardPath, 'utf8'));
  expect(typeof dashboard.title).toBe('string');
  expect(typeof dashboard.uid, 'a stable uid keeps an import idempotent').toBe('string');
  expect(Number.isInteger(dashboard.schemaVersion), 'Grafana needs a schema version').toBe(true);
  expect(Array.isArray(dashboard.panels) && dashboard.panels.length > 0).toBe(true);

  // One datasource variable every panel binds to, so an import needs no editing.
  const variables = dashboard.templating?.list ?? [];
  const datasource = variables.find((/** @type {any} */ variable) => variable.type === 'datasource');
  expect(datasource?.name, 'a datasource template variable must exist').toBe('datasource');
  expect(datasource.query, 'the variable must offer Prometheus').toBe('prometheus');

  /** @type {string[]} */
  const expressions = [];
  const ids = new Set();
  const titles = [];
  for (const panel of dashboard.panels) {
    expect(Number.isInteger(panel?.id), 'every panel needs a numeric id').toBe(true);
    expect(ids.has(panel.id), `panel id ${panel.id} is duplicated`).toBe(false);
    ids.add(panel.id);
    expect(typeof panel?.title, `panel ${panel.id} has no title`).toBe('string');
    titles.push(panel.title);
    // A panel without a description is a panel a responder has to guess about.
    expect(typeof panel?.description, `panel "${panel.title}" has no description`).toBe('string');
    expect(panel.description.length, `panel "${panel.title}" has an empty description`).toBeGreaterThan(0);
    expect(panel?.datasource?.uid, `panel "${panel.title}" is not bound to the datasource variable`).toBe('${datasource}');
    expect(Array.isArray(panel?.targets) && panel.targets.length > 0, `panel "${panel.title}" has no targets`).toBe(true);
    for (const target of panel.targets) {
      expect(typeof target?.expr, `panel "${panel.title}" has a target without an expression`).toBe('string');
      expect(target.expr.trim().length).toBeGreaterThan(0);
      expect(typeof target?.refId, `panel "${panel.title}" has a target without a refId`).toBe('string');
      expressions.push(target.expr);
    }
  }

  assertKnownSeries(expressions, exported, 'the dashboard');
  const text = expressions.join('\n');
  for (const required of REQUIRED_PANELS) expect(text, `the dashboard must keep a panel over ${required}`).toContain(required);
  // The container metric names the dashboard documents are all present, and the
  // session ceiling is shown beside the open count rather than instead of it.
  expect(text).toContain('navi_mcp_sessions_max');
  expect(text).toContain('navi_containment_forward_dropped_total');
  expect(titles.length).toBeGreaterThanOrEqual(REQUIRED_PANELS.length);
});

test('the dashboard states which panels cannot show what their title implies', async () => {
  const dashboard = JSON.parse(await readFile(dashboardPath, 'utf8'));
  const throughput = dashboard.panels.find((/** @type {any} */ panel) => (panel.targets ?? []).some((/** @type {any} */ target) => String(target.expr).includes('navi_host_requests_total')));
  // There is no latency histogram in either exposition. A panel that implied one
  // would be the most confidently wrong thing on the dashboard, so it says so.
  expect(throughput.description).toMatch(/no latency histogram|latency signal/i);
  expect(throughput.title).toMatch(/throughput/i);
  const sessions = dashboard.panels.find((/** @type {any} */ panel) => (panel.targets ?? []).some((/** @type {any} */ target) => String(target.expr).includes('navi_mcp_sessions')));
  expect(sessions.description).toMatch(/Chromium/);
});

test('both expositions are scrapeable without credentials, which is what a rule assumes', async () => {
  const host = await createNaviHostServer({
    port: 0,
    tenants: new Map([['key-alpha', 'tenant-alpha']]),
    storeFile: join(tmpdir(), `navi-alerts-auth-${process.pid}-${Date.now()}.db`),
    retentionDays: 0
  });
  let remote;
  try {
    const hostScrape = await fetch(`http://127.0.0.1:${host.port}/metrics`);
    expect(hostScrape.status).toBe(200);
    remote = await createSseServer({
      host: '127.0.0.1',
      port: 0,
      log: () => {},
      handleMessage: async () => null,
      // A token is deliberately configured: the scraper must still be let in, or
      // every rule in the file would silently evaluate against no data.
      authToken: 'secret-token-for-the-scraper-test',
      maxSessions: 1,
      idleTimeoutMs: 1000,
      createSession: () => new NaviSession()
    });
    const mcpScrape = await fetch(`http://127.0.0.1:${remote.port}/metrics`);
    expect(mcpScrape.status, 'an alerting scraper must not need the bearer token').toBe(200);
    expect(String(mcpScrape.headers.get('cache-control'))).toContain('no-store');
  } finally {
    await remote?.close();
    await host.close();
  }
});

test('the rules file documents what an operator has to know to load it', async () => {
  const text = await readFile(alertsPath, 'utf8');
  for (const guidance of ['promtool check rules', '/metrics', 'NAVI_TELEMETRY_ENDPOINT', '256']) {
    expect(text, `the rules file should mention ${guidance}`).toContain(guidance);
  }
  // The README and the container docs are where an operator starts.
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  expect(readme).toContain('deploy/prometheus/alerts.yml');
  expect(readme).toContain('deploy/grafana/dashboard.json');
  const containers = await readFile(join(root, 'docs/CONTAINERS.md'), 'utf8');
  expect(containers).toContain('deploy/prometheus/alerts.yml');
});
