import type { TtsProvider, TtsRequest, TtsResult } from '../shared/voice-interfaces.js';
import { chunkForGoogle, normalizeForSpeech, worthGemini } from '../shared/speech.ts';

type FetchFn = typeof fetch;

export const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
export const DEFAULT_GEMINI_VOICE = 'Kore';
export const GEMINI_VOICES = ['Kore', 'Puck', 'Zephyr', 'Aoede', 'Leda', 'Charon', 'Fenrir'];

/** Wraps raw 16-bit little-endian PCM in a RIFF/WAVE header so it can be decoded by Web Audio. */
export function pcmToWav(pcm: Uint8Array, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

function speedHint(speed?: number): string {
  if (typeof speed !== 'number' || Math.abs(speed - 1) < 0.08) return '';
  return speed > 1 ? ' Speak a little faster than normal.' : ' Speak a little slower than normal.';
}

/** Builds the exact text sent to Gemini: style instruction first, then the sentence. */
export function buildGeminiPrompt(req: TtsRequest): string {
  const style = req.style || 'Say the following in a natural, conversational tone.';
  return `${style}${speedHint(req.speed)}\n\n${req.text}`;
}

export class GoogleTranslateTtsProvider implements TtsProvider {
  readonly id = 'google' as const;
  readonly name = 'Google Translate TTS';
  private fetchFn: FetchFn;

  constructor(fetchFn: FetchFn = fetch) {
    this.fetchFn = fetchFn;
  }

  private async fetchChunk(text: string, lang: string): Promise<Buffer | null> {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
    const res = await this.fetchFn(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }

  /** Normalises the text, splits it at natural boundaries (<= 180 chars), fetches the chunks in parallel and joins the MP3 frames. */
  async synthesize(req: TtsRequest): Promise<TtsResult> {
    try {
      const chunks = chunkForGoogle(normalizeForSpeech(req.text), 180);
      if (!chunks.length) return { ok: false, error: 'empty' };
      const parts = await Promise.all(chunks.map(chunk => this.fetchChunk(chunk, req.lang)));
      if (parts.some(part => !part)) return { ok: false, error: 'google chunk failed' };
      const buffer = Buffer.concat(parts as Buffer[]);
      return { ok: true, dataUri: `data:audio/mp3;base64,${buffer.toString('base64')}`, provider: 'google', calls: chunks.length };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }
}

const MINUTE = 60_000;

/** Parses "Please retry in 7h11m31.9s" style hints from Google error messages. */
function parseRetryIn(body: string): number {
  const m = /retry in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?/i.exec(body);
  if (!m || (!m[1] && !m[2] && !m[3])) return 0;
  return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
}

/**
 * How long to leave Gemini alone after a 429: Retry-After, else the body's retryDelay / "retry in 7h11m",
 * else 60 s; a per-day quota waits at least 30 min. Capped at 24 h.
 */
export function quotaBackoffMs(retryAfterHeader: string | null | undefined, body: string): number {
  let ms = 0;
  const header = Number(retryAfterHeader);
  if (retryAfterHeader && Number.isFinite(header) && header > 0) ms = header * 1000;
  if (!ms) {
    const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
    if (delay) ms = Number(delay[1]) * 1000;
  }
  if (!ms) ms = parseRetryIn(body);
  if (!ms) ms = MINUTE;
  if (/PerDay|per day|daily/i.test(body)) ms = Math.max(ms, 30 * MINUTE);
  return Math.min(ms, 24 * 60 * MINUTE);
}

/** Small in-memory LRU for synthesized audio, bounded by total bytes. */
export class AudioCache {
  private entries = new Map<string, string>();
  private bytes = 0;
  private maxBytes: number;

  constructor(maxBytes = 24 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: string) {
    const old = this.entries.get(key);
    if (old !== undefined) { this.bytes -= old.length; this.entries.delete(key); }
    if (value.length > this.maxBytes) return;
    this.entries.set(key, value);
    this.bytes += value.length;
    for (const [oldest, oldValue] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.bytes -= oldValue.length;
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface GeminiTtsOptions {
  getKey: () => string;
  fetchFn?: FetchFn;
  model?: string;
}

export class GeminiTtsProvider implements TtsProvider {
  readonly id = 'gemini' as const;
  readonly name = 'Gemini TTS';
  private getKey: () => string;
  private fetchFn: FetchFn;
  private model: string;

  constructor(options: GeminiTtsOptions) {
    this.getKey = options.getKey;
    this.fetchFn = options.fetchFn ?? fetch;
    this.model = options.model ?? GEMINI_TTS_MODEL;
  }

  hasKey(): boolean {
    return Boolean(this.getKey());
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const key = this.getKey();
    if (!key) return { ok: false, error: 'no-key' };
    try {
      const res = await this.fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildGeminiPrompt(req) }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voice || DEFAULT_GEMINI_VOICE } } },
          },
        }),
        signal: AbortSignal.timeout(Math.min(30_000, 10_000 + req.text.length * 40)),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, error: `gemini ${res.status}`, status: res.status, retryAfterMs: res.status === 429 ? quotaBackoffMs(res.headers.get('retry-after'), body) : undefined };
      }
      const json = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }> };
      const inline = json.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data)?.inlineData;
      if (!inline?.data) return { ok: false, error: 'gemini returned no audio' };
      const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1]) || 24000;
      const wav = pcmToWav(Buffer.from(inline.data, 'base64'), rate);
      return { ok: true, dataUri: `data:audio/wav;base64,${wav.toString('base64')}`, provider: 'gemini' };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }
}

export interface RouterOptions {
  getKey: () => string;
  /** 'gemini' (default) or 'google'. */
  getPreferred: () => string | undefined;
  fetchFn?: FetchFn;
  now?: () => number;
}

export interface RouterStats { geminiCalls: number; googleRequests: number; cacheHits: number; skippedShort: number }

/**
 * Gemini first (when a key exists, the engine is not forced to Google, the text is worth a call and the
 * quota is not in back-off), silent fallback to Google. Identical requests come from an in-memory cache.
 */
export class TtsRouter {
  private gemini: GeminiTtsProvider;
  private google: GoogleTranslateTtsProvider;
  private getPreferred: () => string | undefined;
  private now: () => number;
  private geminiDownUntil = 0;
  private cache = new AudioCache();
  readonly stats: RouterStats = { geminiCalls: 0, googleRequests: 0, cacheHits: 0, skippedShort: 0 };

  constructor(options: RouterOptions) {
    this.gemini = new GeminiTtsProvider({ getKey: options.getKey, fetchFn: options.fetchFn });
    this.google = new GoogleTranslateTtsProvider(options.fetchFn);
    this.getPreferred = options.getPreferred;
    this.now = options.now ?? Date.now;
  }

  private key(engine: string, req: TtsRequest): string {
    return [engine, req.lang, req.voice ?? '', req.speed ?? '', req.style ?? '', req.text].join('\u0001');
  }

  /** Forget any quota back-off (e.g. the user just saved a different key or switched plan). */
  resetBackoff() {
    this.geminiDownUntil = 0;
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const wantGemini = (this.getPreferred() ?? 'gemini') === 'gemini' && this.gemini.hasKey();
    const worth = worthGemini(req.text);
    if (wantGemini && !worth) this.stats.skippedShort++;

    if (wantGemini && worth) {
      // A cached Gemini clip is free, even while Gemini is in back-off.
      const cached = this.cache.get(this.key('gemini', req));
      if (cached) { this.stats.cacheHits++; return { ok: true, dataUri: cached, provider: 'gemini', cached: true }; }
      if (this.now() >= this.geminiDownUntil) {
        this.stats.geminiCalls++;
        const result = await this.gemini.synthesize(req);
        if (result.ok) {
          if (result.dataUri) this.cache.set(this.key('gemini', req), result.dataUri);
          return result;
        }
        this.geminiDownUntil = this.now() + (result.retryAfterMs ?? (result.status === 429 ? MINUTE : 30_000));
      }
    }

    const cachedGoogle = this.cache.get(this.key('google', req));
    if (cachedGoogle) { this.stats.cacheHits++; return { ok: true, dataUri: cachedGoogle, provider: 'google', cached: true }; }
    this.stats.googleRequests++;
    const result = await this.google.synthesize(req);
    if (result.ok && result.dataUri) this.cache.set(this.key('google', req), result.dataUri);
    return result;
  }
}
