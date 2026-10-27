export interface BargeInConfig {
  /** Speech RMS threshold used when the bot is NOT speaking. */
  baseThreshold: number;
  /** 0 (hard to interrupt) .. 1 (very easy to interrupt). */
  sensitivity: number;
}

export const DEFAULT_BARGE_IN_SENSITIVITY = 0.5;
const GAP_TOLERANCE_MS = 80;

export function clampSensitivity(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_BARGE_IN_SENSITIVITY;
  return Math.max(0, Math.min(1, n));
}

/** Playback threshold is higher than idle so the bot's own voice leaking into the mic does not trigger it. */
export function bargeInThreshold(config: BargeInConfig): number {
  const s = clampSensitivity(config.sensitivity);
  return config.baseThreshold * (2.4 - s * 1.2);
}

/** Continuous speech needed before interrupting: 250 ms (low sensitivity) .. 150 ms (high). */
export function bargeInMinSpeechMs(sensitivity: number): number {
  return Math.round(250 - clampSensitivity(sensitivity) * 100);
}

/** First part of every reply: the echo level is only learned, nothing but a clearly louder voice may interrupt. */
export const ECHO_WARMUP_MS = 350;
/** During warm-up an interruption must be this many times the normal playback threshold (that is shouting-close, not echo). */
const WARMUP_CLEAR_FACTOR = 5;
/** Echo peak-hold: the envelope halves every 1.5 s so it follows the reply's loudness but forgets old peaks. */
const ECHO_HALF_LIFE_MS = 1500;
/** After the reply ends the room still rings for a moment; speech must beat the echo envelope for this long. */
export const ECHO_TAIL_MS = 600;
/** The echo-based threshold never exceeds this, so a very loud (clipping) echo cannot make interruption impossible. */
const ECHO_THRESHOLD_CAP = 0.3;

/** How far above the echo envelope the mic must be: x2.0 (low sensitivity) .. x1.4 (high); default x1.7 (about +4.6 dB). */
export function echoMargin(sensitivity: number): number {
  return 2.0 - clampSensitivity(sensitivity) * 0.6;
}

/**
 * Feeds mic frames while the bot is speaking. Fires once when the user has spoken
 * continuously (tiny gaps tolerated) for the required duration.
 *
 * Echo handling: the bot's own voice reaches the mic through the speakers. Instead of trusting a fixed number, the detector
 * keeps an envelope (peak-hold with decay) of everything that did NOT look like a user turn and requires the mic to
 * exceed that envelope by `echoMargin`. Bursts that start a run but die out (gap too long) are treated as echo peaks too.
 */
export class BargeInDetector {
  private voicedMs = 0;
  private gapMs = 0;
  private fired = false;
  private startedAt: number | null = null;
  private playbackStartedAt: number | null = null;
  private warmupUntil = 0;
  private playbackEndedAt: number | null = null;
  private envelope = 0;
  private runPeak = 0;

  private config: BargeInConfig;

  constructor(config: BargeInConfig) {
    this.config = config;
  }

  setConfig(config: BargeInConfig) {
    this.config = config;
  }

  /** Full reset (new reply or new listening session): forgets the echo envelope too. */
  reset() {
    this.abortRun();
    this.fired = false;
    this.playbackStartedAt = null;
    this.playbackEndedAt = null;
    this.warmupUntil = 0;
    this.envelope = 0;
  }

  private abortRun() {
    this.voicedMs = 0;
    this.gapMs = 0;
    this.startedAt = null;
    this.runPeak = 0;
  }

  /** Time (ms clock supplied by caller) when the current voiced run began, or null. */
  get speechStartedAt(): number | null {
    return this.startedAt;
  }

  /** Current estimate of how loud the bot's own voice is in the mic (RMS). */
  get echoEnvelope(): number {
    return this.envelope;
  }

  /** The RMS a frame must exceed right now to count as the user (ignores the warm-up rule). */
  currentThreshold(): number {
    const echoBased = Math.min(ECHO_THRESHOLD_CAP, this.envelope * echoMargin(this.config.sensitivity));
    return Math.max(bargeInThreshold(this.config), echoBased);
  }

  /**
   * Call for every mic frame while the bot is NOT speaking. Remembers that playback just ended so the echo tail is still
   * guarded, then forgets the envelope once the tail is over.
   */
  idle(now: number) {
    if (this.playbackStartedAt !== null) {
      this.playbackEndedAt = now;
      this.playbackStartedAt = null;
    }
    this.abortRun();
    this.fired = false;
    if (this.playbackEndedAt !== null && now - this.playbackEndedAt > ECHO_TAIL_MS) {
      this.playbackEndedAt = null;
      this.envelope = 0;
    }
  }

  /** True while the room still rings from a reply that just ended. */
  inEchoTail(now: number): boolean {
    return this.playbackEndedAt !== null && now - this.playbackEndedAt <= ECHO_TAIL_MS;
  }

  /** Threshold for STARTING a normal clip while idle: the plain speech threshold, raised during the echo tail of a reply. */
  idleSpeechThreshold(baseSpeechThreshold: number, now: number): number {
    if (this.playbackEndedAt === null || now - this.playbackEndedAt > ECHO_TAIL_MS) return baseSpeechThreshold;
    return Math.max(baseSpeechThreshold, Math.min(ECHO_THRESHOLD_CAP, this.envelope * echoMargin(this.config.sensitivity)));
  }

  feed(rms: number, frameMs: number, now: number): boolean {
    if (this.fired) return false;
    if (this.playbackStartedAt === null) {
      // A reply that continues right after the previous one (next sentence) already knows the echo level: no new warm-up.
      const continues = this.playbackEndedAt !== null && now - this.playbackEndedAt <= ECHO_TAIL_MS && this.envelope > 0;
      this.playbackStartedAt = now;
      this.playbackEndedAt = null;
      this.warmupUntil = continues ? now : now + ECHO_WARMUP_MS;
    }
    const warm = now < this.warmupUntil;
    const threshold = warm
      ? Math.max(this.currentThreshold(), bargeInThreshold(this.config) * WARMUP_CLEAR_FACTOR)
      : this.currentThreshold();

    if (rms > threshold) {
      if (this.voicedMs === 0) this.startedAt = now - frameMs;
      this.voicedMs += frameMs + this.gapMs;
      this.gapMs = 0;
      if (rms > this.runPeak) this.runPeak = rms;
      if (this.voicedMs >= bargeInMinSpeechMs(this.config.sensitivity)) {
        this.fired = true;
        return true;
      }
      return false;
    }
    if (this.voicedMs > 0) {
      this.gapMs += frameMs;
      if (this.gapMs > GAP_TOLERANCE_MS) {
        // A burst that never became a user turn was most likely an echo peak: remember it.
        this.envelope = Math.max(this.envelope, this.runPeak);
        this.abortRun();
      }
      return false;
    }
    // Quiet or echo-level frame outside a run: peak-hold envelope with decay.
    this.envelope = Math.max(rms, this.envelope * Math.pow(0.5, frameMs / ECHO_HALF_LIFE_MS));
    return false;
  }
}

/**
 * Decides whether a finished clip may go to speech-to-text. A clip that overlapped the bot's playback (or its echo tail)
 * without ever triggering a barge-in, and whose loudest overlapping frame sits at or under the echo envelope, is the bot
 * hearing itself and must never be sent as a user turn.
 */
export function clipIsEcho(info: { overlappedPlayback: boolean; bargeInFired: boolean; overlapPeakRms: number; echoEnvelope: number; sensitivity: number }): boolean {
  if (!info.overlappedPlayback || info.bargeInFired) return false;
  return info.overlapPeakRms <= info.echoEnvelope * echoMargin(info.sensitivity);
}
