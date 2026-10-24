// Deterministic flow execution over the Navi adapter.
// Flows are plain JSON so they can be reviewed, diffed and vendored.

const MAX_STEPS = 200;
const MAX_TEXT = 10000;
const MAX_TIMEOUT = 120000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ACTIONS = new Set(['click', 'type', 'select']);
// 'name' resolves through the Navi action map, so it also works for closed shadow
// roots and same-origin frames that plain CSS selectors cannot reach.
const ASSERT_MODES = new Set(['text', 'value', 'visible', 'exists', 'url', 'name']);

/** @typedef {{kind:'action',label:string,target:string,action:string,text?:string,value?:string,consequential:boolean}} ActionStep */
/** @typedef {{kind:'assert',label:string,mode:string,target?:string,selector?:string,equals?:string,contains?:string,matches?:string,timeoutMs?:number}} AssertStep */
/** @typedef {{found:boolean,visible?:boolean,name?:string,text?:string,value?:string,url:string}} Observation */
/** @typedef {{kind:'wait',label:string,ms:number}} WaitStep */
/** @typedef {{kind:'waitFor',label:string,selector?:string,text?:string,urlIncludes?:string,timeoutMs:number}} WaitForStep */
/** @typedef {{kind:'scrollTo',label:string,target:string}} ScrollStep */
/** @typedef {ActionStep|AssertStep|WaitStep|WaitForStep|ScrollStep} FlowStep */
/** @typedef {{name:string,url?:string,steps:FlowStep[]}} NaviFlow */
/** @typedef {{index:number,label:string,kind:string,ok:boolean,durationMs:number,mode?:string,error?:{code:string,message:string}}} StepResult */

const STEP_KEYS = {
  action: new Set(['label', 'target', 'action', 'text', 'value', 'consequential', 'expect']),
  assert: new Set(['label', 'assert', 'target', 'selector', 'equals', 'contains', 'matches', 'timeoutMs']),
  wait: new Set(['label', 'wait']),
  waitFor: new Set(['label', 'waitFor', 'timeoutMs']),
  scrollTo: new Set(['label', 'scrollTo'])
};

/** @param {unknown} value */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is string} */
function isBoundedString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

/**
 * Validate and normalize an untrusted flow document.
 * @param {unknown} input
 * @returns {{ok:true,flow:NaviFlow}|{ok:false,errors:string[]}}
 */
export function validateFlow(input) {
  /** @type {string[]} */
  const errors = [];
  if (!isPlainObject(input)) return { ok: false, errors: ['flow must be a JSON object'] };
  const raw = /** @type {Record<string, unknown>} */ (input);
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.has(key)) errors.push(`forbidden key "${key}"`);
    else if (!['name', 'url', 'viewport', 'steps'].includes(key)) errors.push(`unknown flow field "${key}"`);
  }
  if (!Array.isArray(raw.steps)) errors.push('flow.steps must be an array');
  else if (raw.steps.length === 0) errors.push('flow.steps must not be empty');
  else if (raw.steps.length > MAX_STEPS) errors.push(`flow.steps must contain at most ${MAX_STEPS} steps`);
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : 'flow';
  if (raw.url !== undefined && !isBoundedString(raw.url)) errors.push('flow.url must be a bounded non-empty string');
  if (errors.length) return { ok: false, errors };

  /** @type {FlowStep[]} */
  const steps = [];
  const list = /** @type {unknown[]} */ (raw.steps);
  for (let index = 0; index < list.length; index++) {
    const step = list[index];
    const at = `steps[${index}]`;
    if (!isPlainObject(step)) { errors.push(`${at} must be an object`); continue; }
    const entry = /** @type {Record<string, unknown>} */ (step);
    const kind = 'action' in entry ? 'action' : 'assert' in entry ? 'assert' : 'wait' in entry ? 'wait' : 'waitFor' in entry ? 'waitFor' : 'scrollTo' in entry ? 'scrollTo' : null;
    if (!kind) { errors.push(`${at} must declare one of action, assert, wait, waitFor or scrollTo`); continue; }
    const declared = ['action', 'assert', 'wait', 'waitFor', 'scrollTo'].filter(key => key in entry);
    if (declared.length > 1) { errors.push(`${at} declares multiple step kinds: ${declared.join(', ')}`); continue; }
    for (const key of Object.keys(entry)) {
      if (FORBIDDEN_KEYS.has(key)) errors.push(`${at} has forbidden key "${key}"`);
      else if (!STEP_KEYS[/** @type {keyof typeof STEP_KEYS} */ (kind)].has(key)) errors.push(`${at} has unknown field "${key}"`);
    }
    const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim().slice(0, 120) : `${kind} ${index + 1}`;

    if (kind === 'action') {
      if (!isBoundedString(entry.target)) errors.push(`${at}.target must be a bounded non-empty string`);
      if (typeof entry.action !== 'string' || !ACTIONS.has(entry.action)) errors.push(`${at}.action must be one of click, type, select`);
      if (entry.action === 'type' && (typeof entry.text !== 'string' || entry.text.length > MAX_TEXT)) errors.push(`${at}.text must be a string of at most ${MAX_TEXT} characters`);
      if (entry.action !== 'type' && entry.text !== undefined) errors.push(`${at}.text is only valid for type actions`);
      if (entry.action === 'select' && (typeof entry.value !== 'string' || !entry.value.length || entry.value.length > 512)) errors.push(`${at}.value must be a bounded non-empty string for select`);
      if (entry.action !== 'select' && entry.value !== undefined) errors.push(`${at}.value is only valid for select actions`);
      if (entry.consequential !== undefined && typeof entry.consequential !== 'boolean') errors.push(`${at}.consequential must be a boolean`);
      if (entry.expect !== undefined) {
        if (!isPlainObject(entry.expect)) errors.push(`${at}.expect must be an object`);
        else {
          for (const key of Object.keys(/** @type {object} */ (entry.expect))) {
            if (!['selector', 'target', 'text', 'value', 'name'].includes(key)) errors.push(`${at}.expect has unknown field "${key}"`);
          }
          const expect = /** @type {Record<string, unknown>} */ (entry.expect);
          const hasComparator = typeof expect.text === 'string' || typeof expect.value === 'string' || typeof expect.name === 'string';
          if (!hasComparator) errors.push(`${at}.expect needs text, value or name`);
          if (!isBoundedString(expect.target) && !isBoundedString(entry.target)) errors.push(`${at}.expect needs a target`);
          if (typeof expect.name !== 'string' && !isBoundedString(expect.selector)) errors.push(`${at}.expect needs a selector or name`);
          if (typeof expect.name === 'string' && isBoundedString(expect.selector)) errors.push(`${at}.expect cannot combine selector and name`);
        }
      }
      if (errors.some(message => message.startsWith(at))) continue;
      /** @type {ActionStep} */
      const normalized = { kind: 'action', label, target: /** @type {string} */ (entry.target), action: /** @type {string} */ (entry.action), consequential: entry.consequential === true };
      if (typeof entry.text === 'string') normalized.text = entry.text;
      if (typeof entry.value === 'string') normalized.value = entry.value;
      steps.push(normalized);
      if (entry.expect !== undefined) {
        const expect = /** @type {Record<string, unknown>} */ (entry.expect);
        const mode = typeof expect.name === 'string' ? 'name' : typeof expect.text === 'string' ? 'text' : 'value';
        const target = isBoundedString(expect.target) ? expect.target : /** @type {string} */ (entry.target);
        /** @type {AssertStep} */
        const assertion = { kind: 'assert', label: `${label} · expect`, mode, equals: String(expect[mode]) };
        if (mode === 'name' || !isBoundedString(expect.selector)) assertion.target = target;
        else assertion.selector = expect.selector;
        steps.push(assertion);
      }
      continue;
    }

    if (kind === 'assert') {
      if (typeof entry.assert !== 'string' || !ASSERT_MODES.has(entry.assert)) errors.push(`${at}.assert must be one of ${[...ASSERT_MODES].join(', ')}`);
      const mode = String(entry.assert);
      const hasTarget = isBoundedString(entry.target), hasSelector = isBoundedString(entry.selector);
      if (mode === 'url') {
        if (hasTarget || hasSelector) errors.push(`${at} url assertions take no target or selector`);
      } else if (mode === 'name') {
        if (!hasTarget) errors.push(`${at} name assertions require a target`);
        if (hasSelector) errors.push(`${at} name assertions take no selector`);
      } else if (hasTarget === hasSelector) errors.push(`${at} needs exactly one of target or selector`);
      const comparators = ['equals', 'contains', 'matches'].filter(key => entry[key] !== undefined);
      for (const key of comparators) if (typeof entry[key] !== 'string') errors.push(`${at}.${key} must be a string`);
      if (mode !== 'visible' && mode !== 'exists' && comparators.length === 0) errors.push(`${at} needs equals, contains or matches`);
      if (mode === 'url' && entry.matches !== undefined) {
        try { new RegExp(String(entry.matches)); } catch { errors.push(`${at}.matches is not a valid regular expression`); }
      }
      if (errors.some(message => message.startsWith(at))) continue;
      /** @type {AssertStep} */
      const normalized = { kind: 'assert', label, mode };
      if (hasTarget) normalized.target = /** @type {string} */ (entry.target);
      if (hasSelector) normalized.selector = /** @type {string} */ (entry.selector);
      if (typeof entry.timeoutMs === 'number' && Number.isFinite(entry.timeoutMs) && entry.timeoutMs >= 0 && entry.timeoutMs <= MAX_TIMEOUT) {
        normalized.timeoutMs = Math.floor(entry.timeoutMs);
      }
      for (const key of comparators) /** @type {any} */ (normalized)[key] = entry[key];
      steps.push(normalized);
      continue;
    }

    if (kind === 'scrollTo') {
      // Opt-in scrolling: Navi never scrolls implicitly, so a flow must ask for it.
      if (!isBoundedString(entry.scrollTo)) errors.push(`${at}.scrollTo must be a bounded non-empty target id`);
      else steps.push({ kind: 'scrollTo', label, target: entry.scrollTo });
      continue;
    }

    if (kind === 'wait') {
      if (typeof entry.wait !== 'number' || !Number.isFinite(entry.wait) || entry.wait < 0 || entry.wait > MAX_TIMEOUT) {
        errors.push(`${at}.wait must be a number between 0 and ${MAX_TIMEOUT}`);
        continue;
      }
      steps.push({ kind: 'wait', label, ms: Math.floor(entry.wait) });
      continue;
    }

    if (entry.timeoutMs !== undefined && (typeof entry.timeoutMs !== 'number' || !Number.isFinite(entry.timeoutMs) || entry.timeoutMs < 0 || entry.timeoutMs > MAX_TIMEOUT)) {
      errors.push(`${at}.timeoutMs must be a number between 0 and ${MAX_TIMEOUT}`);
    }
    const waitFor = entry.waitFor;
    if (!isPlainObject(waitFor)) { errors.push(`${at}.waitFor must be an object`); continue; }
    for (const key of Object.keys(/** @type {object} */ (waitFor))) {
      if (!['selector', 'text', 'urlIncludes'].includes(key)) errors.push(`${at}.waitFor has unknown field "${key}"`);
    }
    const criteria = /** @type {Record<string, unknown>} */ (waitFor);
    const provided = ['selector', 'text', 'urlIncludes'].filter(key => isBoundedString(criteria[key]));
    if (provided.length !== 1) errors.push(`${at}.waitFor needs exactly one bounded string of selector, text or urlIncludes`);
    if (errors.some(message => message.startsWith(at))) continue;
    /** @type {WaitForStep} */
    const normalized = { kind: 'waitFor', label, timeoutMs: typeof entry.timeoutMs === 'number' ? Math.floor(entry.timeoutMs) : 15000 };
    for (const key of provided) /** @type {any} */ (normalized)[key] = criteria[key];
    steps.push(normalized);
  }
  if (errors.length) return { ok: false, errors };
  /** @type {NaviFlow} */
  const flow = { name, steps };
  if (typeof raw.url === 'string') flow.url = raw.url;
  return { ok: true, flow };
}

/**
 * Run a validated flow against an adapter.
 * A step timeout is a hard failure: the operation may already have been dispatched.
 * @param {object} options
 * @param {import('./adapter.js').NaviPlaywrightAdapter} options.adapter
 * @param {import('./adapter.js').NaviPageLike} options.page
 * @param {NaviFlow} options.flow
 * @param {boolean} [options.allowConsequential]
 * @param {number} [options.timeoutMs]
 * @param {(event: StepResult) => void} [options.onStep]
 * @returns {Promise<{ok:boolean,steps:StepResult[],failedStep?:StepResult,durationMs:number}>}
 */
export async function runFlow({ adapter, page, flow, allowConsequential = false, timeoutMs = 15000, onStep }) {
  const started = Date.now();
  /** @type {StepResult[]} */
  const results = [];
  /** @param {FlowStep} step @param {number} index @param {number} began @param {boolean} ok @param {string} [mode] @param {{code:string,message:string}} [error] */
  function record(step, index, began, ok, mode, error) {
    const result = { index, label: step.label, kind: step.kind, ok, durationMs: Date.now() - began, ...(mode ? { mode } : {}), ...(error ? { error } : {}) };
    results.push(result);
    onStep?.(result);
    return result;
  }
  for (let index = 0; index < flow.steps.length; index++) {
    const step = flow.steps[index];
    const began = Date.now();
    if (step.kind === 'action' && step.consequential && !allowConsequential) {
      return { ok: false, steps: results, failedStep: record(step, index, began, false, undefined, { code: 'CONSEQUENTIAL_BLOCKED', message: 'Step is marked consequential; rerun with --allow-consequential after reviewing it' }), durationMs: Date.now() - started };
    }
    try {
      if (step.kind === 'action') {
        const outcome = await withTimeout(adapter.execute(step.target, step.action, step.action === 'type' ? { text: step.text ?? '' } : step.action === 'select' ? { value: step.value ?? '' } : {}), timeoutMs, `action "${step.target}"`);
        if (!outcome.ok) throw stepError(outcome.error?.code || 'EXECUTION_FAILED', outcome.error?.message || 'Execution failed');
        record(step, index, began, true, outcome.mode);
        continue;
      }
      if (step.kind === 'wait') {
        await new Promise(resolve => setTimeout(resolve, step.ms));
        record(step, index, began, true);
        continue;
      }
      if (step.kind === 'scrollTo') {
        await withTimeout(adapter.scrollTo(step.target), timeoutMs, `scrollTo ${step.target}`);
        record(step, index, began, true);
        continue;
      }
      if (step.kind === 'waitFor') {
        await withTimeout(waitFor(page, step), step.timeoutMs, `waitFor on ${step.label}`);
        record(step, index, began, true);
        continue;
      }
      const budget = step.timeoutMs ?? timeoutMs;
      const observation = step.mode === 'name'
        ? await withTimeout(observeName(adapter, step), budget, `assert "${step.label}"`)
        : await withTimeout(observe(page, step), budget, `assert "${step.label}"`);
      const failure = compare(step, observation);
      if (failure) throw stepError('ASSERTION_FAILED', failure);
      record(step, index, began, true);
    } catch (error) {
      const failure = /** @type {Error & {code?: string}} */ (error);
      return { ok: false, steps: results, failedStep: record(step, index, began, false, undefined, { code: failure.code || 'STEP_FAILED', message: failure.message }), durationMs: Date.now() - started };
    }
  }
  return { ok: true, steps: results, durationMs: Date.now() - started };
}

/** @param {string} code @param {string} message */
function stepError(code, message) {
  return Object.assign(new Error(message), { code });
}
/** @param {Promise<any>} promise @param {number} ms @param {string} label */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(stepError('TIMEOUT', `${label} exceeded ${ms}ms; the action may have partially applied and is not retried`)), ms);
    promise.then(
      (/** @type {any} */ value) => { clearTimeout(timer); resolve(value); },
      (/** @type {any} */ error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/** @param {import('./adapter.js').NaviPageLike} page @param {WaitForStep} step */
async function waitFor(page, step) {
  const deadline = Date.now() + step.timeoutMs;
  for (;;) {
    const observed = await page.evaluate((/** @type {{selector?:string,text?:string}} */ arg) => {
      if (arg.selector) return { hit: !!document.querySelector(arg.selector) };
      return { hit: (document.body?.innerText || '').includes(/** @type {string} */ (arg.text)) };
    }, { selector: step.selector, text: step.text });
    if (observed.hit && (!step.urlIncludes || page.url().includes(step.urlIncludes))) return;
    if (Date.now() >= deadline) throw stepError('TIMEOUT', `waitFor on ${step.label} exceeded ${step.timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/**
 * Resolve an assertion through the Navi action map so it also covers closed shadow
 * roots and frames. The map carries accessible names, not live text.
 * @param {import('./adapter.js').NaviPlaywrightAdapter} adapter
 * @param {AssertStep} step
 * @returns {Promise<Observation>}
 */
async function observeName(adapter, step) {
  const map = await adapter.discover();
  const matches = map.actions.filter(action => action.target_id === step.target);
  const url = adapter.page.url();
  if (matches.length !== 1) return { found: false, url };
  const action = matches[0];
  return { found: true, visible: action.state.is_visible, name: action.name, url };
}

/** @param {import('./adapter.js').NaviPageLike} page @param {AssertStep} step @returns {Promise<Observation>} */
async function observe(page, step) {
  return page.evaluate((/** @type {{target?:string,selector?:string}} */ arg) => {
    const escape = (/** @type {string} */ value) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'));
    const selector = arg.target ? `[data-agent-target="${escape(arg.target)}"]` : /** @type {string} */ (arg.selector);
    const element = document.querySelector(selector);
    const found = !!element;
    return {
      found,
      selector,
      visible: found ? element.getClientRects().length > 0 : false,
      text: found ? (element.textContent || '').trim() : undefined,
      value: found && 'value' in element ? String(/** @type {any} */ (element).value) : undefined,
      url: location.href
    };
  }, { target: step.target, selector: step.selector });
}

/**
 * @param {AssertStep} step
 * @param {Observation} observed
 * @returns {string|null} failure message
 */
function compare(step, observed) {
  if (step.mode === 'url') {
    if (step.equals !== undefined && observed.url !== step.equals) return `expected url ${JSON.stringify(step.equals)}, received ${JSON.stringify(observed.url)}`;
    if (step.contains !== undefined && !observed.url.includes(step.contains)) return `expected url to contain ${JSON.stringify(step.contains)}`;
    if (step.matches !== undefined && !new RegExp(step.matches).test(observed.url)) return `expected url to match ${step.matches}`;
    return null;
  }
  if (step.mode === 'name' && !observed.found) return `expected target ${step.target} to be present in the action map`;
  const where = step.selector ? `selector ${step.selector}` : `target ${step.target}`;
  if (step.mode === 'exists') return observed.found ? null : `expected ${where} to exist`;
  if (step.mode === 'visible') return observed.visible ? null : `expected ${where} to be visible`;
  const actual = step.mode === 'value' ? observed.value : step.mode === 'name' ? observed.name : observed.text;
  if (actual === undefined) return `expected ${where} to expose a ${step.mode}`;
  if (step.equals !== undefined && actual !== step.equals) return `expected ${step.mode} ${JSON.stringify(step.equals)}, received ${JSON.stringify(actual)}`;
  if (step.contains !== undefined && !actual.includes(step.contains)) return `expected ${step.mode} to contain ${JSON.stringify(step.contains)}, received ${JSON.stringify(actual)}`;
  if (step.matches !== undefined && !new RegExp(step.matches).test(actual)) return `expected ${step.mode} to match ${step.matches}, received ${JSON.stringify(actual)}`;
  return null;
}
