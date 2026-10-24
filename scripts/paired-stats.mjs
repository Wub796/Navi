/**
 * Paired statistics for the hard checkout benchmark.
 *
 * A benchmark that reports "28/30 versus 26/30" invites a reader to subtract two
 * small numbers and believe the answer. These functions exist so the report can
 * say how much of that difference is distinguishable from noise: a Wilson interval
 * for each rate, the exact McNemar test for the discordant pairs of a matched
 * design, and a seeded bootstrap interval for the paired difference. None of them
 * can turn one local fixture into evidence about agents in general; they only stop
 * a two-trial margin from being read as a proven one.
 */

/** Two-sided 95% normal quantile, the only level this report uses. */
export const Z95 = 1.959963984540054;

/**
 * The margin the study is powered to defend: a model is non-inferior when the
 * paired interval's lower bound is above minus this many points. Fixed before the
 * run so the verdict cannot be chosen after seeing the numbers.
 */
export const NON_INFERIORITY_MARGIN = 0.10;

/**
 * Below this many matched pairs the interval is too wide for the rule above to
 * mean anything, and the verdict says so instead of testing a small sample.
 */
export const MIN_PAIRS = 30;

/**
 * Wilson score interval for a binomial rate. Preferred over the normal
 * approximation because these runs are near 1.0, where the textbook interval
 * collapses to zero width and reads as certainty.
 * @param {number} successes @param {number} trials @param {number} [z]
 * @returns {[number | null, number | null]}
 */
export function wilson(successes, trials, z = Z95) {
  if (!Number.isInteger(trials) || trials <= 0 || !Number.isInteger(successes) || successes < 0 || successes > trials) return [null, null];
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = (p + (z * z) / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Exact two-sided McNemar test: under the null hypothesis the two discordant
 * cells are equally likely, so their split is Binomial(b + c, 1/2). The binomial
 * coefficient is accumulated in log space, because a study large enough to be
 * worth running would overflow the direct form.
 * @param {number} naviOnly @param {number} rawOnly
 */
export function mcnemarExact(naviOnly, rawOnly) {
  if (!Number.isInteger(naviOnly) || !Number.isInteger(rawOnly) || naviOnly < 0 || rawOnly < 0) return null;
  const n = naviOnly + rawOnly;
  if (n === 0) return 1;
  const k = Math.min(naviOnly, rawOnly);
  let logCoefficient = 0;
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logCoefficient += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logCoefficient - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

/**
 * Deterministic PRNG, so a committed interval can be checked by re-running the
 * analysis on the same record instead of trusting this machine's entropy.
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap interval for the mean of a paired signal: +1 where only
 * Navi completed, -1 where only the raw driver did, 0 where the pair agreed. It
 * resamples trials, not the pooled rate, so the interval reflects the matching.
 * @param {number[]} signals @param {{resamples?: number, seed?: number, level?: number}} [options]
 * @returns {{observed: number, low: number, high: number, resamples: number, level: number} | null}
 */
export function pairedDifference(signals, { resamples = 20000, seed = 20261024, level = 0.95 } = {}) {
  const n = signals.length;
  if (!n || !Number.isInteger(resamples) || resamples < 100) return null;
  const observed = signals.reduce((sum, value) => sum + value, 0) / n;
  const random = mulberry32(seed);
  const draws = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += signals[Math.floor(random() * n)];
    draws[r] = sum / n;
  }
  draws.sort();
  const alpha = (1 - level) / 2;
  const low = draws[Math.min(resamples - 1, Math.floor(alpha * resamples))];
  const high = draws[Math.min(resamples - 1, Math.ceil((1 - alpha) * resamples) - 1)];
  return { observed, low, high, resamples, level };
}

/**
 * Analyse one model's raw record. Trials are matched by iteration, which is also
 * the fixture's seed, so both paths saw the same task schedule.
 * @param {{model?: string, iterations?: number, trials: {iteration: number, path: string, success: boolean, steps: number, wallMs: number}[]}} report
 */
export function analyseModel(report) {
  const byPath = (/** @type {string} */ path) => report.trials.filter(trial => trial.path === path);
  const navi = byPath('navi-differential');
  const raw = byPath('raw-playwright');
  /** @type {Map<number, {navi?: boolean, raw?: boolean}>} */
  const pairs = new Map();
  for (const trial of navi) pairs.set(trial.iteration, { navi: trial.success });
  for (const trial of raw) {
    const row = pairs.get(trial.iteration);
    if (row) row.raw = trial.success;
  }
  const rows = [...pairs.values()].filter(row => typeof row.raw === 'boolean' && typeof row.navi === 'boolean');
  const cells = { both: 0, naviOnly: 0, rawOnly: 0, neither: 0 };
  /** @type {number[]} */
  const signals = [];
  for (const row of rows) {
    // Every pair contributes a zero to the resample, including the agreements:
    // dropping them would bootstrap the discordant subset and report an interval
    // for a different, much smaller study.
    if (row.navi && row.raw) { cells.both++; signals.push(0); }
    else if (row.navi) { cells.naviOnly++; signals.push(1); }
    else if (row.raw) { cells.rawOnly++; signals.push(-1); }
    else { cells.neither++; signals.push(0); }
  }
  /** @param {{success: boolean, steps: number}[]} list */
  const summarise = list => {
    const successes = list.filter(trial => trial.success).length;
    return {
      successes, trials: list.length, rate: list.length ? successes / list.length : null,
      ci: wilson(successes, list.length),
      meanSteps: list.length ? list.reduce((sum, trial) => sum + trial.steps, 0) / list.length : null
    };
  };
  const difference = pairedDifference(signals);
  const pValue = mcnemarExact(cells.naviOnly, cells.rawOnly);
  // Zero on both sides is not a non-inferiority result: it says this model could
  // not do the task with either tool surface, so the comparison has no outcome to
  // compare and must not borrow the wording of "not worse".
  const bothFailed = navi.length > 0 && raw.length > 0 && navi.every(trial => !trial.success) && raw.every(trial => !trial.success);
  return {
    model: report.model ?? null,
    iterationPairs: rows.length,
    paths: { 'raw-playwright': summarise(raw), 'navi-differential': summarise(navi) },
    cells, difference, pValue, signals,
    verdict: bothFailed ? 'inconclusive (both paths failed every trial)' : verdictFor(difference, pValue, rows.length)
  };
}

/**
 * The pre-specified decision rule. "Superior" needs a significant McNemar test in
 * Navi's favour; "not worse" only needs the paired lower bound above the margin.
 * @param {{observed: number, low: number, high: number} | null} difference @param {number | null} pValue @param {number} pairs
 */
export function verdictFor(difference, pValue, pairs) {
  if (!difference || !pairs) return 'no pairs';
  if (pairs < MIN_PAIRS) return `inconclusive (only ${pairs} pairs)`;
  if (pValue !== null && pValue < 0.05 && difference.observed > 0) return 'superior';
  if (difference.low > -NON_INFERIORITY_MARGIN) return 'not worse than baseline (within 10 points)';
  if (difference.high < NON_INFERIORITY_MARGIN && difference.observed < 0) return 'worse than baseline';
  return 'inconclusive';
}

/**
 * Cluster bootstrap over models: resample iterations inside each model, then take
 * the pair-weighted mean of the model differences. Weighting by pairs rather than
 * averaging model means keeps a 40-pair model from counting as much as an 80-pair
 * one, while still resampling within a model so its own correlation is kept.
 * @param {{signals: number[]}[]} models @param {{resamples?: number, seed?: number, level?: number}} [options]
 */
export function pooledDifference(models, { resamples = 10000, seed = 20261024, level = 0.95 } = {}) {
  const used = models.filter(model => Array.isArray(model.signals) && model.signals.length);
  if (!used.length || !Number.isInteger(resamples) || resamples < 100) return null;
  const total = used.reduce((sum, model) => sum + model.signals.length, 0);
  const observed = used.reduce((sum, model) => sum + model.signals.reduce((a, b) => a + b, 0), 0) / total;
  const random = mulberry32(seed);
  const draws = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let numerator = 0;
    let denominator = 0;
    for (const model of used) {
      const n = model.signals.length;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += model.signals[Math.floor(random() * n)];
      numerator += sum;
      denominator += n;
    }
    draws[r] = numerator / denominator;
  }
  draws.sort();
  const alpha = (1 - level) / 2;
  return {
    observed, low: draws[Math.min(resamples - 1, Math.floor(alpha * resamples))],
    high: draws[Math.min(resamples - 1, Math.ceil((1 - alpha) * resamples) - 1)],
    resamples, level, pairs: total
  };
}

/** Percentage with one decimal, for a table a human reads. @param {number | null} value */
export function pct(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

/** A percentage-point interval, which is the unit a paired difference is in. @param {{low: number, high: number} | null} interval */
export function points(interval) {
  if (!interval) return 'n/a';
  return `[${(interval.low * 100).toFixed(1)}, ${(interval.high * 100).toFixed(1)}]`;
}
