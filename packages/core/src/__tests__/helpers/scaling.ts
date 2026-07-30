// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Complexity-guard helper: measure how a unit's cost SCALES with input size.
 *
 * WHY THIS EXISTS
 * ---------------
 * A guard against a complexity class (quadratic blowup, catastrophic regex
 * backtracking) must not be written as an absolute wall-clock budget.
 * `expect(elapsedMs).toBeLessThan(2000)` is a claim about the MACHINE, not
 * about the code: it goes red when the host is busy and green when a genuinely
 * quadratic implementation runs on a fast enough box. Both failure directions
 * were observed in this repo — `codebase-introspector.test.ts` blew a 15s
 * budget at 126,715ms under pre-push load on 2026-07-28 while passing in 1.32s
 * in isolation on the same commit, and `template-engine.test.ts` had already
 * had its bound widened 100ms -> 2000ms in 2026-07 for the same reason.
 *
 * A RATIO is different in kind. cost(4n)/cost(n) is a property of the
 * algorithm: ~4 if linear, ~16 if quadratic, unbounded if exponential. The two
 * measurements run back to back on the same host, so ambient load inflates
 * both sides and largely cancels.
 *
 * ROBUSTNESS
 * ----------
 * Each size is measured `repeats` times and the MINIMUM is kept. Contention can
 * only ADD time, never remove it, so the minimum is the least-contaminated
 * estimator available — far better behaved under load than a mean.
 *
 * Callers MUST assert `smallNs` clears {@link MIN_MEASURABLE_NS}. If the small
 * case is too fast to time, the ratio is timer noise and asserting on it is its
 * own blind gate — a meaningless number that passes.
 */

/**
 * Floor below which a measurement is indistinguishable from timer granularity.
 * 50µs is ~3 orders of magnitude above `process.hrtime.bigint()` resolution.
 */
export const MIN_MEASURABLE_NS = 50_000n;

export interface ScalingMeasurement {
  /** Minimum observed cost of the small input, in nanoseconds. */
  smallNs: bigint;
  /** Minimum observed cost of the large input, in nanoseconds. */
  largeNs: bigint;
  /** largeNs / smallNs — compare against the input-size step. */
  ratio: number;
}

/** Time one invocation of `fn`, in nanoseconds. */
function elapsedNs(fn: () => unknown): bigint {
  const start = process.hrtime.bigint();
  fn();
  return process.hrtime.bigint() - start;
}

/**
 * Measure cost at two input sizes and return their ratio.
 *
 * @param small  runs the unit on the baseline input
 * @param large  runs the unit on an input `factor` times bigger
 * @param repeats how many times to measure each side (min is kept)
 */
export function measureScalingRatio(
  small: () => unknown,
  large: () => unknown,
  repeats = 5,
): ScalingMeasurement {
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new Error(`measureScalingRatio: repeats must be a positive integer, got ${repeats}`);
  }
  // Warm up each side so JIT state is comparable; otherwise the first-measured
  // side pays compilation cost and the ratio is meaningless.
  small();
  large();

  // INTERLEAVED, and that is the whole robustness argument.
  //
  // A ratio cancels ambient load ONLY if both sides experience the same load. An
  // earlier revision measured small x N and THEN large x N, so the two sides
  // sampled different time windows — and on 2026-07-28 that flaked in the full
  // suite (RED at the `< 8` bound) while passing in isolation, which is precisely
  // the machine-dependence this helper exists to remove. Contention on this host
  // rises and falls over seconds as ~340 test files run in parallel, so a
  // sequential split is a bet that load holds still between the halves.
  //
  // Alternating means a contention spike lands on BOTH sides of the same
  // iteration and divides out. The MINIMUM across iterations is then the
  // least-contaminated pair, because load can only ADD time.
  // KEEP THE PAIR, NOT TWO INDEPENDENT MINIMA.
  //
  // This previously tracked `min(small)` and `min(large)` separately. That reads as
  // "the least-contaminated measurement of each side", but it BIASES THE RATIO UPWARD:
  // the large run is 4x longer, so it has proportionally more opportunity to overlap a
  // contention spike, and across only `repeats` samples it is likelier than the small
  // run to never catch a quiet window. min(large) is then inflated relative to
  // min(small), and the quotient inflates with it — in the failing direction, for a
  // guard whose whole purpose is to be load-independent.
  //
  // Measured 2026-07-29 in the pre-push battery: ratio 10.02 and 10.84 against a bound
  // of 8, while the same test passed 3/3 in isolation on the same commit. That is the
  // G27/CR-90 defect one level in — the ratio that REPLACED a wall-clock bound was
  // itself load-sensitive.
  //
  // Selecting the single iteration with the smallest COMBINED time keeps both halves
  // from the same window, so a spike that lands there inflates numerator and
  // denominator together and genuinely divides out. Selecting on the smallest RATIO
  // would be wrong in the opposite direction — it takes the best-case quotient and so
  // would HIDE a real regression, which is worse than flaking.
  let smallNs: bigint | null = null;
  let largeNs: bigint | null = null;
  let bestTotal: bigint | null = null;
  for (let i = 0; i < repeats; i++) {
    const s = elapsedNs(small);
    const l = elapsedNs(large);
    const total = s + l;
    if (bestTotal === null || total < bestTotal) {
      bestTotal = total;
      smallNs = s;
      largeNs = l;
    }
  }
  // `repeats >= 1` is validated above, so neither can still be null — but never
  // return a silent 0, which would make the ratio Infinity or NaN.
  if (smallNs === null || largeNs === null) {
    throw new Error('measureScalingRatio: no measurement taken');
  }
  return { smallNs, largeNs, ratio: Number(largeNs) / Number(smallNs) };
}
