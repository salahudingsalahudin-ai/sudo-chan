// Engine "template-dtw": personalised template matching. The user's own 5-8 recordings of the name are turned into MFCC sequences
// and a clip is a candidate when some stretch of its first seconds is close (subsequence DTW) to the best templates.
// Fully offline, no model file, and it doubles as a speaker check because the templates are the owner's voice.
import { FRAME_MS, WAKE_RATE, findSpeechSpan, levelGain, frameEnergiesDb, resampleSlice, resampledLength, N_CEP, HOP, cepstrumAt, withDeltas, FEATURE_DIM } from './dsp.ts';
import type { FeatureSeq } from './dsp.ts';
import { subsequenceDtw } from './dtw.ts';
import type { LocalWakeDetector, LocalWakeEngine, LocalWakeJob, LocalWakeVerdict } from './types.ts';

export const TEMPLATE_ENGINE_ID = 'template-dtw';
/** Only the first seconds of a clip are searched: the name comes within the first words. */
export const MAX_CLIP_SECONDS = 4.5;
export const MAX_SEARCH_FRAMES = 150;
/** Fewest enrolled samples; fewer and the calibration below means nothing. */
export const MIN_TEMPLATES = 5;
export const MAX_TEMPLATES = 8;
/** Stored limits (also used to reject a damaged or hostile profile file). */
export const MAX_TEMPLATE_FRAMES = 120;
const SPEECH_MIN_FRAMES = 6;
const MIN_SNR_DB = 8;
/** Standing in for "no alignment possible" when calibrating. */
const FAIL_COST = 30;

export interface StoredTemplate {
  frames: number;
  /** frames x FEATURE_DIM numbers, rounded to 2 decimals. */
  data: number[];
}

export interface LabelProfile {
  templates: StoredTemplate[];
  /** Calibrated at enrolment from leave-one-out scores of the user's own samples. */
  threshold: number;
  looMean: number;
  looSd: number;
}

export interface TemplateEngineData {
  labels: Record<string, LabelProfile>;
}

// ------------------------------------------------------------------------------------------ scoring helpers
/** The score of a clip against several templates of one word: mean of the closest two (one if there are fewer than five). */
export function aggregateCosts(costs: number[]): number {
  const finite = costs.filter(c => Number.isFinite(c)).sort((a, b) => a - b);
  if (finite.length === 0) return Infinity;
  const take = costs.length >= MIN_TEMPLATES ? 2 : 1;
  const used = finite.slice(0, take);
  return used.reduce((a, b) => a + b, 0) / used.length;
}

export function toSeq(template: StoredTemplate): FeatureSeq {
  return { frames: template.frames, data: Float32Array.from(template.data) };
}

export function toStored(seq: FeatureSeq): StoredTemplate {
  return { frames: seq.frames, data: Array.from(seq.data, v => Math.round(v * 100) / 100) };
}

/** Effective threshold: calibrated value, scaled by the sensitivity slider (0.8x .. 1.25x) and the limiter's adaptive offset. */
export function effectiveThreshold(base: number, sensitivity: number, offset: number): number {
  const s = Math.min(1, Math.max(0, Number.isFinite(sensitivity) ? sensitivity : 0.5));
  const scale = s <= 0.5 ? 0.8 + 0.4 * s : 1 + 0.5 * (s - 0.5);
  return base * scale * (1 + offset);
}

export interface Calibration {
  looScores: number[];
  looMean: number;
  looSd: number;
  threshold: number;
}

/** Leave-one-out: how far is each enrolled sample from the others? The threshold sits two standard deviations above that. */
export function calibrate(seqs: FeatureSeq[]): Calibration {
  const looScores = seqs.map((own, i) => {
    const costs = seqs.filter((_, j) => j !== i).map(other => {
      const match = subsequenceDtw(other, own);
      return Number.isFinite(match.cost) ? match.cost : FAIL_COST;
    });
    const sorted = costs.sort((a, b) => a - b);
    const take = seqs.length >= MIN_TEMPLATES ? 2 : 1;
    return sorted.slice(0, take).reduce((a, b) => a + b, 0) / take;
  });
  const looMean = looScores.reduce((a, b) => a + b, 0) / looScores.length;
  const variance = looScores.reduce((a, b) => a + (b - looMean) * (b - looMean), 0) / looScores.length;
  const looSd = Math.sqrt(variance);
  const threshold = looMean + 2 * Math.max(looSd, 0.15 * looMean);
  return { looScores, looMean, looSd, threshold };
}

// ------------------------------------------------------------------------------------------ the evaluation job
type Phase = 'resample' | 'span' | 'features' | 'match' | 'done';

interface PreparedLabel {
  label: string;
  base: number;
  seqs: FeatureSeq[];
}

class TemplateJob implements LocalWakeJob {
  private phase: Phase = 'resample';
  private input: Float32Array;
  private rate: number;
  private out: Float32Array;
  private resampled = 0;
  private energies = new Float32Array(0);
  private winStart = 0;
  private winEnd = 0;
  private ceps = new Float32Array(0);
  private featuresDone = 0;
  private gain = 1;
  private test: FeatureSeq = { frames: 0, data: new Float32Array(0) };
  private queue: { label: string; seq: FeatureSeq }[] = [];
  private queuePos = 0;
  private costs = new Map<string, number[]>();
  private best: { label: string; cost: number; start: number; end: number } | undefined;
  private verdict: LocalWakeVerdict | undefined;
  private labels: PreparedLabel[];
  private sensitivity: number;
  private offset: number;

  constructor(clip: Float32Array, rate: number, labels: PreparedLabel[], sensitivity: number, offset: number) {
    const keep = Math.min(clip.length, Math.floor(MAX_CLIP_SECONDS * rate));
    this.input = clip.length > keep ? clip.subarray(0, keep) : clip;
    this.rate = rate;
    this.labels = labels;
    this.sensitivity = sensitivity;
    this.offset = offset;
    this.out = rate > 0 ? new Float32Array(resampledLength(this.input.length, rate)) : new Float32Array(0);
    if (!(rate > 0) || this.out.length < HOP * 4) this.finish('too-short');
    else if (Math.abs(rate - WAKE_RATE) < 1) { this.out = this.input; this.resampled = this.out.length; this.phase = 'span'; }
  }

  private finish(reason: LocalWakeVerdict['reason'], extra: Partial<LocalWakeVerdict> = {}) {
    this.phase = 'done';
    const base = this.labels.length ? Math.min(...this.labels.map(l => l.base)) : Infinity;
    this.verdict = { candidate: false, reason, score: Infinity, threshold: effectiveThreshold(Number.isFinite(base) ? base : 0, this.sensitivity, this.offset), ...extra };
  }

  step(budgetMs: number, now: () => number): boolean {
    const deadline = now() + budgetMs;
    try {
      while (this.phase !== 'done') {
        this.work();
        if (this.phase !== 'done' && now() >= deadline) return false;
      }
    } catch {
      this.finish('error');
    }
    return true;
  }

  private work() {
    if (this.phase === 'resample') {
      const to = Math.min(this.out.length, this.resampled + 1024);
      resampleSlice(this.input, this.rate, this.out, this.resampled, to);
      this.resampled = to;
      if (to >= this.out.length) this.phase = 'span';
    } else if (this.phase === 'span') {
      this.energies = frameEnergiesDb(this.out);
      const span = findSpeechSpan(this.energies, { pick: 'first', maxGapFrames: 12 });
      if (!span || span.snrDb < MIN_SNR_DB) return this.finish('no-speech');
      if (span.end - span.start < SPEECH_MIN_FRAMES) return this.finish('too-short');
      this.gain = levelGain(span.peakDb);
      this.winStart = Math.max(0, span.start - 3);
      this.winEnd = Math.min(this.energies.length, span.start + MAX_SEARCH_FRAMES);
      this.ceps = new Float32Array((this.winEnd - this.winStart) * N_CEP);
      this.featuresDone = 0;
      this.phase = 'features';
    } else if (this.phase === 'features') {
      const frames = this.winEnd - this.winStart;
      const upTo = Math.min(frames, this.featuresDone + 4);
      for (let f = this.featuresDone; f < upTo; f++) cepstrumAt(this.out, (this.winStart + f) * HOP, this.ceps, f * N_CEP, this.gain);
      this.featuresDone = upTo;
      if (upTo >= frames) {
        this.test = withDeltas(this.ceps, frames);
        for (const l of this.labels) for (const seq of l.seqs) this.queue.push({ label: l.label, seq });
        this.phase = 'match';
      }
    } else if (this.phase === 'match') {
      if (this.queuePos >= this.queue.length) return this.conclude();
      const { label, seq } = this.queue[this.queuePos++];
      const match = subsequenceDtw(seq, this.test);
      const list = this.costs.get(label) ?? [];
      list.push(match.cost);
      this.costs.set(label, list);
      if (!this.best || match.cost < this.best.cost) this.best = { label, cost: match.cost, start: match.start, end: match.end };
    }
  }

  private conclude() {
    let bestLabel: PreparedLabel | undefined;
    let bestScore = Infinity;
    let bestThreshold = 0;
    for (const l of this.labels) {
      const score = aggregateCosts(this.costs.get(l.label) ?? []);
      const threshold = effectiveThreshold(l.base, this.sensitivity, this.offset);
      // The closest label by margin to its own threshold wins, so a looser word cannot hide a tighter one.
      if (!bestLabel || score / threshold < bestScore / bestThreshold) { bestLabel = l; bestScore = score; bestThreshold = threshold; }
    }
    if (!bestLabel) return this.finish('not-enrolled');
    const candidate = Number.isFinite(bestScore) && bestScore <= bestThreshold;
    const pick = this.best && this.best.label === bestLabel.label ? this.best : undefined;
    this.phase = 'done';
    this.verdict = {
      candidate,
      reason: candidate ? 'match' : 'no-match',
      score: bestScore,
      threshold: bestThreshold,
      label: bestLabel.label,
      startMs: pick ? Math.round((this.winStart + pick.start) * FRAME_MS) : undefined,
      endMs: pick ? Math.round((this.winStart + pick.end) * FRAME_MS) : undefined,
    };
  }

  result(): LocalWakeVerdict {
    return this.verdict ?? { candidate: false, reason: 'error', score: Infinity, threshold: 0 };
  }
}

// ------------------------------------------------------------------------------------------ detector + engine
export class TemplateDetector implements LocalWakeDetector {
  readonly engineId = TEMPLATE_ENGINE_ID;
  private prepared: PreparedLabel[];
  private sensitivity = 0.5;
  private offset = 0;

  constructor(data: TemplateEngineData) {
    this.prepared = Object.entries(data.labels).map(([label, p]) => ({ label, base: p.threshold, seqs: p.templates.map(toSeq) }));
  }

  get ready(): boolean {
    return this.prepared.length > 0;
  }

  get labels(): readonly string[] {
    return this.prepared.map(p => p.label);
  }

  setSensitivity(sensitivity: number) {
    this.sensitivity = sensitivity;
  }

  setOffset(offset: number) {
    this.offset = Math.min(0.15, Math.max(-0.25, Number.isFinite(offset) ? offset : 0));
  }

  start(clip: Float32Array, sampleRate: number): LocalWakeJob {
    return new TemplateJob(clip, sampleRate, this.prepared, this.sensitivity, this.offset);
  }
}

/** Strict structural check of stored engine data: a damaged or hand-edited file must never crash the voice pipeline. */
export function parseTemplateData(value: unknown): TemplateEngineData | undefined {
  if (typeof value !== 'object' || !value) return undefined;
  const labelsRaw = (value as { labels?: unknown }).labels;
  if (typeof labelsRaw !== 'object' || !labelsRaw) return undefined;
  const labels: Record<string, LabelProfile> = {};
  for (const [name, raw] of Object.entries(labelsRaw as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]{0,19}$/.test(name) || typeof raw !== 'object' || !raw) return undefined;
    const p = raw as Partial<LabelProfile>;
    if (!Array.isArray(p.templates) || p.templates.length < 1 || p.templates.length > 12) return undefined;
    if (typeof p.threshold !== 'number' || !Number.isFinite(p.threshold) || p.threshold <= 0 || p.threshold > 100) return undefined;
    const templates: StoredTemplate[] = [];
    for (const t of p.templates) {
      if (typeof t !== 'object' || !t) return undefined;
      const { frames, data } = t as Partial<StoredTemplate>;
      if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < 4 || frames > MAX_TEMPLATE_FRAMES) return undefined;
      if (!Array.isArray(data) || data.length !== frames * FEATURE_DIM || data.some(v => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1000)) return undefined;
      templates.push({ frames, data });
    }
    labels[name] = { templates, threshold: p.threshold, looMean: Number(p.looMean) || 0, looSd: Number(p.looSd) || 0 };
  }
  return Object.keys(labels).length > 0 ? { labels } : undefined;
}

export const templateEngine: LocalWakeEngine = {
  id: TEMPLATE_ENGINE_ID,
  title: 'My voice (template matching)',
  needsDownload: false,
  create(engineData) {
    const data = parseTemplateData(engineData);
    return data ? new TemplateDetector(data) : undefined;
  },
};
