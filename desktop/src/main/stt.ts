/**
 * Speech-to-text with a Gemini-first route (much better on Urdu / Roman Urdu than Whisper),
 * Groq Whisper next, OpenAI Whisper last. Network and keys are injected so this is unit tested.
 */
export type SttLang = 'en' | 'ur' | undefined;
export interface SttRequest {
  base64: string;
  mimeType: string;
  language?: string;
  hint?: string;
}
export interface SttOutcome {
  ok: boolean;
  text?: string;
  provider?: 'gemini' | 'whisper' | 'openai';
  rateLimited?: boolean;
  /** Result came back in Urdu/Arabic script even though Latin Roman Urdu was requested. */
  scriptWarning?: boolean;
  error?: string;
}
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<FetchResponseLike>;
export interface SttDeps {
  fetch: FetchLike;
  getKey(provider: 'gemini' | 'groq' | 'openai'): string;
  now(): number;
  /** 'fast' tries Groq Whisper first (about 0.5 s) before Gemini; 'accurate' (default) tries Gemini first. */
  getMode?(): string | undefined;
}

// '-latest' aliases: the dated 2.5 names returned 404 for the user's key. Lite first: it answered a clip in ~1.8 s, while gemini-flash-latest exceeded the 9 s timeout in a sanity check.
export const GEMINI_STT_MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest'];
const WHISPER_HALLUCINATIONS = /^(thank you|thank you\.|thanks for watching|thank you for watching|thank you very much|thanks\.|you|bye\.|subtitles by|amara\.org|watching!|please subscribe|subscribe)[.!? ]*$/i;
const VALID_SHORT = /^(sid|sudo|ji|haan|suno|kaho|bye|hello|hi|yes|no|theek|kya)$/i;
const ARABIC_SCRIPT = /[؀-ۿ]/;

/** 'auto' and 'ur-PK' are not forced to English; only explicit en/ur are passed as a language. */
export function normalizeSttLang(language: string | undefined): SttLang {
  if (language === 'en') return 'en';
  if (language === 'ur' || language === 'ur-PK') return 'ur';
  return undefined;
}

export function hasArabicScript(text: string): boolean {
  return ARABIC_SCRIPT.test(text);
}

/** Rejects empty text, known Whisper hallucinations, one-word noise, and repeated-token garbage. */
export function isValidTranscription(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return false;
  if (WHISPER_HALLUCINATIONS.test(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2 && !VALID_SHORT.test(trimmed)) return false;
  if (words.length >= 4) {
    const counts = new Map<string, number>();
    for (const w of words) {
      const k = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const top = Math.max(...counts.values());
    if (top / words.length >= 0.7) return false;
  }
  return true;
}

export function cleanTranscript(raw: string): string {
  let text = raw.trim();
  if (/^\[?\s*none\s*\]?\.?$/i.test(text)) return '';
  text = text.replace(/^["'`]+|["'`]+$/g, '').trim();
  return text;
}

export function buildGeminiPrompt(language: SttLang, hint: string | undefined): string {
  const who = language === 'en'
    ? 'The speaker uses English.'
    : language === 'ur'
      ? 'The speaker uses Urdu (Pakistani), possibly mixed with English words.'
      : 'The speaker uses Pakistani Urdu (often mixed with English) or plain English.';
  return [
    'You transcribe one short voice command for a desktop assistant.',
    who,
    'Rules: write Urdu speech in Roman Urdu with Latin letters (for example "tum mere sath baat kyun nahi kar rahe"), never in Urdu or Arabic script. Write English speech in English and keep English words in English.',
    'Output ONLY the transcript, with no quotes, notes or explanations. Do not guess words you cannot hear. If there is no clear speech, output exactly [none].',
    hint ? `Context: ${hint}` : '',
  ].filter(Boolean).join(' ');
}

function extractGeminiText(body: unknown): string {
  const b = body as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return b?.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('').trim() ?? '';
}

export async function geminiTranscribe(fetchFn: FetchLike, key: string, model: string, req: SttRequest): Promise<{ status: number; text: string }> {
  const lang = normalizeSttLang(req.language);
  let res: FetchResponseLike;
  try {
    res = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildGeminiPrompt(lang, req.hint) }, { inlineData: { mimeType: req.mimeType, data: req.base64 } }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 160 },
      }),
      signal: AbortSignal.timeout(9000),
    });
  } catch {
    return { status: 0, text: '' };
  }
  if (!res.ok) return { status: res.status, text: '' };
  try {
    return { status: 200, text: cleanTranscript(extractGeminiText(await res.json())) };
  } catch {
    return { status: 0, text: '' };
  }
}

export const WHISPER_DEFAULT_PROMPT = 'Pakistani conversation in Roman Urdu and English. Sudo-chan, Sid, suno, ji, kya haal hai, kaise ho, theek hai, mujhe batao, kaam, baat, computer.';

async function whisperTranscribe(fetchFn: FetchLike, url: string, key: string, models: string[], req: SttRequest, extraHeaders: Record<string, string>): Promise<{ status: number; text: string }> {
  const lang = normalizeSttLang(req.language);
  const ext = req.mimeType.includes('webm') ? 'webm' : 'wav';
  const bytes = Buffer.from(req.base64, 'base64');
  let status = 0;
  for (const model of models) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: req.mimeType }), `speech.${ext}`);
    form.append('model', model);
    if (lang) form.append('language', lang);
    form.append('prompt', req.hint ? `${req.hint} ${WHISPER_DEFAULT_PROMPT}`.slice(0, 400) : WHISPER_DEFAULT_PROMPT);
    form.append('temperature', '0');
    try {
      const res = await fetchFn(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, ...extraHeaders }, body: form, signal: AbortSignal.timeout(9000) });
      status = res.status;
      if (res.ok) {
        const data = (await res.json()) as { text?: string };
        return { status: 200, text: (data.text ?? '').trim() };
      }
      if (res.status === 429) return { status, text: '' };
    } catch {
      status = 0;
    }
  }
  return { status, text: '' };
}

interface Route {
  id: string;
  provider: 'gemini' | 'whisper' | 'openai';
  run(req: SttRequest, key: string): Promise<{ status: number; text: string }>;
  key: 'gemini' | 'groq' | 'openai';
}

export class SttRouter {
  private deps: SttDeps;
  private blockedUntil: Record<string, number>;
  private blockedByRateLimit: Record<string, boolean>;
  private routes: Route[];

  constructor(deps: SttDeps) {
    this.deps = deps;
    this.blockedUntil = {};
    this.blockedByRateLimit = {};
    const f = deps.fetch;
    this.routes = [
      ...GEMINI_STT_MODELS.map((model): Route => ({ id: `gemini:${model}`, provider: 'gemini', key: 'gemini', run: (req, key) => geminiTranscribe(f, key, model, req) })),
      { id: 'groq', provider: 'whisper', key: 'groq', run: (req, key) => whisperTranscribe(f, 'https://api.groq.com/openai/v1/audio/transcriptions', key, ['whisper-large-v3', 'whisper-large-v3-turbo'], req, { 'User-Agent': 'Sudo-chan-Companion/1.0' }) },
      { id: 'openai', provider: 'openai', key: 'openai', run: (req, key) => whisperTranscribe(f, 'https://api.openai.com/v1/audio/transcriptions', key, ['whisper-1'], req, {}) },
    ];
  }

  async transcribe(req: SttRequest): Promise<SttOutcome> {
    let sawRateLimit = false;
    const lang = normalizeSttLang(req.language);
    const fast = this.deps.getMode?.() === 'fast';
    const ordered = fast ? [...this.routes.filter(r => r.provider === 'whisper'), ...this.routes.filter(r => r.provider !== 'whisper')] : this.routes;
    for (const route of ordered) {
      const key = this.deps.getKey(route.key);
      if (!key) continue;
      const now = this.deps.now();
      if ((this.blockedUntil[route.id] ?? 0) > now) {
        if (this.blockedByRateLimit[route.id]) sawRateLimit = true;
        continue;
      }
      const routeStarted = this.deps.now();
      const result = await route.run(req, key);
      console.info(`[STT] route=${route.id} status=${result.status} chars=${result.text.length} ms=${this.deps.now() - routeStarted}`);
      if (result.status === 429) {
        this.blockedUntil[route.id] = this.deps.now() + 60_000;
        this.blockedByRateLimit[route.id] = true;
        sawRateLimit = true;
        continue;
      }
      if (result.status === 0 || result.status >= 400) {
        // Auth or server error: skip this route for a short while, silently.
        this.blockedUntil[route.id] = this.deps.now() + 15_000;
        this.blockedByRateLimit[route.id] = false;
        continue;
      }
      // Fast mode: Whisper often writes Urdu speech in Arabic script garbage. If we did not ask for Urdu, let Gemini have a go instead.
      if (fast && route.provider === 'whisper' && result.text && hasArabicScript(result.text) && lang !== 'ur') continue;
      if (result.text && isValidTranscription(result.text)) {
        const arabic = hasArabicScript(result.text);
        return { ok: true, text: result.text, provider: route.provider, scriptWarning: arabic && lang !== 'ur' ? true : undefined };
      }
      // A valid but empty/garbage transcription: do not burn more quota on other providers for silence.
      if (route.provider === 'gemini') return { ok: false, error: 'Could not transcribe speech.' };
    }
    return { ok: false, rateLimited: sawRateLimit, error: sawRateLimit ? 'rate-limited' : 'Could not transcribe speech.' };
  }
}
