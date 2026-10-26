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

/**
 * Feeds mic frames while the bot is speaking. Fires once when the user has spoken
 * continuously (tiny gaps tolerated) for the required duration.
 */
export class BargeInDetector {
  private voicedMs = 0;
  private gapMs = 0;
  private fired = false;
  private startedAt: number | null = null;

  private config: BargeInConfig;

  constructor(config: BargeInConfig) {
    this.config = config;
  }

  setConfig(config: BargeInConfig) {
    this.config = config;
  }

  reset() {
    this.voicedMs = 0;
    this.gapMs = 0;
    this.fired = false;
    this.startedAt = null;
  }

  /** Time (ms clock supplied by caller) when the current voiced run began, or null. */
  get speechStartedAt(): number | null {
    return this.startedAt;
  }

  feed(rms: number, frameMs: number, now: number): boolean {
    if (this.fired) return false;
    if (rms > bargeInThreshold(this.config)) {
      if (this.voicedMs === 0) this.startedAt = now - frameMs;
      this.voicedMs += frameMs + this.gapMs;
      this.gapMs = 0;
      if (this.voicedMs >= bargeInMinSpeechMs(this.config.sensitivity)) {
        this.fired = true;
        return true;
      }
      return false;
    }
    if (this.voicedMs > 0) {
      this.gapMs += frameMs;
      if (this.gapMs > GAP_TOLERANCE_MS) this.reset();
    }
    return false;
  }
}
