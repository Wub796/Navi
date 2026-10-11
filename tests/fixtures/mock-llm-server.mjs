// Local mock of an OpenAI-compatible tool-calling model.
//
// This is a *fixture*, not a model. It exists so `npm run benchmark:llm` can
// exercise the whole autonomous harness — the MCP server, the browser, the
// differential action maps, the settlement receipts and the accounting path —
// with no third-party endpoint and no API key. Its token counters are simulated
// provider figures derived from the request body (see `usageFor`), so a run
// against this server measures the harness, never a model's capability.
//
// The policy is a pure function of the request: `messages` are replayed on every
// call to work out what has already been done. Nothing is kept between requests,
// because one server instance serves every trial of a run.
//
// It completes one task: the Trail Store checkout in `demo/tcr-checkout.html`,
// through either of the two tool surfaces the harness offers — the raw
// Playwright tools (`observe_page` / `browser_action`) or the Navi MCP tools
// (`navi_get_actions` / `navi_execute_action`).
//
// It binds an ephemeral loopback port by default, because the harness and its
// contract spec both start instances and neither should have to care what else is
// running. Set `MOCK_LLM_PORT` (or pass `{ port }`) to pin it to a known address; a
// collision then becomes a real error rather than something to paper over.
import { createServer } from 'node:http';

/** Model name this fixture answers as. */
export const MODEL_ID = 'navi-mock-fixture-v1';
/** Largest request body accepted; the harness sends one conversation, not a document. */
const MAX_REQUEST_BYTES = 1024 * 1024;
/** Attempts allowed per step before the planner moves on instead of looping. */
const MAX_STEP_ATTEMPTS = 2;
/** Consecutive map reads tolerated before the planner stops instead of spinning. */
const MAX_TRAILING_READS = 2;

/** @typedef {{id: string, name: string, args: Record<string, unknown>}} EmittedCall */
/** @typedef {{call: EmittedCall, result: unknown}} LastOutcome */
/** @typedef {{calls: EmittedCall[], succeeded: Set<string>, last: LastOutcome | null, url: string | null, targets: Map<string, Record<string, any>>, trailingReads: number}} Replay */
/** @typedef {{name: string, arguments: Record<string, unknown>}} PlannedCall */
/** @typedef {{ids: string[], names: string[], roles: string[], action: 'click' | 'type' | 'select', payload?: Record<string, string>, wait_for: 'mutation_settle' | 'navigation'}} NaviStep */
/** @typedef {{role: string, name: string, action: 'click' | 'type' | 'select', value?: string, wait_for: 'mutation_settle' | 'navigation'}} RawStep */
/** @typedef {{origin: string, baseUrl: string, model: string, requests: number, close(): Promise<void>}} MockLlmServer */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);
/** @param {unknown} value @returns {string | null} */
const asText = value => (typeof value === 'string' ? value : null);
/** @param {unknown} value @returns {string | null} */
const asId = value => (typeof value === 'string' && value.length > 0 ? value : null);

/** The stop signal: the harness verifies the committed order itself. */
const FINISH = /** @type {PlannedCall} */ ({ name: 'finish_task', arguments: {} });
/** Re-read the action map, which is what a planner does when its map may be stale. */
const READ_MAP = /** @type {PlannedCall} */ ({ name: 'navi_get_actions', arguments: {} });
/** Re-read the page, which is what a planner does after a failed locator. */
const READ_PAGE = /** @type {PlannedCall} */ ({ name: 'observe_page', arguments: {} });

/**
 * The raw-tool script. Every role/name pair resolves to exactly one element on
 * the page it belongs to, which is what the harness's locator count asserts.
 * @type {RawStep[]}
 */
const RAW_CATALOG = [
  { role: 'textbox', name: 'Search products', action: 'type', value: 'backpack', wait_for: 'mutation_settle' },
  { role: 'combobox', name: 'Quantity', action: 'select', value: '2', wait_for: 'mutation_settle' },
  { role: 'button', name: 'Add Trail backpack', action: 'click', wait_for: 'mutation_settle' },
  { role: 'button', name: 'Review checkout', action: 'click', wait_for: 'navigation' }
];
/** @type {RawStep[]} */
const RAW_REVIEW = [
  { role: 'textbox', name: 'Email address', action: 'type', value: 'agent@example.test', wait_for: 'mutation_settle' },
  { role: 'combobox', name: 'Shipping method', action: 'select', value: 'express', wait_for: 'mutation_settle' },
  { role: 'button', name: 'Place sandbox order', action: 'click', wait_for: 'navigation' }
];

/**
 * The Navi script. `ids` are the authored `data-agent-target` values, which the
 * SDK keeps as stable target ids; the names and roles are the fallback match for
 * a map that identifies a control some other way.
 * @type {NaviStep[]}
 */
const NAVI_CATALOG = [
  { ids: ['search'], names: ['search products'], roles: ['textbox', 'searchbox'], action: 'type', payload: { text: 'backpack' }, wait_for: 'mutation_settle' },
  { ids: ['quantity'], names: ['quantity'], roles: ['combobox', 'listbox'], action: 'select', payload: { value: '2' }, wait_for: 'mutation_settle' },
  { ids: ['add'], names: ['add trail backpack'], roles: ['button'], action: 'click', wait_for: 'mutation_settle' },
  { ids: ['review'], names: ['review checkout'], roles: ['button', 'link'], action: 'click', wait_for: 'navigation' }
];
/** @type {NaviStep[]} */
const NAVI_REVIEW = [
  { ids: ['email'], names: ['email address'], roles: ['textbox'], action: 'type', payload: { text: 'agent@example.test' }, wait_for: 'mutation_settle' },
  { ids: ['shipping'], names: ['shipping method'], roles: ['combobox', 'listbox'], action: 'select', payload: { value: 'express' }, wait_for: 'mutation_settle' },
  { ids: ['place'], names: ['place sandbox order'], roles: ['button'], action: 'click', wait_for: 'navigation' }
];

/**
 * Rebuild the conversation's state from the messages alone: every call the
 * fixture already emitted, which of them actually succeeded, the last outcome,
 * the page it last saw, and the action map as the tool contract tells a model to
 * maintain it (a `reset: true` reply replaces it, `removed: true` deletes one
 * entry, everything else merges).
 * @param {unknown} messages
 * @returns {Replay}
 */
function replay(messages) {
  /** @type {EmittedCall[]} */
  const calls = [];
  /** @type {Map<string, unknown>} */
  const results = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isRecord(message)) continue;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        const name = asText(call.function.name) ?? '';
        const raw = asText(call.function.arguments) ?? '{}';
        /** @type {Record<string, unknown>} */
        let args = {};
        try {
          const parsed = JSON.parse(raw);
          if (isRecord(parsed)) args = parsed;
        } catch { /* unparsable arguments are treated as none, as a reader would */ }
        calls.push({ id: asId(call.id) ?? `call-${calls.length}`, name, args });
      }
      continue;
    }
    if (message.role === 'tool') {
      const id = asId(message.tool_call_id);
      if (!id) continue;
      const content = asText(message.content) ?? 'null';
      try {
        results.set(id, JSON.parse(content));
      } catch {
        results.set(id, { unparsable: content.slice(0, 200) });
      }
    }
  }
  const succeeded = new Set(calls.filter(call => {
    const result = results.get(call.id);
    return isRecord(result) && result.error === undefined;
  }).map(call => call.id));
  /** @type {Map<string, Record<string, any>>} */
  const targets = new Map();
  /** @type {string | null} */
  let url = null;
  for (const call of calls) {
    const result = results.get(call.id);
    if (!isRecord(result)) continue;
    const seen = asText(result.final_url) ?? asText(result.url);
    if (seen) url = seen;
    if (call.name !== 'navi_get_actions' || !Array.isArray(result.actions)) continue;
    if (result.reset === true) targets.clear();
    for (const action of result.actions) {
      if (!isRecord(action)) continue;
      const targetId = asId(action.target_id);
      if (!targetId) continue;
      if (action.removed === true) targets.delete(targetId);
      else targets.set(targetId, action);
    }
  }
  const lastCall = calls[calls.length - 1];
  /** @type {LastOutcome | null} */
  const last = lastCall ? { call: lastCall, result: results.get(lastCall.id) } : null;
  let trailingReads = 0;
  for (let index = calls.length - 1; index >= 0 && calls[index].name === 'navi_get_actions'; index--) trailingReads++;
  return { calls, succeeded, last, url, targets, trailingReads };
}

/** @param {string | null} url @returns {'catalog' | 'review' | 'complete'} */
function stageOf(url) {
  if (!url) return 'catalog';
  try {
    const step = new URL(url).searchParams.get('step');
    return step === 'complete' ? 'complete' : step === 'review' ? 'review' : 'catalog';
  } catch {
    return 'catalog';
  }
}

/**
 * The first target in the map that answers to this step: the authored id wins,
 * then any control whose accessible name and role match.
 * @param {Map<string, Record<string, any>>} targets
 * @param {NaviStep} step
 * @returns {string | null}
 */
function resolveTarget(targets, step) {
  for (const id of step.ids) if (targets.has(id)) return id;
  for (const action of targets.values()) {
    const name = (asText(action.name) ?? '').toLowerCase();
    const role = (asText(action.role) ?? '').toLowerCase();
    if (!step.roles.includes(role)) continue;
    if (!step.names.some(candidate => name.includes(candidate))) continue;
    return asId(action.target_id);
  }
  return null;
}

/** @param {string} targetId @param {NaviStep} step @returns {boolean} */
const targetsStep = (targetId, step) => step.ids.includes(targetId);

/**
 * Decide the next raw-tool call from the replayed state.
 * @param {Replay} state
 * @returns {PlannedCall}
 */
function planRaw(state) {
  if (!state.calls.length) return READ_PAGE;
  const stage = stageOf(state.url);
  if (stage === 'complete') return FINISH;
  const last = state.last;
  if (last && !state.succeeded.has(last.call.id)) {
    const args = last.call.args;
    // The placement click is never repeated: it may already have applied.
    if (last.call.name === 'browser_action' && args.name === 'Place sandbox order') return FINISH;
    // A failed read means there is nothing more this planner can learn.
    if (last.call.name === 'observe_page') return FINISH;
    return READ_PAGE;
  }
  const plan = stage === 'review' ? RAW_REVIEW : RAW_CATALOG;
  for (const step of plan) {
    const attempts = state.calls.filter(call => call.name === 'browser_action' && call.args.role === step.role && call.args.name === step.name).length;
    const done = state.calls.some(call => call.name === 'browser_action' && call.args.role === step.role && call.args.name === step.name && state.succeeded.has(call.id));
    if (done) continue;
    if (attempts >= MAX_STEP_ATTEMPTS) continue;
    return { name: 'browser_action', arguments: step.value === undefined ? { role: step.role, name: step.name, action: step.action, wait_for: step.wait_for } : { role: step.role, name: step.name, action: step.action, value: step.value, wait_for: step.wait_for } };
  }
  return FINISH;
}

/**
 * Decide the next Navi MCP call from the replayed state. A step whose target is
 * missing from the map re-reads the map first rather than guessing, because the
 * harness replays the cursor and a mutation may not have reached the planner yet.
 * @param {Replay} state
 * @returns {PlannedCall}
 */
function planNavi(state) {
  if (!state.calls.some(call => call.name === 'navi_get_actions')) return READ_MAP;
  const stage = stageOf(state.url);
  if (stage === 'complete') return FINISH;
  const last = state.last;
  if (last && !state.succeeded.has(last.call.id)) {
    // The placement click is never repeated, matched by the id the map currently
    // exposes for it so a map that renames controls cannot defeat the rule.
    const placeId = resolveTarget(state.targets, NAVI_REVIEW[2]);
    const failedTarget = asText(last.call.args.target_id) ?? '';
    if (last.call.name === 'navi_execute_action' && (targetsStep(failedTarget, NAVI_REVIEW[2]) || failedTarget === placeId)) return FINISH;
    if (last.call.name === 'navi_get_actions' || state.trailingReads >= MAX_TRAILING_READS) return FINISH;
    return READ_MAP;
  }
  const plan = stage === 'review' ? NAVI_REVIEW : NAVI_CATALOG;
  for (const step of plan) {
    const targetId = resolveTarget(state.targets, step);
    // A step counts as attempted or done when the emitted call named either an
    // authored id or the id this map resolves to for it.
    const matches = (/** @type {unknown} */ value) => {
      const id = asText(value);
      return id !== null && (targetsStep(id, step) || id === targetId);
    };
    const attempted = state.calls.filter(call => call.name === 'navi_execute_action' && matches(call.args.target_id)).length;
    const done = state.calls.some(call => call.name === 'navi_execute_action' && matches(call.args.target_id) && state.succeeded.has(call.id));
    if (done || attempted >= MAX_STEP_ATTEMPTS) continue;
    if (!targetId) return state.trailingReads >= MAX_TRAILING_READS ? FINISH : READ_MAP;
    const suggested = asText(state.targets.get(targetId)?.suggested_action);
    const actionType = suggested === 'click' || suggested === 'type' || suggested === 'select' ? suggested : step.action;
    return {
      name: 'navi_execute_action',
      arguments: {
        target_id: targetId,
        action_type: actionType,
        // The tool takes one nested payload: `{ text }` for a type, `{ value }` for
        // a select, and nothing at all for a click.
        ...(step.payload ? { payload: step.payload } : {}),
        // The harness rejects an action without a settlement request, and the
        // requirement is real: an unconfirmed dispatch is not a completed step.
        settle: { wait_for: step.wait_for, timeout_ms: 5000 }
      }
    };
  }
  return FINISH;
}

/**
 * The next call for this conversation, whichever tool surface it is using.
 * @param {Replay} state
 * @param {string[]} toolNames
 * @returns {PlannedCall}
 */
function plan(state, toolNames) {
  if (toolNames.includes('browser_action')) return planRaw(state);
  if (toolNames.includes('navi_execute_action')) return planNavi(state);
  // A caller that offered no known tool surface gets a terminal answer rather
  // than a fabricated action.
  return FINISH;
}

/**
 * Simulated provider usage, derived only from the request so the same
 * conversation always reports the same figures. It exists so the harness's
 * accounting path runs end to end; it is not a provider's billing report and
 * must never be read as one.
 * @param {Record<string, any>} body
 * @param {PlannedCall} call
 * @returns {{prompt_tokens: number, completion_tokens: number, prompt_tokens_details: {cached_tokens: number}}}
 */
function usageFor(body, call) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const system = messages.filter(message => isRecord(message) && message.role === 'system');
  const promptChars = JSON.stringify(messages).length + JSON.stringify(tools).length;
  const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
  // The system prompt and the tool schemas are the stable prefix of every turn,
  // which is what a provider reports as a cache read.
  const prefixChars = JSON.stringify(system).length + JSON.stringify(tools).length;
  const cachedTokens = Math.min(promptTokens, Math.max(0, Math.ceil(prefixChars / 4)));
  const completionChars = call.name.length + JSON.stringify(call.arguments).length;
  return { prompt_tokens: promptTokens, completion_tokens: Math.max(1, Math.ceil(completionChars / 4)), prompt_tokens_details: { cached_tokens: cachedTokens } };
}

/**
 * Bind port for the fixture. `0` means an ephemeral port, which is the default.
 * @param {unknown} value
 * @returns {number}
 */
function resolvePort(value) {
  if (value === undefined || value === null || value === '') return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`MOCK_LLM_PORT must be an integer from 0 to 65535, got ${JSON.stringify(value)}`);
  return port;
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(payload);
}

/** @param {import('node:http').IncomingMessage} req @returns {Promise<string>} */
async function readBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = /** @type {Buffer} */ (chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Start the fixture and resolve once it is listening on loopback.
 * @param {{port?: number}} [options] pin the bind port; defaults to MOCK_LLM_PORT, or
 * an ephemeral port when that is unset.
 * @returns {Promise<MockLlmServer>}
 */
export async function createMockLlmServer(options = {}) {
  const requestedPort = options.port ?? resolvePort(process.env.MOCK_LLM_PORT);
  let requests = 0;
  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (!res.headersSent) sendJson(res, 500, { error: { message: error instanceof Error ? error.message : String(error), type: 'fixture_error' } });
      else res.end();
    });
  });

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return sendJson(res, 200, { object: 'list', data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'navi-fixture' }] });
    }
    if (url.pathname !== '/v1/chat/completions') {
      return sendJson(res, 404, { error: { message: `No route for ${req.method ?? 'GET'} ${url.pathname}.`, type: 'invalid_request_error' } });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'Use POST /v1/chat/completions.', type: 'invalid_request_error' } });
    /** @type {Record<string, any>} */
    let body;
    try {
      const parsed = JSON.parse(await readBody(req));
      if (!isRecord(parsed)) throw new Error('Body must be a JSON object');
      body = parsed;
    } catch (error) {
      return sendJson(res, 400, { error: { message: error instanceof Error ? error.message : 'Unparsable body', type: 'invalid_request_error' } });
    }
    if (!Array.isArray(body.messages)) return sendJson(res, 400, { error: { message: 'messages is required', type: 'invalid_request_error' } });
    requests++;
    const toolNames = (Array.isArray(body.tools) ? body.tools : []).map(entry => (isRecord(entry) && isRecord(entry.function) ? asText(entry.function.name) : null)).filter(/** @returns {name is string} */ name => typeof name === 'string');
    const call = plan(replay(body.messages), toolNames);
    return sendJson(res, 200, {
      id: `chatcmpl-fixture-${requests}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: typeof body.model === 'string' ? body.model : MODEL_ID,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: `call_${requests}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }]
        },
        finish_reason: 'tool_calls'
      }],
      usage: usageFor(body, call)
    });
  }

  await new Promise(/** @param {(value?: void) => void} resolve @param {(reason?: unknown) => void} reject */ (resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The mock model could not bind a loopback port');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    baseUrl: `${origin}/v1`,
    model: MODEL_ID,
    get requests() { return requests; },
    close: () => new Promise(/** @param {(value?: void) => void} resolve */ resolve => server.close(() => resolve()))
  };
}
