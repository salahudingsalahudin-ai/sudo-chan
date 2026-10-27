/**
 * Speech-to-text with a Gemini-first route (much better on Urdu / Roman Urdu than Whisper),
 * Groq Whisper next, OpenAI Whisper last. Network and keys are injected so this is unit tested.
 */
import { estimateAudioSeconds } from '../shared/usage.ts';
import type { HeaderLike, SttUsageSink } from '../shared/usage.ts';
import { classifyTranscript, whisperTextIsSilence } from '../shared/stt-hallucination.ts';
import { aliasForMatching, isShortCommandWord } from '../shared/transcript-normalize.ts';
import { isStopCommand } from '../shared/stop-intent.ts';
import { decideRetry } from '../shared/stt-retry.ts';
import type { ClipInfo, FirstReason } from '../shared/stt-retry.ts';
export type SttLang = 'en' | 'ur' | undefined;
export interface SttRequest {
  base64: string;
  mimeType: string;
  language?: string;
  hint?: string;
  /** Level facts about the clip (from the main process); enables the single retry of an empty result. */
  clip?: ClipInfo;
  /** Internal: second-chance request without Whisper prompt / forced language. */
  bare?: boolean;
}
export interface SttOutcome {
  ok: boolean;
  text?: string;
  provider?: 'gemini' | 'whisper' | 'openai';
  rateLimited?: boolean;
  /** Result came back in Urdu/Arabic script even though Latin Roman Urdu was requested. */
  scriptWarning?: boolean;
  error?: string;
  /** Why it failed: 'empty' = the engine heard nothing (the only reason that may be retried once). */
  reason?: FirstReason;
  /** The result came from the single second try. */
  retried?: boolean;
}
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** Present on real fetch responses; the usage meter reads Groq's x-ratelimit-* values from it. */
  headers?: HeaderLike;
}
export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<FetchResponseLike>;
export interface SttDeps {
  fetch: FetchLike;
  getKey(provider: 'gemini' | 'groq' | 'openai'): string;
  now(): number;
  /** 'fast' tries Groq Whisper first (about 0.5 s) before Gemini; 'accurate' (default) tries Gemini first. */
  getMode?(): string | undefined;
  /** Usage meter (counts calls, remembers Groq's remaining quota). Optional. */
  usage?: SttUsageSink;
}

// '-latest' aliases: the dated 2.5 names returned 404 for the user's key. Lite first: it answered a clip in ~1.8 s, while gemini-flash-latest exceeded the 9 s timeout in a sanity check.
export const GEMINI_STT_MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest'];
const WHISPER_HALLUCINATIONS = /^(thank you|thank you\.|thanks for watching|thank you for watching|thank you very much|thanks\.|you|bye\.|subtitles by|amara\.org|watching!|please subscribe|subscribe)[.!? ]*$/i;
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
  // One word is only real when it is a known command / answer in any script ("Sudo.", "ruko", "रुको", "رکو"): punctuation is ignored.
  if (words.length < 2 && !isShortCommandWord(trimmed) && !isStopCommand(trimmed)) return false;
  // Whisper writing back its own prompt (a list of the assistant's names) or subtitle junk is not speech.
  if (classifyTranscript(trimmed).drop) return false;
  if (words.length >= 4) {
    const counts = new Map<string, number>();
    for (const w of words) {
      const k = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const top = Math.max(...counts.values());
    if (top / words.length >= 0.7 && !isStopCommand(trimmed)) return false; // "ruko ruko ruko ruko" is a real stop
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
    'Output ONLY the transcript, with no quotes, notes or explanations. Do not guess words you cannot hear. A single short command word (for example "ruko", "bas" or "dekho") is a valid transcript. If there is no clear speech, output exactly [none].',
    hint ? `Context: ${hint}` : '',
  ].filter(Boolean).join(' ');
}

function extractGeminiText(body: unknown): string {
  const b = body as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return b?.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('').trim() ?? '';
}

export async function geminiTranscribe(fetchFn: FetchLike, key: string, model: string, req: SttRequest): Promise<RouteResult> {
  const lang = req.bare ? undefined : normalizeSttLang(req.language);
  let res: FetchResponseLike;
  try {
    res = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildGeminiPrompt(lang, req.bare ? undefined : req.hint) }, { inlineData: { mimeType: req.mimeType, data: req.base64 } }] }],
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

/**
 * Whisper `prompt` is a style/spelling prior, not an instruction, and on quiet clips Whisper writes it back as the transcript.
 * The old prompt began with "Sudo-chan, Sid, ..." and the wake hint added a second list of the same names, so silence came back
 * as "Sudo-chan, Sido-chan," and woke the bot. Now: natural sentence, no name list, the name at most ONCE and never first.
 */
export function whisperPromptFor(primaryName: string): string {
  return `Roman Urdu and English: kaise ho, theek hai, mujhe computer ka kaam batao. Mujhe ${primaryName} se baat karni hai.`;
}
export const WHISPER_DEFAULT_PROMPT = whisperPromptFor('Sudo-chan');
const WAKE_HINT_NAMES = /by name:?\s*([^.]*)\./i;
const NAME_LIKE = /\b(?:sudo|sido|sid|suddo|chan)\b/i;

/** Builds the Whisper prompt from the caller's hint without ever sending a list of names or the same name twice. */
export function buildWhisperPrompt(hint: string | undefined): string {
  const clause = hint?.match(WAKE_HINT_NAMES);
  if (clause) {
    const first = clause[1].split(',').map(n => n.trim()).find(Boolean);
    return whisperPromptFor(first || 'Sudo-chan').slice(0, 400);
  }
  // A free-form hint is kept only if it does not carry a name of its own (the default sentence already has one).
  const extra = hint && !NAME_LIKE.test(hint) ? `${hint.trim()} ` : '';
  return `${extra}${WHISPER_DEFAULT_PROMPT}`.slice(0, 400);
}

export interface RouteResult { status: number; text: string; /** Whisper said silence; the text it had (if any) is kept only for the retry decision. */ silenced?: string }

/** Numbers only (never text or keys): lets the log show why a clip was called silence. */
function segmentSummary(segments: unknown): string {
  if (!Array.isArray(segments) || !segments.length) return 'segs=0';
  const nums = (field: string) => segments.map(x => (x as Record<string, unknown>)?.[field]).filter((v): v is number => typeof v === 'number');
  const nsp = nums('no_speech_prob');
  const lp = nums('avg_logprob');
  return `segs=${segments.length} nsp=${nsp.length ? Math.max(...nsp).toFixed(2) : '-'} logprob=${lp.length ? Math.min(...lp).toFixed(2) : '-'}`;
}

async function whisperTranscribe(fetchFn: FetchLike, url: string, key: string, models: string[], req: SttRequest, extraHeaders: Record<string, string>, onResponse?: (res: FetchResponseLike) => void): Promise<RouteResult> {
  const lang = normalizeSttLang(req.language);
  const ext = req.mimeType.includes('webm') ? 'webm' : 'wav';
  const bytes = Buffer.from(req.base64, 'base64');
  let status = 0;
  for (const model of models) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: req.mimeType }), `speech.${ext}`);
    form.append('model', model);
    // A bare (second-chance) request sends neither a forced language nor a prompt: nothing for Whisper to be biased by or to echo.
    if (lang && !req.bare) form.append('language', lang);
    if (!req.bare) form.append('prompt', buildWhisperPrompt(req.hint));
    // Segment confidence (no_speech_prob / avg_logprob) lets us drop clips Whisper itself thinks are silence.
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    try {
      const res = await fetchFn(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, ...extraHeaders }, body: form, signal: AbortSignal.timeout(9000) });
      status = res.status;
      onResponse?.(res);
      if (res.ok) {
        const data = (await res.json()) as { text?: string; segments?: unknown; language?: string };
        const text = (data.text ?? '').trim();
        console.info(`[STT] whisper model=${model} lang=${data.language ?? '-'} bare=${req.bare ? 1 : 0} ${segmentSummary(data.segments)}`);
        if (whisperTextIsSilence(data.segments, text)) {
          console.info('[STT] whisper result rejected: segments look like silence');
          return { status: 200, text: '', silenced: text };
        }
        return { status: 200, text };
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
  run(req: SttRequest, key: string): Promise<RouteResult>;
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
      { id: 'groq', provider: 'whisper', key: 'groq', run: (req, key) => whisperTranscribe(f, 'https://api.groq.com/openai/v1/audio/transcriptions', key, ['whisper-large-v3', 'whisper-large-v3-turbo'], req, { 'User-Agent': 'Sudo-chan-Companion/1.0' }, res => this.deps.usage?.groqStt(estimateAudioSeconds(req.base64, req.mimeType), res.headers, res.ok)) },
      { id: 'openai', provider: 'openai', key: 'openai', run: (req, key) => whisperTranscribe(f, 'https://api.openai.com/v1/audio/transcriptions', key, ['whisper-1'], req, {}) },
    ];
  }

  /** One request to one route, with the usage and back-off bookkeeping. */
  private async call(route: Route, req: SttRequest): Promise<RouteResult> {
    const routeStarted = this.deps.now();
    const result = await route.run(req, this.deps.getKey(route.key));
    console.info(`[STT] route=${route.id} status=${result.status} chars=${result.text.length} ms=${this.deps.now() - routeStarted}${req.bare ? ' retry=1' : ''}`);
    if (result.status === 200 && route.provider === 'gemini') this.deps.usage?.geminiStt();
    if (result.status === 429) {
      if (route.provider === 'gemini') this.deps.usage?.geminiSttLimit(this.deps.now() + 60_000);
      this.blockedUntil[route.id] = this.deps.now() + 60_000;
      this.blockedByRateLimit[route.id] = true;
    } else if (result.status === 0 || result.status >= 400) {
      // Auth or server error: skip this route for a short while, silently.
      this.blockedUntil[route.id] = this.deps.now() + 15_000;
      this.blockedByRateLimit[route.id] = false;
    }
    return result;
  }

  private usable(route: Route): boolean {
    return Boolean(this.deps.getKey(route.key)) && (this.blockedUntil[route.id] ?? 0) <= this.deps.now();
  }

  private ordered(): Route[] {
    const fast = this.deps.getMode?.() === 'fast';
    return fast ? [...this.routes.filter(r => r.provider === 'whisper'), ...this.routes.filter(r => r.provider !== 'whisper')] : this.routes;
  }

  /** Why an unusable answer was unusable: nothing heard ('empty') or something the filters dropped ('filtered'). */
  private static emptyReason(result: RouteResult): 'empty' | 'filtered' {
    if (result.text) return 'filtered';
    return result.silenced && classifyTranscript(result.silenced).drop ? 'filtered' : 'empty';
  }

  /** The normal pass over the routes (unchanged semantics). `answered` lists the routes that returned HTTP 200. */
  private async pass(req: SttRequest): Promise<{ outcome: SttOutcome; answered: Route[] }> {
    let sawRateLimit = false;
    let anyKey = false;
    let lastReason: 'empty' | 'filtered' | undefined;
    const answered: Route[] = [];
    const lang = normalizeSttLang(req.language);
    const fast = this.deps.getMode?.() === 'fast';
    for (const route of this.ordered()) {
      if (!this.deps.getKey(route.key)) continue;
      anyKey = true;
      if ((this.blockedUntil[route.id] ?? 0) > this.deps.now()) {
        if (this.blockedByRateLimit[route.id]) sawRateLimit = true;
        continue;
      }
      const result = await this.call(route, req);
      if (result.status === 429) {
        sawRateLimit = true;
        continue;
      }
      if (result.status === 0 || result.status >= 400) continue;
      answered.push(route);
      // Fast mode: Whisper often writes Urdu speech in Arabic script garbage. If we did not ask for Urdu, let Gemini have a go instead,
      // unless the Arabic-script text is already a recognisable command (wake name, stop word): then it is not garbage and costs no extra request.
      if (fast && route.provider === 'whisper' && result.text && hasArabicScript(result.text) && lang !== 'ur' && !looksLikeCommand(result.text)) continue;
      if (result.text) {
        const verdict = classifyTranscript(result.text);
        if (verdict.drop) console.info(`[STT] dropped phantom transcript (${verdict.reason})`);
      }
      if (result.text && isValidTranscription(result.text)) {
        const arabic = hasArabicScript(result.text);
        return { outcome: { ok: true, text: result.text, provider: route.provider, scriptWarning: arabic && lang !== 'ur' ? true : undefined }, answered };
      }
      lastReason = SttRouter.emptyReason(result);
      // Fast mode: a short rejected Whisper result (one or two words) is almost always noise or a half-heard word;
      // asking Gemini as well just adds ~2 s of waiting and usually returns nothing. Only longer garbage gets a second opinion.
      if (fast && route.provider === 'whisper' && result.text.trim().split(/\s+/).filter(Boolean).length < 4) {
        return { outcome: { ok: false, error: 'Could not transcribe speech.', reason: lastReason }, answered };
      }
      // A valid but empty/garbage transcription: do not burn more quota on other providers for silence.
      if (route.provider === 'gemini') return { outcome: { ok: false, error: 'Could not transcribe speech.', reason: lastReason }, answered };
    }
    const reason: FirstReason = sawRateLimit ? 'rate-limited' : answered.length ? (lastReason ?? 'empty') : anyKey ? 'error' : 'no-key';
    return { outcome: { ok: false, rateLimited: sawRateLimit, error: sawRateLimit ? 'rate-limited' : 'Could not transcribe speech.', reason }, answered };
  }

  /** Different strategy than the first pass: another provider if one is usable, else the same Groq route without prompt / language. */
  private pickRetryRoute(answered: Route[]): Route | undefined {
    const tried = new Set(answered.map(r => r.provider));
    const other = this.ordered().find(r => !tried.has(r.provider) && this.usable(r));
    if (other) return other;
    const groq = answered.find(r => r.id === 'groq');
    return groq && this.usable(groq) ? groq : undefined;
  }

  async transcribe(req: SttRequest): Promise<SttOutcome> {
    const { outcome, answered } = await this.pass(req);
    if (outcome.ok || outcome.reason !== 'empty' || outcome.rateLimited) return outcome;
    const decision = decideRetry({ reason: outcome.reason, clip: req.clip, groqRemainingFraction: this.deps.usage?.groqSttRemainingFraction?.() });
    if (!decision.retry) return outcome;
    const route = this.pickRetryRoute(answered);
    if (!route) return outcome;
    console.info(`[STT] retrying once via ${route.id} (${decision.why})`);
    // Exactly one extra request, never a loop. It is counted by the usage meter like any other request.
    const bareReq: SttRequest = { ...req, bare: true, language: undefined, hint: undefined };
    const result = await this.call(route, bareReq);
    if (result.status === 200 && result.text && isValidTranscription(result.text)) {
      return { ok: true, text: result.text, provider: route.provider, scriptWarning: hasArabicScript(result.text) ? true : undefined, retried: true };
    }
    return { ...outcome, retried: true };
  }
}

/** A short result in any script that is a wake name, stop word or known command word. */
function looksLikeCommand(text: string): boolean {
  return isShortCommandWord(text) || isStopCommand(text) || /(?:^|\s)(?:sudo|sid)(?:\s|$|[,.!?-])/i.test(aliasForMatching(text));
}
