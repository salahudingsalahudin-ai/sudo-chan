export type SttProviderId = 'auto' | 'browser' | 'whisper' | 'gemini';
export type TtsProviderId = 'google' | 'gemini' | 'azure' | 'elevenlabs';
export type VoiceLanguage = 'auto' | 'ur-PK' | 'en';

export interface SttResult {
  text: string;
  isFinal: boolean;
  confidence?: number;
  language?: string;
}

export interface SttProvider {
  id: SttProviderId;
  name: string;
  transcribe(audio: { base64Audio: string; mimeType?: string; language?: VoiceLanguage }): Promise<string>;
}

export interface TtsRequest {
  text: string;
  lang: 'ur' | 'en' | 'hi';
  /** Natural-language style instruction (from the sentence's emotion tag). */
  style?: string;
  voice?: string;
  speed?: number;
}

export interface TtsResult {
  ok: boolean;
  dataUri?: string;
  error?: string;
  status?: number;
  provider?: TtsProviderId;
  /** Gemini quota back-off hint in ms (from Retry-After / retryDelay / per-day detection). */
  retryAfterMs?: number;
  cached?: boolean;
  /** Network requests this result cost (Google chunks). */
  calls?: number;
}

export interface TtsProvider {
  id: TtsProviderId;
  name: string;
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

export interface LlmProvider {
  stream(messages: Array<{ role: string; content: string }>, onChunk: (text: string) => void, options?: { voice?: boolean }): Promise<void>;
}
