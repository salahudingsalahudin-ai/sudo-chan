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

export interface TtsProvider {
  id: TtsProviderId;
  name: string;
  synthesize(text: string, options?: { voice?: string; speed?: number; language?: VoiceLanguage }): Promise<{ ok: boolean; dataUri?: string; error?: string }>;
}

export interface LlmProvider {
  stream(messages: Array<{ role: string; content: string }>, onChunk: (text: string) => void, options?: { voice?: boolean }): Promise<void>;
}
