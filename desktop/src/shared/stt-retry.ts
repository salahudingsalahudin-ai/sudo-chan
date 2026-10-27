/**
 * When may an EMPTY transcript get ONE second try? (pure policy; SttRouter applies it and picks a different strategy.)
 *
 * Why: about half of the quiet-mic Roman Urdu clips came back empty. A first empty answer is often the engine's guess that a
 * quiet clip is silence, not proof. But the daily Groq allowance is small, so the retry is deliberately narrow:
 *  - only an EMPTY first answer (not one the hallucination filter dropped, not an error or rate limit),
 *  - only a clip that is clearly speech: at least 1.2 s, above the idle level, with real voiced frames,
 *  - never while the bot speaks or just spoke (the mic hears the bot),
 *  - never when the usage meter shows Groq listening below 25 percent remaining,
 *  - at most once per clip (the router never loops).
 */
export const RETRY_MIN_SECONDS = 1.2;
/** Idle mic noise is about 0.009 rms in this app; speech on the user's quiet mic is 0.035-0.07. */
export const RETRY_MIN_RMS = 0.015;
export const RETRY_MIN_VOICED_MS = 300;
export const RETRY_MIN_GROQ_FRACTION = 0.25;
/** Bot speech plus its echo tail (SELF_ECHO_WINDOW_MS is 3 s). */
export const BOT_ECHO_GUARD_MS = 4000;

export type FirstReason = 'ok' | 'empty' | 'filtered' | 'rate-limited' | 'error' | 'no-key';

export interface ClipInfo {
  seconds: number;
  rms: number;
  voicedMs?: number;
  /** The bot is speaking now or finished speaking within BOT_ECHO_GUARD_MS. */
  botActive?: boolean;
}

export interface RetryInput {
  reason: FirstReason | undefined;
  clip?: ClipInfo;
  /** Fraction (0..1) of the Groq listening allowance left, or undefined when unknown. */
  groqRemainingFraction?: number;
  alreadyRetried?: boolean;
}

export interface RetryDecision {
  retry: boolean;
  why: string;
}

export function decideRetry(input: RetryInput): RetryDecision {
  const no = (why: string): RetryDecision => ({ retry: false, why });
  if (input.alreadyRetried) return no('already retried');
  if (input.reason !== 'empty') return no(`first result was ${input.reason ?? 'unknown'}, not empty`);
  const clip = input.clip;
  if (!clip) return no('no clip information');
  if (clip.botActive) return no('bot was speaking');
  if (!(clip.seconds >= RETRY_MIN_SECONDS)) return no('clip too short');
  if (!(clip.rms >= RETRY_MIN_RMS)) return no('clip too quiet (idle level)');
  if (clip.voicedMs !== undefined && clip.voicedMs < RETRY_MIN_VOICED_MS) return no('too little voiced audio');
  const left = input.groqRemainingFraction;
  if (left !== undefined && left < RETRY_MIN_GROQ_FRACTION) return no('Groq listening quota low');
  return { retry: true, why: 'clear speech, empty result' };
}
