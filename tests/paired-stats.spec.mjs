import { expect, test } from '@playwright/test';
import { analyseModel, mcnemarExact, mulberry32, pairedDifference, pooledDifference, verdictFor, wilson } from '../scripts/paired-stats.mjs';

test('a Wilson interval stays honest at a perfect and an empty rate', () => {
  // The normal approximation gives [1, 1] for 10/10 and [0, 0] for 0/10, which
  // reads as certainty from ten trials. The score interval does not.
  const perfect = wilson(10, 10);
  expect(perfect[1]).toBeCloseTo(1, 12);
  expect(perfect[0]).toBeGreaterThan(0.7);
  expect(perfect[0]).toBeLessThan(0.75);
  const empty = wilson(0, 10);
  expect(empty[0]).toBe(0);
  expect(empty[1]).toBeGreaterThan(0.25);
  expect(empty[1]).toBeLessThan(0.3);
  expect(wilson(0, 0)).toEqual([null, null]);
  expect(wilson(11, 10)).toEqual([null, null]);
});

test('the exact McNemar test reads the discordant split, not the completion totals', () => {
  expect(mcnemarExact(0, 0)).toBe(1);
  expect(mcnemarExact(5, 5)).toBe(1);
  expect(mcnemarExact(6, 0)).toBeCloseTo(0.03125, 10);
  expect(mcnemarExact(0, 6)).toBeCloseTo(0.03125, 10);
  expect(mcnemarExact(9, 1)).toBeCloseTo(2 * 11 / 1024, 10);
  // A lopsided split over more pairs is significant; the same split over fewer is not.
  expect(mcnemarExact(10, 2)).toBeLessThan(0.05);
  expect(mcnemarExact(3, 1)).toBeGreaterThan(0.05);
});

test('a paired interval is seeded, so a committed number can be re-derived', () => {
  const first = mulberry32(7);
  const second = mulberry32(7);
  expect(Array.from({ length: 5 }, first)).toEqual(Array.from({ length: 5 }, second));
  const signals = [1, 1, 0, 0, -1, 0, 0, 0];
  const a = pairedDifference(signals);
  const b = pairedDifference(signals);
  expect(a).not.toBeNull();
  if (!a || !b) throw new Error('expected a paired interval');
  expect(a).toEqual(b);
  expect(a.observed).toBeCloseTo(1 / 8, 10);
  // The interval has to cover the sampled difference itself.
  expect(a.low).toBeLessThanOrEqual(a.observed);
  expect(a.high).toBeGreaterThanOrEqual(a.observed);
  expect(pairedDifference([])).toBeNull();
});

test('a paired model analysis matches trials by iteration and names what it cannot conclude', () => {
  /** @param {number} iteration @param {boolean} navi @param {boolean} raw */
  const pair = (iteration, navi, raw) => ([
    { iteration, path: 'navi-differential', success: navi, steps: 5, wallMs: 1000 },
    { iteration, path: 'raw-playwright', success: raw, steps: 8, wallMs: 1000 }
  ]);
  const report = { model: 'synthetic', trials: [...pair(1, true, true), ...pair(2, true, false), ...pair(3, false, true), ...pair(4, false, false)] };
  const analysis = analyseModel(report);
  expect(analysis.iterationPairs).toBe(4);
  expect(analysis.cells).toEqual({ both: 1, naviOnly: 1, rawOnly: 1, neither: 1 });
  expect(analysis.paths['navi-differential'].successes).toBe(2);
  expect(analysis.paths['raw-playwright'].successes).toBe(2);
  expect(analysis.pValue).toBe(1);
  expect(analysis.verdict).toBe('inconclusive (only 4 pairs)');
  // The rule is fixed before the run: a wide interval that still contains a
  // ten-point regression is not rounded into a win, and four pairs decide nothing.
  expect(verdictFor({ observed: 0.1, low: -0.12, high: 0.3 }, 0.4, 80)).toBe('inconclusive');
  expect(verdictFor({ observed: 0.1, low: -0.02, high: 0.2 }, 0.4, 80)).toBe('not worse than baseline (within 10 points)');
  expect(verdictFor({ observed: 0.15, low: 0.02, high: 0.28 }, 0.01, 80)).toBe('superior');
  expect(verdictFor({ observed: -0.2, low: -0.3, high: -0.1 }, 0.01, 80)).toBe('worse than baseline');
  // A negative sample estimate whose interval overlaps zero is not labelled a
  // regression unless the paired test establishes the directional effect.
  expect(verdictFor({ observed: -0.125, low: -0.25, high: 0 }, 0.125, 40)).toBe('inconclusive');
  expect(verdictFor({ observed: 0.5, low: 0.4, high: 0.6 }, 0.001, 4)).toBe('inconclusive (only 4 pairs)');
  // A model that completes nothing on either path has no comparison to report,
  // even though its interval is technically above the margin.
  const allFailed = analyseModel({ model: 'weak', trials: [...pair(1, false, false), ...pair(2, false, false), ...pair(3, false, false), ...pair(4, false, false)] });
  expect(allFailed.verdict).toBe('inconclusive (both paths failed every trial)');
});

test('the pooled interval resamples inside each model instead of pooling trials blindly', () => {
  const pooled = pooledDifference([{ signals: [1, 1, 1, 0] }, { signals: [-1, -1, 0, 0] }]);
  expect(pooled).not.toBeNull();
  if (!pooled) throw new Error('expected a pooled interval');
  expect(pooled.pairs).toBe(8);
  expect(pooled.observed).toBeCloseTo(1 / 8, 10);
  // Resampling has to produce a range, not a point: an interval of zero width
  // out of eight pairs would be a certainty this design cannot buy.
  expect(pooled.low).toBeLessThan(pooled.observed);
  expect(pooled.high).toBeGreaterThan(pooled.observed);
  expect(pooledDifference([])).toBeNull();
});
