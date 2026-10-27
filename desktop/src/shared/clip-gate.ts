/**
 * Quota saver: cheap, deterministic checks that decide whether a recorded speech clip is worth a cloud
 * speech-to-text request while the bot is only waiting for her name ("wake mode").
 *
 * Why: in wake mode every detected speech clip (room talk, TV, a cough) used to go to Groq Whisper, ~5 requests a
 * minute while idle, from a free allowance of 2000 a day. Nothing here uses a model: only numbers that the voice
 * engine already has (clip length, voiced time, level, envelope shape, zero crossings, time since the last clip).
 *
 * What it never does:
 *  - gate a clip during Live Talk / the 30 s conversation window (`live: true` always sends, touches no state);
 *  - gate a barge-in clip (the user interrupted the bot);
 *  - go silent for good: at least one speech-like clip per FLOOR_MS (60 s) is always sent, whatever the quota pressure.
 *
 * Pure and clock-free (time is passed in), so it runs under `node --test` without a browser. Numbers: QUOTA-SAVER.md.
 */

/** Everything the gate looks at, measured by the voice engine from PCM it already holds. */
export interface ClipFeatures {
  /** The whole recorded clip: pre-roll + speech + the trailing silence that closed it. */
  durationMs: number;
  /** Time above the speech threshold. */
  voicedMs: number;
  /** First voiced frame to last voiced frame. */
  spanMs: number;
  /** Largest sample magnitude in voiced frames (0..1). */
  peak: number;
  /** Mean frame RMS over voiced frames. */
  rms: number;
  /** Coefficient of variation (std / mean) of the voiced-frame RMS. Speech is lumpy (syllables), music and fans are not. */
  envCv: number;
  /** Mean zero crossings per second over voiced frames. Voiced speech ~1-4k, hiss/white noise > 9k. */
  zcrPerSec: number;
  /** Voiced stretches separated by >= 100 ms of quiet. */
  runs: number;
  /** Length of the first voiced stretch. */
  leadRunMs: number;
  /** Quiet gap that followed the first stretch (0 when the clip is a single stretch). */
  leadGapMs: number;
  /** The clip overlapped the bot's playback or its echo tail. */
  overlappedPlayback: boolean;
  /** The user interrupted the bot with this clip. */
  bargeInFired: boolean;
}

export interface GateContext {
  /** Same clock as every other call (ms). */
  now: number;
  /** Live Talk or the conversation window is open: every utterance is sent. */
  live: boolean;
}

export type SendReason = 'live' | 'barge-in' | 'floor' | 'isolated' | 'name-shaped' | 'budget';
export type SkipReason = 'impulse' | 'hiss' | 'steady-noise' | 'long-talk' | 'cluster' | 'budget';
export type GateReason = SendReason | SkipReason;

export interface ClipDecision {
  send: boolean;
  reason: GateReason;
  /** Upload at most this much of the clip (wake mode only needs the name, not a monologue). */
  trimMs?: number;
  /** Tokens taken from the budget; hand to `refund()` if something downstream refuses the clip. */
  spent: number;
}

export const GATE_BURST = 3;
export const GATE_REFILL_MS = 20_000;
/** One speech-like clip per minute is always allowed, however stingy the budget or the quota pressure. */
export const GATE_FLOOR_MS = 60_000;
/** Wake mode uploads at most this much of a clip (pre-roll included). */
export const WAKE_TRIM_MS = 3500;
/** A clip that starts at least this long after the previous clip ended is "isolated": a command, not a conversation. */
export const ISOLATION_MS = 5000;
/** A clip with this much voiced time or more is the start of a monologue, not "Sudo, ...". */
export const LONG_CLIP_MS = 8000;
/** Short enough to be the bare name ("Sudo", "Sid"). */
export const NAME_ALONE_MAX_MS = 900;
export const NAME_ALONE_MIN_MS = 220;
/** Results remembered for the hit-rate back-off. */
const RESULT_MEMORY = 8;

export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Per-frame numbers the engine feeds in. */
export interface FrameStats {
  peak: number;
  zcrPerSec: number;
}

export function frameStats(samples: ArrayLike<number>, sampleRate: number): FrameStats {
  const n = samples.length;
  if (n < 2 || !(sampleRate > 0)) return { peak: 0, zcrPerSec: 0 };
  let peak = 0;
  let crossings = 0;
  let prev = samples[0];
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    if (i > 0 && (v >= 0) !== (prev >= 0)) crossings++;
    prev = v;
  }
  return { peak, zcrPerSec: (crossings / (n - 1)) * sampleRate };
}

const RUN_GAP_MS = 100;

/** Collects ClipFeatures one frame at a time while the engine records a clip. */
export class ClipFeatureAccumulator {
  private elapsedMs = 0;
  private firstVoicedAt = -1;
  private lastVoicedAt = -1;
  private voicedMs = 0;
  private voicedFrames = 0;
  private sumRms = 0;
  private sumRmsSq = 0;
  private sumZcr = 0;
  private peak = 0;
  private runs = 0;
  private leadRunMs = 0;
  private leadGapMs = 0;
  private quietMs = 0;

  reset() {
    this.elapsedMs = 0;
    this.firstVoicedAt = -1;
    this.lastVoicedAt = -1;
    this.voicedMs = 0;
    this.voicedFrames = 0;
    this.sumRms = 0;
    this.sumRmsSq = 0;
    this.sumZcr = 0;
    this.peak = 0;
    this.runs = 0;
    this.leadRunMs = 0;
    this.leadGapMs = 0;
    this.quietMs = 0;
  }

  push(frame: { rms: number; peak: number; zcrPerSec: number; frameMs: number; voiced: boolean }) {
    const { frameMs } = frame;
    if (frame.voiced) {
      if (this.runs === 0) this.runs = 1;
      else if (this.quietMs >= RUN_GAP_MS) {
        this.runs++;
        if (this.runs === 2) this.leadGapMs = this.quietMs;
      }
      this.quietMs = 0;
      if (this.runs === 1) this.leadRunMs += frameMs;
      if (this.firstVoicedAt < 0) this.firstVoicedAt = this.elapsedMs;
      this.lastVoicedAt = this.elapsedMs + frameMs;
      this.voicedMs += frameMs;
      this.voicedFrames++;
      this.sumRms += frame.rms;
      this.sumRmsSq += frame.rms * frame.rms;
      this.sumZcr += frame.zcrPerSec;
      if (frame.peak > this.peak) this.peak = frame.peak;
    } else if (this.runs > 0) {
      this.quietMs += frameMs;
    }
    this.elapsedMs += frameMs;
  }

  finish(base: { durationMs: number; overlappedPlayback: boolean; bargeInFired: boolean }): ClipFeatures {
    const n = this.voicedFrames;
    const mean = n ? this.sumRms / n : 0;
    const variance = n ? Math.max(0, this.sumRmsSq / n - mean * mean) : 0;
    return {
      durationMs: base.durationMs,
      voicedMs: this.voicedMs,
      spanMs: this.firstVoicedAt >= 0 ? this.lastVoicedAt - this.firstVoicedAt : 0,
      peak: this.peak,
      rms: mean,
      envCv: mean > 0 ? Math.sqrt(variance) / mean : 0,
      zcrPerSec: n ? this.sumZcr / n : 0,
      runs: this.runs,
      leadRunMs: this.leadRunMs,
      leadGapMs: this.leadGapMs,
      overlappedPlayback: base.overlappedPlayback,
      bargeInFired: base.bargeInFired,
    };
  }
}

/** Clips that are obviously not "a person said a word to the bot". Each rule is conservative on purpose. */
export function junkReason(f: ClipFeatures): 'impulse' | 'hiss' | 'steady-noise' | null {
  // A door, a clap, a keyboard thump: a very peaky short burst. Speech has a crest factor (peak / rms) of roughly 3-9.
  if (f.voicedMs < 450 && f.rms > 0 && f.peak / f.rms > 12) return 'impulse';
  // Air, a fan or a rustle: most of the energy sits in the highest frequencies and the level hardly moves.
  if (f.zcrPerSec > 9000 && f.envCv < 0.5) return 'hiss';
  // Music, a fan or a hum: several seconds with an almost constant level and no syllable rhythm.
  if (f.voicedMs >= 4000 && f.envCv < 0.22 && f.runs <= 2) return 'steady-noise';
  return null;
}

/** Fraction of today's Groq STT allowance in use, as pressure 0..1: 0 while half or more is left, 1 when it is gone. */
export function pressureFromRemaining(remaining: number | undefined, limit: number | undefined): number {
  if (remaining === undefined || limit === undefined || !(limit > 0) || !Number.isFinite(remaining)) return 0;
  const left = Math.min(1, Math.max(0, remaining / limit));
  return clamp01((0.5 - left) / 0.5);
}

export interface GateStatLine {
  reason: GateReason;
  skipped: number;
  sent: number;
}

export interface ClipGateOptions {
  burst?: number;
  refillMs?: number;
  floorMs?: number;
}

export class ClipGate {
  private burst: number;
  private baseRefillMs: number;
  private floorMs: number;
  private tokens: number;
  private lastRefillAt = Number.NaN;
  private lastSentAt = Number.NaN;
  private lastClipEndAt = Number.NEGATIVE_INFINITY;
  private pressure = 0;
  private results: boolean[] = [];
  private statSkipped: Record<string, number> = {};
  private statSent: Record<string, number> = {};
  private statSince = Number.NaN;

  constructor(options: ClipGateOptions = {}) {
    this.burst = options.burst ?? GATE_BURST;
    this.baseRefillMs = options.refillMs ?? GATE_REFILL_MS;
    this.floorMs = options.floorMs ?? GATE_FLOOR_MS;
    this.tokens = this.burst;
  }

  /** 0 = plenty of quota left, 1 = nearly gone. Learned from the main process (Groq's own headers). */
  setQuotaPressure(pressure: number) {
    this.pressure = clamp01(pressure);
  }

  get quotaPressure(): number {
    return this.pressure;
  }

  /** Did the transcript of a sent clip contain the wake word? A hit loosens the gate, a run of misses tightens it. */
  noteResult(hit: boolean) {
    this.results.push(hit);
    if (this.results.length > RESULT_MEMORY) this.results.shift();
    if (hit) this.tokens = Math.min(this.currentBurst(), this.tokens + 1);
  }

  /** Consecutive clips at the end of the memory that had no wake word. */
  get missStreak(): number {
    let n = 0;
    for (let i = this.results.length - 1; i >= 0 && !this.results[i]; i--) n++;
    return n;
  }

  /** Fraction of the remembered results that were wake words (0 with no memory). */
  get hitRate(): number {
    return this.results.length ? this.results.filter(Boolean).length / this.results.length : 0;
  }

  private currentBurst(): number {
    if (this.pressure >= 0.75) return 1;
    if (this.pressure >= 0.4) return Math.min(2, this.burst);
    return this.burst;
  }

  /** Milliseconds per token: slower after a run of misses and under quota pressure, never slower than the floor. */
  currentRefillMs(): number {
    const misses = this.missStreak;
    const missFactor = misses >= 6 ? 3 : misses >= 3 ? 2 : 1;
    return Math.min(this.floorMs, this.baseRefillMs * missFactor * (1 + 2 * this.pressure));
  }

  private refill(now: number) {
    if (Number.isNaN(this.lastRefillAt)) this.lastRefillAt = now;
    const elapsed = Math.max(0, now - this.lastRefillAt);
    this.lastRefillAt = now;
    this.tokens = Math.min(this.currentBurst(), this.tokens + elapsed / this.currentRefillMs());
  }

  refund(spent: number) {
    this.tokens = Math.min(this.currentBurst(), this.tokens + spent);
  }

  decide(f: ClipFeatures, ctx: GateContext): ClipDecision {
    if (ctx.live) return { send: true, reason: 'live', spent: 0 };
    this.refill(ctx.now);
    const startedAt = ctx.now - f.durationMs;
    const gapBefore = startedAt - this.lastClipEndAt;
    this.lastClipEndAt = ctx.now;

    if (f.bargeInFired) return this.send('barge-in', ctx.now, 0);

    const junk = junkReason(f);
    if (junk) return this.record({ send: false, reason: junk, spent: 0 }, ctx.now);

    const overdue = Number.isNaN(this.lastSentAt) || ctx.now - this.lastSentAt >= this.floorMs;
    const isolated = gapBefore >= ISOLATION_MS;
    const nameAlone = f.voicedMs >= NAME_ALONE_MIN_MS && f.voicedMs <= NAME_ALONE_MAX_MS && f.runs <= 2;
    const leadsLikeAddress = f.leadRunMs <= 800 && f.leadGapMs >= 120;

    let cost: number;
    let sendReason: SendReason;
    let skipReason: SkipReason;
    if (f.voicedMs >= LONG_CLIP_MS && !leadsLikeAddress) {
      // A monologue with no "name, pause" at its start: room talk or TV. Only the minute floor can let it through.
      return overdue ? this.send('floor', ctx.now, 0) : this.record({ send: false, reason: 'long-talk', spent: 0 }, ctx.now);
    }
    if (f.voicedMs >= LONG_CLIP_MS) {
      cost = 2; sendReason = 'budget'; skipReason = 'cluster';
    } else if (f.overlappedPlayback) {
      // The bot's own tail is still in the room: a weak candidate.
      cost = 2; sendReason = 'budget'; skipReason = 'cluster';
    } else if (isolated && f.voicedMs <= LONG_CLIP_MS / 2) {
      cost = 1; sendReason = 'isolated'; skipReason = 'budget';
    } else if (nameAlone) {
      cost = 1; sendReason = 'name-shaped'; skipReason = 'budget';
    } else {
      // Mid-conversation talk: costs a full pair of tokens, so it only passes when the bucket is nearly full.
      cost = 2; sendReason = 'budget'; skipReason = 'cluster';
    }
    // Under quota pressure the expensive (conversation-like) class is closed completely; the floor still applies.
    const closed = cost === 2 && this.pressure >= 0.5;
    if (!closed && this.tokens >= cost) {
      this.tokens -= cost;
      return this.send(sendReason, ctx.now, cost);
    }
    if (overdue) return this.send('floor', ctx.now, 0);
    return this.record({ send: false, reason: skipReason, spent: 0 }, ctx.now);
  }

  private send(reason: SendReason, now: number, spent: number): ClipDecision {
    this.lastSentAt = now;
    return this.record({ send: true, reason, trimMs: WAKE_TRIM_MS, spent }, now);
  }

  private record(decision: ClipDecision, now: number): ClipDecision {
    if (Number.isNaN(this.statSince)) this.statSince = now;
    const bucket = decision.send ? this.statSent : this.statSkipped;
    bucket[decision.reason] = (bucket[decision.reason] ?? 0) + 1;
    return decision;
  }

  /**
   * Counts since the last flush, one entry per decision class. Counts only, never audio or text.
   * Returns [] if nothing happened or `windowMs` has not elapsed yet (unless `force`).
   */
  flushStats(now: number, windowMs = 60_000, force = false): GateStatLine[] {
    if (Number.isNaN(this.statSince)) return [];
    if (!force && now - this.statSince < windowMs) return [];
    const reasons = new Set<string>([...Object.keys(this.statSkipped), ...Object.keys(this.statSent)]);
    const lines: GateStatLine[] = [];
    for (const reason of reasons) lines.push({ reason: reason as GateReason, skipped: this.statSkipped[reason] ?? 0, sent: this.statSent[reason] ?? 0 });
    this.statSkipped = {};
    this.statSent = {};
    this.statSince = Number.NaN;
    return lines;
  }
}

export function formatGateLine(line: GateStatLine): string {
  return `[gate] skipped=${line.skipped} sent=${line.sent} reason=${line.reason}`;
}
