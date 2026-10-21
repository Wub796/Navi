// Semantic workflow synthesis and OpenAPI 3.1 compilation for a stored sitemap.
//
// A sitemap is a flat list of controls: `{ target_id, role, name, action,
// selector, disabled, required, input_type, options }`. That is the right wire
// shape — it is what the crawler can produce without guessing at a page's intent,
// and the browser bundle that produces it is frozen byte for byte. It is also a
// poor thing to hand an agent, which has to re-derive "these five controls are
// one search form" on every run.
//
// So the grouping happens here, on the server, as a *derived view*: the stored
// payload is never rewritten. That matters because `validateCrawlerPayload`
// accepts exactly `{url, actions}` — adding a `workflows` field to the stored map
// would make the write contract and the read model disagree, and a redesign of
// the synthesis would then need a data migration rather than a deploy.
//
// Everything in this module is pure: same payload in, byte-identical output out,
// no clock and no randomness. `source_indexed_at` is the map's own `updated_at`,
// not "now", so recompiling an unchanged map is a no-op a cache can trust.
//
// Three surfaces:
//   synthesizeWorkflows(payload)  group controls into typed, risk-classified workflows
//   compileOpenApi(input)         turn that into an OpenAPI 3.1 document
//   resolveTarget(request, payload)  heal a stale target_id against a newer sitemap

import { NAVI_PROTOCOL_VERSION } from './endpoints.js';

/** Risk levels, ordered from least to most consequential. */
export const WORKFLOW_RISK_LEVELS = ['read', 'write', 'destructive'];

/**
 * Similarity a healed resolution must reach before it is returned. Below it the
 * caller gets a cold miss: guessing wrong on a `destructive` control is worse
 * than failing, so the threshold is deliberately high.
 */
export const HEAL_THRESHOLD = 0.85;

/** Weight of each signal in a healing score. Role alone cannot clear the threshold. */
export const HEAL_WEIGHTS = { role: 0.5, name: 0.3, action: 0.2 };

/** Vocabulary that names a workflow, most specific first. @type {Array<[string, RegExp]>} */
const KIND_RULES = [
  // `cart` alone is deliberately absent: "View cart" is a link, and a rule that
  // claimed it would file navigation under checkout.
  ['checkout', /\b(checkout|pay|payment|billing|purchase|buy|place order|order total|card number|credit card|shipping)\b/],
  ['login', /\b(log ?in|login|sign ?in|signin|sign ?up|signup|register|password|passcode|username|email address|one-time code|otp|2fa)\b/],
  ['search', /\b(search|query|find|lookup|look up)\b/],
  ['filter', /\b(filter|filters|refine|sort|sort by|facet|price range|category|results per page)\b/]
];

/** Human labels for each kind, so a workflow's summary does not depend on a page's copy. @type {Record<string, string>} */
const KIND_LABELS = {
  search: 'Search',
  login: 'Sign in',
  checkout: 'Checkout',
  filter: 'Filter results',
  submit_form: 'Submit form',
  navigate: 'Browse links'
};

/** Controls whose click only reveals or navigates, never changes state. */
const READ_ROLES = new Set(['link', 'tab', 'menuitem', 'treeitem']);

/** Wording that makes an otherwise ordinary control consequential. */
const DESTRUCTIVE_WORDS = /\b(delete|remove|purge|revoke|wipe|destroy|reset|cancel|unsubscribe|deactivate|disable|suspend|archive|pay|purchase|checkout|buy|transfer|withdraw)\b/;

/** Wording that makes a click a read even on a `button` role. */
const READ_WORDS = /\b(view|open|expand|collapse|next|previous|back|details|show|read more)\b/;

/** Input types that are numbers, and the ones that carry a string format. */
const NUMBER_INPUT_TYPES = new Set(['number', 'range']);
/** @type {Record<string, string>} */
const FORMATTED_INPUT_TYPES = { email: 'email', url: 'uri', password: 'password', date: 'date', time: 'time', 'datetime-local': 'date-time', month: 'date', week: 'date' };

/** Longest parameter name emitted; a URL query key longer than this is not readable. */
const MAX_PARAMETER_NAME = 48;

/**
 * Lowercase a label into a parameter name: letters, digits and single underscores.
 * @param {unknown} value @returns {string}
 */
function parameterName(value) {
  const text = typeof value === 'string' ? value : '';
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, MAX_PARAMETER_NAME).replace(/_+$/, '');
  return /^[a-z]/.test(slug) ? slug : `field${slug ? `_${slug}` : ''}`;
}

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The container a control lives in, as far as its selector can say.
 *
 * The crawler emits either a unique attribute or id selector (`#email`,
 * `[name="q"]`) or a positional path (`#login-form > input:nth-of-type(2)`,
 * `body > form:nth-of-type(1) > button:nth-of-type(1)`). Only the path form names
 * an ancestor, so only it yields a container. The payload carries no form or
 * landmark metadata — it is not in the validated wire contract — so a page whose
 * controls all have unique selectors is grouped by intent instead, which is the
 * signal that actually survives a redesign.
 * @param {unknown} selector @returns {string | null}
 */
function containerOf(selector) {
  const value = text(selector);
  const index = value.lastIndexOf(' > ');
  return index === -1 ? null : value.slice(0, index);
}

/**
 * Classify one control by the vocabulary a reader would use for it.
 * @param {{role?: unknown, name?: unknown, action?: unknown, input_type?: unknown}} target
 * @returns {string | null}
 */
function classifyControl(target) {
  const name = text(target.name);
  const inputType = text(target.input_type);
  const haystack = `${name} ${inputType}`.toLowerCase();
  if (haystack.trim().length > 0) {
    for (const [kind, rule] of KIND_RULES) {
      if (rule.test(haystack)) return kind;
    }
  }
  // An input is part of a form by construction, even when nothing names it.
  if (target.action === 'select' || target.action === 'type') return 'submit_form';
  if (target.action === 'click' && READ_ROLES.has(text(target.role))) return 'navigate';
  return null;
}

/**
 * How consequential acting on one control is.
 * @param {Record<string, any>} target @returns {'read' | 'write' | 'destructive'}
 */
function controlRisk(target) {
  const haystack = `${text(target.name)} ${text(target.input_type)}`.toLowerCase();
  if (DESTRUCTIVE_WORDS.test(haystack)) return 'destructive';
  if (target.action !== 'click') return 'write';
  if (READ_ROLES.has(text(target.role)) || READ_WORDS.test(haystack)) return 'read';
  return 'write';
}

/** @param {string} a @param {string} b @returns {string} the more consequential of the two */
function worseRisk(a, b) {
  return WORKFLOW_RISK_LEVELS.indexOf(a) >= WORKFLOW_RISK_LEVELS.indexOf(b) ? a : b;
}

/**
 * The value an option offers. The crawler emits `label=value` when the two
 * differ, so the part after the first `=` is the value and the whole string is
 * the label otherwise.
 * @param {unknown} option @returns {string}
 */
function optionValue(option) {
  const value = text(option);
  const index = value.indexOf('=');
  return index > 0 && index < value.length - 1 ? value.slice(index + 1) : value;
}

/**
 * The typed parameter one input control contributes, or null when it takes no
 * input. Enum membership comes from the options the crawler already read off the
 * page, so an agent can choose a legal value without visiting it.
 * @param {Record<string, any>} target
 * @param {Set<string>} used
 * @param {number} index
 * @returns {{name: string, target_id: string, type: string, format?: string, enum?: string[], required: boolean, description: string} | null}
 */
function parameterFor(target, used = new Set(), index = 0) {
  if (target.action !== 'type' && target.action !== 'select') return null;
  const inputType = text(target.input_type).toLowerCase();
  const options = Array.isArray(target.options)
    ? target.options.map(optionValue).filter(value => value.length > 0)
    : [];
  /** @type {{type: string, format?: string, enum?: string[]}} */
  let schema;
  if (options.length > 0) schema = { type: 'string', enum: options };
  else if (NUMBER_INPUT_TYPES.has(inputType)) schema = { type: 'number' };
  else if (inputType === 'checkbox' || inputType === 'radio' || target.role === 'switch') schema = { type: 'boolean' };
  else if (FORMATTED_INPUT_TYPES[inputType]) schema = { type: 'string', format: FORMATTED_INPUT_TYPES[inputType] };
  else schema = { type: 'string' };

  let name = parameterName(target.name) || `field_${index + 1}`;
  for (let suffix = 2; used.has(name); suffix += 1) name = `${parameterName(target.name) || `field_${index + 1}`}_${suffix}`;
  used.add(name);

  const label = text(target.name);
  return {
    name,
    target_id: text(target.target_id),
    ...schema,
    required: target.required === true,
    description: label ? `${label} (target ${text(target.target_id)})` : `Target ${text(target.target_id)}`
  };
}

/** Kinds that name a whole form, most specific first: a group takes the first one present. */
const KIND_PRIORITY = ['checkout', 'login', 'search', 'filter'];

/**
 * The kind a group of controls describes.
 *
 * The container is the strongest evidence available. A form with an email field,
 * a password field and a "Sign in" button is one login flow, and splitting it
 * into three workflows because only one control names itself would be worse than
 * useless — so the group takes the most specific kind any member hinted at, then
 * falls back to navigation or a generic form submission.
 * @param {{hints: Set<string>, members: Record<string, any>[]}} group @returns {string}
 */
function kindOf(group) {
  for (const kind of KIND_PRIORITY) if (group.hints.has(kind)) return kind;
  if (group.members.every(member => member.action === 'click' && READ_ROLES.has(text(member.role)))) return 'navigate';
  return 'submit_form';
}

/**
 * Group a sitemap's controls into high-level workflows.
 *
 * Deterministic by construction: controls are visited in declaration order, a
 * group is keyed by the control's container (or, when its selector names no
 * ancestor, by its own intent), groups are emitted in the order their first
 * member appeared, and a kind comes from an ordered priority list rather than from
 * scoring. Two runs over one payload, or two replicas compiling the same stored
 * map, therefore produce the same workflows in the same order with the same ids.
 * @param {{url?: string, actions?: unknown[]} | null | undefined} payload
 * @returns {{url: string, workflows: Array<{id: string, kind: string, label: string, risk_level: string, parameters: any[], targets: {target_id: string, role: string, action: string}[]}>}}
 */
export function synthesizeWorkflows(payload) {
  const actions = /** @type {Record<string, any>[]} */ (Array.isArray(payload?.actions) ? payload.actions.filter(action => action && typeof action === 'object') : []);
  /** @type {Map<string, {hints: Set<string>, members: Record<string, any>[]}>} */
  const groups = new Map();

  for (const target of actions) {
    // A disabled control is not something a workflow can drive; leaving it out is
    // what keeps a synthesized parameter from describing an input that refuses.
    if (target.disabled === true) continue;
    const hint = classifyControl(target);
    const container = containerOf(target.selector);
    // A positional selector names its ancestor, so two controls in one form share
    // a container even when nothing about their labels agrees. A unique attribute
    // or id selector names no ancestor at all, and then intent is the only signal
    // left, so those controls group by what they are for.
    const key = container ? `container:${container}` : `intent:${hint ?? 'cluster'}`;
    let group = groups.get(key);
    if (!group) {
      group = { hints: new Set(), members: [] };
      groups.set(key, group);
    }
    if (hint) group.hints.add(hint);
    group.members.push(target);
  }

  // Ids are numbered per kind in emission order, so they stay stable regardless of
  // which containers the other kinds happened to produce.
  const usedIds = new Set();
  const workflows = [];
  const kindSeen = new Map();
  for (const group of groups.values()) {
    const kind = kindOf(group);
    const ordinal = (kindSeen.get(kind) ?? 0) + 1;
    kindSeen.set(kind, ordinal);
    let id = ordinal === 1 ? kind : `${kind}-${ordinal}`;
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${kind}-${ordinal}-${suffix}`;
    usedIds.add(id);

    const used = new Set();
    const parameters = [];
    for (const [index, member] of group.members.entries()) {
      const parameter = parameterFor(member, used, index);
      if (parameter) parameters.push(parameter);
    }
    workflows.push({
      id,
      kind,
      label: KIND_LABELS[kind] ?? kind,
      risk_level: group.members.reduce((risk, member) => worseRisk(risk, controlRisk(member)), 'read'),
      parameters,
      targets: group.members.map(member => ({
        target_id: text(member.target_id),
        role: text(member.role),
        action: text(member.action)
      }))
    });
  }
  return { url: text(payload?.url), workflows };
}

/**
 * Normalize a label for comparison: lowercase words, punctuation and runs of
 * whitespace collapsed to one space. `Sign in!` and `sign  in` compare equal.
 * @param {unknown} value @returns {string}
 */
function normalizeLabel(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Similarity of two accessible names, in [0, 1]. Equal names are 1, a contained
 * name is 0.9 (a button relabelled "Delete account" for "Delete" is the same
 * intent), and otherwise the Jaccard overlap of the word sets. A character-level
 * edit distance would score "Sign in" against "Sign out" as a near match, which is
 * exactly the pair a healing pass must not confuse.
 * @param {unknown} a @param {unknown} b @returns {number}
 */
export function labelSimilarity(a, b) {
  const left = normalizeLabel(a);
  const right = normalizeLabel(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.9;
  const leftWords = new Set(left.split(' '));
  const rightWords = new Set(right.split(' '));
  let shared = 0;
  for (const word of leftWords) if (rightWords.has(word)) shared += 1;
  return shared / (leftWords.size + rightWords.size - shared);
}

/**
 * Score how well one control answers an expected descriptor.
 * @param {{role?: unknown, name?: unknown, action?: unknown}} expected
 * @param {Record<string, any>} candidate
 * @returns {number}
 */
function healScore(expected, candidate) {
  let score = 0;
  if (text(expected.role) && text(expected.role) === text(candidate.role)) score += HEAL_WEIGHTS.role;
  if (text(expected.name)) score += HEAL_WEIGHTS.name * labelSimilarity(expected.name, candidate.name);
  if (text(expected.action) && text(expected.action) === text(candidate.action)) score += HEAL_WEIGHTS.action;
  return Math.round(score * 1000) / 1000;
}

/**
 * Resolve a requested control against the sitemap that replaced it.
 *
 * The descriptor is what makes healing possible: an id alone says nothing about
 * what the control was, so a request carrying only `target_id` is answered
 * exactly or not at all rather than guessed at. Ties are broken by declaration
 * order, and a candidate must clear `HEAL_THRESHOLD`; below it the answer is a
 * cold miss, because a wrong resolution on a `destructive` control is worse than
 * an honest failure.
 * @param {{target_id?: unknown, role?: unknown, name?: unknown, action?: unknown} | string} request
 * @param {{actions?: unknown[]} | null | undefined} payload
 * @param {{threshold?: number}} [options]
 * @returns {{requested_target_id: string, resolved_target_id: string | null, healed: boolean, confidence: number, reason: 'exact' | 'healed' | 'miss', target: Record<string, any> | null}}
 */
export function resolveTarget(request, payload, options = {}) {
  const descriptor = typeof request === 'string' ? { target_id: request } : (request ?? {});
  const requestedId = text(descriptor.target_id);
  const threshold = typeof options.threshold === 'number' && options.threshold >= 0 && options.threshold <= 1
    ? options.threshold
    : HEAL_THRESHOLD;
  const actions = /** @type {Record<string, any>[]} */ (Array.isArray(payload?.actions) ? payload.actions.filter(action => action && typeof action === 'object') : []);
  const miss = () => ({
    requested_target_id: requestedId,
    resolved_target_id: null,
    healed: false,
    confidence: 0,
    reason: /** @type {'miss'} */ ('miss'),
    target: null
  });

  for (const target of actions) {
    if (text(target.target_id) === requestedId) {
      return {
        requested_target_id: requestedId,
        resolved_target_id: requestedId,
        healed: false,
        confidence: 1,
        reason: 'exact',
        target
      };
    }
  }
  // Without at least one descriptor there is nothing to match on. Reported as a
  // miss rather than silently scoring every candidate 0 and returning the first.
  if (!text(descriptor.role) && !text(descriptor.name) && !text(descriptor.action)) return miss();

  /** @type {{target: Record<string, any>, score: number} | null} */
  let best = null;
  for (const target of actions) {
    if (target.disabled === true) continue;
    if (text(target.target_id) === requestedId) continue;
    const score = healScore(descriptor, target);
    if (score < threshold) continue;
    if (best === null || score > best.score) best = { target, score };
  }
  if (best === null) return miss();
  return {
    requested_target_id: requestedId,
    resolved_target_id: text(best.target.target_id),
    healed: true,
    confidence: best.score,
    reason: 'healed',
    target: best.target
  };
}

/**
 * The JSON Schema one workflow's request body uses: `additionalProperties: false`
 * so a caller learns about a typo instead of having it ignored.
 * @param {{parameters: any[]}} workflow
 * @returns {Record<string, any>}
 */
function bodySchema(workflow) {
  /** @type {Record<string, any>} */
  const properties = {};
  const required = [];
  for (const parameter of workflow.parameters) {
    const { name, type, format, enum: values, description } = parameter;
    properties[name] = { type, ...(format ? { format } : {}), ...(values ? { enum: values } : {}), description };
    if (parameter.required) required.push(name);
  }
  return required.length > 0
    ? { type: 'object', additionalProperties: false, properties, required }
    : { type: 'object', additionalProperties: false, properties };
}

/** The receipt every workflow returns, shared so two operations cannot disagree. */
const WORKFLOW_RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'workflow_id', 'resolved_target_id', 'healed', 'confidence'],
  properties: {
    ok: { type: 'boolean', description: 'Whether the workflow ran.' },
    workflow_id: { type: 'string', description: 'The workflow this receipt belongs to.' },
    resolved_target_id: { type: 'string', description: 'The control that was acted on, after any healing.' },
    healed: { type: 'boolean', description: 'True when the control was resolved from a descriptor rather than the requested id.' },
    confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Resolution confidence; 1 for an exact target id.' },
    receipt_id: { type: ['string', 'null'], description: 'Settlement receipt id, or null when the run settled nothing.' }
  }
};

/**
 * Compile synthesized workflows into an OpenAPI 3.1 document.
 *
 * One `POST /workflows/<id>` per workflow, with the parameters as a JSON request
 * body, so an OpenAPI client, an LLM tool definition or an MCP bridge all read the
 * same typed surface. The document is deterministic for a given input: nothing is
 * clocked, so `source_indexed_at` is the stored map's own timestamp.
 * @param {{tenantId: string, pageUrl?: string, serverUrl?: string, updatedAt?: string | null, workflows: any[], protocolVersion?: string}} input
 * @returns {Record<string, any>}
 */
export function compileOpenApi(input) {
  const workflows = Array.isArray(input.workflows) ? input.workflows : [];
  const pageUrl = text(input.pageUrl);
  const serverUrl = text(input.serverUrl) || (() => {
    try { return new URL(pageUrl).origin; } catch { return 'http://127.0.0.1'; }
  })();
  const protocolVersion = text(input.protocolVersion) || NAVI_PROTOCOL_VERSION;
  /** @type {Record<string, any>} */
  const paths = {};
  /** @type {string[]} */
  const riskLevels = [];

  for (const workflow of workflows) {
    if (!riskLevels.includes(workflow.risk_level)) riskLevels.push(workflow.risk_level);
    const body = workflow.parameters.length > 0
      ? {
        required: workflow.parameters.some((/** @type {any} */ parameter) => parameter.required),
        content: { 'application/json': { schema: bodySchema(workflow) } }
      }
      : undefined;
    paths[`/workflows/${workflow.id}`] = {
      post: {
        operationId: `run_${String(workflow.id).replace(/[^A-Za-z0-9]+/g, '_')}`,
        summary: workflow.label,
        description: `${workflow.label}: ${workflow.targets.length} control(s) compiled from the sitemap at ${pageUrl || 'the indexed page'}.`,
        tags: [workflow.kind, workflow.risk_level],
        // Where a general OpenAPI reader sees the part that matters most to an
        // agent: how consequential this operation is, and which controls it drives.
        'x-navi-risk-level': workflow.risk_level,
        'x-navi-workflow-kind': workflow.kind,
        'x-navi-targets': workflow.targets.map((/** @type {any} */ target) => target.target_id),
        ...(body ? { requestBody: body } : {}),
        responses: {
          200: { description: 'The workflow ran and its receipt was recorded.', content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowReceipt' } } } },
          409: { description: 'A requested target is gone and no candidate reached the healing threshold; re-read the sitemap.' },
          429: { description: 'The tenant is over its metered quota window.' }
        }
      }
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: `${text(input.tenantId) || 'tenant'} workflows`,
      version: protocolVersion,
      summary: `Typed workflows compiled from the Navi sitemap for ${pageUrl || 'the indexed page'}.`,
      description: 'Every path is one synthesized workflow from the stored sitemap. Parameters are the controls the crawler indexed, typed from their roles and options.'
    },
    servers: [{ url: serverUrl, description: 'The Navi host that compiled this document.' }],
    // The document is a view over one page's controls, and everything a client
    // needs to trust it is here rather than in a prose description.
    'x-navi': {
      protocol_version: protocolVersion,
      tenant_id: text(input.tenantId),
      source_url: pageUrl,
      source_indexed_at: input.updatedAt ?? null,
      workflow_count: workflows.length,
      risk_levels: riskLevels,
      resolution: { strategy: 'role+label+action', threshold: HEAL_THRESHOLD }
    },
    paths,
    components: { schemas: { WorkflowReceipt: WORKFLOW_RECEIPT_SCHEMA } }
  };
}
