import { test, expect } from '@playwright/test';
import { TOOLS } from '../src/mcp/server.js';
import { SETTLE_MODES, normalizeSettle } from '../src/settle.js';
import { rawTools, settleArguments, toolFromDescriptor } from './llm-agent-benchmark.mjs';

/**
 * One contract, two readers.
 *
 * `src/mcp/server.js` advertises the schema an agent reads and validates every call it
 * receives with `src/settle.js`; the benchmark harness drives that same server on a
 * model's behalf. When the two disagree, the harness is not measuring the model — it is
 * measuring a contract nothing else has. That is not hypothetical: a recorded run lost
 * eight trials to `INVALID_SETTLE: Settlement request required` for calls the server
 * would have accepted, which read as a model failure and was a harness one.
 *
 * So the properties that drifted are pinned here, read from the server's own tool list
 * and from the harness's own exported entry points rather than from either side's prose.
 */
/** @type {any} The tool array is a literal of differently shaped entries, so this is the
 * boundary at which the shape this file pins is stated. */
const tools = TOOLS;
const executeTool = tools.find(/** @param {{name: string}} candidate */ candidate => candidate.name === 'navi_execute_action');
// The execution tool is the subject of every assertion here; a missing one is a failure.
if (!executeTool) throw new Error('navi_execute_action must be advertised');
/** @type {any} */
const raw = rawTools;

test('the served schema advertises settlement as optional, out of the same module', () => {
  expect(executeTool.inputSchema.required).toEqual(['target_id', 'action_type']);
  expect(executeTool.inputSchema.required).not.toContain('settle');
  const settle = executeTool.inputSchema.properties.settle;
  expect(settle, 'the schema must advertise settle').toBeTruthy();
  // The enum an agent picks from and the list the runtime validates against are one list.
  expect(settle.properties.wait_for.enum).toEqual([...SETTLE_MODES]);
  expect(executeTool.inputSchema.properties.action_type.enum).toEqual(['click', 'type', 'select']);
  // And the default the schema documents is the one the runtime resolves for an absent
  // wait_for, so the sentence an agent reads and the behaviour it gets are one rule.
  const omitted = normalizeSettle({});
  if ('error' in omitted) throw new Error(omitted.error);
  expect(omitted.plan.waitFor).toBe('mutation_settle');
});

test('the harness resolves a call exactly as the served schema describes', () => {
  // The model is handed the server's schema object itself, not a transcription of it.
  expect(toolFromDescriptor(executeTool).function.parameters).toBe(executeTool.inputSchema);
  // An omitted settlement is a conforming call, because the schema requires only
  // target_id and action_type, and it resolves to the documented default.
  expect(settleArguments({ target_id: 'checkout', action_type: 'click' }).settle).toEqual({ wait_for: 'mutation_settle' });
  // Every mode the schema advertises is accepted, and the request survives intact.
  for (const mode of executeTool.inputSchema.properties.settle.properties.wait_for.enum) {
    expect(settleArguments({ settle: { wait_for: mode, timeout_ms: 1500 } }).settle).toEqual({ wait_for: mode, timeout_ms: 1500 });
  }
  // Whatever the server's own rule refuses, the harness refuses — including the values
  // that are merely falsy rather than absent, which is where "optional" is easy to
  // over-read.
  for (const requested of [null, 'mutation_settle', [], { wait_for: 'settle' }, { wait_for: 'parallax' }, { typo_ms: 10 }, { timeout_ms: 0 }, { timeout_ms: 60001 }, { timeout_ms: 100.5 }]) {
    if (!('error' in normalizeSettle(requested))) throw new Error(`expected the module to refuse ${JSON.stringify(requested)}`);
    expect(() => settleArguments({ settle: requested }), JSON.stringify(requested)).toThrow(/INVALID_SETTLE/);
  }
});

test('no path offers a model a value the served schema would reject', () => {
  const browserAction = raw.find(/** @param {{function: {name: string}}} candidate */ candidate => candidate.function.name === 'browser_action');
  if (!browserAction) throw new Error('the raw path must offer browser_action');
  const properties = browserAction.function.parameters.properties;
  // A model that can only choose from the served enums cannot be recorded as failing a
  // call the server would have refused for a reason that has nothing to do with it.
  expect(properties.action.enum).toEqual(executeTool.inputSchema.properties.action_type.enum);
  expect(Array.isArray(properties.wait_for.enum) && properties.wait_for.enum.length > 0).toBe(true);
  for (const mode of properties.wait_for.enum) expect([...SETTLE_MODES]).toContain(mode);
});
