import type { Emotion } from './speech.ts';

/**
 * Pure helpers for the official Azure AI Speech REST API (voices, language routing, SSML).
 * No network, no Electron, so they can be unit tested and shared with the settings UI.
 */
export type AzureRomanUrduRoute = 'hi' | 'ur';
export type SpeechLang = 'ur' | 'en' | 'hi';

export interface AzureVoice { id: string; label: string; locale: string }

export const AZURE_VOICE_AUTO = 'auto';
export const AZURE_VOICES: AzureVoice[] = [
  { id: 'ur-PK-UzmaNeural', label: 'Uzma (Urdu, female)', locale: 'ur-PK' },
  { id: 'ur-PK-AsadNeural', label: 'Asad (Urdu, male)', locale: 'ur-PK' },
  { id: 'hi-IN-SwaraNeural', label: 'Swara (Hindi, female)', locale: 'hi-IN' },
  { id: 'hi-IN-MadhurNeural', label: 'Madhur (Hindi, male)', locale: 'hi-IN' },
  { id: 'en-US-AriaNeural', label: 'Aria (English, female)', locale: 'en-US' },
  { id: 'en-US-JennyNeural', label: 'Jenny (English, female)', locale: 'en-US' },
  { id: 'en-US-AvaNeural', label: 'Ava (English, female)', locale: 'en-US' },
  { id: 'en-US-AndrewNeural', label: 'Andrew (English, male)', locale: 'en-US' },
];
export const DEFAULT_AZURE_URDU_VOICE = 'ur-PK-UzmaNeural';
export const DEFAULT_AZURE_HINDI_VOICE = 'hi-IN-SwaraNeural';
export const DEFAULT_AZURE_ENGLISH_VOICE = 'en-US-AriaNeural';
export const DEFAULT_AZURE_ROMAN_ROUTE: AzureRomanUrduRoute = 'hi';
export const AZURE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

export function isAzureVoice(value: unknown): value is string {
  return typeof value === 'string' && AZURE_VOICES.some(voice => voice.id === value);
}

/** Azure region ids look like eastus, uaenorth, southeastasia, westus2, centralindia. */
export function validAzureRegion(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9]{2,29}$/.test(value);
}

/** Subscription keys are 32 or 84 characters of letters and digits; accept a sane range only. */
export function validAzureKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9]{16,100}$/.test(value);
}

export function azureEndpoint(region: string): string {
  return `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
}

function family(locale: string): 'ur' | 'hi' | 'en' {
  return locale.startsWith('en') ? 'en' : locale.startsWith('hi') ? 'hi' : 'ur';
}

/**
 * Voice for a sentence. `setting` is 'auto' or one of AZURE_VOICES. An explicit voice is used when it can
 * speak the text (an Urdu/Hindi voice for Urdu or Roman Urdu text, an English voice for English text);
 * otherwise the language default is used, so choosing "Asad" does not make English sound broken.
 * Roman Urdu (Latin script) has no native Azure voice; `romanRoute` picks Hindi (default) or Urdu voices.
 */
export function pickAzureVoice(lang: SpeechLang, setting: string | undefined, romanRoute: AzureRomanUrduRoute = DEFAULT_AZURE_ROMAN_ROUTE): string {
  const wantsEnglish = lang === 'en';
  if (setting && setting !== AZURE_VOICE_AUTO && isAzureVoice(setting)) {
    const chosenEnglish = family(setting.slice(0, 5)) === 'en';
    if (chosenEnglish === wantsEnglish) return setting;
  }
  if (lang === 'en') return DEFAULT_AZURE_ENGLISH_VOICE;
  if (lang === 'ur') return DEFAULT_AZURE_URDU_VOICE;
  return romanRoute === 'ur' ? DEFAULT_AZURE_URDU_VOICE : DEFAULT_AZURE_HINDI_VOICE;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface Prosody { rate: number; pitch: number; volume: 'default' | 'soft' | 'medium' | 'loud' }
const PROSODY: Record<Emotion, Prosody> = {
  neutral: { rate: 0, pitch: 0, volume: 'default' },
  warm: { rate: -3, pitch: 1, volume: 'default' },
  excited: { rate: 8, pitch: 5, volume: 'medium' },
  calm: { rate: -10, pitch: -2, volume: 'soft' },
  curious: { rate: 0, pitch: 4, volume: 'default' },
  soft: { rate: -8, pitch: -3, volume: 'soft' },
  happy: { rate: 4, pitch: 4, volume: 'default' },
};

/** `mstts:express-as` styles, only for voices that document them (others reject the tag). */
const EXPRESS_AS: Record<string, Partial<Record<Emotion, string>>> = {
  'en-US-AriaNeural': { warm: 'friendly', excited: 'excited', soft: 'empathetic', happy: 'cheerful', curious: 'chat', neutral: 'chat' },
  'en-US-JennyNeural': { warm: 'friendly', excited: 'excited', happy: 'cheerful', curious: 'chat', neutral: 'chat' },
};

export function expressStyle(voice: string, emotion: Emotion): string | undefined {
  return EXPRESS_AS[voice]?.[emotion];
}

export function prosodyFor(emotion: Emotion, speed?: number): { rate: string; pitch: string; volume: string } {
  const base = PROSODY[emotion] ?? PROSODY.neutral;
  const speedDelta = typeof speed === 'number' && Number.isFinite(speed) ? Math.round((speed - 1) * 100) : 0;
  const rate = Math.max(-40, Math.min(60, base.rate + speedDelta));
  const signed = (n: number) => `${n >= 0 ? '+' : ''}${n}%`;
  return { rate: signed(rate), pitch: signed(base.pitch), volume: base.volume };
}

/** Escapes the text, then adds short breaks after commas and longer ones after sentence ends. */
export function addPauses(text: string): string {
  const escaped = escapeXml(text);
  return escaped
    .replace(/([.!?۔]+)(\s+)(?=\S)/g, '$1<break time="320ms"/>$2')
    .replace(/([,،;:])(\s+)(?=\S)/g, '$1<break time="120ms"/>$2');
}

export interface AzureSsmlInput {
  text: string;
  voice: string;
  emotion?: Emotion;
  speed?: number;
  /** Set false to build the SSML without mstts:express-as (retry after an HTTP 400). */
  useStyle?: boolean;
}

export function buildAzureSsml(input: AzureSsmlInput): string {
  if (!isAzureVoice(input.voice)) throw new Error('unsupported Azure voice');
  const emotion = input.emotion ?? 'neutral';
  const locale = input.voice.slice(0, 5);
  const prosody = prosodyFor(emotion, input.speed);
  const style = input.useStyle === false ? undefined : expressStyle(input.voice, emotion);
  let body = addPauses(input.text);
  if (prosody.rate !== '+0%' || prosody.pitch !== '+0%' || prosody.volume !== 'default') {
    body = `<prosody rate="${prosody.rate}" pitch="${prosody.pitch}"${prosody.volume !== 'default' ? ` volume="${prosody.volume}"` : ''}>${body}</prosody>`;
  }
  if (style) body = `<mstts:express-as style="${style}">${body}</mstts:express-as>`;
  return `<speak version='1.0' xml:lang='${locale}' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='https://www.w3.org/2001/mstts'><voice name='${input.voice}'>${body}</voice></speak>`;
}

/** How long to leave Azure alone after a failure, from the HTTP status and an optional Retry-After header. */
export function azureBackoffMs(status: number | undefined, retryAfterHeader?: string | null): number {
  const seconds = Number(retryAfterHeader);
  const hinted = retryAfterHeader && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  if (status === 401 || status === 403) return 10 * 60_000; // bad key or region: do not hammer; saving a key resets it
  if (status === 429) return Math.min(hinted || 30_000, 60 * 60_000);
  if (status !== undefined && status >= 500) return Math.min(hinted || 30_000, 10 * 60_000);
  if (status === 400) return 60_000;
  return 20_000; // network error or timeout
}
