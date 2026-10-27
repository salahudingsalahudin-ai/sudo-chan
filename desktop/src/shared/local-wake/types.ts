// Shared vocabulary of the on-device wake word. Engines implement LocalWakeDetector; everything else (limiter, stats, gate
// combination, enrolment UI) only talks to these interfaces, so another engine can be registered later (see registry.ts).

/** Settings.localWake: 'off' = cloud decides as before; 'assist' = local candidates are always sent, others only if the old gate would; 'strict' = only candidates. */
export type LocalWakeMode = 'off' | 'assist' | 'strict';
export const LOCAL_WAKE_MODES: readonly LocalWakeMode[] = ['off', 'assist', 'strict'];
export const DEFAULT_LOCAL_WAKE_MODE: LocalWakeMode = 'off';
export const DEFAULT_LOCAL_WAKE_SENSITIVITY = 0.5;

export type VerdictReason = 'match' | 'no-match' | 'not-enrolled' | 'no-speech' | 'too-short' | 'limited' | 'error';

export interface LocalWakeVerdict {
  /** True when the clip is worth a cloud request as a possible "Sudo" / "Sid". */
  candidate: boolean;
  reason: VerdictReason;
  /** Distance to the closest enrolled template (lower = closer); Infinity when nothing was compared. */
  score: number;
  /** The score has to be at or below this. Already includes the sensitivity and the adaptive offset. */
  threshold: number;
  /** Which enrolled word matched best ('sudo', 'sid'). */
  label?: string;
  /** Where the match sits in the clip (ms from its start). */
  startMs?: number;
  endMs?: number;
  /** Time the evaluation took, filled in by the caller that measured it (never audio, never text). */
  computeMs?: number;
}

/** One evaluation, runnable in small slices so the renderer's main thread (which also runs the audio callback) is never blocked for long. */
export interface LocalWakeJob {
  /** Does about `budgetMs` of work; true when finished. */
  step(budgetMs: number, now: () => number): boolean;
  result(): LocalWakeVerdict;
}

export interface LocalWakeDetector {
  readonly engineId: string;
  /** False when nothing is enrolled (the caller then behaves as if the feature were off). */
  readonly ready: boolean;
  readonly labels: readonly string[];
  /** 0..1 from Settings; 0.5 is the calibrated threshold. */
  setSensitivity(sensitivity: number): void;
  /** Adaptive shift from the false-accept limiter, -0.25 (stricter) .. +0.15 (looser). */
  setOffset(offset: number): void;
  start(clip: Float32Array, sampleRate: number): LocalWakeJob;
}

export interface LocalWakeEngine {
  readonly id: string;
  readonly title: string;
  /** True when the engine needs a model file the user must fetch with an explicit click (none of the shipped ones do). */
  readonly needsDownload: boolean;
  /** Builds a detector from a stored profile's engine data; undefined when the data is unusable. */
  create(engineData: unknown): LocalWakeDetector | undefined;
}

/** What is written to userData/local-wake.json: derived feature vectors only, never audio. */
export interface LocalWakeProfile {
  version: 1;
  engine: string;
  createdAt: number;
  data: unknown;
}

export function isLocalWakeMode(value: unknown): value is LocalWakeMode {
  return value === 'off' || value === 'assist' || value === 'strict';
}
