import { decideCapture } from './screen-assist.ts';
import type { ScreenSource } from './screen-assist.ts';
import type { GuardResult } from './screen-guard.ts';

/**
 * The whole "look at my screen" sequence as one testable state machine, with every side effect injected:
 * consent (once), cooldown / 2-minute cache, sensitive-window guard, a first-capture countdown, the capture
 * itself and cancellation. Nothing here touches Electron, the disk or the network.
 */

export const CACHE_TTL_MS = 2 * 60 * 1000;
export const COUNTDOWN_SECONDS = 3;
/** A new "session" (countdown again) starts after this much idle time without a capture. */
export const COUNTDOWN_IDLE_RESET_MS = 10 * 60 * 1000;
export const GUARD_WAIT_MS = 2500;

export type FlowStatus = 'consent' | 'countdown' | 'capturing' | 'sent' | 'cached' | 'notice' | null;

export interface Shot { dataUri: string; thumbnail: string }
export type CaptureOutcome = { ok: true; shot: Shot } | { ok: false; reason: string };

export interface FlowDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  isEnabled(): boolean;
  countdownEnabled(): boolean;
  hasConsent(): boolean;
  saveConsent(): void;
  /** Resolves true only when the user clicks Allow. A spoken answer must never resolve this. */
  askConsent(source: ScreenSource): Promise<boolean>;
  /** Dismisses a pending consent prompt (cancel / stop). */
  cancelConsent(): void;
  setStatus(status: FlowStatus, extra?: { countdown?: number; notice?: string }): void;
  capture(): Promise<CaptureOutcome>;
  checkWindows(): Promise<GuardResult>;
}

export type SkipReason = 'disabled' | 'busy' | 'no-consent' | 'cooldown' | 'sensitive' | 'capture-failed';
export interface Timings { guardMs: number; captureMs: number; totalMs: number }
export type FlowResult =
  | { kind: 'proceed'; shot: Shot; cached: boolean; ageSeconds: number; timings: Timings }
  | { kind: 'skipped'; reason: SkipReason; notice: string }
  | { kind: 'cancelled' };

export const NOTICES: Record<Exclude<SkipReason, 'capture-failed'>, string> = {
  disabled: 'Screen dekhne wali setting band hai. Settings mein usay On karein.',
  busy: 'Main pehle se screen dekh rahi hoon.',
  'no-consent': 'Theek hai, main screen nahi dekhungi.',
  cooldown: 'Abhi abhi screen dekhi hai, thori der baad dobara bolein.',
  sensitive: 'Screen par password, bank ya login jaisi window khuli hai, isliye maine screenshot nahi li. Pehle usay band kar dein.',
};

export function captureNotice(reason: string): string {
  if (reason === 'no-python-gi' || reason === 'no-python3') return 'Screen dekhne ke liye python3-gi chahiye (sudo apt install python3-gi).';
  if (reason === 'portal-denied') return 'Screenshot ki ijazat portal ne nahi di.';
  if (reason === 'portal-timeout') return 'Screenshot mein bohot der lag gayi, dobara try karein.';
  if (reason === 'blank-frame') return 'Screen khaali (black) aayi, dobara try karein.';
  return 'Screen capture nahi ho saka.';
}

/** In-memory only: the last screenshot, for follow-up questions within two minutes. Never written anywhere. */
export class ScreenCache {
  private shot: Shot | null = null;
  private takenAt = 0;

  set(shot: Shot, now: number) {
    this.shot = shot;
    this.takenAt = now;
  }

  get(now: number): { shot: Shot; ageSeconds: number } | null {
    if (!this.shot) return null;
    if (now - this.takenAt > CACHE_TTL_MS) {
      this.clear();
      return null;
    }
    return { shot: this.shot, ageSeconds: Math.max(0, Math.round((now - this.takenAt) / 1000)) };
  }

  has(now: number): boolean {
    return this.get(now) !== null;
  }

  clear() {
    this.shot = null;
    this.takenAt = 0;
  }
}

const STRONG_WORDS = /\b(screen|error|errors|fix|bug|line|code|button|window|tab|file|message|popup|dialog|upar|neeche|yahan|wahan|here|above|below)\b/i;
const DEICTIC = /\b(is|iska|iski|iske|isko|isme|isse|ye|yeh|yahi|wo|woh|this|that|these|it)\b/i;
const QUESTION = /\b(kya|kyun|kyu|kaise|kese|matlab|mean|fix|theek|solve|badlo|change|karun|karna|kare|karein|why|what|how|explain|samjhao|batao)\b/i;

/** Does this turn look like a question about the screenshot she just looked at? Deliberately conservative. */
export function isScreenFollowUp(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (STRONG_WORDS.test(t)) return true;
  return DEICTIC.test(t) && QUESTION.test(t);
}

interface Job { cancelled: boolean }

export class ScreenFlow {
  private deps: FlowDeps;
  private job: Job | null = null;
  private lastCaptureAt: number | null = null;
  private countdownDoneAt: number | null = null;
  readonly cache: ScreenCache = new ScreenCache();

  constructor(deps: FlowDeps) {
    this.deps = deps;
  }

  get busy(): boolean {
    return this.job !== null;
  }

  /** Stop / cancel button / "ruko": abort whatever is pending and forget the cached screenshot. */
  cancel(keepCache = false) {
    if (this.job) this.job.cancelled = true;
    this.deps.cancelConsent();
    // A barge-in (the user talks over her to ask a follow-up) keeps the screenshot; a real stop drops it.
    if (!keepCache) this.cache.clear();
    this.deps.setStatus(null);
  }

  /** Setting turned off: nothing may stay in memory. */
  disable() {
    this.cancel();
    this.lastCaptureAt = null;
    this.countdownDoneAt = null;
  }

  /**
   * A cached screenshot for a normal (non-wake) turn, only if the feature is on, consented, the cache is younger
   * than two minutes and the words look like a follow-up about the screen.
   */
  followUp(text: string): { shot: Shot; ageSeconds: number } | null {
    const d = this.deps;
    if (!d.isEnabled() || !d.hasConsent()) return null;
    if (!isScreenFollowUp(text)) return null;
    const hit = this.cache.get(d.now());
    if (hit) d.setStatus('cached');
    return hit;
  }

  private skip(reason: SkipReason, notice: string): FlowResult {
    this.deps.setStatus('notice', { notice });
    return { kind: 'skipped', reason, notice };
  }

  private async guard(): Promise<{ result: GuardResult; ms: number }> {
    const d = this.deps;
    const started = d.now();
    const timeout = d.sleep(GUARD_WAIT_MS).then((): GuardResult => ({ status: 'unknown' }));
    const check = d.checkWindows().catch((): GuardResult => ({ status: 'unknown' }));
    const result = await Promise.race([check, timeout]);
    return { result, ms: d.now() - started };
  }

  private needsCountdown(): boolean {
    const d = this.deps;
    return this.countdownDoneAt === null || d.now() - this.countdownDoneAt > COUNTDOWN_IDLE_RESET_MS;
  }

  async request(source: ScreenSource): Promise<FlowResult> {
    const d = this.deps;
    if (!d.isEnabled()) return this.skip('disabled', NOTICES.disabled);
    if (this.job) return this.skip('busy', NOTICES.busy);
    const job: Job = { cancelled: false };
    this.job = job;
    const started = d.now();
    try {
      // 1. Consent, once. Only an explicit click can grant it.
      if (!d.hasConsent()) {
        d.setStatus('consent');
        const granted = await d.askConsent(source);
        if (job.cancelled) return this.cancelled();
        if (!granted) return this.skip('no-consent', NOTICES['no-consent']);
        d.saveConsent();
      }

      // 2. Cooldown. Inside it a cached screenshot (<2 min) is reused instead of refusing.
      const decision = decideCapture({ enabled: true, consented: true, source, now: d.now(), lastCaptureAt: this.lastCaptureAt, busy: false });
      if (!decision.capture) {
        const hit = this.cache.get(d.now());
        if (hit) {
          d.setStatus('cached');
          return { kind: 'proceed', shot: hit.shot, cached: true, ageSeconds: hit.ageSeconds, timings: { guardMs: 0, captureMs: 0, totalMs: d.now() - started } };
        }
        return this.skip('cooldown', NOTICES.cooldown);
      }

      // 3. First capture of a session: a visible countdown so the user can close or cancel. The guard looks at the same time.
      if (d.countdownEnabled() && this.needsCountdown()) {
        const early = this.guard();
        for (let n = COUNTDOWN_SECONDS; n >= 1; n--) {
          d.setStatus('countdown', { countdown: n });
          await d.sleep(1000);
          if (job.cancelled) return this.cancelled();
        }
        const earlyGuard = await Promise.race([early, Promise.resolve(null)]);
        if (earlyGuard && earlyGuard.result.status === 'sensitive') return this.skip('sensitive', NOTICES.sensitive);
        this.countdownDoneAt = d.now();
      }

      // 4. Capture and guard in parallel; the image stays local until the guard says it may go.
      d.setStatus('capturing');
      const captureStarted = d.now();
      const [outcome, guard] = await Promise.all([d.capture().then(o => ({ o, ms: d.now() - captureStarted })), this.guard()]);
      if (job.cancelled) return this.cancelled();
      this.lastCaptureAt = d.now();
      if (guard.result.status === 'sensitive') return this.skip('sensitive', NOTICES.sensitive);
      if (!outcome.o.ok) return this.skip('capture-failed', captureNotice(outcome.o.reason));
      this.cache.set(outcome.o.shot, d.now());
      return {
        kind: 'proceed',
        shot: outcome.o.shot,
        cached: false,
        ageSeconds: 0,
        timings: { guardMs: guard.ms, captureMs: outcome.ms, totalMs: d.now() - started },
      };
    } finally {
      this.job = null;
    }
  }

  private cancelled(): FlowResult {
    this.deps.setStatus(null);
    return { kind: 'cancelled' };
  }
}
