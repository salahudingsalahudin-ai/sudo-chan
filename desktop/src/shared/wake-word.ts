export const DEFAULT_ASSISTANT_NAME = 'Sudo';
export const DEFAULT_WAKE_ALIASES = ['Sudo', 'Sid', 'Sudo-chan', 'Suddo', 'Sit'];
export const WAKE_WINDOW_MS = 30_000;
/** The name must appear within the first few words, so chatter that merely mentions it later is ignored. */
export const WAKE_MAX_LEADING_WORDS = 4;

export interface WakeMatch {
  matched: boolean;
  /** The alias that matched. */
  alias?: string;
  /** Whatever was said after the name (the actual command), if anything. */
  rest: string;
}

export function normalizeWord(word: string): string {
  return word.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Tolerated typos: none for very short names (sid, sit), 1 for 4-5 letters, 2 for longer. */
export function allowedDistance(alias: string): number {
  if (alias.length <= 3) return 0;
  return alias.length <= 5 ? 1 : 2;
}

export function wakeVocabulary(name: string | undefined, aliases: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [name ?? '', ...(aliases && aliases.length ? aliases : DEFAULT_WAKE_ALIASES)]) {
    const trimmed = raw.trim();
    const key = normalizeWord(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Prompt hint for the speech-to-text provider so the name is spelled the way we match it. */
export function buildWakeHint(name: string | undefined, aliases: string[] | undefined): string {
  return `Short voice command. The speaker may call the assistant by name: ${wakeVocabulary(name, aliases).join(', ')}.`;
}

export function matchWakeWord(transcript: string, name: string | undefined, aliases: string[] | undefined): WakeMatch {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  const none: WakeMatch = { matched: false, rest: transcript.trim() };
  if (!words.length) return none;
  const vocabulary = wakeVocabulary(name, aliases).map(alias => ({ alias, key: normalizeWord(alias) }));
  const limit = Math.min(words.length, WAKE_MAX_LEADING_WORDS);

  for (let i = 0; i < limit; i++) {
    // Single word, and two words glued together ("sudo chan" -> "sudochan").
    const candidates: Array<{ text: string; length: number }> = [];
    if (i + 1 < words.length) candidates.push({ text: normalizeWord(words[i] + words[i + 1]), length: 2 });
    candidates.push({ text: normalizeWord(words[i]), length: 1 });
    for (const candidate of candidates) {
      if (!candidate.text) continue;
      for (const { alias, key } of vocabulary) {
        // Glued word pairs are only accepted with at most one typo, otherwise "sudo what" would look like "sudochan".
        const tolerance = candidate.length === 2 ? Math.min(1, allowedDistance(key)) : allowedDistance(key);
        if (editDistance(candidate.text, key) <= tolerance) {
          return { matched: true, alias, rest: words.slice(i + candidate.length).join(' ').trim() };
        }
      }
    }
  }
  return none;
}

/** Cloud-call limiter: at most one clip per interval, with silent exponential back-off on failures. */
export class WakeGate {
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private blockedUntil = 0;
  private backoffMs = 0;
  private minIntervalMs: number;

  constructor(minIntervalMs = 2000) {
    this.minIntervalMs = minIntervalMs;
  }

  /** True (and records the send) if a clip may go to the cloud right now. */
  allow(now: number): boolean {
    if (now < this.blockedUntil) return false;
    if (now - this.lastSentAt < this.minIntervalMs) return false;
    this.lastSentAt = now;
    return true;
  }

  report(now: number, outcome: 'ok' | 'rate-limited' | 'error') {
    if (outcome === 'ok') {
      this.backoffMs = 0;
      return;
    }
    this.backoffMs = Math.min(60_000, this.backoffMs ? this.backoffMs * 2 : outcome === 'rate-limited' ? 8_000 : 4_000);
    this.blockedUntil = now + this.backoffMs;
  }

  get blockedForMs(): number {
    return this.backoffMs;
  }
}

/** The 30 s "no name needed" window after a wake word; every user utterance extends it. */
export class ConversationWindow {
  private until = 0;
  private windowMs: number;

  constructor(windowMs = WAKE_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  open(now: number) {
    this.until = now + this.windowMs;
  }

  touch(now: number) {
    if (this.isOpen(now)) this.until = now + this.windowMs;
  }

  isOpen(now: number): boolean {
    return now < this.until;
  }

  close() {
    this.until = 0;
  }
}
