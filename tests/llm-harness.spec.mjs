import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { modelTurn, countUsage, resolveConfig, childEnvironment } from './llm-agent-benchmark.mjs';
import { createMockLlmServer } from './fixtures/mock-llm-server.mjs';
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
