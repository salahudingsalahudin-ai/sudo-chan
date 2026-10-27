/**
 * Free-quota usage meter: pure counters, header parsing and the key-free summary the Settings and Chat windows show.
 * No Electron, no file access, no keys: the main process feeds it events and persists `serialize()` (see main/usage-store.ts).
 */

/** Anything with a Headers-like `get`; Response.headers, a Map wrapper or a test double. */
export type HeaderLike = { get(name: string): string | null } | null | undefined;

/** Gemini free tier gave the user about 10 TTS calls a day. Google publishes no remaining-quota header, so this is an ESTIMATE. */
export const GEMINI_TTS_DAILY_ESTIMATE = 10;
/** Rough free allowance for Gemini speech recognition (flash-lite). Also an ESTIMATE. */
export const GEMINI_STT_DAILY_ESTIMATE = 250;
/** Azure Speech free tier (F0): 500,000 characters per month. */
export const AZURE_FREE_CHARS_PER_MONTH = 500_000;
/** Days of per-day counters kept on disk. */
export const KEEP_DAYS = 31;
const KEEP_MONTHS = 12;

export interface DayUsage {
  geminiTts: number;
  geminiStt: number;
  groqStt: number;
  groqSttSeconds: number;
  groqChat: number;
  groqChatTokens: number;
  googleFallback: number;
}

/** Latest x-ratelimit-* values Groq reported. `*ResetAt` are absolute epoch ms (response time + reset duration). */
export interface RateSnapshot {
  limitRequests?: number;
  remainingRequests?: number;
  limitTokens?: number;
  remainingTokens?: number;
  resetRequestsAt?: number;
  resetTokensAt?: number;
  /** When the response carrying these values arrived. */
  at: number;
}

export interface UsageData {
  version: 1;
  days: Record<string, DayUsage>;
  months: Record<string, { azureChars: number }>;
  groqStt?: RateSnapshot;
  groqChat?: RateSnapshot;
  /** Epoch ms until which a 429 told us the service is out of quota. */
  blocks: { geminiTts?: number; geminiStt?: number };
}

/** What the speech and chat code reports to. Optional everywhere, so features work without a tracker. */
export interface TtsUsageSink {
  geminiTts(): void;
  geminiTtsLimit(untilMs: number): void;
  geminiTtsBlockedUntil(): number;
  clearGeminiTtsBlock(): void;
  googleFallback(): void;
  azureChars(chars: number): void;
}
export interface SttUsageSink {
  geminiStt(): void;
  geminiSttLimit(untilMs: number): void;
  groqStt(seconds: number, headers: HeaderLike, ok: boolean): void;
}
export interface ChatUsageSink {
  groqChat(headers: HeaderLike, ok: boolean): void;
  groqChatTokens(tokens: number): void;
}

export function emptyDay(): DayUsage {
  return { geminiTts: 0, geminiStt: 0, groqStt: 0, groqSttSeconds: 0, groqChat: 0, groqChatTokens: 0, googleFallback: 0 };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local calendar day, "2026-10-27". Counters roll over at local midnight. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localMonthKey(ms: number): string {
  return localDayKey(ms).slice(0, 7);
}

/** First moment of the next local month (when the Azure monthly allowance renews). */
export function nextMonthStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

/** "14:05" for today, "tomorrow 05:00" for the next day, "Fri 05:00" further out. Local time. */
export function formatResetLabel(untilMs: number, nowMs: number): string {
  const d = new Date(untilMs);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(new Date(nowMs).getFullYear(), new Date(nowMs).getMonth(), new Date(nowMs).getDate()).getTime()) / 86_400_000);
  if (dayDiff <= 0) return clock;
  if (dayDiff === 1) return `tomorrow ${clock}`;
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${clock}`;
}

/** Groq reset hints: "2m59.56s", "7.66s", "250ms", "1h2m3s", or plain seconds. Returns ms, or undefined. */
export function parseResetDuration(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1000;
  let ms = 0;
  let matched = false;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    ms += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : m[2] === 'h' ? n * 3_600_000 : n * 86_400_000;
  }
  return matched ? ms : undefined;
}

function headerNumber(headers: NonNullable<HeaderLike>, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Reads Groq's x-ratelimit-* response headers. Returns null when the response carried none of them. */
export function parseRateLimitHeaders(headers: HeaderLike, now: number): RateSnapshot | null {
  if (!headers || typeof headers.get !== 'function') return null;
  const snap: RateSnapshot = { at: now };
  snap.limitRequests = headerNumber(headers, 'x-ratelimit-limit-requests');
  snap.remainingRequests = headerNumber(headers, 'x-ratelimit-remaining-requests');
  snap.limitTokens = headerNumber(headers, 'x-ratelimit-limit-tokens');
  snap.remainingTokens = headerNumber(headers, 'x-ratelimit-remaining-tokens');
  const resetRequests = parseResetDuration(headers.get('x-ratelimit-reset-requests'));
  const resetTokens = parseResetDuration(headers.get('x-ratelimit-reset-tokens'));
  if (resetRequests !== undefined) snap.resetRequestsAt = now + resetRequests;
  if (resetTokens !== undefined) snap.resetTokensAt = now + resetTokens;
  const any = [snap.limitRequests, snap.remainingRequests, snap.limitTokens, snap.remainingTokens, snap.resetRequestsAt, snap.resetTokensAt].some(v => v !== undefined);
  if (!any) return null;
  for (const key of Object.keys(snap) as Array<keyof RateSnapshot>) if (snap[key] === undefined) delete snap[key];
  return snap;
}

/** Audio length of a base64 clip: exact for 16-bit PCM WAV, a rough guess (about 48 kbit/s) for compressed formats. */
export function estimateAudioSeconds(base64: string, mimeType: string): number {
  if (!base64) return 0;
  const bytes = Math.floor(base64.length * 0.75);
  if (/wav/i.test(mimeType) && base64.length >= 60) {
    // First 45 bytes are enough for the RIFF header (60 base64 chars = 45 bytes); byte rate sits at offset 28.
    const header = atob(base64.slice(0, 60));
    const byteRate = header.length >= 32 ? (header.charCodeAt(28) | (header.charCodeAt(29) << 8) | (header.charCodeAt(30) << 16)) + header.charCodeAt(31) * 16_777_216 : 0;
    if (byteRate > 0) return Math.max(0, (bytes - 44) / byteRate);
  }
  return bytes / 6000;
}

/** total_tokens from an OpenAI-style chat payload or SSE chunk (Groq also nests it under x_groq.usage). 0 when absent. */
export function tokensFromChatPayload(payload: unknown): number {
  if (!payload || typeof payload !== 'object') return 0;
  const p = payload as { usage?: { total_tokens?: unknown }; x_groq?: { usage?: { total_tokens?: unknown } } };
  const n = p.usage?.total_tokens ?? p.x_groq?.usage?.total_tokens;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function cleanSnapshot(value: unknown): RateSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const at = optNum(v.at);
  if (at === undefined) return undefined;
  const snap: RateSnapshot = { at };
  for (const key of ['limitRequests', 'remainingRequests', 'limitTokens', 'remainingTokens', 'resetRequestsAt', 'resetTokensAt'] as const) {
    const n = optNum(v[key]);
    if (n !== undefined) snap[key] = n;
  }
  return snap;
}

/** Rebuilds trusted data from whatever is on disk: unknown fields (and anything that looks like a secret) are dropped. */
export function parseUsageData(raw: unknown): UsageData {
  const out: UsageData = { version: 1, days: {}, months: {}, blocks: {} };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (r.days && typeof r.days === 'object') {
    for (const [key, value] of Object.entries(r.days as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      out.days[key] = {
        geminiTts: num(v.geminiTts), geminiStt: num(v.geminiStt), groqStt: num(v.groqStt), groqSttSeconds: num(v.groqSttSeconds),
        groqChat: num(v.groqChat), groqChatTokens: num(v.groqChatTokens), googleFallback: num(v.googleFallback),
      };
    }
  }
  if (r.months && typeof r.months === 'object') {
    for (const [key, value] of Object.entries(r.months as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}$/.test(key) || !value || typeof value !== 'object') continue;
      out.months[key] = { azureChars: num((value as Record<string, unknown>).azureChars) };
    }
  }
  out.groqStt = cleanSnapshot(r.groqStt);
  out.groqChat = cleanSnapshot(r.groqChat);
  if (!out.groqStt) delete out.groqStt;
  if (!out.groqChat) delete out.groqChat;
  const blocks = r.blocks && typeof r.blocks === 'object' ? r.blocks as Record<string, unknown> : {};
  const tts = optNum(blocks.geminiTts);
  const sttBlock = optNum(blocks.geminiStt);
  if (tts !== undefined) out.blocks.geminiTts = tts;
  if (sttBlock !== undefined) out.blocks.geminiStt = sttBlock;
  return out;
}

export interface UsageRow {
  id: 'geminiTts' | 'geminiStt' | 'groqStt' | 'groqChat' | 'azureTts';
  label: string;
  /** What `used` counts: "replies today", "characters this month"... */
  unit: string;
  used: number;
  /** null when no allowance is known (shows "used" only, no bar). */
  allowance: number | null;
  remaining: number | null;
  /** 'provider' = reported by the service itself (exact); 'estimate' = our guess; 'free-tier' = published plan size. */
  source: 'provider' | 'estimate' | 'free-tier';
  /** used / allowance, 0..1, or null. */
  fraction: number | null;
  blocked: boolean;
  /** Epoch ms when a blocked or rolling allowance renews. */
  resetsAt: number | null;
  /** Short extra line (audio seconds, tokens...). Never contains secrets. */
  detail: string;
  /** A key (or Azure key + region) is saved for this service. */
  configured: boolean;
}

export interface UsageSummary {
  generatedAt: number;
  day: string;
  rows: UsageRow[];
  /** Replies spoken with the basic Google voice today although a better engine was wanted. */
  basicVoiceToday: number;
  /** Set only while Gemini voice is blocked by a 429 (epoch ms), so the Chat window can show one calm line. */
  geminiVoiceBlockedUntil: number | null;
}

export interface SummaryFlags {
  gemini: boolean;
  groq: boolean;
  azure: boolean;
}

function fraction(used: number, allowance: number | null): number | null {
  if (!allowance || allowance <= 0) return null;
  return Math.max(0, Math.min(1, used / allowance));
}

function groqRow(id: 'groqStt' | 'groqChat', label: string, unit: string, usedToday: number, snap: RateSnapshot | undefined, now: number, configured: boolean, extra: string): UsageRow {
  // Provider numbers are trusted for a day; an older snapshot says nothing about today.
  const live = snap && snap.limitRequests !== undefined && snap.remainingRequests !== undefined && snap.at > now - 86_400_000;
  const resetAt = snap?.resetRequestsAt;
  const blocked = Boolean(live && snap!.remainingRequests === 0 && resetAt !== undefined && resetAt > now);
  const tokenLine = snap && snap.limitTokens !== undefined && snap.remainingTokens !== undefined
    ? `Tokens left this minute: ${Math.round(snap.remainingTokens)} / ${Math.round(snap.limitTokens)}.` : '';
  const detail = [extra, tokenLine].filter(Boolean).join(' ');
  if (live) {
    const allowance = snap!.limitRequests!;
    const remaining = snap!.remainingRequests!;
    const used = Math.max(0, allowance - remaining);
    return { id, label, unit: 'requests today (Groq)', used, allowance, remaining, source: 'provider', fraction: fraction(used, allowance), blocked, resetsAt: blocked ? resetAt! : null, detail, configured };
  }
  return { id, label, unit, used: usedToday, allowance: null, remaining: null, source: 'estimate', fraction: null, blocked: false, resetsAt: null, detail: detail || 'Groq reports the remaining amount after the first request.', configured };
}

export interface UsageTrackerOptions {
  now?: () => number;
  initial?: unknown;
  /** Called after every counter change; the owner debounces and writes the file. */
  onChange?: () => void;
}

export class UsageTracker implements TtsUsageSink, SttUsageSink, ChatUsageSink {
  private data: UsageData;
  private now: () => number;
  private onChange: () => void;

  constructor(options: UsageTrackerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange ?? (() => {});
    this.data = parseUsageData(options.initial);
    this.prune();
  }

  /** Counters for the current local day (created on first use, so a new day starts from zero). */
  private today(): DayUsage {
    const key = localDayKey(this.now());
    let day = this.data.days[key];
    if (!day) {
      day = emptyDay();
      this.data.days[key] = day;
      this.prune();
    }
    return day;
  }

  /** Drops days older than KEEP_DAYS and months older than a year. */
  prune() {
    const nowMs = this.now();
    const d = new Date(nowMs);
    const dayCutoff = localDayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (KEEP_DAYS - 1)).getTime());
    for (const key of Object.keys(this.data.days)) if (key < dayCutoff) delete this.data.days[key];
    const monthCutoff = localMonthKey(new Date(d.getFullYear(), d.getMonth() - (KEEP_MONTHS - 1), 1).getTime());
    for (const key of Object.keys(this.data.months)) if (key < monthCutoff) delete this.data.months[key];
  }

  private changed() {
    this.onChange();
  }

  geminiTts() { this.today().geminiTts++; this.changed(); }

  /** A 429 arrived: Gemini voice is out of quota until `untilMs`. */
  geminiTtsLimit(untilMs: number) {
    if (!Number.isFinite(untilMs)) return;
    this.data.blocks.geminiTts = untilMs;
    this.changed();
  }

  /** 0 when Gemini voice is not blocked (or the block has passed). */
  geminiTtsBlockedUntil(): number {
    const until = this.data.blocks.geminiTts ?? 0;
    return until > this.now() ? until : 0;
  }

  clearGeminiTtsBlock() {
    if (this.data.blocks.geminiTts === undefined) return;
    delete this.data.blocks.geminiTts;
    this.changed();
  }

  geminiStt() { this.today().geminiStt++; this.changed(); }

  geminiSttLimit(untilMs: number) {
    if (!Number.isFinite(untilMs)) return;
    this.data.blocks.geminiStt = untilMs;
    this.changed();
  }

  groqStt(seconds: number, headers: HeaderLike, ok: boolean) {
    if (ok) {
      const day = this.today();
      day.groqStt++;
      day.groqSttSeconds += Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    }
    const snap = parseRateLimitHeaders(headers, this.now());
    if (snap) this.data.groqStt = snap;
    this.changed();
  }

  groqChat(headers: HeaderLike, ok: boolean) {
    if (ok) this.today().groqChat++;
    const snap = parseRateLimitHeaders(headers, this.now());
    if (snap) this.data.groqChat = snap;
    this.changed();
  }

  groqChatTokens(tokens: number) {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.today().groqChatTokens += Math.round(tokens);
    this.changed();
  }

  googleFallback() { this.today().googleFallback++; this.changed(); }

  azureChars(chars: number) {
    if (!Number.isFinite(chars) || chars <= 0) return;
    const key = localMonthKey(this.now());
    const month = this.data.months[key] ?? { azureChars: 0 };
    month.azureChars += Math.round(chars);
    this.data.months[key] = month;
    this.prune();
    this.changed();
  }

  /** Plain JSON for the usage file: counters only, never a key. */
  serialize(): UsageData {
    this.prune();
    return JSON.parse(JSON.stringify(this.data)) as UsageData;
  }

  /** The key-free summary shown in Settings and (one line of it) in Chat. */
  summary(flags: SummaryFlags): UsageSummary {
    const now = this.now();
    const day = this.data.days[localDayKey(now)] ?? emptyDay();
    const month = this.data.months[localMonthKey(now)] ?? { azureChars: 0 };
    const ttsBlock = this.geminiTtsBlockedUntil();
    const sttBlockRaw = this.data.blocks.geminiStt ?? 0;
    const sttBlock = sttBlockRaw > now ? sttBlockRaw : 0;
    const rows: UsageRow[] = [
      {
        id: 'geminiTts', label: 'Gemini voice (realistic)', unit: 'replies today', used: day.geminiTts, allowance: GEMINI_TTS_DAILY_ESTIMATE,
        remaining: Math.max(0, GEMINI_TTS_DAILY_ESTIMATE - day.geminiTts), source: 'estimate', fraction: fraction(day.geminiTts, GEMINI_TTS_DAILY_ESTIMATE),
        blocked: ttsBlock > 0, resetsAt: ttsBlock > 0 ? ttsBlock : null,
        detail: day.geminiTts >= GEMINI_TTS_DAILY_ESTIMATE && !ttsBlock ? 'Past the usual free amount, but Gemini has not refused yet.' : '', configured: flags.gemini,
      },
      {
        id: 'geminiStt', label: 'Gemini listening', unit: 'clips today', used: day.geminiStt, allowance: GEMINI_STT_DAILY_ESTIMATE,
        remaining: Math.max(0, GEMINI_STT_DAILY_ESTIMATE - day.geminiStt), source: 'estimate', fraction: fraction(day.geminiStt, GEMINI_STT_DAILY_ESTIMATE),
        blocked: sttBlock > 0, resetsAt: sttBlock > 0 ? sttBlock : null, detail: '', configured: flags.gemini,
      },
      groqRow('groqStt', 'Groq listening', 'requests today', day.groqStt, this.data.groqStt, now, flags.groq, day.groqSttSeconds > 0 ? `About ${Math.round(day.groqSttSeconds)} s of audio today.` : ''),
      groqRow('groqChat', 'Groq chat', 'requests today', day.groqChat, this.data.groqChat, now, flags.groq, day.groqChatTokens > 0 ? `About ${day.groqChatTokens} tokens used today.` : ''),
      {
        id: 'azureTts', label: 'Azure voice', unit: 'characters this month', used: month.azureChars, allowance: AZURE_FREE_CHARS_PER_MONTH,
        remaining: Math.max(0, AZURE_FREE_CHARS_PER_MONTH - month.azureChars), source: 'free-tier', fraction: fraction(month.azureChars, AZURE_FREE_CHARS_PER_MONTH),
        blocked: false, resetsAt: nextMonthStart(now), detail: '', configured: flags.azure,
      },
    ];
    return { generatedAt: now, day: localDayKey(now), rows, basicVoiceToday: day.googleFallback, geminiVoiceBlockedUntil: ttsBlock > 0 ? ttsBlock : null };
  }
}
