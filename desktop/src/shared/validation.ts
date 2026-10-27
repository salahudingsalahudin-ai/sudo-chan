import type { CloudConfigInput, CloudProviderId, Settings } from './types.js';
import { isAzureVoice } from './azure-tts.ts';
import { isLocalWakeMode } from './local-wake/types.ts';
import { isLiveAwarenessSetting } from './live-awareness.ts';

export const DEFAULT_SETTINGS: Settings = {
  shortcut: 'Control+Space',
  launchAtLogin: false,
  botSize: 'medium',
  pomodoroEnabled: true,
  pomodoroMinutes: 25,
  voiceLockEnabled: false,
  registeredVoiceSample: '',
  customWakeWord: 'Sudo-chan',
  wakeWordEnabled: true,
  wakeAliases: ['Sudo', 'Sid', 'Sudo-chan', 'Suddo', 'Sit'],
  voiceVisualizerMode: 'bot',
  sttProvider: 'whisper',
  sttLanguage: 'auto',
  ttsProvider: 'auto',
  ttsQuality: 'best',
  ttsVoice: 'default',
  ttsGeminiVoice: 'Kore',
  ttsAzureVoice: 'auto',
  ttsAzureRomanUrdu: 'hi',
  ttsSpeed: 1.0,
  voiceLanguage: 'auto',
  micDeviceId: 'default',
  vadSensitivity: 'medium',
  pushToTalk: false,
  glassesEnabled: true,
  toolsEnabled: false,
  screenAssistEnabled: false,
  screenAssistCountdown: true,
  bargeInSensitivity: 0.5,
  localWake: 'off',
  localWakeSensitivity: 0.5,
  liveAwareness: 'off',
  liveKeepAnEye: false,
  updateCheckEnabled: true,
};
export const BOT_DIMENSIONS = { small: [190, 230], medium: [220, 260], large: [264, 312] } as const;
export const MAX_MESSAGE_LENGTH = 2000;
export const CLOUD_PRESETS: Record<CloudProviderId, { label: string; endpoint: string; defaultModel: string; models: string[] }> = {
  gemini: {
    label: 'Google Gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  },
  groq: {
    label: 'Groq Cloud',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.1-8b-instant',
    models: ['llama-3.1-8b-instant', 'gemma2-9b-it', 'llama-3.3-70b-versatile'],
  },
  openai: {
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  },
  openrouter: {
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    models: ['meta-llama/llama-3.3-70b-instruct:free', 'google/gemini-2.0-flash-exp:free', 'qwen/qwen-2.5-72b-instruct:free'],
  },
  custom: {
    label: 'Custom OpenAI-Compatible Endpoint',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    models: [],
  },
};
export function validSettings(value: unknown): value is Settings {
  if (typeof value !== 'object' || !value) return false;
  const s = value as Partial<Settings>;
  const base = typeof s.shortcut === 'string' && s.shortcut.length <= 80
    && /^(?:(?:CommandOrControl|Control|Ctrl|Command|Cmd|Alt|Option|Shift|Super)\+)+(?:[A-Z0-9]|Space|Enter|F(?:[1-9]|1[0-9]|2[0-4]))$/i.test(s.shortcut)
    && typeof s.launchAtLogin === 'boolean'
    && (s.botSize === 'small' || s.botSize === 'medium' || s.botSize === 'large');
  if (!base) return false;
  if (s.pomodoroEnabled !== undefined && typeof s.pomodoroEnabled !== 'boolean') return false;
  if (s.pomodoroMinutes !== undefined && (typeof s.pomodoroMinutes !== 'number' || !Number.isFinite(s.pomodoroMinutes) || s.pomodoroMinutes < 1 || s.pomodoroMinutes > 180)) return false;
  if (s.voiceLockEnabled !== undefined && typeof s.voiceLockEnabled !== 'boolean') return false;
  if (s.registeredVoiceSample !== undefined && typeof s.registeredVoiceSample !== 'string') return false;
  if (s.customWakeWord !== undefined && (typeof s.customWakeWord !== 'string' || s.customWakeWord.length > 100)) return false;
  if (s.wakeWordEnabled !== undefined && typeof s.wakeWordEnabled !== 'boolean') return false;
  if (s.wakeAliases !== undefined && (!Array.isArray(s.wakeAliases) || s.wakeAliases.length > 20 || s.wakeAliases.some(a => typeof a !== 'string' || a.length > 40))) return false;
  if (s.voiceVisualizerMode !== undefined && s.voiceVisualizerMode !== 'bot' && s.voiceVisualizerMode !== 'orb') return false;
  if (s.sttProvider !== undefined && !['auto', 'browser', 'whisper', 'gemini'].includes(s.sttProvider)) return false;
  if (s.sttSpeed !== undefined && s.sttSpeed !== 'accurate' && s.sttSpeed !== 'fast') return false;
  if (s.ttsProvider !== undefined && !['auto', 'google', 'gemini', 'azure', 'elevenlabs'].includes(s.ttsProvider)) return false;
  if (s.ttsQuality !== undefined && s.ttsQuality !== 'best' && s.ttsQuality !== 'save') return false;
  if (s.ttsVoice !== undefined && typeof s.ttsVoice !== 'string') return false;
  if (s.ttsGeminiVoice !== undefined && (typeof s.ttsGeminiVoice !== 'string' || !/^[A-Za-z]{2,30}$/.test(s.ttsGeminiVoice))) return false;
  if (s.ttsAzureVoice !== undefined && s.ttsAzureVoice !== 'auto' && !isAzureVoice(s.ttsAzureVoice)) return false;
  if (s.ttsAzureRomanUrdu !== undefined && s.ttsAzureRomanUrdu !== 'hi' && s.ttsAzureRomanUrdu !== 'ur') return false;
  if (s.ttsSpeed !== undefined && (typeof s.ttsSpeed !== 'number' || s.ttsSpeed < 0.5 || s.ttsSpeed > 2.0)) return false;
  if (s.voiceLanguage !== undefined && !['auto', 'ur-PK', 'en', 'ur'].includes(s.voiceLanguage)) return false;
  if (s.micDeviceId !== undefined && typeof s.micDeviceId !== 'string') return false;
  if (s.glassesEnabled !== undefined && typeof s.glassesEnabled !== 'boolean') return false;
  if (s.toolsEnabled !== undefined && typeof s.toolsEnabled !== 'boolean') return false;
  if (s.screenAssistEnabled !== undefined && typeof s.screenAssistEnabled !== 'boolean') return false;
  if (s.screenAssistCountdown !== undefined && typeof s.screenAssistCountdown !== 'boolean') return false;
  if (s.liveAwareness !== undefined && !isLiveAwarenessSetting(s.liveAwareness)) return false;
  if (s.liveKeepAnEye !== undefined && typeof s.liveKeepAnEye !== 'boolean') return false;
  if (s.updateCheckEnabled !== undefined && typeof s.updateCheckEnabled !== 'boolean') return false;
  if (s.bargeInSensitivity !== undefined && (typeof s.bargeInSensitivity !== 'number' || !Number.isFinite(s.bargeInSensitivity) || s.bargeInSensitivity < 0 || s.bargeInSensitivity > 1)) return false;
  if (s.localWake !== undefined && !isLocalWakeMode(s.localWake)) return false;
  if (s.localWakeSensitivity !== undefined && (typeof s.localWakeSensitivity !== 'number' || !Number.isFinite(s.localWakeSensitivity) || s.localWakeSensitivity < 0 || s.localWakeSensitivity > 1)) return false;
  return true;
}
export function validPosition(value: unknown): value is { x: number; y: number } {
  if (typeof value !== 'object' || !value) return false;
  const p = value as { x?: unknown; y?: unknown };
  return typeof p.x === 'number' && Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y);
}
export function clampPosition(position: { x: number; y: number }, area: { x: number; y: number; width: number; height: number }, width: number, height: number) {
  return {
    x: Math.round(Math.max(area.x, Math.min(position.x, area.x + Math.max(0, area.width - width)))),
    y: Math.round(Math.max(area.y, Math.min(position.y, area.y + Math.max(0, area.height - height)))),
  };
}
export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••••••';
  return '••••••••' + key.slice(-4);
}
export function validCloudConfig(value: unknown): value is CloudConfigInput {
  if (typeof value !== 'object' || !value) return false;
  const c = value as Partial<CloudConfigInput>;
  return (
    typeof c.provider === 'string' &&
    ['gemini', 'groq', 'openai', 'openrouter', 'custom'].includes(c.provider) &&
    typeof c.endpoint === 'string' &&
    (c.endpoint.startsWith('https://') || c.endpoint.startsWith('http://127.0.0.1') || c.endpoint.startsWith('http://localhost')) &&
    typeof c.model === 'string' &&
    c.model.length > 0 &&
    (c.apiKey === undefined || typeof c.apiKey === 'string')
  );
}
