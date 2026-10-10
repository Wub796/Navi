import { test, expect } from '@playwright/test';
import { classifyFailure, summarizeFailures, isFailureBucket, FAILURE_BUCKETS, BUCKET_GUIDANCE } from '../src/failure-classifier.js';

// Pure classification: no browser, no fixture. Every case below is a synthetic
// observation, so the taxonomy is verified independently of whether a model ran.

test('every bucket is reachable from a structured signal, and only from one', () => {
  // 1. SELECTOR_HALLUCINATION — the identifier does not resolve to one target.
  expect(classifyFailure({ path: 'navi-differential', code: 'NOT_FOUND', detail: 'NOT_FOUND: Target does not exist' })).toBe('SELECTOR_HALLUCINATION');
  expect(classifyFailure({ path: 'navi-differential', code: 'AMBIGUOUS' })).toBe('SELECTOR_HALLUCINATION');
  expect(classifyFailure({ path: 'navi-differential', detail: 'NOT_FOUND: Target does not exist' })).toBe('SELECTOR_HALLUCINATION');
  expect(classifyFailure({ path: 'raw-playwright', code: 'SELECTOR_RESOLUTION', detail: 'SELECTOR_RESOLUTION: selector/name is missing or ambiguous' })).toBe('SELECTOR_HALLUCINATION');
  // 2. DETERMINISTIC_REFUSAL — the target exists, Navi refused before dispatching.
  expect(classifyFailure({ path: 'navi-differential', code: 'UNAVAILABLE', detail: 'UNAVAILABLE: Target is not actionable' })).toBe('DETERMINISTIC_REFUSAL');
  expect(classifyFailure({ path: 'navi-differential', code: 'TARGET_UNAVAILABLE', reason: 'occluded' })).toBe('DETERMINISTIC_REFUSAL');
  expect(classifyFailure({ path: 'navi-differential', code: 'EXECUTION_FAILED' })).toBe('DETERMINISTIC_REFUSAL');
  expect(classifyFailure({ path: 'navi-differential', code: 'BUSY' })).toBe('DETERMINISTIC_REFUSAL');
  // 3. UNTRUSTED_GESTURE_REQUIRED — needs hardware-level driver events.
  expect(classifyFailure({ path: 'navi-differential', code: 'FALLBACK_DISABLED' })).toBe('UNTRUSTED_GESTURE_REQUIRED');
  expect(classifyFailure({ path: 'navi-differential', code: 'CANCELED' })).toBe('UNTRUSTED_GESTURE_REQUIRED');
  expect(classifyFailure({ path: 'navi-differential', reason: 'untrusted_gesture_required' })).toBe('UNTRUSTED_GESTURE_REQUIRED');
  // 4. TIMEOUT_UNSETTLED — dispatched, settlement never confirmed.
  expect(classifyFailure({ path: 'navi-differential', code: 'UNSETTLED', settled: false })).toBe('TIMEOUT_UNSETTLED');
  expect(classifyFailure({ path: 'navi-differential', settled: false, reason: 'timeout' })).toBe('TIMEOUT_UNSETTLED');
  expect(classifyFailure({ path: 'navi-differential', detail: 'UNSETTLED: no settlement confirmation' })).toBe('TIMEOUT_UNSETTLED');
  // 5. SCHEMA_VIOLATION — the call itself was malformed.
  expect(classifyFailure({ path: 'navi-differential', code: 'INVALID_PAYLOAD' })).toBe('SCHEMA_VIOLATION');
  expect(classifyFailure({ path: 'navi-differential', code: 'INVALID_ACTION' })).toBe('SCHEMA_VIOLATION');
  expect(classifyFailure({ path: 'navi-differential', code: 'INVALID_SETTLE' })).toBe('SCHEMA_VIOLATION');
  expect(classifyFailure({ path: 'raw-playwright', code: 'UNKNOWN_TOOL' })).toBe('SCHEMA_VIOLATION');
  // Every declared bucket is reachable and documented, and the set is closed.
  const reached = new Set(FAILURE_BUCKETS.map(bucket => bucket));
  for (const bucket of reached) expect(BUCKET_GUIDANCE[bucket]).toBeTruthy();
  expect(new Set(FAILURE_BUCKETS).size).toBe(FAILURE_BUCKETS.length);
  expect(Object.keys(BUCKET_GUIDANCE).sort()).toEqual([...FAILURE_BUCKETS].sort());
});

test('ambiguous or unstructured failures are never promoted to a claim bucket', () => {
  // A prose message may describe a refusal, but prose is not a receipt.
  expect(classifyFailure({ path: 'navi-differential', detail: 'Target is not actionable' })).toBe('UNCLASSIFIED');
  expect(classifyFailure({ path: 'navi-differential', detail: 'UNAVAILABLE' })).toBe('UNCLASSIFIED');
  expect(classifyFailure({ path: 'navi-differential', detail: 'The control appears to be occluded by a modal' })).toBe('UNCLASSIFIED');
  expect(classifyFailure({ path: 'navi-differential', detail: 'not_found' })).toBe('UNCLASSIFIED');
  // An unrecognized code is not a known refusal either.
  expect(classifyFailure({ path: 'navi-differential', code: 'SOMETHING_ELSE' })).toBe('UNCLASSIFIED');
  expect(classifyFailure({ path: 'navi-differential', code: 'NAVIGATION_FAILED' })).toBe('UNCLASSIFIED');
  // Engine- and harness-level noise stays unclassified rather than becoming a claim.
  expect(classifyFailure({ path: 'raw-playwright', detail: 'locator.click: Timeout 3000ms exceeded' })).toBe('UNCLASSIFIED');
  expect(classifyFailure({ path: 'raw-playwright', detail: 'strict mode violation: locator resolved to 2 elements' })).toBe('UNCLASSIFIED');
  expect(classifyFailure({ path: 'raw-playwright', detail: 'OUT_OF_SCOPE: navigation left the task origin' })).toBe('UNCLASSIFIED');
  expect(classifyFailure({ path: 'navi-differential', detail: 'Harness exploded' })).toBe('UNCLASSIFIED');
  // Non-object and empty input cannot throw, and cannot claim a bucket.
  expect(classifyFailure(null)).toBe('UNCLASSIFIED');
  expect(classifyFailure(undefined)).toBe('UNCLASSIFIED');
  expect(classifyFailure({})).toBe('UNCLASSIFIED');
  expect(classifyFailure(/** @type {any} */ ('NOT_FOUND'))).toBe('UNCLASSIFIED');
  // A code buried mid-sentence is not extracted: that would be reading intent.
  expect(classifyFailure({ path: 'navi-differential', detail: 'call failed with NOT_FOUND earlier' })).toBe('UNCLASSIFIED');
  // DETERMINISTIC_REFUSAL specifically must never be the fallback.
  for (const observation of [null, {}, { detail: 'unknown failure' }, { code: 42 }, { code: '' }]) {
    expect(classifyFailure(observation)).not.toBe('DETERMINISTIC_REFUSAL');
  }
});

test('structured signals win over prose, and precedence is deterministic', () => {
  // A structured code outranks a misleading message body.
  expect(classifyFailure({ path: 'navi-differential', code: 'NOT_FOUND', detail: 'the button looks disabled to me' })).toBe('SELECTOR_HALLUCINATION');
  // Schema problems outrank a settlement field: a malformed call never dispatched.
  expect(classifyFailure({ path: 'navi-differential', code: 'INVALID_PAYLOAD', settled: false })).toBe('SCHEMA_VIOLATION');
  // Trusted-input requirement outranks settlement, because no dispatch was possible.
  expect(classifyFailure({ path: 'navi-differential', code: 'FALLBACK_DISABLED', settled: false })).toBe('UNTRUSTED_GESTURE_REQUIRED');
  // Settlement outranks an identity lookup that already succeeded.
  expect(classifyFailure({ path: 'navi-differential', code: 'UNSETTLED', reason: 'timeout' })).toBe('TIMEOUT_UNSETTLED');
  // Case and flag decoration in a supplied code are normalized, not guessed.
  expect(classifyFailure({ path: 'navi-differential', code: ' not_found ' })).toBe('SELECTOR_HALLUCINATION');
  expect(classifyFailure({ path: 'navi-differential', code: '--UNAVAILABLE' })).toBe('DETERMINISTIC_REFUSAL');
  expect(classifyFailure({ path: 'navi-differential', code: 'UNAVAILABLE: Target is not actionable' })).toBe('DETERMINISTIC_REFUSAL');
});

test('isFailureBucket accepts exactly the taxonomy and summarizeFailures is stable', () => {
  for (const bucket of FAILURE_BUCKETS) expect(isFailureBucket(bucket)).toBe(true);
  for (const value of ['selector_resolution_failure', 'navi_target_refusal', 'tool_failure', 'planner_stopped', '', 7, null, undefined]) {
    expect(isFailureBucket(value)).toBe(false);
  }
  const counts = summarizeFailures([
    { category: 'planner_stopped' },
    { category: 'UNCLASSIFIED' },
    { category: 'SELECTOR_HALLUCINATION' },
    { category: 'SELECTOR_HALLUCINATION' },
    { category: 'DETERMINISTIC_REFUSAL' },
    { category: 'task_incomplete' },
    { category: 'UNCLASSIFIED' }
  ]);
  // Buckets first in taxonomy order, then run-level markers alphabetically.
  expect(Object.keys(counts)).toEqual(['SELECTOR_HALLUCINATION', 'DETERMINISTIC_REFUSAL', 'UNCLASSIFIED', 'planner_stopped', 'task_incomplete']);
  expect(counts.SELECTOR_HALLUCINATION).toBe(2);
  expect(counts.UNCLASSIFIED).toBe(2);
  expect(summarizeFailures([])).toEqual({});
  expect(summarizeFailures(/** @type {any} */ (undefined))).toEqual({});
});
