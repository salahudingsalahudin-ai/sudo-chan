// Enrolment: checks one recording of the name, turns 5-8 good ones into calibrated templates, and (de)serialises the profile.
// Only derived feature vectors leave this module. The raw audio stays in the caller's memory and is dropped after one call.
import { FRAME_MS, extractFeatures, findSpeechSpan, frameEnergiesDb, levelGain, resampleTo16k } from './dsp.ts';
import type { FeatureSeq } from './dsp.ts';
import { MAX_TEMPLATES, MAX_TEMPLATE_FRAMES, MIN_TEMPLATES, TEMPLATE_ENGINE_ID, calibrate, parseTemplateData, toStored } from './template-engine.ts';
import type { LabelProfile, TemplateEngineData } from './template-engine.ts';
import type { LocalWakeProfile, LocalWakeVerdict } from './types.ts';

export type SampleIssue = 'no-speech' | 'too-quiet' | 'clipped' | 'too-short' | 'too-long' | 'noisy';

/** Plain-words advice for the Settings panel (calm, one thing to fix at a time). */
export const SAMPLE_ADVICE: Record<SampleIssue, string> = {
  'no-speech': 'I did not hear anything. Say it right after you press the button.',
  'too-quiet': 'That was too quiet. Say it a little louder, or move closer to the mic.',
  clipped: 'That was too loud and got cut off. Say it a bit softer or move back a little.',
  'too-short': 'That was too short. Say the whole name clearly.',
  'too-long': 'That was too long. Just the name, nothing else.',
  noisy: 'The room is too noisy for a clean sample. Try again when it is quieter.',
};

export const MIN_WORD_MS = 160;
export const MAX_WORD_MS = 1600;
/** Loudest speech frame, in dB of mean square: -42 is an RMS of about 0.008 (the voice engine's own start threshold is 0.009). */
export const MIN_PEAK_DB = -42;
export const MIN_ENROLL_SNR_DB = 12;
export const CLIP_LEVEL = 0.985;
export const CLIP_FRACTION = 0.004;
/** Context frames kept around the word so deltas at the word's edges look like they will in a real clip. */
const CONTEXT_FRAMES = 3;

export interface SampleCheck {
  ok: boolean;
  issues: SampleIssue[];
  /** Length of the detected word in ms. */
  wordMs: number;
  peakDb: number;
  snrDb: number;
  /** Present when the sample is usable. */
  features?: FeatureSeq;
}

/** Looks at one recording of the name. Pure: samples in, verdict + features out. */
export function checkEnrollmentSample(samples: Float32Array, sampleRate: number): SampleCheck {
  const empty: SampleCheck = { ok: false, issues: ['no-speech'], wordMs: 0, peakDb: -120, snrDb: 0 };
  if (!(sampleRate > 0) || samples.length === 0) return empty;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) >= CLIP_LEVEL) clipped++;
  const pcm = resampleTo16k(samples, sampleRate);
  const energies = frameEnergiesDb(pcm);
  const span = findSpeechSpan(energies, { pick: 'longest', maxGapFrames: 15 });
  const issues: SampleIssue[] = [];
  if (!span) return { ...empty, issues: clipped / samples.length > CLIP_FRACTION ? ['clipped'] : ['no-speech'] };
  const wordMs = Math.round((span.end - span.start) * FRAME_MS);
  if (span.peakDb < MIN_PEAK_DB) issues.push('too-quiet');
  if (clipped / samples.length > CLIP_FRACTION) issues.push('clipped');
  if (wordMs < MIN_WORD_MS) issues.push('too-short');
  if (wordMs > MAX_WORD_MS) issues.push('too-long');
  if (span.snrDb < MIN_ENROLL_SNR_DB) issues.push('noisy');
  const result: SampleCheck = { ok: issues.length === 0, issues, wordMs, peakDb: Math.round(span.peakDb), snrDb: Math.round(span.snrDb) };
  if (result.ok) {
    const from = Math.max(0, span.start - CONTEXT_FRAMES);
    const to = Math.min(energies.length, span.end + CONTEXT_FRAMES);
    result.features = extractFeatures(pcm, from, Math.min(to, from + MAX_TEMPLATE_FRAMES), levelGain(span.peakDb));
  }
  return result;
}

export interface LabelBuild {
  ok: boolean;
  /** Set when ok. */
  label?: LabelProfile;
  /** Indices (into the input) of samples dropped because they were unlike the others. */
  dropped: number[];
  /** Why it failed: too few samples or an inconsistent set. */
  error?: 'too-few' | 'inconsistent';
  looMean?: number;
  threshold?: number;
}

/** Highest relative spread of leave-one-out scores we accept; above it the samples do not look like one word. */
export const MAX_LOO_SPREAD = 0.6;

/** Calibrates a set of 5-8 accepted samples. One clear outlier is dropped (if five remain); a set that stays inconsistent is refused. */
export function buildLabel(samples: FeatureSeq[]): LabelBuild {
  const dropped: number[] = [];
  let kept = samples.slice(0, MAX_TEMPLATES).map((seq, index) => ({ seq, index }));
  if (kept.length < MIN_TEMPLATES) return { ok: false, dropped, error: 'too-few' };
  for (;;) {
    const cal = calibrate(kept.map(k => k.seq));
    const spread = cal.looSd / Math.max(1e-9, cal.looMean);
    const worst = cal.looScores.reduce((w, s, i) => (s > cal.looScores[w] ? i : w), 0);
    const outlier = cal.looScores[worst] > cal.looMean + 1.5 * Math.max(cal.looSd, 1e-9) && spread > 0.25;
    if (spread <= MAX_LOO_SPREAD && !(outlier && kept.length > MIN_TEMPLATES)) {
      return { ok: true, dropped, label: { templates: kept.map(k => toStored(k.seq)), threshold: cal.threshold, looMean: cal.looMean, looSd: cal.looSd }, looMean: cal.looMean, threshold: cal.threshold };
    }
    if (kept.length <= MIN_TEMPLATES) return { ok: false, dropped, error: 'inconsistent', looMean: cal.looMean };
    dropped.push(kept[worst].index);
    kept = kept.filter((_, i) => i !== worst);
  }
}

export function makeProfile(labels: Record<string, LabelProfile>, now: number): LocalWakeProfile {
  return { version: 1, engine: TEMPLATE_ENGINE_ID, createdAt: now, data: { labels } satisfies TemplateEngineData };
}

/** Parses the stored file. Anything unexpected returns undefined (= "not enrolled"); it never throws. */
export function parseProfile(text: unknown): LocalWakeProfile | undefined {
  let value: unknown = text;
  if (typeof text === 'string') {
    if (text.length > 4_000_000) return undefined;
    try { value = JSON.parse(text); } catch { return undefined; }
  }
  if (typeof value !== 'object' || !value) return undefined;
  const p = value as Partial<LocalWakeProfile>;
  if (p.version !== 1 || typeof p.engine !== 'string' || typeof p.createdAt !== 'number') return undefined;
  if (p.engine === TEMPLATE_ENGINE_ID && !parseTemplateData(p.data)) return undefined;
  return { version: 1, engine: p.engine, createdAt: p.createdAt, data: p.data };
}

/** The labels enrolled in a profile (for the Settings summary). */
export function profileLabels(profile: LocalWakeProfile | undefined): { label: string; samples: number }[] {
  const data = profile && profile.engine === TEMPLATE_ENGINE_ID ? parseTemplateData(profile.data) : undefined;
  return data ? Object.entries(data.labels).map(([label, p]) => ({ label, samples: p.templates.length })) : [];
}

// ------------------------------------------------------------------------------------------ self-test
export interface SelfTestSummary {
  heard: number;
  total: number;
  /** Plain sentence for the panel. */
  message: string;
}

/** "Say it 3 times: heard 3/3". Only the verdicts count; clips that were too quiet to judge are reported as not heard. */
export function summariseSelfTest(verdicts: Pick<LocalWakeVerdict, 'candidate'>[]): SelfTestSummary {
  const total = verdicts.length;
  const heard = verdicts.filter(v => v.candidate).length;
  const message = total === 0 ? 'Say her name three times.'
    : heard === total ? `Heard ${heard}/${total}. She knows your voice.`
    : heard === 0 ? `Heard 0/${total}. Try again closer to the mic, or teach her your voice once more.`
    : `Heard ${heard}/${total}. Good enough to try Assist mode; if it misses often, raise sensitivity or record the samples again.`;
  return { heard, total, message };
}

// ------------------------------------------------------------------------------------------ enrolment session
export const WORD_LABELS = ['sudo', 'sid'] as const;
export type WordLabel = typeof WORD_LABELS[number];
/** Recommended number of takes; 5 is the minimum, 8 the maximum. */
export const TARGET_SAMPLES = 6;

export interface AddResult {
  accepted: boolean;
  /** One calm sentence when the take was refused. */
  advice?: string;
  check: SampleCheck;
}

/** Collects accepted takes of one word. Holds feature vectors only: the caller drops the audio right after `add`. */
export class EnrollmentSession {
  private seqs: FeatureSeq[] = [];

  get count(): number {
    return this.seqs.length;
  }

  get canFinish(): boolean {
    return this.seqs.length >= MIN_TEMPLATES;
  }

  get full(): boolean {
    return this.seqs.length >= MAX_TEMPLATES;
  }

  add(samples: Float32Array, sampleRate: number): AddResult {
    const check = checkEnrollmentSample(samples, sampleRate);
    if (this.full) return { accepted: false, advice: 'That is enough samples. Press Done.', check };
    if (!check.ok || !check.features) return { accepted: false, advice: SAMPLE_ADVICE[check.issues[0] ?? 'no-speech'], check };
    this.seqs.push(check.features);
    return { accepted: true, check };
  }

  /** Discards the newest take (the user said "that one was wrong"). */
  undo() {
    this.seqs.pop();
  }

  finish(): LabelBuild {
    return buildLabel(this.seqs);
  }
}

/** The profile with `label` replaced by `built` (other enrolled words are kept). */
export function withLabel(existing: LocalWakeProfile | undefined, label: string, built: LabelProfile, now: number): LocalWakeProfile {
  const old = existing && existing.engine === TEMPLATE_ENGINE_ID ? parseTemplateData(existing.data) : undefined;
  return makeProfile({ ...(old?.labels ?? {}), [label]: built }, now);
}

/** The profile without `label`, or undefined when no word is left. */
export function withoutLabel(existing: LocalWakeProfile | undefined, label: string, now: number): LocalWakeProfile | undefined {
  const old = existing && existing.engine === TEMPLATE_ENGINE_ID ? parseTemplateData(existing.data) : undefined;
  if (!old) return undefined;
  const { [label]: _removed, ...rest } = old.labels;
  return Object.keys(rest).length ? makeProfile(rest, now) : undefined;
}
