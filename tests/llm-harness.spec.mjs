import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { modelTurn, countUsage, resolveConfig, childEnvironment } from './llm-agent-benchmark.mjs';
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

test('the child MCP process never inherits provider credentials', () => {
  const scrubbed = childEnvironment({ PATH: '/usr/bin', LLM_API_KEY: 'secret-value', OPENAI_API_KEY: 'other', NAVI_MCP_TOKEN: 'token', DB_PASSWORD: 'pw', LLM_ENDPOINT: 'http://127.0.0.1:11434/v1' });
  expect(scrubbed).toEqual({ PATH: '/usr/bin', LLM_ENDPOINT: 'http://127.0.0.1:11434/v1' });
});
