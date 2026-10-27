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
  /** Voiced stretches separated by >= 60 ms of quiet. */
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

export type SendReason = 'live' | 'barge-in' | 'floor' | 'isolated' | 'in-talk' | 'retry';
export type SkipReason = 'impulse' | 'hiss' | 'steady-noise' | 'long-talk' | 'budget' | 'cluster';
export type GateReason = SendReason | SkipReason;

export type GateLane = 'shaped' | 'plain' | 'talk';

export interface ClipDecision {
  send: boolean;
  reason: GateReason;
  /** Upload at most this much of the clip (wake mode only needs the name, not a monologue). */
  trimMs?: number;
  /** Which budget paid for it; hand the decision to `refund()` if something downstream refuses the clip. */
  lane?: GateLane;
  spent: number;
}

/**
 * Three budgets (token buckets), so room talk cannot starve the clips that look like "Sudo, ...":
 *  - shaped: after a quiet spell AND shaped like an address (a bare name, or a short word + pause + short request). Burst 3, 1 per 15 s.
 *  - plain: after a quiet spell, any other short clip. Burst 1, 1 per 60 s (up to 3x slower after a run of misses).
 *  - talk: right after other speech (chatter, TV, the bot's echo tail). Burst 1, 1 per 90 s (up to 3x slower), closed under quota pressure.
 */
export const GATE_BURST = 3;
export const GATE_REFILL_MS = 15_000;
export const PLAIN_REFILL_MS = 60_000;
export const TALK_REFILL_MS = 90_000;
/** A clip this short with a name-like start can be an address even in a few words. */
export const SHAPED_MAX_MS = 2500;
/** This many speech-like clips within BUSY_WINDOW_MS make the room "busy": only strictly address-shaped clips get a token. */
export const BUSY_CLIPS = 3;
/** A repeated short attempt within this long after a skipped one gets through (once per floor). */
export const RETRY_WINDOW_MS = 15_000;
export const BUSY_WINDOW_MS = 120_000;
export const NAME_ALONE_MIN_MS = 220;
export const NAME_ALONE_MAX_MS = 900;
/** One speech-like clip per minute is always allowed, however stingy the budget or the quota pressure. */
export const GATE_FLOOR_MS = 60_000;
/** Wake mode uploads at most this much of a clip (pre-roll included). */
export const WAKE_TRIM_MS = 3500;
/** A clip that starts at least this long after the previous clip ended is "isolated": the speaker waited for quiet. */
export const ISOLATION_MS = 4000;
/** An isolated clip longer than this is a monologue start, not a command, and goes to the talk lane. */
export const ISOLATED_MAX_MS = 6000;
/** A clip with this much voiced time or more is the start of a monologue, not "Sudo, ...". */
export const LONG_CLIP_MS = 8000;
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

const RUN_GAP_MS = 60;

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
  private tokensShaped: number;
  private tokensPlain = 1;
  private tokensTalk = 1;
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
    this.tokensShaped = this.burst;
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
    if (hit) this.tokensShaped = Math.min(this.shapedBurst(), this.tokensShaped + 1);
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

  private shapedBurst(): number {
    return this.pressure >= 0.75 ? 1 : this.burst;
  }

  /** How much to slow down: 1 normally, 2 when about 60%+ of the last results had no wake word, 3 at 85%+. */
  private missFactor(cap: number): number {
    const n = this.results.length;
    if (n < 3) return 1;
    const missRatio = 1 - this.hitRate;
    return Math.min(cap, missRatio >= 0.85 ? 3 : missRatio >= 0.6 ? 2 : 1);
  }

  /**
   * Milliseconds per token in the shaped lane: up to twice as slow after a run of misses (a short name-like clip after a quiet
   * spell is the most likely wake attempt, so this lane is protected from chatter), slower under quota pressure, never slower than the floor.
   */
  currentRefillMs(): number {
    return Math.min(this.floorMs, this.baseRefillMs * this.missFactor(2) * (1 + 2 * this.pressure));
  }

  currentPlainRefillMs(): number {
    return PLAIN_REFILL_MS * this.missFactor(3) * (1 + 2 * this.pressure);
  }

  /** The talk lane: 3x slower after many misses, closed above pressure 0.5. */
  currentTalkRefillMs(): number {
    return TALK_REFILL_MS * this.missFactor(3) * (1 + 2 * this.pressure);
  }

  /**
   * The safety net: after this long without any request, the next speech-like clip goes whatever the budgets say.
   * One minute normally and whenever quota is short (never silent); stretched to 2-3 minutes while the quota is healthy
   * and nothing but misses has been heard, because then a speculative send is the cheapest thing to give up.
   */
  currentFloorMs(): number {
    return this.pressure >= 0.4 ? this.floorMs : this.floorMs * this.missFactor(3);
  }

  private refill(now: number) {
    if (Number.isNaN(this.lastRefillAt)) this.lastRefillAt = now;
    const elapsed = Math.max(0, now - this.lastRefillAt);
    this.lastRefillAt = now;
    this.tokensShaped = Math.min(this.shapedBurst(), this.tokensShaped + elapsed / this.currentRefillMs());
    this.tokensPlain = Math.min(1, this.tokensPlain + elapsed / this.currentPlainRefillMs());
    this.tokensTalk = Math.min(1, this.tokensTalk + elapsed / this.currentTalkRefillMs());
  }

  refund(decision: ClipDecision) {
    if (decision.lane === 'shaped') this.tokensShaped = Math.min(this.shapedBurst(), this.tokensShaped + decision.spent);
    else if (decision.lane === 'plain') this.tokensPlain = Math.min(1, this.tokensPlain + decision.spent);
    else if (decision.lane === 'talk') this.tokensTalk = Math.min(1, this.tokensTalk + decision.spent);
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

    const overdue = Number.isNaN(this.lastSentAt) || ctx.now - this.lastSentAt >= this.currentFloorMs();
    const isolated = gapBefore >= ISOLATION_MS && !f.overlappedPlayback;
    const leadsLikeAddress = f.leadRunMs <= 800 && f.leadGapMs >= 60;

    const busy = this.recentClips(ctx.now) >= BUSY_CLIPS;
    this.noteClip(ctx.now);

    // A monologue with no "name, pause" at its start is room talk or TV: only the minute floor can let it through.
    if (f.voicedMs >= LONG_CLIP_MS && !leadsLikeAddress) {
      return overdue ? this.send('floor', ctx.now, 0) : this.record({ send: false, reason: 'long-talk', spent: 0 }, ctx.now);
    }

    const nameAlone = f.voicedMs >= NAME_ALONE_MIN_MS && f.voicedMs <= NAME_ALONE_MAX_MS && f.runs <= 2;
    // Strict shape: a bare name, or a short word + pause + short request ("Sudo, kaise ho?").
    const shaped = f.voicedMs <= SHAPED_MAX_MS && (nameAlone || leadsLikeAddress);
    // A busy room (several clips in the last two minutes) only gets the strict shapes; a quiet one gets any short isolated clip.

    if (isolated && f.voicedMs <= ISOLATED_MAX_MS) {
      if (shaped && this.tokensShaped >= 1) {
        this.tokensShaped -= 1;
        return this.send('isolated', ctx.now, 1, 'shaped');
      }
      if (!busy && this.tokensPlain >= 1) {
        this.tokensPlain -= 1;
        return this.send('isolated', ctx.now, 1, 'plain');
      }
      // People repeat themselves: a short isolated clip soon after a skipped one is let through, once a minute at most.
      if (f.voicedMs <= SHAPED_MAX_MS && ctx.now - this.lastSkippedShortAt <= RETRY_WINDOW_MS && ctx.now - this.lastRetryAt >= this.floorMs && this.pressure < 0.9) {
        this.lastRetryAt = ctx.now;
        return this.send('retry', ctx.now, 0);
      }
      if (f.voicedMs <= SHAPED_MAX_MS) this.lastSkippedShortAt = ctx.now;
      return overdue ? this.send('floor', ctx.now, 0) : this.record({ send: false, reason: 'budget', spent: 0 }, ctx.now);
    }
    // Right after other speech (chatter, TV, the bot's echo tail): only the strict shapes, one token, closed under quota pressure.
    if (shaped && !f.overlappedPlayback && this.pressure < 0.5 && this.tokensTalk >= 1) {
      this.tokensTalk -= 1;
      return this.send('in-talk', ctx.now, 1, 'talk');
    }
    return overdue ? this.send('floor', ctx.now, 0) : this.record({ send: false, reason: 'cluster', spent: 0 }, ctx.now);
  }

  private clipTimes: number[] = [];
  private lastSkippedShortAt = Number.NEGATIVE_INFINITY;
  private lastRetryAt = Number.NEGATIVE_INFINITY;

  private recentClips(now: number): number {
    while (this.clipTimes.length && now - this.clipTimes[0] > BUSY_WINDOW_MS) this.clipTimes.shift();
    return this.clipTimes.length;
  }

  private noteClip(now: number) {
    this.clipTimes.push(now);
  }

  private send(reason: SendReason, now: number, spent: number, lane?: GateLane): ClipDecision {
    this.lastSentAt = now;
    return this.record({ send: true, reason, trimMs: WAKE_TRIM_MS, lane, spent }, now);
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
