// Pure DSP for the on-device wake word: resampling to 16 kHz, frame energy, speech span, MFCC (+ delta) features.
// No DOM, no Node APIs, no parameter properties: runs in the renderer and under `node --experimental-strip-types`.
// Everything is plain arithmetic on Float32Array/Float64Array so it can be unit-tested with synthetic signals.

export const WAKE_RATE = 16000;
/** 25 ms analysis window and a 20 ms hop (50 feature frames a second): half the work of the usual 10 ms hop, enough for a 1-2 syllable word. */
export const FRAME_LEN = 400;
export const HOP = 320;
export const FRAME_MS = (HOP / WAKE_RATE) * 1000;
export const NFFT = 512;
export const N_MEL = 24;
/** Cepstra c1..c12 (c0 is just loudness and is dropped), plus their deltas. */
export const N_CEP = 12;
export const FEATURE_DIM = N_CEP * 2;
const PRE_EMPHASIS = 0.97;
const LIFTER = 22;
const DELTA_WEIGHT = 0.6;

// ------------------------------------------------------------------------------------------ resampling
const KERNEL_ZEROS = 6;
const KERNEL_RES = 256;
const KERNEL_CUTOFF = 0.92;
let kernelTable: Float32Array | undefined;

/** Windowed-sinc low-pass sampled finely once; `u` is the distance from the output sample in output-sample units. */
function kernel(u: number): number {
  if (!kernelTable) {
    const size = KERNEL_ZEROS * KERNEL_RES * 2 + 1;
    kernelTable = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const x = (i - KERNEL_ZEROS * KERNEL_RES) / KERNEL_RES;
      const arg = Math.PI * KERNEL_CUTOFF * x;
      const sinc = Math.abs(arg) < 1e-9 ? 1 : Math.sin(arg) / arg;
      const hann = 0.5 + 0.5 * Math.cos((Math.PI * x) / KERNEL_ZEROS);
      kernelTable[i] = KERNEL_CUTOFF * sinc * hann;
    }
  }
  return kernelTable[Math.round((u + KERNEL_ZEROS) * KERNEL_RES)];
}

/** Number of 16 kHz samples `resampleTo16k` produces for `length` input samples. */
export function resampledLength(length: number, rate: number): number {
  return rate > 0 ? Math.floor((length * WAKE_RATE) / rate) : 0;
}

/**
 * Resample to 16 kHz with an anti-aliasing low-pass (the app's older helper just interpolated, which folds 8-24 kHz noise into the band
 * the MFCCs look at). Writes outputs [from, to) into `out` so a caller can do it in small slices.
 */
export function resampleSlice(input: Float32Array, rate: number, out: Float32Array, from: number, to: number): void {
  const ratio = rate / WAKE_RATE;
  for (let i = from; i < to; i++) {
    const centre = i * ratio;
    if (ratio <= 1) {
      // Upsampling (an 8 kHz mic): plain linear interpolation is enough, nothing can alias.
      const base = Math.floor(centre);
      const frac = centre - base;
      out[i] = input[base] * (1 - frac) + input[Math.min(base + 1, input.length - 1)] * frac;
      continue;
    }
    const lo = Math.max(0, Math.ceil(centre - KERNEL_ZEROS * ratio));
    const hi = Math.min(input.length - 1, Math.floor(centre + KERNEL_ZEROS * ratio));
    let sum = 0;
    let weight = 0;
    for (let n = lo; n <= hi; n++) {
      const k = kernel((n - centre) / ratio);
      sum += input[n] * k;
      weight += k;
    }
    out[i] = weight !== 0 ? sum / weight : 0;
  }
}

export function resampleTo16k(input: Float32Array, rate: number): Float32Array {
  if (!(rate > 0) || input.length === 0) return new Float32Array(0);
  if (Math.abs(rate - WAKE_RATE) < 1) return input;
  const out = new Float32Array(resampledLength(input.length, rate));
  resampleSlice(input, rate, out, 0, out.length);
  return out;
}

// ------------------------------------------------------------------------------------------ FFT / mel / DCT
const bitReverse = new Uint16Array(NFFT);
const twiddleRe = new Float64Array(NFFT / 2);
const twiddleIm = new Float64Array(NFFT / 2);
const hamming = new Float64Array(FRAME_LEN);
const melBank: { start: number; weights: Float64Array }[] = [];
const dct = new Float64Array(N_CEP * N_MEL);
const lifter = new Float64Array(N_CEP);
let tablesReady = false;

const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

function prepare() {
  if (tablesReady) return;
  tablesReady = true;
  const bits = Math.log2(NFFT);
  for (let i = 0; i < NFFT; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    bitReverse[i] = r;
  }
  for (let i = 0; i < NFFT / 2; i++) {
    twiddleRe[i] = Math.cos((-2 * Math.PI * i) / NFFT);
    twiddleIm[i] = Math.sin((-2 * Math.PI * i) / NFFT);
  }
  for (let i = 0; i < FRAME_LEN; i++) hamming[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME_LEN - 1));
  const lowMel = hzToMel(100);
  const highMel = hzToMel(7000);
  const points: number[] = [];
  for (let m = 0; m < N_MEL + 2; m++) points.push((melToHz(lowMel + ((highMel - lowMel) * m) / (N_MEL + 1)) / WAKE_RATE) * NFFT);
  for (let m = 1; m <= N_MEL; m++) {
    const left = points[m - 1];
    const centre = points[m];
    const right = points[m + 1];
    const start = Math.max(0, Math.ceil(left));
    const end = Math.min(NFFT / 2, Math.floor(right));
    const weights = new Float64Array(Math.max(0, end - start + 1));
    for (let bin = start; bin <= end; bin++) weights[bin - start] = bin <= centre ? (bin - left) / (centre - left) : (right - bin) / (right - centre);
    melBank.push({ start, weights });
  }
  for (let k = 0; k < N_CEP; k++) {
    for (let m = 0; m < N_MEL; m++) dct[k * N_MEL + m] = Math.cos((Math.PI * (k + 1) * (m + 0.5)) / N_MEL);
    lifter[k] = 1 + (LIFTER / 2) * Math.sin((Math.PI * (k + 1)) / LIFTER);
  }
}

const re = new Float64Array(NFFT);
const im = new Float64Array(NFFT);
const melLog = new Float64Array(N_MEL);

/** Static lifted cepstra c1..c12 of the frame starting at `start` (zero padded at the end), written to `out[outAt..]`. */
export function cepstrumAt(samples: Float32Array, start: number, out: Float32Array, outAt: number, gain = 1): void {
  prepare();
  re.fill(0);
  im.fill(0);
  let previous = start > 0 ? samples[start - 1] * gain : 0;
  for (let i = 0; i < FRAME_LEN; i++) {
    const x = start + i < samples.length ? samples[start + i] * gain : 0;
    re[bitReverse[i]] = (x - PRE_EMPHASIS * previous) * hamming[i];
    previous = x;
  }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1;
    const stride = NFFT / size;
    for (let base = 0; base < NFFT; base += size) {
      for (let k = 0; k < half; k++) {
        const wr = twiddleRe[k * stride];
        const wi = twiddleIm[k * stride];
        const a = base + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  for (let m = 0; m < N_MEL; m++) {
    const { start: first, weights } = melBank[m];
    let energy = 0;
    for (let w = 0; w < weights.length; w++) {
      const bin = first + w;
      energy += weights[w] * (re[bin] * re[bin] + im[bin] * im[bin]);
    }
    melLog[m] = Math.log(energy + 1e-7);
  }
  for (let k = 0; k < N_CEP; k++) {
    let sum = 0;
    for (let m = 0; m < N_MEL; m++) sum += dct[k * N_MEL + m] * melLog[m];
    out[outAt + k] = (sum / N_MEL) * lifter[k];
  }
}

/** Loudness of each analysis frame in dB (time domain only, cheap enough to run over a whole clip). */
export function frameEnergiesDb(samples: Float32Array): Float32Array {
  const count = samples.length >= FRAME_LEN ? Math.floor((samples.length - FRAME_LEN) / HOP) + 1 : 0;
  const out = new Float32Array(count);
  for (let f = 0; f < count; f++) {
    let sum = 0;
    const start = f * HOP;
    for (let i = 0; i < FRAME_LEN; i++) sum += samples[start + i] * samples[start + i];
    out[f] = 10 * Math.log10(sum / FRAME_LEN + 1e-10);
  }
  return out;
}

// ------------------------------------------------------------------------------------------ speech span
export interface SpeechSpan {
  /** First and one-past-last feature frame of the span. */
  start: number;
  end: number;
  /** Mean loudness of the speech frames above the noise floor (dB). */
  snrDb: number;
  floorDb: number;
  peakDb: number;
  /** Number of frames louder than the speech threshold. */
  voicedFrames: number;
}

export interface SpanOptions {
  /** Longest silence (frames) bridged inside one word. A stop like the d in "Sudo" is 50-120 ms. */
  maxGapFrames?: number;
  /** Shortest voiced run (frames) that counts. */
  minRunFrames?: number;
  /** Which run to take: the first one that starts the utterance (wake clips), or the longest (enrolment). */
  pick?: 'first' | 'longest';
}

function percentile(values: Float32Array, p: number): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/**
 * Finds the speech in a clip from frame energies alone. The threshold sits well above the noise floor and well below the peak, so
 * quiet voices and noisy rooms both work; a clip whose loudest part is not at least 10 dB above its floor has no speech.
 */
export function findSpeechSpan(energyDb: Float32Array, options: SpanOptions = {}): SpeechSpan | undefined {
  if (energyDb.length < 4) return undefined;
  const maxGap = options.maxGapFrames ?? 12;
  const minRun = options.minRunFrames ?? 3;
  const floorDb = percentile(energyDb, 0.1);
  const peakDb = percentile(energyDb, 0.95);
  if (peakDb - floorDb < 10) return undefined;
  const threshold = Math.max(floorDb + 8, peakDb - 28);
  const runs: { start: number; end: number }[] = [];
  let runStart = -1;
  for (let f = 0; f <= energyDb.length; f++) {
    const loud = f < energyDb.length && energyDb[f] > threshold;
    if (loud && runStart < 0) runStart = f;
    else if (!loud && runStart >= 0) {
      const last = runs[runs.length - 1];
      if (last && runStart - last.end <= maxGap) last.end = f;
      else runs.push({ start: runStart, end: f });
      runStart = -1;
    }
  }
  const real = runs.filter(r => r.end - r.start >= minRun);
  if (real.length === 0) return undefined;
  const chosen = options.pick === 'longest' ? real.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a)) : real[0];
  let voiced = 0;
  let sum = 0;
  for (let f = chosen.start; f < chosen.end; f++) if (energyDb[f] > threshold) { voiced++; sum += energyDb[f]; }
  return { start: chosen.start, end: chosen.end, snrDb: voiced ? sum / voiced - floorDb : 0, floorDb, peakDb, voicedFrames: voiced };
}

/** Level the loudest speech frame is brought to before features are taken, so a whispered and a loud "Sudo" meet the same spectral floor. */
export const TARGET_PEAK_DB = -22;
export const MAX_GAIN = 40;

export function levelGain(peakDb: number): number {
  return Math.min(MAX_GAIN, 10 ** ((TARGET_PEAK_DB - peakDb) / 20));
}

// ------------------------------------------------------------------------------------------ feature sequences
/** `frames` x FEATURE_DIM, row-major: c1..c12 then the (down-weighted) deltas. */
export interface FeatureSeq {
  frames: number;
  data: Float32Array;
}

/** Appends deltas to a block of static cepstra (frames x N_CEP, row-major). */
export function withDeltas(ceps: Float32Array, frames: number): FeatureSeq {
  const data = new Float32Array(frames * FEATURE_DIM);
  const at = (t: number, k: number) => ceps[Math.min(frames - 1, Math.max(0, t)) * N_CEP + k];
  for (let t = 0; t < frames; t++) {
    for (let k = 0; k < N_CEP; k++) {
      data[t * FEATURE_DIM + k] = ceps[t * N_CEP + k];
      data[t * FEATURE_DIM + N_CEP + k] = (DELTA_WEIGHT * (at(t + 2, k) - at(t - 2, k) + 2 * (at(t + 1, k) - at(t - 1, k)))) / 10;
    }
  }
  return { frames, data };
}

/** Features of feature frames [from, to) of a 16 kHz signal, in one go (tests, enrolment). The runtime job does the same in small steps. */
export function extractFeatures(samples16: Float32Array, from: number, to: number, gain = 1): FeatureSeq {
  const frames = Math.max(0, to - from);
  const ceps = new Float32Array(frames * N_CEP);
  for (let f = 0; f < frames; f++) cepstrumAt(samples16, (from + f) * HOP, ceps, f * N_CEP, gain);
  return withDeltas(ceps, frames);
}
