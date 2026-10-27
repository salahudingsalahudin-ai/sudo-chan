import type { SpeechEvent } from './speech-events.js';
import type { UsageSummary } from './usage.ts';
export type Mood = 'calm' | 'worried' | 'happy';
export type WindowKind = 'overlay' | 'chat' | 'settings';
export type BotSize = 'small' | 'medium' | 'large';
export type AIMode = 'local' | 'cloud';
export type CloudProviderId = 'gemini' | 'groq' | 'openai' | 'openrouter' | 'custom';
export type SttProviderId = 'auto' | 'browser' | 'whisper' | 'gemini';
export type TtsProviderId = 'auto' | 'google' | 'gemini' | 'azure' | 'elevenlabs';
/** 'best' = Gemini for every reply while free quota lasts; 'save' = only longer replies use Gemini. */
export type TtsQuality = 'best' | 'save';
export type VoiceLanguage = 'auto' | 'ur-PK' | 'en' | 'ur';
export type SttLanguage = 'auto' | 'ur' | 'en' | 'ur-PK';
export type VadSensitivity = 'low' | 'medium' | 'high';
export interface Settings {
  shortcut: string;
  launchAtLogin: boolean;
  botSize: BotSize;
  pomodoroEnabled?: boolean;
  pomodoroMinutes?: number;
  voiceLockEnabled?: boolean;
  registeredVoiceSample?: string;
  customWakeWord?: string;
  wakeWordEnabled?: boolean;
  wakeAliases?: string[];
  voiceVisualizerMode?: 'bot' | 'orb';
  sttProvider?: SttProviderId;
  sttLanguage?: SttLanguage;
  ttsProvider?: TtsProviderId;
  /** Voice policy for Gemini's small free quota: 'best' (default) or 'save'. */
  ttsQuality?: TtsQuality;
  /** Speech recognition: 'accurate' = Gemini first (better Urdu, ~2-3 s), 'fast' = Groq Whisper first (~0.5 s). */
  sttSpeed?: 'accurate' | 'fast';
  ttsVoice?: string;
  ttsGeminiVoice?: string;
  /** 'auto' (by language) or an Azure neural voice id. */
  ttsAzureVoice?: string;
  /** Voice family used for Roman Urdu (Latin script) text on Azure. */
  ttsAzureRomanUrdu?: 'hi' | 'ur';
  ttsSpeed?: number;
  voiceLanguage?: VoiceLanguage;
  micDeviceId?: string;
  vadSensitivity?: VadSensitivity;
  pushToTalk?: boolean;
  glassesEnabled?: boolean;
  /** "Let Sudo-chan use tools" (files, commands, links) with per-action approval. Off by default. */
  toolsEnabled?: boolean;
  screenAssistEnabled?: boolean;
  /** Show "Screenshot in 3..." before the first capture of a session so a sensitive window can be closed (default ON). */
  screenAssistCountdown?: boolean;
  /** 0..1, how easily the user can interrupt the bot while it speaks. */
  bargeInSensitivity?: number;
}
export interface AppState {
  settings: Settings;
  paused: boolean;
  mood: Mood;
  speech: string;
  overlayVisible: boolean;
  shortcutAvailable: boolean;
  platform: string;
  displayBackend: string;
  loginSupported: boolean;
  pomodoro?: { status: 'idle' | 'focus' | 'break'; minutesLeft: number; secondsLeft: number };
  systemMemory?: { percent: number; isHeavy: boolean };
  voiceCallActive?: boolean;
  voiceActiveTarget?: 'overlay' | 'chat' | null;
  isSpeaking?: boolean;
  /** Shown on the overlay while a screenshot is taken / just sent. */
  screenStatus?: 'consent' | 'countdown' | 'capturing' | 'sent' | 'cached' | 'notice' | null;
  /** Seconds left in the first-capture countdown (3, 2, 1) while screenStatus is 'countdown'. */
  screenCountdown?: number;
  /** Short reason shown and spoken on the overlay while screenStatus is 'notice' (consent declined, sensitive window, capture failed...). */
  screenNotice?: string;
  /** True while the desktop bot shows a Live Talk caption, so the native window shape leaves room for it. */
  captionVisible?: boolean;
  /** True while a tool approval card is shown on the desktop bot (the native window shape then leaves room for it). */
  approvalVisible?: boolean;
  /** 'working' while a tool is running, so the desktop bot can say "kaam kar rahi hoon...". */
  toolStatus?: 'working' | null;
}
export interface ModelMeta {
  sizeMB: number;
  sizeLabel: string;
  paramSize: string;
  heavy: boolean;
  warning?: string;
}
export interface CloudConfig {
  provider: CloudProviderId;
  endpoint: string;
  model: string;
  apiKeySet: boolean;
  maskedKey: string;
}
export interface CloudConfigInput {
  provider: CloudProviderId;
  endpoint: string;
  model: string;
  apiKey?: string;
  /** Make this provider the active chat provider. A Gemini key saved while another provider is active is otherwise kept for voice only. */
  makeActive?: boolean;
}
export interface ChatAttachment { kind: 'screen'; thumbnail: string }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; attachment?: ChatAttachment; spoken?: string; status?: 'streaming' | 'complete' | 'stopped' | 'error'; isVoice?: boolean; }
export interface ChatState { messages: ChatMessage[]; busy: boolean; error: string; revision: number }
export interface AIState {
  mode: AIMode;
  model: string;
  models: string[];
  modelSizes: Record<string, ModelMeta>;
  connected: boolean;
  error: string;
  cloud: CloudConfig;
}
export interface ActionResult { ok: boolean; error?: string; notice?: string; /** The reason was already shown/spoken on the overlay; do not send the words as a plain chat message. */ handled?: boolean }
/** How API keys are stored on this platform. Produced by `describeKeyStorage()` in the main process (the single source of the wording). */
export interface KeyStorageInfo { encrypted: boolean; hint: string; detail: string; fact: string }
export interface AzureStatus { keySet: boolean; maskedKey: string; region: string; charsUsed: number; lastError: string; backoffSeconds: number }
export type ToolRisk = 'read' | 'write' | 'command' | 'open';
/** An action Sudo-chan wants to take that needs the user's click. */
export interface ToolApprovalRequest {
  id: string;
  tool: string;
  risk: ToolRisk;
  title: string;
  detail: string;
  /** Red warning (sudo, outside the home folder, ...). */
  elevated?: boolean;
  /** Offer "Allow for this chat" (only for open_url). */
  allowForChat?: boolean;
  expiresInMs: number;
}
export type ToolApprovalEvent = { type: 'request'; request: ToolApprovalRequest } | { type: 'close'; id: string };
/** Who asked to change the mic switch (logged only; never grants anything). */
export type MicSource = 'dot' | 'tray' | 'settings' | 'chat';

export interface DesktopAPI {
  getState(): Promise<AppState>;
  onState(callback: (state: AppState) => void): () => void;
  openChat(): Promise<void>;
  openSettings(): Promise<void>;
  hideWindow(): Promise<void>;
  welcome(): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  /** Pass only the fields that changed; main merges them onto its current settings. `source` is for the [mic] log line. */
  saveSettings(settings: Partial<Settings>, source?: MicSource): Promise<ActionResult>;
  resetPosition(): Promise<void>;
  setInteractive(interactive: boolean): void;
  setCaptionVisible(visible: boolean): void;
  onReminder(callback: (reminder: { text: string; late: boolean }) => void): () => void;
  sendMessage(text: string, voice?: boolean): Promise<ActionResult>;
  getMessages(): Promise<ChatState>;
  onChat(callback: (state: ChatState) => void): () => void;
  /** `keepScreen`: a barge-in keeps the cached screenshot; a real Stop / "ruko" drops it. */
  stopReply(options?: { keepScreen?: boolean }): Promise<void>;
  getAI(): Promise<AIState>;
  onAI(callback: (state: AIState) => void): () => void;
  checkAI(): Promise<AIState>;
  selectModel(model: string): Promise<ActionResult>;
  setAIMode(mode: AIMode): Promise<ActionResult>;
  saveCloudConfig(config: CloudConfigInput): Promise<ActionResult>;
  fetchCloudModels(config: { provider: CloudProviderId; endpoint: string; apiKey?: string }): Promise<{ ok: boolean; models?: string[]; error?: string }>;
  detectProvider(apiKey: string): Promise<{ ok: boolean; provider?: CloudProviderId }>;
  testCloud(config: CloudConfigInput): Promise<ActionResult>;
  testFeature(feature: 'break' | 'heavy'): Promise<ActionResult>;
  playSpeech(payload: string | { text: string; lang?: string; emotion?: string }): Promise<{ ok: boolean; dataUri?: string }>;
  setVoiceActive(active: boolean, target?: 'overlay' | 'chat'): Promise<ActionResult>;
  setIsSpeaking(speaking: boolean): Promise<ActionResult>;
  emitSpeechEvent(event: SpeechEvent): void;
  onSpeechEvent(callback: (event: SpeechEvent) => void): () => void;
  transcribeAudio(base64Audio: string, mimeType?: string, language?: string, hint?: string): Promise<{ ok: boolean; text?: string; error?: string; fallbackToBrowser?: boolean; rateLimited?: boolean; scriptWarning?: boolean }>;
  playAudio(dataUri: string): Promise<{ ok: boolean; error?: string }>;
  /** Free-quota meter for Settings and Chat. Counters and reset times only, never keys. */
  getUsage(): Promise<UsageSummary>;
  /** Plain-words description of how keys are stored on this platform (Settings window only). */
  getKeyStorageInfo(): Promise<KeyStorageInfo>;
  /** Deletes every saved provider key from disk and memory (Settings window only; the UI asks for confirmation first). */
  clearSavedKeys(): Promise<ActionResult & { removed?: number }>;
  getAzure(): Promise<AzureStatus>;
  saveAzure(config: { apiKey?: string; region: string }): Promise<ActionResult>;
  testAzure(sample: 'en' | 'roman'): Promise<{ ok: boolean; error?: string; dataUri?: string; voice?: string }>;
  sendScreen(payload: { text?: string; voice?: boolean; source: 'wake' | 'button' }): Promise<ActionResult>;
  cancelScreen(): Promise<void>;
  /** Overlay Allow / Not now buttons. Only a click can call this: there is no voice path to consent. */
  screenConsent(granted: boolean): Promise<void>;
  clearMessages(): Promise<void>;
  quit(): Promise<void>;
  onToolApproval(callback: (event: ToolApprovalEvent) => void): () => void;
  getToolApprovals(): Promise<ToolApprovalRequest[]>;
  respondToolApproval(id: string, decision: 'allow' | 'allow-chat' | 'deny'): Promise<ActionResult>;
  stopAllTools(): Promise<void>;
}
export const CHANNELS = {
  state: 'companion:state', getState: 'companion:get-state',
  chat: 'companion:open-chat', settings: 'companion:open-settings',
  hide: 'companion:hide', welcome: 'companion:welcome', pause: 'companion:pause',
  save: 'companion:save', reset: 'companion:reset', interactive: 'companion:interactive',
  send: 'companion:send', messages: 'companion:messages', clear: 'companion:clear', quit: 'companion:quit',
  chatState: 'companion:chat-state', stop: 'companion:stop',
  ai: 'companion:ai', aiState: 'companion:ai-state', checkAI: 'companion:check-ai',
  model: 'companion:model', aiMode: 'companion:ai-mode', cloudConfig: 'companion:cloud-config',
  fetchCloudModels: 'companion:fetch-cloud-models',
  detectProvider: 'companion:detect-provider',
  testCloud: 'companion:test-cloud',
  testFeature: 'companion:test-feature',
  playSpeech: 'companion:play-speech',
  setVoiceActive: 'companion:set-voice-active',
  setIsSpeaking: 'companion:set-is-speaking',
  transcribeAudio: 'companion:transcribe-audio',
  playAudio: 'companion:play-audio',
  speechEvent: 'companion:speech-event',
  speechBroadcast: 'companion:speech-broadcast',
  caption: 'companion:caption',
  reminderDue: 'companion:reminder-due',
  usage: 'companion:usage',
  keyStorageInfo: 'companion:key-storage-info',
  clearKeys: 'companion:clear-keys',
  azureGet: 'companion:azure-get',
  azureSave: 'companion:azure-save',
  azureTest: 'companion:azure-test',
  toolApproval: 'companion:tool-approval',
  toolApprovals: 'companion:tool-approvals',
  toolApprovalReply: 'companion:tool-approval-reply',
  toolsStopAll: 'companion:tools-stop-all',
  sendScreen: 'companion:send-screen',
  cancelScreen: 'companion:cancel-screen',
  screenConsent: 'companion:screen-consent',
} as const;
