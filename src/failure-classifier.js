/**
 * Failure taxonomy for agent interaction runs.
 *
 * This module exists so a runner classifies *observed* failures with one
 * deterministic rule set instead of prose heuristics spread across harness code.
 *
 * Scope and blast radius: this module is deliberately imported by nothing that
 * ships. `src/` is outside the publish allowlist, and neither `src/navi.js` (the
 * client bundle) nor the entry points that produce `dist/index.mjs`,
 * `dist/index.cjs`, `dist/cli.mjs` or `dist/mcp.mjs` import it, so adding it
 * changes no distributed byte — `dist/navi.min.js` stays byte-identical.
 *
 * Classification is evidence-driven, never inferential. A bucket is only
 * assigned from a structured signal:
 *
 *   - an explicit code (`NOT_FOUND`, `UNAVAILABLE`, …) supplied as a field, or as
 *     the harness's own leading `CODE:` token, which is the MCP error envelope's
 *     format rather than free prose;
 *   - an explicit receipt field (`settled: false`, `settle_reason`, or the
 *     adapter's `reason`);
 *   - or, for the raw path, the harness's own resolution code.
 *
 * Anything else — a stack trace, an engine timeout message, an unrecognized
 * error string — is UNCLASSIFIED. Nothing is ever promoted to
 * DETERMINISTIC_REFUSAL (or to any other claim) because it "looks like" a
 * refusal: an unclassified failure is honest, a misclassified one is not.
 *
 * @typedef {'SELECTOR_HALLUCINATION' | 'DETERMINISTIC_REFUSAL' | 'UNTRUSTED_GESTURE_REQUIRED' | 'TIMEOUT_UNSETTLED' | 'SCHEMA_VIOLATION' | 'UNCLASSIFIED'} FailureBucket
 * @typedef {{path?: string, code?: unknown, reason?: unknown, detail?: unknown, settled?: boolean}} FailureObservation
 */

/** Every bucket a failure can be assigned to, in report order.
 * @type {readonly FailureBucket[]} */
export const FAILURE_BUCKETS = [
  'SELECTOR_HALLUCINATION',
  'DETERMINISTIC_REFUSAL',
  'UNTRUSTED_GESTURE_REQUIRED',
  'TIMEOUT_UNSETTLED',
  'SCHEMA_VIOLATION',
  'UNCLASSIFIED'
];

/**
 * One line of operator-facing meaning per bucket. Prose for humans; no bucket is
 * ever *decided* from prose.
 * @type {Record<FailureBucket, string>}
 */
export const BUCKET_GUIDANCE = {
  SELECTOR_HALLUCINATION: 'The identifier the caller used does not resolve to exactly one target in the current action map or DOM. In a model-driven run the likely cause is a guessed or stale identifier, but the identifier is the evidence — the model\'s intent is not.',
  DETERMINISTIC_REFUSAL: 'The target exists and Navi refused before dispatching, because of its state (occluded, disabled, off-screen) or a session guard. Recoverable by re-reading the map; nothing was dispatched.',
  UNTRUSTED_GESTURE_REQUIRED: 'The control requires trusted native driver input (data-navi-trusted="true"), or the page canceled synthesized events. Recoverable by using trusted input, not by retrying the same call.',
  TIMEOUT_UNSETTLED: 'The action dispatched but its settlement condition never confirmed within the deadline. The action may already have applied, so it is not safe to retry blindly.',
  SCHEMA_VIOLATION: 'The tool call itself was malformed: unknown tool, unsupported action type, bad or missing payload, or an unparsable settle request.',
  UNCLASSIFIED: 'No structured signal identified this failure. It is reported as-is rather than guessed into a claim bucket.'
};

/** Codes that mean the call was malformed. */
const SCHEMA_CODES = new Set(['INVALID_PAYLOAD', 'INVALID_ACTION', 'INVALID_SETTLE', 'INVALID_SESSION', 'INVALID_URL', 'UNKNOWN_TOOL', 'INVALID_TOOL_CALL']);
/** Codes that mean trusted input is required. */
const TRUSTED_CODES = new Set(['FALLBACK_DISABLED', 'FALLBACK_UNSUPPORTED', 'CANCELED', 'UNTRUSTED_GESTURE_REQUIRED']);
/** Codes that mean the action ran but never settled. */
const SETTLE_CODES = new Set(['UNSETTLED', 'SETTLE_TIMEOUT', 'TIMEOUT']);
/** Codes that mean the caller's identifier did not resolve. */
const IDENTITY_CODES = new Set(['NOT_FOUND', 'AMBIGUOUS', 'SELECTOR_RESOLUTION', 'TARGET_NOT_FOUND']);
/** Codes that mean Navi refused a target that does exist. */
const REFUSAL_CODES = new Set(['UNAVAILABLE', 'TARGET_UNAVAILABLE', 'EXECUTION_FAILED', 'DISPATCH_FAILED', 'BUSY', 'STOPPED']);
/** Adapter `reason` values that mean trusted input is required. */
const TRUSTED_REASONS = new Set(['UNTRUSTED_GESTURE_REQUIRED']);
/** Adapter `reason` values that mean settlement never confirmed. */
const SETTLE_REASONS = new Set(['TIMEOUT', 'UNSETTLED']);

/** @param {unknown} value */
function code(value) {
  if (typeof value !== 'string') return null;
  const head = value.split(':')[0]?.trim().replace(/^-+/, '').toUpperCase() ?? '';
  return head || null;
}

/**
 * The harness's own error text is `${code}: ${message}`, so a leading token in
 * that shape is a code, not a guess. A code appearing mid-sentence is not
 * accepted: that would be reading prose for intent.
 * @param {unknown} detail
 */
function leadingCode(detail) {
  if (typeof detail !== 'string') return null;
  const match = /^\s*([A-Z][A-Z0-9_]{2,})\s*:/.exec(detail);
  return match ? match[1] ?? null : null;
}

/**
 * Classify one observed failure. Never throws and never guesses: unparsable or
 * unstructured input is UNCLASSIFIED.
 * @param {FailureObservation | null | undefined} observation
 * @returns {FailureBucket}
 */
export function classifyFailure(observation) {
  const input = observation && typeof observation === 'object' ? observation : {};
  const explicit = code(input.code) ?? leadingCode(input.detail);
  const reason = code(input.reason);
  if (explicit && SCHEMA_CODES.has(explicit)) return 'SCHEMA_VIOLATION';
  if ((explicit && TRUSTED_CODES.has(explicit)) || (reason !== null && TRUSTED_REASONS.has(reason))) return 'UNTRUSTED_GESTURE_REQUIRED';
  if (input.settled === false || (reason !== null && SETTLE_REASONS.has(reason)) || (explicit && SETTLE_CODES.has(explicit))) return 'TIMEOUT_UNSETTLED';
  if (explicit && IDENTITY_CODES.has(explicit)) return 'SELECTOR_HALLUCINATION';
  if (explicit && REFUSAL_CODES.has(explicit)) return 'DETERMINISTIC_REFUSAL';
  return 'UNCLASSIFIED';
}

/** @param {unknown} value @returns {value is FailureBucket} */
export function isFailureBucket(value) {
  return typeof value === 'string' && FAILURE_BUCKETS.some(bucket => bucket === value);
}

/**
 * Count failures by category, buckets first in taxonomy order and any run-level
 * marker (planner_stopped, task_incomplete, … ) after them, deterministically
 * ordered so a report never depends on insertion timing.
 * @param {{category: string}[]} failures
 * @returns {Record<string, number>}
 */
export function summarizeFailures(failures) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const failure of Array.isArray(failures) ? failures : []) {
    const category = typeof failure?.category === 'string' ? failure.category : 'UNCLASSIFIED';
    counts[category] = (counts[category] ?? 0) + 1;
  }
  /** @type {Record<string, number>} */
  const ordered = {};
  for (const bucket of FAILURE_BUCKETS) if (counts[bucket]) ordered[bucket] = counts[bucket];
  for (const category of Object.keys(counts).sort()) if (!isFailureBucket(category)) ordered[category] = counts[category];
  return ordered;
}
