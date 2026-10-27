// Runtime glue of the local wake word: runs one evaluation without hogging the main thread, limits false accepts,
// combines the local verdict with the existing quota-saver gate, and counts (never records) what happened.
// Pure: time and yielding are injected, so tests drive it with fake clocks and fake detectors.
import { WAKE_TRIM_MS } from '../clip-gate.ts';
import type { ClipFeatures, ClipGate } from '../clip-gate.ts';
import type { WakeGate } from '../wake-word.ts';
import { createDetector } from './registry.ts';
import { DEFAULT_LOCAL_WAKE_SENSITIVITY } from './types.ts';
import type { LocalWakeDetector, LocalWakeMode, LocalWakeProfile, LocalWakeVerdict } from './types.ts';

/** Slice of work per step; the audio callback shares this thread, so it stays far below one 21 ms audio buffer. */
export const STEP_BUDGET_MS = 4;
/** An evaluation that takes longer than this (overloaded laptop) is abandoned and the old gate decides alone. */
export const MAX_EVAL_MS = 600;
/** Candidate budget: a burst of 4, one more every 20 s. A real wake needs one; a TV reading the name would need many. */
export const CANDIDATE_BURST = 4;
export const CANDIDATE_REFILL_MS = 20_000;
/** In Assist mode a clip that is not a candidate is sent by the old gate only while quota pressure is below this. */
export const ASSIST_MAX_PRESSURE = 0.4;
export const OFFSET_MIN = -0.25;
export const OFFSET_MAX = 0.15;

// ------------------------------------------------------------------------------------------ limiter
export class CandidateLimiter {
  private tokens = CANDIDATE_BURST;
  private lastAt = Number.NaN;
  private shift = 0;

  /** Adaptive threshold shift: negative after candidates the cloud did not confirm, positive after wakes the local check missed. */
  get offset(): number {
    return this.shift;
  }

  private refill(now: number) {
    if (Number.isNaN(this.lastAt)) this.lastAt = now;
    this.tokens = Math.min(CANDIDATE_BURST, this.tokens + Math.max(0, now - this.lastAt) / CANDIDATE_REFILL_MS);
    this.lastAt = now;
  }

  /** Takes one candidate token; false when the budget is empty (the clip is then treated as "not a candidate"). */
  allow(now: number): boolean {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  refund() {
    this.tokens = Math.min(CANDIDATE_BURST, this.tokens + 1);
  }

  /** The cloud's answer for a clip that was sent: was it really the name? */
  noteOutcome(wasCandidate: boolean, confirmed: boolean) {
    if (wasCandidate && !confirmed) this.shift = Math.max(OFFSET_MIN, this.shift - 0.04);
    else if (wasCandidate && confirmed) this.shift = this.shift < 0 ? Math.min(0, this.shift + 0.04) : this.shift;
    else if (!wasCandidate && confirmed) this.shift = Math.min(OFFSET_MAX, this.shift + 0.05);
  }
}

// ------------------------------------------------------------------------------------------ stats
export interface WakeLocalStatLine {
  candidates: number;
  rejected: number;
  sent: number;
  mode: LocalWakeMode;
}

export class LocalWakeStats {
  private candidates = 0;
  private rejected = 0;
  private sent = 0;
  private since = Number.NaN;

  private touch(now: number) {
    if (Number.isNaN(this.since)) this.since = now;
  }

  recordVerdict(verdict: Pick<LocalWakeVerdict, 'candidate'>, now: number) {
    this.touch(now);
    if (verdict.candidate) this.candidates++;
    else this.rejected++;
  }

  recordSent(now: number) {
    this.touch(now);
    this.sent++;
  }

  /** One line per window with anything in it. Counts only: no audio, no text, no scores. */
  flush(now: number, mode: LocalWakeMode, windowMs = 60_000, force = false): WakeLocalStatLine | undefined {
    if (Number.isNaN(this.since) || (!force && now - this.since < windowMs)) return undefined;
    const line = { candidates: this.candidates, rejected: this.rejected, sent: this.sent, mode };
    this.candidates = 0;
    this.rejected = 0;
    this.sent = 0;
    this.since = Number.NaN;
    return line;
  }
}

export function formatWakeLocalLine(line: WakeLocalStatLine): string {
  return `[wake-local] candidates=${line.candidates} rejected=${line.rejected} sent=${line.sent} mode=${line.mode}`;
}

// ------------------------------------------------------------------------------------------ combining with the quota-saver gate
export interface GateOutcome {
  send: boolean;
  reason?: string;
}

export interface LocalDecision {
  send: boolean;
  /** Where the yes/no came from. */
  source: 'candidate' | 'gate' | 'local-drop' | 'quota-drop';
  /** The gate said yes but the local check overruled it: give its token back. */
  refundGate: boolean;
}

/** True when the verdict can be trusted to say "not the name" (not just "could not tell"). */
function usable(verdict: LocalWakeVerdict | undefined): verdict is LocalWakeVerdict {
  return Boolean(verdict) && verdict!.reason !== 'error' && verdict!.reason !== 'not-enrolled';
}

/**
 * off / no usable verdict: the gate alone, exactly as before.
 * candidate: always sent (the gate's own answer is irrelevant).
 * assist, not a candidate: the old gate's yes still counts, but only while quota is healthy (or when it is the once-a-minute floor).
 * strict, not a candidate: dropped.
 */
export function decideWithLocal(mode: LocalWakeMode, verdict: LocalWakeVerdict | undefined, gate: GateOutcome, quotaPressure: number): LocalDecision {
  if (mode === 'off' || !usable(verdict)) return { send: gate.send, source: 'gate', refundGate: false };
  if (verdict.candidate) return { send: true, source: 'candidate', refundGate: false };
  if (mode === 'strict') return { send: false, source: 'local-drop', refundGate: gate.send };
  if (!gate.send) return { send: false, source: 'local-drop', refundGate: false };
  if (quotaPressure < ASSIST_MAX_PRESSURE || gate.reason === 'floor') return { send: true, source: 'gate', refundGate: false };
  return { send: false, source: 'quota-drop', refundGate: true };
}

// ------------------------------------------------------------------------------------------ cooperative evaluation
export interface EvalIo {
  /** Milliseconds, monotonic (performance.now). */
  now: () => number;
  /** Gives the main thread back (setTimeout 0 in the renderer). */
  yieldNow: () => Promise<void>;
  budgetMs?: number;
  maxMs?: number;
}

/** Runs a detector over one clip in slices. Resolves with computeMs filled in; reason 'error' means "could not tell" (timeout or exception). */
export async function evaluateCooperative(detector: LocalWakeDetector, clip: Float32Array, sampleRate: number, io: EvalIo): Promise<LocalWakeVerdict> {
  const started = io.now();
  try {
    const job = detector.start(clip, sampleRate);
    while (!job.step(io.budgetMs ?? STEP_BUDGET_MS, io.now)) {
      if (io.now() - started > (io.maxMs ?? MAX_EVAL_MS)) return { candidate: false, reason: 'error', score: Infinity, threshold: 0, computeMs: io.now() - started };
      await io.yieldNow();
    }
    return { ...job.result(), computeMs: io.now() - started };
  } catch {
    return { candidate: false, reason: 'error', score: Infinity, threshold: 0, computeMs: io.now() - started };
  }
}

/** Runs a detector to completion in one go (tests, benchmark, the enrolment self-test). */
export function evaluateNow(detector: LocalWakeDetector, clip: Float32Array, sampleRate: number): LocalWakeVerdict {
  const job = detector.start(clip, sampleRate);
  while (!job.step(1e9, () => 0)) { /* a huge budget finishes in one step */ }
  return job.result();
}

// ------------------------------------------------------------------------------------------ controller
export interface ControllerIo extends EvalIo {
  /** Same clock as the quota gate (performance.now). */
}

/** One per voice pipeline. Holds the detector, the limiter and the counters; the pipeline only calls evaluate / decide / noteOutcome. */
export class LocalWakeController {
  readonly limiter = new CandidateLimiter();
  readonly stats = new LocalWakeStats();
  private detector: LocalWakeDetector | undefined;
  private modeValue: LocalWakeMode = 'off';
  private sensitivity = DEFAULT_LOCAL_WAKE_SENSITIVITY;
  private pending: { candidate: boolean } | undefined;
  private io: ControllerIo;

  constructor(io: ControllerIo) {
    this.io = io;
  }

  get mode(): LocalWakeMode {
    return this.modeValue;
  }

  configure(mode: LocalWakeMode, sensitivity: number | undefined) {
    this.modeValue = mode;
    this.sensitivity = sensitivity ?? DEFAULT_LOCAL_WAKE_SENSITIVITY;
    this.detector?.setSensitivity(this.sensitivity);
  }

  setProfile(profile: LocalWakeProfile | undefined) {
    this.detector = createDetector(profile);
    this.detector?.setSensitivity(this.sensitivity);
  }

  /** On and enrolled. Otherwise the pipeline behaves exactly as it did before this feature existed. */
  get active(): boolean {
    return this.modeValue !== 'off' && Boolean(this.detector?.ready);
  }

  /** Verdict for a finished clip, or undefined when the feature is off / not enrolled. Applies the candidate budget. */
  async evaluate(clip: Float32Array, sampleRate: number): Promise<LocalWakeVerdict | undefined> {
    const detector = this.detector;
    if (!this.active || !detector) return undefined;
    detector.setOffset(this.limiter.offset);
    let verdict = await evaluateCooperative(detector, clip, sampleRate, this.io);
    if (verdict.candidate && !this.limiter.allow(this.io.now())) verdict = { ...verdict, candidate: false, reason: 'limited' };
    if (verdict.reason !== 'error') this.stats.recordVerdict(verdict, this.io.now());
    return verdict;
  }

  /** Combines the verdict with the gate's answer, remembers the verdict for the cloud's reply, and counts the send. */
  decide(verdict: LocalWakeVerdict | undefined, gate: GateOutcome, quotaPressure: number): LocalDecision {
    const decision = decideWithLocal(this.modeValue, verdict, gate, quotaPressure);
    this.pending = decision.send && usable(verdict) ? { candidate: verdict.candidate } : undefined;
    if (decision.send && this.active) this.stats.recordSent(this.io.now());
    return decision;
  }

  /** The clip was not sent after all (a downstream rate limit refused it): a candidate's token goes back and no cloud answer is expected. */
  unsend(decision: LocalDecision) {
    if (decision.source === 'candidate') this.limiter.refund();
    this.pending = undefined;
  }

  /** The cloud's answer for the clip that was sent last: did its text contain the name? */
  noteOutcome(confirmed: boolean) {
    if (!this.pending) return;
    this.limiter.noteOutcome(this.pending.candidate, confirmed);
    this.pending = undefined;
  }

  flushStats(now: number, force = false): string | undefined {
    const line = this.stats.flush(now, this.modeValue, 60_000, force);
    return line ? formatWakeLocalLine(line) : undefined;
  }
}

// ------------------------------------------------------------------------------------------ the whole wake-mode clip decision
export interface WakeClipInput {
  features: ClipFeatures;
  /** Verdict from `controller.evaluate`, or undefined (off, not enrolled, Live Talk, barge-in). */
  local: LocalWakeVerdict | undefined;
  live: boolean;
  /** performance.now() */
  now: number;
  clipGate: ClipGate;
  wakeGate: WakeGate;
  controller: LocalWakeController;
}

/**
 * The one place that decides whether a finished clip leaves the machine: Live Talk always sends; otherwise the quota-saver gate and the
 * on-device check decide together, then the old 2 s minimum interval / error back-off still applies. Whoever refuses gets its token back.
 */
export function decideWakeClip(input: WakeClipInput): { send: boolean; trimMs?: number } {
  const { features, local, live, now, clipGate, wakeGate, controller } = input;
  const decision = clipGate.decide(features, { now, live });
  if (live) return { send: true };
  const combined = controller.decide(local, decision, clipGate.quotaPressure);
  if (combined.refundGate) clipGate.refund(decision);
  if (!combined.send) return { send: false };
  if (!wakeGate.allow(now)) {
    if (decision.send && !combined.refundGate) clipGate.refund(decision);
    controller.unsend(combined);
    return { send: false };
  }
  return { send: true, trimMs: decision.trimMs ?? WAKE_TRIM_MS };
}
