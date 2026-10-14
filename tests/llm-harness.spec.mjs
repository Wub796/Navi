import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { artifactPaths, childEnvironment, countUsage, LOCAL_INFERENCE_PRESETS, modelTurn, percentile, preflightEndpoint, resolveConfig } from './llm-agent-benchmark.mjs';
import { createMockLlmServer } from './fixtures/mock-llm-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);

/**
 * A stand-in for a local OpenAI-compatible daemon: it answers `GET /models` and one
 * prepared tool-calling completion, and it records what it was asked. Modelling the
 * daemon is the only way to exercise the preflight's success path without a model
 * installed, and the request log is how these tests prove the probe is the shape the
 * daemon actually has to accept.
 * @param {{models?: string[], toolCall?: string | null, toolArguments?: string, modelsStatus?: number, chatStatus?: number, body?: unknown}} [options]
 */
async function createStubDaemon(options = {}) {
  /** @type {{path: string, body: any, authorization?: string}[]} */
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ path: String(req.url), body, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') {
      res.writeHead(options.modelsStatus ?? 200);
      res.end(JSON.stringify(options.body ?? { object: 'list', data: (options.models ?? ['stub-tools-a']).map(id => ({ id, object: 'model' })) }));
      return;
    }
    res.writeHead(options.chatStatus ?? 200);
    const call = options.toolCall === undefined ? 'navi_preflight_probe' : options.toolCall;
    res.end(JSON.stringify({ choices: [{ message: call
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: call, arguments: options.toolArguments ?? '{"value":"ok"}' } }] }
      : { role: 'assistant', content: 'I cannot call tools.' } }], usage: { prompt_tokens: 12, completion_tokens: 8 } }));
  });
  await new Promise(/** @param {(value?: void) => void} resolve */ resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing stub address');
  const close = () => new Promise(resolve => server.close(resolve));
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, close, port: address.port };
}
// The failure taxonomy has its own spec: tests/failure-classifier.spec.mjs.

test('LLM HTTP contract sends model tools and preserves provider usage without exposing keys', async () => {
  /** @type {any} */
  let received;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received = { path: req.url, body: JSON.parse(raw), authorized: req.headers.authorization === 'Bearer test-only' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'one', type: 'function', function: { name: 'observe_page', arguments: '{}' } }] } }], usage: { prompt_tokens: 100, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 40 } } }));
  });
  await new Promise(/** @param {(value?: void) => void} resolve */ resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  try {
    const tools = [{ type: 'function', function: { name: 'observe_page', parameters: { type: 'object' } } }];
    const response = await modelTurn({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test-stub-not-live-llm', apiKey: 'test-only', iterations: 1, maxTurns: 1 }, [{ role: 'user', content: 'Test' }], tools);
    expect(received.path).toBe('/v1/chat/completions');
    expect(received.authorized).toBe(true);
    expect(received.body.tools).toEqual(tools);
    expect(received.body.model).toBe('test-stub-not-live-llm');
    expect(response.usage).toEqual({ prompt_tokens: 100, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 40 } });
    expect(response.message.tool_calls[0].function.name).toBe('observe_page');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('provider usage is accounted verbatim: prompt, completion and cached tokens stay unknown when absent', () => {
  /** @type {any} */
  const trial = { path: 'test', iteration: 1, success: false, steps: 0, requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, usageComplete: true, cachedComplete: true, wallMs: 0, failures: [] };
  countUsage(trial, { prompt_tokens: 100, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 40 } });
  countUsage(trial, { prompt_tokens: 200, completion_tokens: 30, cached_tokens: 60 });
  expect(trial.inputTokens).toBe(300);
  expect(trial.outputTokens).toBe(55);
  // Both provider shapes are read, and cached reads are never subtracted from
  // the billed prompt total or replaced by a local estimate.
  expect(trial.cachedTokens).toBe(100);
  expect(trial.cachedComplete).toBe(true);
  countUsage(trial, undefined);
  expect(trial.usageComplete).toBe(false);
  expect(trial.cachedComplete).toBe(false);
  expect(trial.inputTokens).toBe(300);
  expect(trial.cachedTokens).toBe(100);
});

test('model endpoint rejects remote plaintext and embedded credentials before fetching', async () => {
  for (const baseUrl of ['http://remote.example/v1', 'https://user:secret@example.com/v1']) {
    await expect(modelTurn({ baseUrl, model: 'test', iterations: 1, maxTurns: 1 }, [], [])).rejects.toThrow();
  }
});

test('live model configuration is read from the environment only and a partial setup fails closed', () => {
  expect(resolveConfig({})).toHaveProperty('error');
  expect(resolveConfig({ LLM_ENDPOINT: 'http://127.0.0.1:11434/v1' })).toHaveProperty('error');
  expect(resolveConfig({ LLM_MODEL: 'llama-tools' })).toHaveProperty('error');
  // A remote endpoint without a key is refused rather than attempted anonymously.
  expect(resolveConfig({ LLM_ENDPOINT: 'https://api.example.com/v1', LLM_MODEL: 'gpt-test' })).toHaveProperty('error');
  const remote = resolveConfig({ LLM_ENDPOINT: 'https://api.example.com/v1', LLM_MODEL: 'gpt-test', LLM_API_KEY: 'secret-value', LLM_ITERATIONS: '2', LLM_MAX_TURNS: '9' });
  expect(remote).toMatchObject({ config: { baseUrl: 'https://api.example.com/v1', model: 'gpt-test', apiKey: 'secret-value', iterations: 2, maxTurns: 9 } });
  // A loopback OpenAI-compatible server needs no key (Ollama and friends).
  const local = /** @type {any} */ (resolveConfig({ LLM_ENDPOINT: 'http://localhost:11434/v1', LLM_MODEL: 'qwen-tools' }));
  expect(local).not.toHaveProperty('error');
  expect(local.config.model).toBe('qwen-tools');
  expect(local.config.apiKey).toBeUndefined();
  expect(resolveConfig({ LLM_ENDPOINT: 'http://127.0.0.1:11434/v1', LLM_MODEL: 'm', LLM_ITERATIONS: '99' })).toHaveProperty('error');
  expect(resolveConfig({ LLM_ENDPOINT: 'not-a-url', LLM_MODEL: 'm' })).toHaveProperty('error');
});

test('an unconfigured run is distinguishable from a half-configured one', () => {
  // 'unconfigured' is the only case the runner answers with the local fixture; a
  // partial or invalid setup stays an error, so LLM_ENDPOINT without LLM_MODEL can
  // never be mistaken for a deliberate fixture run.
  expect(resolveConfig({})).toMatchObject({ reason: 'unconfigured' });
  expect(resolveConfig({ LLM_ENDPOINT: 'http://127.0.0.1:11434/v1' })).toMatchObject({ reason: 'invalid' });
  expect(resolveConfig({ LLM_MODEL: 'llama-tools' })).toMatchObject({ reason: 'invalid' });
  // The knobs are validated in fixture mode too, so a bad iteration count cannot
  // be accepted merely because no endpoint was named.
  expect(resolveConfig({ LLM_ITERATIONS: '99' })).toMatchObject({ reason: 'invalid' });
  expect(resolveConfig({ LLM_MAX_TURNS: '0' })).toMatchObject({ reason: 'invalid' });
  // The fixture can also be requested by name, which is the only way to reach it while
  // an endpoint variable is set at all. Any casing counts, and LLM_MODEL is ignored
  // rather than required, because the fixture answers as itself.
  expect(resolveConfig({ LLM_ENDPOINT: 'mock' })).toMatchObject({ reason: 'mock' });
  expect(resolveConfig({ LLM_ENDPOINT: 'MOCK' })).toMatchObject({ reason: 'mock' });
  expect(resolveConfig({ LLM_ENDPOINT: 'mock', LLM_MODEL: 'ignored' })).toMatchObject({ reason: 'mock' });
  // Naming the fixture by hand is not a way to skip the knobs: a bad count still fails.
  expect(resolveConfig({ LLM_ENDPOINT: 'mock', LLM_ITERATIONS: '99' })).toMatchObject({ reason: 'invalid' });
  // Asking for the fixture while forbidding it is a contradiction, and the fail-closed
  // flag wins: a caller who required a live model never gets a fixture baseline.
  expect(resolveConfig({ LLM_ENDPOINT: 'mock', NAVI_LLM_FIXTURE: '0' })).toMatchObject({ reason: 'invalid' });
});

test('the local fixture answers as an OpenAI-compatible tool-calling model and advances its plan', async () => {
  const fixture = await createMockLlmServer();
  const config = { baseUrl: fixture.baseUrl, model: fixture.model, iterations: 1, maxTurns: 1 };
  const tools = [
    { type: 'function', function: { name: 'observe_page', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'browser_action', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'finish_task', parameters: { type: 'object' } } }
  ];
  try {
    const task = [{ role: 'user', content: 'Complete the sandbox checkout.' }];
    const first = await modelTurn(config, task, tools);
    expect(first.message.tool_calls[0].function.name).toBe('observe_page');
    // The usage envelope is the shape the accounting path reads, with simulated
    // figures derived from the request rather than a provider's report.
    expect(Number.isInteger(first.usage?.prompt_tokens) && first.usage.prompt_tokens > 0).toBe(true);
    expect(Number.isInteger(first.usage?.completion_tokens) && first.usage.completion_tokens > 0).toBe(true);
    expect(Number.isInteger(first.usage?.prompt_tokens_details?.cached_tokens)).toBe(true);
    expect(first.usage.prompt_tokens_details.cached_tokens).toBeLessThanOrEqual(first.usage.prompt_tokens);

    // The same conversation is served again: the fixture replays its own emitted
    // call and the tool result, and moves to the next step rather than repeating.
    const second = await modelTurn(config, [
      ...task,
      { role: 'assistant', content: null, tool_calls: first.message.tool_calls },
      { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: JSON.stringify({ url: 'http://127.0.0.1:1/checkout', snapshot: 'button "Search products"' }) }
    ], tools);
    expect(second.message.tool_calls[0].function.name).toBe('browser_action');
    expect(JSON.parse(second.message.tool_calls[0].function.arguments)).toMatchObject({ role: 'textbox', action: 'type' });
    expect(fixture.requests).toBe(2);
  } finally {
    await fixture.close();
  }
});

test('the mock fixture binds an ephemeral port by default, and MOCK_LLM_PORT is honoured when set', async () => {
  const first = await createMockLlmServer();
  const second = await createMockLlmServer();
  try {
    // Ephemeral by default, so two instances coexist - which is what lets the benchmark
    // and this contract spec run without either one having to know about the other.
    expect(new URL(first.baseUrl).port).not.toBe(new URL(second.baseUrl).port);
    // `baseUrl` already ends in /v1, which is how the harness appends /chat/completions.
    expect((await fetch(`${first.baseUrl}/models`)).status).toBe(200);
    const taken = Number(new URL(first.baseUrl).port);
    // A pinned port is honoured rather than treated as a hint: a caller who named a port
    // is going to connect to the port they named, so a collision has to be an error.
    await expect(createMockLlmServer({ port: taken })).rejects.toThrow(/EADDRINUSE|address already in use/i);
    process.env.MOCK_LLM_PORT = String(taken);
    await expect(createMockLlmServer()).rejects.toThrow(/EADDRINUSE|address already in use/i);
    // A value that is not a port is refused with the variable named, never coerced.
    process.env.MOCK_LLM_PORT = 'not-a-port';
    await expect(createMockLlmServer()).rejects.toThrow(/MOCK_LLM_PORT/);
  } finally {
    delete process.env.MOCK_LLM_PORT;
    await first.close();
    await second.close();
  }
});

test('the child MCP process never inherits provider credentials', () => {
  const scrubbed = childEnvironment({ PATH: '/usr/bin', LLM_API_KEY: 'secret-value', OPENAI_API_KEY: 'other', NAVI_MCP_TOKEN: 'token', DB_PASSWORD: 'pw', LLM_ENDPOINT: 'http://127.0.0.1:11434/v1' });
  expect(scrubbed).toEqual({ PATH: '/usr/bin', LLM_ENDPOINT: 'http://127.0.0.1:11434/v1' });
});

test('a live run writes its own artifacts, and no path it can write is a baseline artifact', () => {
  const fixture = artifactPaths(true);
  const live = artifactPaths(false);
  // The exact names are contract, not preference: the release documents link to them.
  expect(live.report.href.endsWith('/reports/LLM-TCR-BENCHMARK-LIVE.md')).toBe(true);
  expect(live.raw.href.endsWith('/reports/llm-benchmark-live.json')).toBe(true);
  expect(fixture.report.href.endsWith('/reports/LLM-TCR-BENCHMARK.md')).toBe(true);
  expect(fixture.raw.href.endsWith('/reports/llm-benchmark.json')).toBe(true);
  expect(fixture.alias?.href.endsWith('/reports/llm-tcr-benchmark.json')).toBe(true);
  // A live run has no alias: the pre-rename name is the baseline's own record, so
  // "live" cannot be given a second file that a fixture run also writes.
  expect(live.alias).toBeNull();
  // Disjointness is the invariant, asserted on the resolved URLs rather than on the
  // names, so a later rename cannot quietly reintroduce a shared file.
  const liveFiles = [live.report.href, live.raw.href];
  const baselineFiles = [fixture.report.href, fixture.raw.href, fixture.alias?.href];
  expect(liveFiles.filter(file => baselineFiles.includes(file))).toEqual([]);
});

test('a local daemon can be named instead of addressed, and still needs an explicit model', () => {
  // The three daemons the harness knows are the three OpenAI-compatible servers a
  // local run is actually started with; each resolves to its documented default port.
  expect(Object.keys(LOCAL_INFERENCE_PRESETS)).toEqual(['ollama', 'vllm', 'lmstudio']);
  for (const [name, preset] of Object.entries(LOCAL_INFERENCE_PRESETS)) {
    // A preset is loopback by construction, so it can never be a way around the
    // HTTPS-plus-key rule for remote endpoints.
    expect(new URL(preset.baseUrl).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
    const local = /** @type {any} */ (resolveConfig({ LLM_ENDPOINT: name, LLM_MODEL: 'm' }));
    expect(local.config.baseUrl).toBe(preset.baseUrl);
    expect(local.config.preset).toBe(name);
    expect(local.config.apiKey).toBeUndefined();
  }
  expect(/** @type {any} */ (resolveConfig({ LLM_ENDPOINT: 'OLLAMA', LLM_MODEL: 'm' })).config.baseUrl).toBe(LOCAL_INFERENCE_PRESETS.ollama.baseUrl);
  // The weights are not inferred from whatever happens to be installed: naming the
  // daemon is a port, and choosing the model stays the caller's decision.
  const missing = /** @type {any} */ (resolveConfig({ LLM_ENDPOINT: 'ollama' }));
  expect(missing.reason).toBe('invalid');
  expect(missing.error).toContain('ollama list');
  // A full URL keeps working and is not mistaken for a preset name.
  const addressed = /** @type {any} */ (resolveConfig({ LLM_ENDPOINT: 'http://127.0.0.1:9999/v1', LLM_MODEL: 'm' }));
  expect(addressed.config.baseUrl).toBe('http://127.0.0.1:9999/v1');
  expect(addressed.config.preset).toBeUndefined();
});

test('the preflight proves the model is served and that it calls tools before any task runs', async () => {
  const daemon = await createStubDaemon({ models: ['another-model', 'stub-tools-a'] });
  try {
    const result = await preflightEndpoint({ baseUrl: daemon.baseUrl, model: 'stub-tools-a', iterations: 1, maxTurns: 1 });
    expect(result).toMatchObject({ ok: true, endpoint: daemon.baseUrl, models: ['another-model', 'stub-tools-a'] });
    expect(result.ok && Number.isFinite(result.probeMs)).toBe(true);
    // Two requests, in this order: the model list decides whether the probe is worth
    // sending at all, and the probe is a real tool-calling completion.
    expect(daemon.requests.map((/** @type {any} */ entry) => entry.path)).toEqual(['/v1/models', '/v1/chat/completions']);
    const probe = daemon.requests[1].body;
    expect(probe.model).toBe('stub-tools-a');
    expect(probe.tool_choice).toBe('auto');
    expect(probe.tools.map((/** @type {any} */ entry) => entry.function.name)).toEqual(['navi_preflight_probe']);
    // No key is set for a loopback daemon, and none is invented for it.
    expect(daemon.requests.every((/** @type {any} */ entry) => entry.authorization === undefined)).toBe(true);
  } finally { await daemon.close(); }

  // The same check on an authenticated endpoint carries the key and nothing else.
  const secured = await createStubDaemon();
  try {
    const authorized = await preflightEndpoint({ baseUrl: secured.baseUrl, model: 'stub-tools-a', apiKey: 'test-only', iterations: 1, maxTurns: 1 });
    expect(authorized.ok).toBe(true);
    expect(secured.requests.every(entry => entry.authorization === 'Bearer test-only')).toBe(true);
  } finally { await secured.close(); }
});

test('the preflight fails closed with a named reason and the setup steps that fix it', async () => {
  /** @param {string} baseUrl @param {string} [model] */
  const check = (baseUrl, model = 'stub-tools-a') => preflightEndpoint({ baseUrl, model, iterations: 1, maxTurns: 1 });
  /** @param {any} result @param {string} code */
  const expectRefusal = (result, code) => {
    expect(result.ok).toBe(false);
    expect(result.code).toBe(code);
    expect(typeof result.detail).toBe('string');
    // Every refusal has to be printable: `main` exits 2 with these lines, so an empty
    // or blank instruction would be a fail-fast with nothing to act on.
    expect(Array.isArray(result.instructions) && result.instructions.length).toBeGreaterThan(0);
    expect(result.instructions.filter((/** @type {any} */ line) => typeof line !== 'string' || !line.trim())).toEqual([]);
    // ...and the steps have to be steps, not a restatement of the failure.
    expect(result.instructions.join(' ')).toMatch(/curl|LLM_MODEL|Start the/);
  };

  // 1. Nothing listening on the port - what an operator who never started the daemon hits.
  const dead = await createStubDaemon();
  const deadPort = dead.port;
  await dead.close();
  const unreachable = /** @type {any} */ (await check(`http://127.0.0.1:${deadPort}/v1`));
  expectRefusal(unreachable, 'ENDPOINT_UNREACHABLE');
  expect(unreachable.instructions.join(' ')).toContain(`127.0.0.1:${deadPort}`);
  // The daemon names are offered as the fix, so a reader is not left guessing ports.
  expect(unreachable.instructions.join(' ')).toContain('LLM_ENDPOINT=ollama');

  // 2. A server that answers, but not with a model list.
  const notCompatible = await createStubDaemon({ body: { ok: true } });
  try { expectRefusal(/** @type {any} */ (await check(notCompatible.baseUrl)), 'ENDPOINT_NOT_OPENAI_COMPATIBLE'); } finally { await notCompatible.close(); }

  // 3. A model list behind an error status is a failure, not an empty catalogue.
  const broken = await createStubDaemon({ modelsStatus: 500 });
  try {
    const failed = /** @type {any} */ (await check(broken.baseUrl));
    expectRefusal(failed, 'ENDPOINT_MODELS_FAILED');
    expect(failed.detail).toContain('500');
  } finally { await broken.close(); }

  // 4. The daemon is up and reachable, but serves something else: the message names
  //    both the model that was asked for and what is actually installed.
  const wrongModel = await createStubDaemon({ models: ['qwen3:8b'] });
  try {
    const missing = /** @type {any} */ (await check(wrongModel.baseUrl, 'not-installed'));
    expectRefusal(missing, 'MODEL_NOT_SERVED');
    expect(missing.detail).toContain('not-installed');
    expect(missing.detail).toContain('qwen3:8b');
  } finally { await wrongModel.close(); }

  // 5. The expensive case: the model exists but cannot call tools, which a model list
  //    cannot tell you and which would otherwise be discovered as a 0% TCR after a full run.
  const noTools = await createStubDaemon({ toolCall: null });
  try {
    const text = /** @type {any} */ (await check(noTools.baseUrl));
    expectRefusal(text, 'TOOL_CALLING_UNSUPPORTED');
    expect(text.instructions.join(' ')).toContain('tool-calling model');
  } finally { await noTools.close(); }

  // 6. A probe that is refused outright is reported as the probe's failure, not as an
  //    unreachable endpoint: the two have different fixes.
  const probeRefused = await createStubDaemon({ chatStatus: 400 });
  try {
    const refused = /** @type {any} */ (await check(probeRefused.baseUrl));
    expectRefusal(refused, 'PROBE_FAILED');
    expect(refused.detail).toContain('400');
  } finally { await probeRefused.close(); }
});

test('an unreachable endpoint exits 2 with instructions and writes no report at all', async () => {
  const daemon = await createStubDaemon();
  const port = daemon.port;
  await daemon.close();
  const fixture = artifactPaths(true);
  const live = artifactPaths(false);
  const baselineBefore = await readFile(fixture.report);
  const baselineRawBefore = await readFile(fixture.raw);
  const liveReportBefore = await readFile(live.report).catch(() => null);
  const liveRawBefore = await readFile(live.raw).catch(() => null);

  const failure = await run(process.execPath, ['tests/llm-agent-benchmark.mjs'], {
    cwd: root,
    env: { ...process.env, LLM_ENDPOINT: `http://127.0.0.1:${port}/v1`, LLM_MODEL: 'stub-tools-a', LLM_ITERATIONS: '1', LLM_MAX_TURNS: '1' }
  }).then(() => null, /** @param {any} error */ error => error);

  expect(failure).not.toBeNull();
  expect(failure.code).toBe(2);
  expect(String(failure.stderr)).toContain('ENDPOINT_UNREACHABLE');
  expect(String(failure.stderr)).toContain('- Start');
  expect(String(failure.stderr)).toContain('no benchmark was run and no report was written');
  // Nothing was written: the committed baseline is byte-identical afterwards and the
  // live artifacts were not created either, so a failed preflight is not a failed run
  // that still left a report behind for someone to misread.
  expect((await readFile(fixture.report)).equals(baselineBefore)).toBe(true);
  expect((await readFile(fixture.raw)).equals(baselineRawBefore)).toBe(true);
  expect(await readFile(live.report).catch(() => null)).toEqual(liveReportBefore);
  expect(await readFile(live.raw).catch(() => null)).toEqual(liveRawBefore);
});

test('invalid configuration and preflight-only setup preserve every existing report', async () => {
  const files = [...Object.values(artifactPaths(true)), ...Object.values(artifactPaths(false))].filter(file => file !== null);
  const before = await Promise.all(files.map(file => readFile(file).catch(() => null)));
  const cleanEnv = { ...childEnvironment(), LLM_ENDPOINT: '', LLM_BASE_URL: '', LLM_MODEL: '', NAVI_LLM_FIXTURE: '0' };
  for (const env of [{ ...cleanEnv, LLM_ENDPOINT: 'ollama' }, { ...cleanEnv, LLM_ITERATIONS: '99' }, cleanEnv]) {
    const failure = await run(process.execPath, ['tests/llm-agent-benchmark.mjs', '--preflight'], { cwd: root, env })
      .then(() => null, /** @param {any} error */ error => error);
    expect(failure?.code).toBe(2);
    expect(String(failure?.stderr)).toContain('no report was written');
    expect(await Promise.all(files.map(file => readFile(file).catch(() => null)))).toEqual(before);
  }
});

test('a tool name without valid JSON arguments cannot pass capability preflight', async () => {
  for (const toolArguments of ['not-json', '{}', '{"value":"wrong"}']) {
    const daemon = await createStubDaemon({ toolArguments });
    try {
      expect(await preflightEndpoint({ baseUrl: daemon.baseUrl, model: 'stub-tools-a', iterations: 1, maxTurns: 1 }))
        .toMatchObject({ ok: false, code: 'TOOL_CALLING_UNSUPPORTED' });
    } finally { await daemon.close(); }
  }
});

test('the CLI writes live token, latency and TCR artifacts without touching fixture baselines', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'navi-live-contract-'));
  const daemon = await createStubDaemon();
  try {
    for (const directory of ['tests/fixtures', 'reports', 'src']) await mkdir(join(workspace, directory), { recursive: true });
    for (const path of ['tests/llm-agent-benchmark.mjs', 'tests/fixtures/tcr-app.mjs', 'tests/fixtures/mock-llm-server.mjs', 'src/failure-classifier.js', 'src/settle.js', 'bin', 'dist', 'demo', 'package.json']) {
      await cp(join(root, path), join(workspace, path), { recursive: true });
    }
    await symlink(join(root, 'node_modules'), join(workspace, 'node_modules'), 'dir');
    const baselineFiles = ['LLM-TCR-BENCHMARK.md', 'llm-benchmark.json', 'llm-tcr-benchmark.json'];
    for (const name of baselineFiles) await cp(join(root, 'reports', name), join(workspace, 'reports', name));
    const before = await Promise.all(baselineFiles.map(name => readFile(join(workspace, 'reports', name))));
    const env = { ...childEnvironment(), LLM_ENDPOINT: daemon.baseUrl, LLM_MODEL: 'stub-tools-a', LLM_ITERATIONS: '1', LLM_MAX_TURNS: '1' };
    const preflight = await run(process.execPath, ['tests/llm-agent-benchmark.mjs', '--preflight'], { cwd: workspace, env });
    expect(preflight.stdout).toContain('LLM preflight ok');
    // This daemon is deliberately not a planner: failed tasks must still record
    // provider-reported usage and timing, not masquerade as completed orders.
    const result = await run(process.execPath, ['tests/llm-agent-benchmark.mjs'], { cwd: workspace, env })
      .then(() => null, /** @param {any} error */ error => error);
    expect(result?.code).toBe(1);
    const report = JSON.parse(await readFile(join(workspace, 'reports/llm-benchmark-live.json'), 'utf8'));
    expect(report.status).toBe('measured');
    expect(report.fixture).toBeNull();
    expect(report.trials).toHaveLength(2);
    for (const summary of report.summaries) {
      expect(summary).toMatchObject({ successes: 0, trials: 1, inputTokens: 12, outputTokens: 8, cachedInputTokens: null });
      expect(summary.latency.turns).toBe(1);
      expect(summary.latency.meanTurnMs).toBeGreaterThan(0);
    }
    for (const trial of report.trials) expect(trial.turnLatenciesMs).toHaveLength(trial.requests);
    // A refusal is recorded with the call that produced it, verbatim. The bucket alone
    // says what the harness thought went wrong, not what the model actually sent, so a
    // root-cause audit would have to replay the model to learn it.
    const refusals = report.trials.flatMap(/** @param {any} trial */ trial => trial.failures).filter(/** @param {any} failure */ failure => failure.tool !== undefined);
    expect(refusals, 'a refused tool call must be recorded with the call that produced it').not.toHaveLength(0);
    for (const refusal of refusals) {
      expect(refusal.tool).toBe('navi_preflight_probe');
      // Kept as emitted and unparsed, so malformed arguments stay visible as the model
      // wrote them rather than as this harness's own parse error.
      expect(refusal.rawArgs).toBe('{"value":"ok"}');
    }
    expect(await readFile(join(workspace, 'reports/LLM-TCR-BENCHMARK-LIVE.md'), 'utf8')).toContain('0.0%');
    expect(await Promise.all(baselineFiles.map(name => readFile(join(workspace, 'reports', name))))).toEqual(before);
  } finally {
    await daemon.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('turn latency is summarised so a slow tail is visible, and an absent measurement stays unknown', () => {
  // A mean alone hides the tail, which is what a caller feels; the percentile is the
  // number that has to be right, including on the smallest possible samples.
  expect(percentile([], 95)).toBeNull();
  expect(percentile([7], 95)).toBe(7);
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  // Arrival order must not matter, and the caller's array must not be reordered.
  const sample = [30, 10, 20];
  expect(percentile(sample, 50)).toBe(20);
  expect(sample).toEqual([30, 10, 20]);
});
