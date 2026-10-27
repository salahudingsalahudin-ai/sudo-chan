// Subsequence dynamic time warping: where in a (longer) clip does a short template fit best, and how well?
// Open begin, open end, so "Sudo kaise ho" and "hey Sudo" both contain a good match for "Sudo".
import { FEATURE_DIM } from './dsp.ts';
import type { FeatureSeq } from './dsp.ts';

/** Extra cost of a non-diagonal step, so a template cannot be squashed onto one test frame or stretched over a long vowel for free. */
const STEP_PENALTY = 1.2;
/** Accepted length of the matched stretch relative to the template (speaking faster or slower). */
export const MIN_STRETCH = 0.55;
export const MAX_STRETCH = 2.0;

export interface DtwMatch {
  /** Per-template-frame cost of the best path (lower is better); Infinity if nothing fit. */
  cost: number;
  /** First and last test frame (inclusive) of the best path. */
  start: number;
  end: number;
}

/** Euclidean distance between frame `i` of `a` and frame `j` of `b`. */
function distance(a: Float32Array, i: number, b: Float32Array, j: number): number {
  let sum = 0;
  const ao = i * FEATURE_DIM;
  const bo = j * FEATURE_DIM;
  for (let k = 0; k < FEATURE_DIM; k++) {
    const d = a[ao + k] - b[bo + k];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Runs the whole subsequence search. `test` frames in [from, to) only. */
export function subsequenceDtw(template: FeatureSeq, test: FeatureSeq, from = 0, to = test.frames): DtwMatch {
  const m = template.frames;
  const minLen = Math.max(1, Math.round(MIN_STRETCH * m));
  const maxLen = Math.max(minLen, Math.round(MAX_STRETCH * m));
  let prevCost = new Float64Array(m).fill(Infinity);
  let prevStart = new Int32Array(m);
  let curCost = new Float64Array(m);
  let curStart = new Int32Array(m);
  let best: DtwMatch = { cost: Infinity, start: -1, end: -1 };
  for (let j = from; j < Math.min(to, test.frames); j++) {
    for (let i = 0; i < m; i++) {
      const d = distance(template.data, i, test.data, j);
      let c: number;
      let s: number;
      if (i === 0) {
        // A path may begin at any test frame (open begin) or continue the previous column.
        c = d;
        s = j;
        const stay = prevCost[0] + d + STEP_PENALTY;
        if (stay < c) { c = stay; s = prevStart[0]; }
      } else {
        const diag = prevCost[i - 1];
        const up = curCost[i - 1] + STEP_PENALTY;
        const left = prevCost[i] + STEP_PENALTY;
        if (diag <= up && diag <= left) { c = diag + d; s = prevStart[i - 1]; }
        else if (up <= left) { c = up + d; s = curStart[i - 1]; }
        else { c = left + d; s = prevStart[i]; }
      }
      curCost[i] = c;
      curStart[i] = s;
    }
    const length = j - curStart[m - 1] + 1;
    if (length >= minLen && length <= maxLen) {
      const normalised = curCost[m - 1] / m;
      if (normalised < best.cost) best = { cost: normalised, start: curStart[m - 1], end: j };
    }
    [prevCost, curCost] = [curCost, prevCost];
    [prevStart, curStart] = [curStart, prevStart];
  }
  return best;
}
