import type { TtsProvider, TtsRequest, TtsResult } from '../shared/voice-interfaces.js';

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

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    try {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(req.text)}&tl=${req.lang}&client=tw-ob`;
      const res = await this.fetchFn(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
        signal: AbortSignal.timeout(7000),
      });
      if (!res.ok) return { ok: false, error: `google ${res.status}` };
      const buffer = Buffer.from(await res.arrayBuffer());
      return { ok: true, dataUri: `data:audio/mp3;base64,${buffer.toString('base64')}`, provider: 'google' };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
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
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return { ok: false, error: `gemini ${res.status}`, status: res.status };
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

/** Gemini first, silent fallback to Google. A failing Gemini is not retried for a short while. */
export class TtsRouter {
  private gemini: GeminiTtsProvider;
  private google: GoogleTranslateTtsProvider;
  private getPreferred: () => string | undefined;
  private now: () => number;
  private geminiDownUntil = 0;

  constructor(options: RouterOptions) {
    this.gemini = new GeminiTtsProvider({ getKey: options.getKey, fetchFn: options.fetchFn });
    this.google = new GoogleTranslateTtsProvider(options.fetchFn);
    this.getPreferred = options.getPreferred;
    this.now = options.now ?? Date.now;
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const wantGemini = (this.getPreferred() ?? 'gemini') === 'gemini';
    if (wantGemini && this.gemini.hasKey() && this.now() >= this.geminiDownUntil) {
      const result = await this.gemini.synthesize(req);
      if (result.ok) return result;
      this.geminiDownUntil = this.now() + (result.status === 429 ? 60_000 : 30_000);
    }
    return this.google.synthesize(req);
  }
}
