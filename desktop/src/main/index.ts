import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, safeStorage, screen, session, Tray } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import Store from 'electron-store';
import { setLaunchAtLogin } from './autostart.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appendFileSync, mkdtempSync, promises as fsp } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { CHANNELS } from '../shared/types.js';
import type { AIMode, AIState, AppState, ChatState, CloudConfigInput, CloudProviderId, Settings, WindowKind } from '../shared/types.js';
import { BOT_DIMENSIONS, clampPosition, CLOUD_PRESETS, DEFAULT_SETTINGS, maskApiKey, validCloudConfig, validPosition, validSettings } from '../shared/validation.js';
import { cleanTextForSpeech, detectSentenceLanguage, emotionStyle, EMOTIONS } from '../shared/speech.js';
import type { Emotion } from '../shared/speech.js';
import { TtsRouter } from './tts-provider.js';
import { AzureTtsProvider } from './azure-provider.js';
import { validAzureKey, validAzureRegion } from '../shared/azure-tts.js';
import { displayBackend } from '../shared/display-backend.js';
import { migrateProviders, resolveProviderKey, shouldActivate, withProviderEntry } from './provider-keys.js';
import type { KeyCodec, ProviderMap } from './provider-keys.js';
import { SttRouter } from './stt.js';
import type { SpeechEvent, StopReason } from '../shared/speech-events.js';
import { installHiddenWindows, runSmoke, smokeApprovalTimeoutMs } from './smoke.js';
import { overlayShape } from '../shared/overlay-shape.js';
import { activePanelForState } from '../shared/overlay-panels.js';
import { decodeKey, encodeKey, keyStoragePlan } from './key-storage.js';
import { LocalAI, normalizeCloudModel } from './local-ai.js';
import { ChatSession } from './chat-session.js';
import { ApprovalManager } from './tools/approval.js';
import { routeApprovalClose, routeApprovalRequest, type ApprovalPort } from '../shared/approval-ui.js';
import { AuditLog, redact } from './tools/audit.js';
import * as toolPolicy from './tools/policy.js';
import { createRegistry, nodeOpenDetached, nodeRunProgram, toDefinitions } from './tools/registry.js';
import { ToolRuntime } from './tools/runtime.js';
import { createNoteSpecs, createReminderSpecs } from './tools/extra-tools.js';
import { NotesStore } from './tools/notes.js';
import { Reminders, type Reminder } from './tools/reminders.js';
import { PomodoroTimer } from './pomodoro.js';
import { SystemHealthMonitor } from './system-health.js';
import { captureScreen } from './screen-capture.ts';
import { DEFAULT_SCREEN_PROMPT, pickVisionTargets, VISION_DEFAULT_MODELS } from '../shared/screen-assist.ts';
import { ScreenFlow } from '../shared/screen-flow.ts';
import type { FlowStatus } from '../shared/screen-flow.ts';
import { checkVisibleWindows } from './screen-guard.ts';
import type { VisionProviderInfo, VisionTarget } from '../shared/screen-assist.ts';
import type { StreamOptions } from './local-ai.js';

interface StoredCloud {
  provider: CloudProviderId;
  endpoint: string;
  model: string;
  encryptedKey?: string;
  rawKey?: string;
}
/** One entry per provider in `providers`; Azure Speech is voice-only and carries a region instead of a chat endpoint. */
interface StoredProvider {
  provider: string;
  endpoint?: string;
  model?: string;
  region?: string;
  encryptedKey?: string;
  rawKey?: string;
}
interface StoreSchema {
  settings: Settings;
  mode: AIMode;
  model: string;
  position: { x: number; y: number } | null;
  cloud?: StoredCloud;
  providers?: Record<string, StoredProvider | undefined>;
  /** The user has read and accepted that screenshots are sent to their cloud AI provider. */
  screenAssistConsent?: boolean;
  /** Pending reminders (set by the assistant's set_reminder tool). */
  reminders?: Reminder[];
}

const smokeTest = process.argv.includes('--smoke-test');
if (smokeTest) app.setPath('userData', mkdtempSync(join(tmpdir(), 'sudo-chan-smoke-')));
// `npm run verify` smoke runs: windows stay invisible, no tray icon (see src/main/smoke.ts). Never active in normal runs.
const smokeHidden = smokeTest && process.env.SUDO_CHAN_SMOKE_HIDDEN === '1';
if (smokeHidden) installHiddenWindows();
app.setName('Sudo-chan');
// This SVG/CSS companion does not need GPU acceleration. Prefer software
// rendering on Linux to avoid driver crashes in transparent overlay windows.
const softwareRendering = process.argv.includes('--disable-gpu') ||
  (process.platform === 'linux' && !process.argv.includes('--hardware-acceleration'));
if (softwareRendering) app.disableHardwareAcceleration();
const wayland = process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland';
// XWayland keeps transparent overlays, global shortcuts and window positioning reliable.
const nativeWayland = displayBackend(process.platform, process.argv.slice(1)).backend === 'wayland';
if (nativeWayland) app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const directory = dirname(fileURLToPath(import.meta.url));
const rendererFile = join(directory, '../renderer/index.html');
const devUrl = !app.isPackaged && process.env.SUDO_CHAN_DEV_URL === 'http://127.0.0.1:5178' ? process.env.SUDO_CHAN_DEV_URL : undefined;
let store: Store<StoreSchema>;
const windowKinds = new WeakMap<BrowserWindow, WindowKind>();
let overlay: BrowserWindow;
let chat: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let ignoreMouse = false;
let positionTimer: ReturnType<typeof setTimeout> | undefined;
let happyTimer: ReturnType<typeof setTimeout> | undefined;
let displayTimer: ReturnType<typeof setTimeout> | undefined;
let resetInterval: ReturnType<typeof setInterval> | undefined;
let state: AppState;
let activeSpeech: { id: number; senderId: number } | null = null;
let pomodoroTimer: PomodoroTimer | undefined;
let healthMonitor: SystemHealthMonitor | undefined;
const localAI = new LocalAI();

const keyPlan = keyStoragePlan(process.platform, process.env, smokeTest);
/** Never blocks: on Linux safeStorage is not used at all (see key-storage.ts). */
function encryptApiKey(key: string): { encryptedKey?: string; rawKey?: string } {
  return encodeKey(key, keyPlan, keyPlan === 'safeStorage' ? safeStorage : null);
}

let router: TtsRouter | undefined;
const keyCodec: KeyCodec = { encrypt: encryptApiKey, decrypt: stored => decryptApiKey(stored) };
function canEncryptKeys(): boolean {
  return keyPlan === 'safeStorage';
}
/** Key for any provider, whether or not it is the active chat provider. */
function getProviderKey(id: string): string {
  return resolveProviderKey(id, store.get('cloud'), store.get('providers') as ProviderMap | undefined, keyCodec);
}
function geminiKey(): string {
  return getProviderKey('gemini');
}
let sttRouter: SttRouter | undefined;
function stt(): SttRouter {
  sttRouter ??= new SttRouter({ fetch: (url, init) => fetch(url, init as RequestInit), getKey: id => getProviderKey(id), now: () => Date.now(), getMode: () => state.settings.sttSpeed ?? 'fast' });
  return sttRouter;
}
let azureProvider: AzureTtsProvider | undefined;
function azureEntry(): StoredProvider | undefined {
  return (store.get('providers') as Record<string, StoredProvider | undefined> | undefined)?.azure;
}
/** Azure Speech (official REST API). Key and region never leave the main process. */
function azure(): AzureTtsProvider {
  azureProvider ??= new AzureTtsProvider({
    getKey: () => getProviderKey('azure'),
    getRegion: () => azureEntry()?.region ?? '',
    getVoice: () => state.settings.ttsAzureVoice,
    getRomanRoute: () => state.settings.ttsAzureRomanUrdu,
  });
  return azureProvider;
}
function ttsRouter(): TtsRouter {
  router ??= new TtsRouter({ getKey: geminiKey, getPreferred: () => state.settings.ttsProvider, azure: azure() });
  return router;
}
function decryptApiKey(stored?: { encryptedKey?: string; rawKey?: string }): string {
  return decodeKey(stored, keyPlan, keyPlan === 'safeStorage' ? safeStorage : null);
}

let aiState: AIState = {
  mode: 'local',
  model: 'qwen2.5:3b',
  models: [],
  modelSizes: {},
  connected: false,
  error: '',
  cloud: {
    provider: 'gemini',
    endpoint: CLOUD_PRESETS.gemini.endpoint,
    model: CLOUD_PRESETS.gemini.defaultModel,
    apiKeySet: false,
    maskedKey: '',
  },
};

function publishAI() {
  const snapshot = structuredClone(aiState);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.aiState, snapshot);
  }
}

function withoutAttachments(next: ChatState): ChatState {
  return { ...next, messages: next.messages.map(message => (message.attachment ? { ...message, attachment: undefined } : message)) };
}
const conversation = new ChatSession(localAI, next => {
  if (chat && !chat.isDestroyed()) chat.webContents.send(CHANNELS.chatState, next);
  // The desktop bot speaks replies and shows captions in Live Talk, so it needs chat updates too.
  // Screenshot thumbnails are for the chat window only: the overlay gets the same text without any image.
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(CHANNELS.chatState, withoutAttachments(next));
});
// ---- Tools (files, commands, links) with a click-to-approve card for every risky action ----
// The desktop bot is where the user talks, so cards go there first (and to the chat window if it is open).
function approvalPort(win: () => BrowserWindow | null | undefined): ApprovalPort | null {
  const live = win();
  if (!live || live.isDestroyed()) return null;
  return {
    visible: () => { const w = win(); return Boolean(w && !w.isDestroyed() && w.isVisible()); },
    // A freshly created window pulls pending cards itself once it has loaded.
    ready: () => { const w = win(); return Boolean(w && !w.isDestroyed() && !w.webContents.isLoading()); },
    send: event => { const w = win(); if (w && !w.isDestroyed()) w.webContents.send(CHANNELS.toolApproval, event); },
  };
}
function approvalPorts() {
  return {
    overlay: approvalPort(() => overlay),
    chat: approvalPort(() => chat),
    openChat: () => { openChat(); return approvalPort(() => chat); },
  };
}
function setApprovalVisible(visible: boolean) {
  if (Boolean(state?.approvalVisible) === visible) return;
  state.approvalVisible = visible;
  publish();
}
const toolApprovals = new ApprovalManager({
  timeoutMs: smokeTest ? smokeApprovalTimeoutMs() : undefined,
  emit: request => {
    const routed = routeApprovalRequest(request, approvalPorts());
    if (routed.overlay) setApprovalVisible(true);
    return routed.shown;
  },
  onClose: id => {
    routeApprovalClose(id, approvalPorts());
    // `finish` removes the entry before calling onClose, so 0 means this was the last open card.
    if (toolApprovals.pendingCount === 0) setApprovalVisible(false);
  },
});
// Reminders keep firing after they were set even if tools are switched off later: switching tools off stops the
// assistant from creating, listing or cancelling them, but a reminder the user asked for is never silently dropped.
let reminders: Reminders | undefined;
function reminderService(): Reminders {
  reminders ??= new Reminders({
    load: () => (store.get('reminders') as Reminder[] | undefined) ?? [],
    save: list => store.set('reminders', list),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onDue: (reminder, lateMs) => {
      const late = lateMs > 120_000;
      try { if (Notification.isSupported()) new Notification({ title: 'Sudo-chan reminder', body: reminder.text, silent: false }).show(); } catch { /* notification service may be missing */ }
      setHappy(`⏰ ${reminder.text}`, 9000);
      if (overlay && !overlay.isDestroyed()) overlay.webContents.send(CHANNELS.reminderDue, { text: reminder.text, late });
      console.info(`[Reminder] fired id=${reminder.id} late=${late}`);
    },
  });
  return reminders;
}
let toolRuntime: ToolRuntime | undefined;
function tools(): ToolRuntime {
  if (!toolRuntime) {
    const specs = [
      ...createRegistry(toolPolicy, { home: homedir(), runProgram: nodeRunProgram, openDetached: nodeOpenDetached }),
      ...createNoteSpecs(new NotesStore(join(app.getPath('userData'), 'notes'))),
      ...createReminderSpecs(reminderService()),
    ];
    const audit = new AuditLog({
      append: line => appendFileSync(join(app.getPath('userData'), 'tool-audit.jsonl'), line, { encoding: 'utf8', mode: 0o600 }),
    });
    toolRuntime = new ToolRuntime({
      specs,
      definitions: toDefinitions(specs),
      approval: toolApprovals,
      audit,
      isEnabled: () => state.settings.toolsEnabled === true,
      redact,
      onActivity: running => {
        const next = running > 0 ? 'working' : null;
        if ((state.toolStatus ?? null) !== next) { state.toolStatus = next; publish(); }
      },
    });
  }
  return toolRuntime;
}
function stopAllTools() {
  toolRuntime?.stopAll();
  toolApprovals.stopAll();
}

let connectionCheck: Promise<AIState> | undefined;
async function checkAI(): Promise<AIState> {
  if (connectionCheck) return connectionCheck;
  connectionCheck = (async () => {
    try {
      const { names, meta } = await localAI.modelsWithMeta();
      aiState.models = names;
      aiState.modelSizes = meta;
      aiState.connected = true;
      aiState.error = names.length ? '' : 'No downloaded models found. Install a local model in Ollama, then check again.';
      if (names.length && !names.includes(aiState.model)) {
        const preferred = names.find(n => /3b|2b/i.test(n)) || (names.includes('qwen2.5:3b') ? 'qwen2.5:3b' : names[0]);
        aiState.model = preferred;
        store.set('model', aiState.model);
      }
    } catch (error) {
      aiState.connected = false;
      aiState.error = error instanceof Error ? error.message : 'Could not connect to Ollama.';
    }
    publishAI();
    return structuredClone(aiState);
  })();
  try { return await connectionCheck; } finally { connectionCheck = undefined; }
}
const greetings = ["Take your time. I'm right here.", 'A little company for your next idea.', 'You create. I’ll keep you company.'];
let greetingIndex = 0;

function snapshot(): AppState {
  const current = structuredClone(state);
  if (pomodoroTimer) {
    current.pomodoro = pomodoroTimer.getTime();
  }
  if (healthMonitor) {
    const mem = healthMonitor.getMemoryInfo();
    current.systemMemory = { percent: mem.percent, isHeavy: mem.isHeavy };
  }
  return current;
}
function updateOverlayShape() {
  if (process.platform !== 'linux' || nativeWayland || !overlay || overlay.isDestroyed()) return;
  const [width, height] = overlay.getContentSize();
  overlay.setShape(overlayShape(width, height, activePanelForState(state)));
}
function parseSpeechEvent(value: unknown): SpeechEvent | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { type?: unknown; id?: unknown; level?: unknown; reason?: unknown };
  if (typeof v.id !== 'number' || !Number.isFinite(v.id)) return null;
  if (v.type === 'start') return { type: 'start', id: v.id };
  if (v.type === 'level' && typeof v.level === 'number' && Number.isFinite(v.level)) return { type: 'level', id: v.id, level: Math.max(0, Math.min(1, v.level)) };
  if (v.type === 'stop') return { type: 'stop', id: v.id, reason: typeof v.reason === 'string' ? (v.reason as StopReason) : 'finish' };
  return null;
}
function applySpeechEvent(evt: SpeechEvent) {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(CHANNELS.speechBroadcast, evt);
  if (evt.type === 'level') return;
  const speaking = evt.type === 'start';
  if (evt.type === 'stop') activeSpeech = null;
  if (Boolean(state.isSpeaking) !== speaking) { state.isSpeaking = speaking; publish(); }
}
function publish() {
  updateOverlayShape();
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(CHANNELS.state, snapshot());
  updateTray();
}
function setHappy(speech: string, milliseconds = 2000) {
  clearTimeout(happyTimer);
  state.mood = 'happy'; state.speech = speech; publish();
  happyTimer = setTimeout(() => { state.mood = 'calm'; state.speech = ''; publish(); }, milliseconds);
}
function authorize(event: IpcMainInvokeEvent | Electron.IpcMainEvent, kind?: WindowKind | WindowKind[]) {
  const frame = event.senderFrame;
  const win = BrowserWindow.fromWebContents(event.sender);
  const known = win && [overlay, chat, settingsWindow].includes(win);
  if (!known || !frame || frame !== event.sender.mainFrame) throw new Error('Untrusted IPC sender.');
  const url = new URL(frame.url);
  if (devUrl ? url.origin !== devUrl : url.protocol !== 'file:' || fileURLToPath(url).split('#')[0] !== rendererFile) throw new Error('Untrusted document.');
  if (kind) {
    const winKind = windowKinds.get(win!);
    const allowed = Array.isArray(kind) ? kind.includes(winKind!) : winKind === kind;
    if (!allowed) throw new Error('Operation unavailable in this window.');
  }
  return win;
}
function createWindow(kind: WindowKind) {
  const isOverlay = kind === 'overlay';
  const [width, height] = isOverlay ? BOT_DIMENSIONS[state.settings.botSize] : kind === 'chat' ? [460, 650] : [780, 760];
  const work = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width: Math.min(width, work.width), height: Math.min(height, work.height), minWidth: isOverlay ? undefined : Math.min(360, work.width), minHeight: isOverlay ? undefined : Math.min(450, work.height),
    title: `Sudo-chan${kind === 'settings' ? ' · Your space' : kind === 'chat' ? ' · A little closer' : ''}`,
    frame: false, transparent: isOverlay, backgroundColor: isOverlay ? '#00000000' : '#101d25',
    alwaysOnTop: isOverlay || kind === 'chat', skipTaskbar: isOverlay, resizable: !isOverlay,
    show: false, hasShadow: !isOverlay, autoHideMenuBar: true,
    webPreferences: { preload: join(directory, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false, devTools: !app.isPackaged },
  });
  windowKinds.set(win, kind);
  // Forward renderer warnings/errors and our own "[voice]" breadcrumbs to the main log (no secrets are ever logged there).
  win.webContents.on('console-message', (...args: unknown[]) => {
    const first = args[0] as { message?: string; level?: string | number } | undefined;
    const message = typeof first === 'object' && first && 'message' in first ? String(first.message) : String(args[2] ?? '');
    const level = typeof first === 'object' && first && 'level' in first ? first.level : args[1];
    const loud = level === 'warning' || level === 'error' || level === 2 || level === 3;
    if (loud || message.startsWith('[voice]')) console.info(`[renderer:${kind}] ${message.slice(0, 300)}`);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); if (isOverlay) { state.overlayVisible = false; publish(); } } });
  win.webContents.on('did-finish-load', () => {
    win.webContents.send(CHANNELS.state, snapshot());
    win.webContents.send(CHANNELS.aiState, structuredClone(aiState));
  });
  if (devUrl) void win.loadURL(`${devUrl}/#${kind}`);
  else void win.loadFile(rendererFile, { hash: kind });
  if (isOverlay) { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); win.setAlwaysOnTop(true, 'floating'); }
  return win;
}
function showOverlay() { state.overlayVisible = true; overlay.showInactive(); publish(); }
function saveOverlayPosition() {
  if (!overlay || overlay.isDestroyed() || !store) return;
  const { x, y } = overlay.getBounds();
  store.set('position', { x, y });
}
function positionOverlay(reset = false) {
  const [width, height] = BOT_DIMENSIONS[state.settings.botSize];
  const saved = reset ? null : store.get('position');
  const area = saved && validPosition(saved) ? screen.getDisplayNearestPoint(saved).workArea : screen.getPrimaryDisplay().workArea;
  const position = saved && validPosition(saved) ? saved : { x: area.x + area.width - width - 28, y: area.y + area.height - height - 24 };
  const bounds = { ...clampPosition(position, area, width, height), width, height };
  overlay.setBounds(bounds);
  updateOverlayShape();
  store.set('position', { x: bounds.x, y: bounds.y });
}
function resetOverlayPosition() {
  if (!overlay || overlay.isDestroyed()) return;
  if (resetInterval) {
    clearInterval(resetInterval);
    resetInterval = undefined;
  }
  const [width, height] = BOT_DIMENSIONS[state.settings.botSize];
  const area = screen.getPrimaryDisplay().workArea;
  const targetPos = { x: area.x + area.width - width - 28, y: area.y + area.height - height - 24 };
  const target = clampPosition(targetPos, area, width, height);
  const start = overlay.getBounds();
  const startX = start.x;
  const startY = start.y;
  const deltaX = target.x - startX;
  const deltaY = target.y - startY;
  const duration = 360;
  const startTime = Date.now();
  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

  resetInterval = setInterval(() => {
    if (!overlay || overlay.isDestroyed()) {
      if (resetInterval) clearInterval(resetInterval);
      resetInterval = undefined;
      return;
    }
    const elapsed = Date.now() - startTime;
    const t = Math.min(1, elapsed / duration);
    const progress = easeOutCubic(t);
    const curX = Math.round(startX + deltaX * progress);
    const curY = Math.round(startY + deltaY * progress);

    overlay.setBounds({ x: curX, y: curY, width, height });
    updateOverlayShape();

    if (t >= 1) {
      if (resetInterval) clearInterval(resetInterval);
      resetInterval = undefined;
      overlay.setBounds({ x: target.x, y: target.y, width, height });
      updateOverlayShape();
      store.set('position', target);
      setHappy('Right here with you!', 2500);
    }
  }, 16);
}
function openChat() {
  if (!chat || chat.isDestroyed()) {
    chat = createWindow('chat');
    // Smoke tests keep it visible for automation; ordinary use dismisses on blur.
    if (!smokeTest) chat.on('blur', () => chat?.hide());
    chat.on('hide', () => {
      if (state.voiceActiveTarget === 'chat') {
        state.voiceActiveTarget = null;
        state.voiceCallActive = false;
        publish();
      }
    });
    chat.once('ready-to-show', () => { chat?.show(); chat?.focus(); });
  } else { chat.show(); chat.focus(); }
  const area = screen.getDisplayMatching(overlay.getBounds()).workArea;
  const bounds = chat.getBounds();
  const position = clampPosition({ x: overlay.getBounds().x - bounds.width - 12, y: area.y + area.height - bounds.height - 28 }, area, bounds.width, bounds.height);
  chat.setPosition(position.x, position.y);
}
function openSettings() {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    settingsWindow = createWindow('settings');
    settingsWindow.once('ready-to-show', () => { settingsWindow?.show(); settingsWindow?.focus(); });
  } else { settingsWindow.show(); settingsWindow.focus(); }
}
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Sudo-chan · Local AI', enabled: false }, { type: 'separator' },
    { label: state.overlayVisible ? 'Hide companion' : 'Show companion', click: () => { if (state.overlayVisible) { overlay.hide(); state.overlayVisible = false; publish(); } else showOverlay(); } },
    { label: 'Microphone: listen for my name', type: 'checkbox', checked: state.settings.wakeWordEnabled ?? true, click: item => { void saveSettings({ ...state.settings, wakeWordEnabled: item.checked }); } },
    { label: 'Pause companion animation', type: 'checkbox', checked: state.paused, click: item => { state.paused = item.checked; publish(); } },
    { label: 'Open chat', click: openChat }, { label: 'Settings', click: openSettings },
    { type: 'separator' }, { label: 'Quit Sudo-chan', click: () => app.quit() },
  ]));
}
function registerShortcut(shortcut: string) {
  try { return globalShortcut.register(shortcut, openChat); } catch { return false; }
}
// ---- Screen assist: capture only on wake word / explicit button, only with setting + consent, never stored ----
// The sequence (consent once, cooldown/cache, sensitive-window guard, first-capture countdown, capture, cancel)
// lives in shared/screen-flow.ts so it can be unit-tested; this file only supplies the Electron side effects.
let screenStatusTimer: ReturnType<typeof setTimeout> | undefined;
let lastCaptureTimings: { portalMs: number; resizeMs: number } | null = null;
let consentResolver: ((granted: boolean) => void) | null = null;
let consentShownAt = 0;
function setScreenStatus(status: FlowStatus, extra?: { countdown?: number; notice?: string }) {
  clearTimeout(screenStatusTimer);
  state.screenStatus = status;
  state.screenCountdown = status === 'countdown' ? extra?.countdown : undefined;
  state.screenNotice = status === 'notice' ? extra?.notice : undefined;
  publish();
  const clearAfter = status === 'sent' ? 3500 : status === 'cached' ? 4000 : status === 'notice' ? 6000 : 0;
  if (clearAfter > 0) screenStatusTimer = setTimeout(() => { state.screenStatus = null; state.screenNotice = undefined; publish(); }, clearAfter);
}
async function consentDialog(): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Let Sudo-chan look at your screen?',
    message: 'Allow Sudo-chan to look at your screen when you ask?',
    detail: 'Only when you say her name (with "Listen for my name" on) or press the eye button, she takes ONE screenshot and sends it over the internet to your cloud AI provider (Groq or Gemini) so she can explain what you are working on. Nothing is saved, and you can turn this off in Settings at any time.',
    buttons: ['Allow', 'Not now'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}
/** Wake word: a compact panel on the overlay (Allow / Not now buttons, click only). Other sources use the native dialog. */
function askConsentOnOverlay(): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    consentResolver?.(false);
    consentShownAt = Date.now();
    const timer = setTimeout(() => { if (consentResolver === done) { consentResolver = null; resolve(false); } }, 60_000);
    const done = (granted: boolean) => { clearTimeout(timer); resolve(granted); };
    consentResolver = done;
  });
}
function answerScreenConsent(granted: boolean) {
  // Ignore clicks that arrive within 400 ms of the panel appearing (a stray double-click from the earlier action).
  if (!consentResolver || Date.now() - consentShownAt < 400) return;
  const resolver = consentResolver;
  consentResolver = null;
  resolver(granted);
}
function cancelScreenConsent() {
  const resolver = consentResolver;
  consentResolver = null;
  resolver?.(false);
}
const screenFlow = new ScreenFlow({
  now: () => Date.now(),
  sleep: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
  isEnabled: () => Boolean(state.settings.screenAssistEnabled),
  countdownEnabled: () => state.settings.screenAssistCountdown !== false,
  hasConsent: () => Boolean(store.get('screenAssistConsent')),
  saveConsent: () => { store.set('screenAssistConsent', true); },
  askConsent: source => (source === 'wake' ? askConsentOnOverlay() : consentDialog()),
  cancelConsent: cancelScreenConsent,
  setStatus: setScreenStatus,
  capture: async () => {
    // Hide our own panels so the screenshot shows the user's work. The small overlay bot stays visible (it carries the indicator).
    const hidden = [chat, settingsWindow].filter((w): w is BrowserWindow => Boolean(w && !w.isDestroyed() && w.isVisible()));
    for (const win of hidden) win.hide();
    if (hidden.length) await new Promise(resolve => setTimeout(resolve, 350));
    try {
      const shot = await captureScreen();
      lastCaptureTimings = shot.ok ? { portalMs: shot.portalMs, resizeMs: shot.resizeMs } : null;
      if (!shot.ok) console.info(`[Screen] capture failed reason=${shot.reason}`);
      return shot.ok ? { ok: true as const, shot: { dataUri: shot.dataUri, thumbnail: shot.thumbnail } } : { ok: false as const, reason: shot.reason };
    } finally {
      for (const win of hidden) if (!win.isDestroyed()) win.showInactive();
    }
  },
  checkWindows: checkVisibleWindows,
});
function visionTargets(): VisionTarget[] {
  const active = aiState.mode === 'cloud'
    ? { provider: aiState.cloud.provider, endpoint: aiState.cloud.endpoint, model: aiState.cloud.model, apiKey: getProviderKey(aiState.cloud.provider) }
    : null;
  const others: Record<string, VisionProviderInfo> = {};
  for (const id of ['groq', 'gemini'] as const) {
    const apiKey = getProviderKey(id);
    if (apiKey) others[id] = { endpoint: CLOUD_PRESETS[id].endpoint, model: VISION_DEFAULT_MODELS[id], apiKey };
  }
  return pickVisionTargets(active, others);
}
function sendChat(text: string, isVoice: boolean, vision?: StreamOptions['vision']) {
  const effectiveCloud = aiState.mode === 'cloud' ? {
    provider: aiState.cloud.provider,
    endpoint: aiState.cloud.endpoint,
    model: aiState.cloud.model,
    apiKey: decryptApiKey(store.get('cloud')),
  } : undefined;
  const result = conversation.send(text, aiState.model, {
    mode: aiState.mode,
    heavy: aiState.modelSizes[aiState.model]?.heavy,
    cloud: effectiveCloud,
    voice: isVoice,
    vision,
    tools: state.settings.toolsEnabled === true && effectiveCloud ? tools() : undefined,
  });
  if (result.ok && !state.voiceCallActive) setHappy('Thinking with you.');
  return result;
}
async function sendWithScreen(value: unknown) {
  const v = (value && typeof value === 'object' ? value : {}) as { text?: unknown; voice?: unknown; source?: unknown };
  const text = typeof v.text === 'string' ? v.text.trim() : '';
  const isVoice = typeof v.voice === 'boolean' ? v.voice : (v.source === 'wake' || Boolean(state.voiceCallActive));
  if (v.source !== 'wake' && v.source !== 'button') return { ok: false, error: 'Unknown screen request.' };
  const source = v.source;
  if (conversation.snapshot().busy) return { ok: false, error: 'Wait for this reply, or press Stop first.' };
  if (aiState.mode !== 'cloud') return { ok: false, error: 'Screen assist needs Cloud mode (Settings → AI): the image is only sent to your cloud provider.' };
  const targets = visionTargets();
  if (!targets.length) return { ok: false, error: 'Screen dekhne ke liye Groq ya Gemini ki key chahiye (Settings → AI).' };

  const result = await screenFlow.request(source);
  if (result.kind === 'cancelled') return { ok: false, error: 'Screen capture cancelled.', handled: true };
  if (result.kind === 'skipped') {
    // The reason is already on the overlay (and spoken there). A busy/cooldown repeat of the name still answers the words.
    if ((result.reason === 'busy' || result.reason === 'cooldown') && text) return sendChat(text, isVoice);
    return { ok: false, error: result.notice, handled: true };
  }
  const prompt = text || DEFAULT_SCREEN_PROMPT;
  const timingsBeforeVision = result.timings;
  const captureTimings = result.cached ? null : lastCaptureTimings;
  // One line per screen turn, no content: capture (portal) / resize / guard (parallel with capture) / vision / total.
  const logTimings = (visionMs: number) => console.info(
    `[Screen] capture=${captureTimings?.portalMs ?? 0}ms resize=${captureTimings?.resizeMs ?? 0}ms guard=${timingsBeforeVision.guardMs}ms vision=${visionMs}ms total=${timingsBeforeVision.totalMs + visionMs}ms cached=${result.cached}`,
  );
  const sent = sendChat(prompt, isVoice, { dataUri: result.shot.dataUri, thumbnail: result.shot.thumbnail, targets, fallbackText: prompt, ageSeconds: result.cached ? result.ageSeconds : 0, onTiming: logTimings });
  if (sent.ok && !result.cached) setScreenStatus('sent');
  if (sent.ok && source === 'wake' && !state.voiceCallActive) openChat();
  return sent;
}
function cancelScreenCapture(keepCache = false) {
  screenFlow.cancel(keepCache);
}
/** A normal turn that clearly refers to the screen she looked at less than two minutes ago re-uses that screenshot. */
function followUpVision(text: string, targets: VisionTarget[]): StreamOptions['vision'] | undefined {
  if (aiState.mode !== 'cloud' || !targets.length) return undefined;
  const hit = screenFlow.followUp(text);
  if (!hit) return undefined;
  return { dataUri: hit.shot.dataUri, thumbnail: undefined, targets, fallbackText: text, ageSeconds: hit.ageSeconds, onTiming: visionMs => console.info(`[Screen] follow-up on a ${hit.ageSeconds}s old screenshot vision=${visionMs}ms`) };
}
async function saveSettings(candidate: unknown) {
  if (!validSettings(candidate)) return { ok: false, error: 'Choose a valid shortcut and companion size.' };
  if (candidate.screenAssistEnabled && !state.settings.screenAssistEnabled && !store.get('screenAssistConsent')) {
    if (await consentDialog()) store.set('screenAssistConsent', true);
    else candidate.screenAssistEnabled = false;
  }
  // Turning the feature off drops the cached screenshot and any pending capture / consent prompt immediately.
  if (!candidate.screenAssistEnabled && state.settings.screenAssistEnabled) screenFlow.disable();
  if (candidate.launchAtLogin && !state.loginSupported) return { ok: false, error: 'Install the app before enabling launch at login.' };
  const previous = state.settings;
  const changed = candidate.shortcut !== previous.shortcut;
  if ((changed || !state.shortcutAvailable) && !registerShortcut(candidate.shortcut)) return { ok: false, error: 'That shortcut is already in use or unavailable. Your previous shortcut is unchanged.' };
  try {
    if (candidate.launchAtLogin !== previous.launchAtLogin) setLaunchAtLogin(candidate.launchAtLogin);
    store.set('settings', candidate);
  } catch {
    if (candidate.launchAtLogin !== previous.launchAtLogin) { try { setLaunchAtLogin(previous.launchAtLogin); } catch { /* Keep settings failure recoverable. */ } }
    if (changed || !state.shortcutAvailable) globalShortcut.unregister(candidate.shortcut);
    return { ok: false, error: 'Settings could not be saved. Please try again.' };
  }
  if (changed && state.shortcutAvailable) globalShortcut.unregister(previous.shortcut);
  state.settings = candidate; state.shortcutAvailable = true;
  // Turning tools off cancels anything waiting for approval or still running.
  if (previous.toolsEnabled === true && candidate.toolsEnabled !== true) stopAllTools();
  if (candidate.pomodoroEnabled !== undefined) {
    pomodoroTimer?.setEnabled(candidate.pomodoroEnabled);
  }
  if (typeof candidate.pomodoroMinutes === 'number') {
    pomodoroTimer?.setDuration(candidate.pomodoroMinutes * 60 * 1000);
  }
  positionOverlay(); publish();
  return { ok: true };
}
function setupIPC() {
  const handle = (channel: string, callback: (event: IpcMainInvokeEvent, value: unknown) => unknown, kind?: WindowKind | WindowKind[]) => ipcMain.handle(channel, (event, value: unknown) => { authorize(event, kind); return callback(event, value); });
  handle(CHANNELS.getState, () => snapshot());
  handle(CHANNELS.chat, () => openChat());
  handle(CHANNELS.settings, () => openSettings());
  handle(CHANNELS.hide, event => {
    const win = BrowserWindow.fromWebContents(event.sender);
    // Only panels use the dismiss action. Hiding the persistent companion is
    // an explicit tray action, even if focus returns to it during an Esc press.
    if (win && win !== overlay) win.hide();
  });
  handle(CHANNELS.welcome, () => setHappy(greetings[greetingIndex++ % greetings.length], 4000), 'overlay');
  handle(CHANNELS.pause, (_e, paused) => { if (typeof paused !== 'boolean') throw new Error('Invalid pause state.'); state.paused = paused; publish(); });
  handle(CHANNELS.save, (_e, value) => saveSettings(value), ['settings', 'chat', 'overlay']);
  handle(CHANNELS.reset, () => { resetOverlayPosition(); showOverlay(); }, 'settings');
  handle(CHANNELS.messages, () => conversation.snapshot(), 'chat');
  handle(CHANNELS.clear, event => {
    const kind = windowKinds.get(BrowserWindow.fromWebContents(event.sender)!);
    if (kind !== 'chat' && kind !== 'settings') throw new Error('Operation unavailable in this window.');
    conversation.clear();
    toolApprovals.resetChat();
  });
  handle(CHANNELS.send, (_e, value) => {
    let text = '';
    let isVoice = Boolean(state.voiceCallActive);
    if (typeof value === 'string') {
      text = value;
    } else if (value && typeof value === 'object') {
      const v = value as { text?: unknown; voice?: unknown };
      if (typeof v.text === 'string') text = v.text;
      if (typeof v.voice === 'boolean') isVoice = v.voice;
    }

    // Follow-ups like "aur is error ka fix batao" re-use the screenshot from the last two minutes (in memory only).
    return sendChat(text, isVoice, followUpVision(text, visionTargets()));
  }, ['chat', 'overlay']);
  handle(CHANNELS.sendScreen, (_e, value) => sendWithScreen(value), ['chat', 'overlay']);
  handle(CHANNELS.cancelScreen, () => cancelScreenCapture(), ['chat', 'overlay']);
  // Click-only: nothing spoken can reach this handler. It only does anything while a consent panel is pending.
  handle(CHANNELS.screenConsent, (_e, granted) => answerScreenConsent(granted === true), 'overlay');
  // Overlay may stop too (barge-in / "ruko" from the desktop bot); a stop also cancels a pending screen capture and running tools.
  handle(CHANNELS.stop, (_e, value) => { cancelScreenCapture((value as { keepScreen?: unknown } | undefined)?.keepScreen === true); conversation.stop(); stopAllTools(); }, ['chat', 'overlay']);
  handle(CHANNELS.toolApprovals, () => toolApprovals.list(), ['chat', 'overlay']);
  handle(CHANNELS.toolApprovalReply, (_e, value) => {
    const v = value as { id?: unknown; decision?: unknown } | null;
    if (!v || typeof v.id !== 'string' || (v.decision !== 'allow' && v.decision !== 'allow-chat' && v.decision !== 'deny')) return { ok: false, error: 'Invalid answer.' };
    return toolApprovals.respond(v.id, v.decision) ? { ok: true } : { ok: false, error: 'That request already ended.' };
  }, ['chat', 'overlay']);
  handle(CHANNELS.toolsStopAll, () => { cancelScreenCapture(); conversation.stop(); stopAllTools(); }, ['chat', 'overlay', 'settings']);
  handle(CHANNELS.ai, () => structuredClone(aiState));
  handle(CHANNELS.checkAI, () => checkAI());
  handle(CHANNELS.model, async (_e, value) => {
    if (conversation.snapshot().busy) return { ok: false, error: 'Stop the current reply before changing the model.' };
    if (typeof value !== 'string' || value.length > 200) return { ok: false, error: 'Invalid model name.' };
    if (aiState.mode === 'local' && aiState.models.length && !aiState.models.includes(value)) {
      return { ok: false, error: 'Check the connection and choose an installed model.' };
    }
    try {
      store.set('model', value);
      aiState.model = value;
      publishAI();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not save the model. Please try again.' };
    }
  }, ['chat', 'settings']);
  handle(CHANNELS.aiMode, async (_e, value) => {
    if (value !== 'local' && value !== 'cloud') return { ok: false, error: 'Invalid mode.' };
    try {
      store.set('mode', value);
      aiState.mode = value;
      publishAI();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not save mode. Please try again.' };
    }
  }, ['chat', 'settings']);
  handle(CHANNELS.cloudConfig, async (_e, value) => {
    router?.resetBackoff(); // a new key or plan may have quota again
    if (!validCloudConfig(value)) return { ok: false, error: 'Enter a valid provider and HTTPS endpoint.' };
    const currentSaved = store.get('cloud');
    const existingKey = getProviderKey(value.provider);
    const newKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
    const effectiveKey = newKey || existingKey;
    if (!effectiveKey) return { ok: false, error: 'Enter your API key first.' };

    const cleanModel = normalizeCloudModel(value.provider, value.model);
    try {
      await localAI.testCloud({
        provider: value.provider,
        endpoint: value.endpoint,
        model: cleanModel,
        apiKey: effectiveKey,
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not connect to Cloud API.' };
    }

    try {
      const keyStorage = encryptApiKey(effectiveKey);
      const toStore: StoredCloud = {
        provider: value.provider,
        endpoint: value.endpoint,
        model: cleanModel,
        ...keyStorage,
      };
      // Every provider keeps its own entry, so a Gemini key for voice survives while chat stays on another provider.
      store.set('providers', withProviderEntry(store.get('providers') as ProviderMap | undefined, value.provider, toStore) as Record<string, StoredProvider | undefined>);
      if (!shouldActivate(currentSaved?.provider, value.provider, (value as { makeActive?: boolean }).makeActive)) {
        publishAI();
        return { ok: true, notice: `${CLOUD_PRESETS[value.provider].label} key saved for voice (speech recognition and voice). Chat stays on ${CLOUD_PRESETS[currentSaved!.provider].label}.` };
      }
      store.set('cloud', toStore);
      aiState.cloud = {
        provider: value.provider,
        endpoint: value.endpoint,
        model: cleanModel,
        apiKeySet: true,
        maskedKey: maskApiKey(effectiveKey),
      };
      publishAI();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not save cloud configuration.' };
    }
  }, 'settings');
  handle(CHANNELS.fetchCloudModels, async (event, config: unknown) => {
    authorize(event, 'settings');
    if (!config || typeof config !== 'object') return { ok: false, error: 'Invalid configuration.' };
    const input = config as { provider?: unknown; endpoint?: unknown; apiKey?: unknown };
    const provider = (typeof input.provider === 'string' && ['gemini', 'groq', 'openai', 'openrouter', 'custom'].includes(input.provider))
      ? (input.provider as CloudProviderId)
      : 'groq';
    const endpoint = typeof input.endpoint === 'string' && input.endpoint.trim()
      ? input.endpoint.trim()
      : CLOUD_PRESETS[provider].endpoint;

    const currentSaved = store.get('cloud');
    const existingKey = getProviderKey(provider);
    const passedKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    const effectiveKey = passedKey || existingKey;

    if (!effectiveKey) {
      return { ok: false, error: 'Enter your API key first to detect models.' };
    }

    try {
      const models = await localAI.fetchCloudModels({
        provider,
        endpoint,
        apiKey: effectiveKey,
      });
      return { ok: true, models };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not fetch models.' };
    }
  }, 'settings');
  handle(CHANNELS.detectProvider, async (event, apiKey: unknown) => {
    authorize(event, 'settings');
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      return { ok: false };
    }
    try {
      const provider = await localAI.detectProvider(apiKey.trim());
      if (provider) return { ok: true, provider };
      return { ok: false };
    } catch {
      return { ok: false };
    }
  }, 'settings');
  handle(CHANNELS.testCloud, async (event, config: unknown) => {
    authorize(event, 'settings');
    if (!validCloudConfig(config)) return { ok: false, error: 'Enter a valid provider and HTTPS endpoint.' };
    const currentSaved = store.get('cloud');
    const existingKey = getProviderKey((config as { provider: CloudProviderId }).provider);
    const newKey = typeof (config as { apiKey?: string }).apiKey === 'string' ? (config as { apiKey?: string }).apiKey!.trim() : '';
    const effectiveKey = newKey || existingKey;
    if (!effectiveKey) return { ok: false, error: 'Enter your API key first.' };

    const cleanModel = normalizeCloudModel((config as { provider: CloudProviderId }).provider, (config as { model: string }).model);
    try {
      await localAI.testCloud({
        provider: (config as { provider: CloudProviderId }).provider,
        endpoint: (config as { endpoint: string }).endpoint,
        model: cleanModel,
        apiKey: effectiveKey,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not connect to Cloud API.' };
    }
  }, 'settings');
  handle(CHANNELS.testFeature, (_event, feature: unknown) => {
    if (feature === 'break') {
      setHappy('Sid, 25 minutes ho gaye! 5 minute break le lo aur paani pee lo 🍵', 6000);
      return { ok: true };
    }
    if (feature === 'heavy') {
      state.mood = 'worried';
      state.speech = 'Laptop thoda garam/heavy chal raha hai, koi heavy tab band karni hai?';
      publish();
      setTimeout(() => {
        state.mood = 'calm';
        state.speech = '';
        publish();
      }, 6000);
      return { ok: true };
    }
    return { ok: false, error: 'Unknown feature' };
  });
  handle(CHANNELS.playSpeech, async (_event, payload: unknown) => {
    let rawText = '';
    let requestedLang: 'ur' | 'en' | 'hi' | undefined;
    let emotion: Emotion = 'neutral';

    if (typeof payload === 'string') {
      rawText = payload;
    } else if (payload && typeof payload === 'object') {
      const p = payload as { text?: string; lang?: string; emotion?: string };
      rawText = p.text || '';
      if (p.lang === 'ur' || p.lang === 'en' || p.lang === 'hi') requestedLang = p.lang;
      if (typeof p.emotion === 'string' && (EMOTIONS as readonly string[]).includes(p.emotion)) emotion = p.emotion as Emotion;
    }

    const clean = cleanTextForSpeech(rawText);
    if (!clean) return { ok: false };

    const lang = requestedLang || detectSentenceLanguage(clean);
    const synthStarted = Date.now();
    // Synthesis only (all provider calls and keys stay here). Playback, stop and the output level live in the renderer's tts-player.
    const result = await ttsRouter().synthesize({
      text: clean,
      lang,
      style: emotionStyle(emotion, lang),
      voice: state.settings.ttsGeminiVoice,
      speed: state.settings.ttsSpeed,
      emotion,
    });
    console.info(`[TTS] engine=${result.provider ?? 'none'} voice=${result.voice ?? '-'} lang=${lang} chars=${clean.length} ok=${result.ok} ms=${Date.now() - synthStarted}${result.cached ? ' cached' : ''}${result.ok ? '' : ` status=${result.status ?? '-'}`}`);
    return result.ok ? { ok: true, dataUri: result.dataUri } : { ok: false };
  });
  handle(CHANNELS.azureGet, () => {
    const key = getProviderKey('azure');
    return {
      keySet: Boolean(key),
      maskedKey: maskApiKey(key),
      region: azureEntry()?.region ?? '',
      charsUsed: azure().charsUsed,
      lastError: azure().lastError,
      backoffSeconds: Math.ceil((router?.azureBackoffRemainingMs() ?? 0) / 1000),
    };
  }, 'settings');
  handle(CHANNELS.azureSave, (_e, value: unknown) => {
    if (!value || typeof value !== 'object') return { ok: false, error: 'Invalid Azure settings.' };
    const input = value as { apiKey?: unknown; region?: unknown };
    const region = typeof input.region === 'string' ? input.region.trim().toLowerCase() : '';
    if (!validAzureRegion(region)) return { ok: false, error: 'Enter the Azure region, for example eastus, uaenorth or southeastasia.' };
    const newKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (newKey && !validAzureKey(newKey)) return { ok: false, error: 'That does not look like an Azure Speech key (letters and digits only).' };
    const existing = azureEntry();
    // Stored like the other voice keys (base64). Not safeStorage: it can block on this Linux setup (see DECISIONS.md).
    const keyFields = newKey ? { rawKey: Buffer.from(newKey, 'utf-8').toString('base64') } : { encryptedKey: existing?.encryptedKey, rawKey: existing?.rawKey };
    if (!keyFields.rawKey && !keyFields.encryptedKey) return { ok: false, error: 'Enter your Azure Speech key first.' };
    store.set('providers', withProviderEntry(store.get('providers') as ProviderMap | undefined, 'azure', { provider: 'azure', region, ...keyFields }) as Record<string, StoredProvider | undefined>);
    router?.resetBackoff(); // a new key or region may work again
    azure().lastError = '';
    return { ok: true, notice: 'Azure Speech saved. Voice engine "Auto" will now use it after Gemini.' };
  }, 'settings');
  handle(CHANNELS.azureTest, async (_e, sample: unknown) => {
    const provider = azure();
    if (!provider.hasKey()) return { ok: false, error: 'Save your Azure key and region first.' };
    const roman = sample === 'roman';
    const started = Date.now();
    const result = await provider.synthesize({
      text: roman ? 'Assalam o alaikum! Main Sudo-chan hoon. Aap kaise hain?' : 'Hello! I am Sudo-chan, your desktop companion.',
      lang: roman ? 'hi' : 'en',
      emotion: 'warm',
      speed: state.settings.ttsSpeed,
    });
    console.info(`[TTS] engine=azure test voice=${result.voice ?? '-'} ok=${result.ok} ms=${Date.now() - started}${result.ok ? '' : ` status=${result.status ?? '-'}`}`);
    if (result.ok) {
      router?.resetBackoff(); // a working test lifts any earlier back-off
      return { ok: true, dataUri: result.dataUri, voice: result.voice };
    }
    const error = result.status === 401 || result.status === 403
      ? 'Azure rejected the key or region. Check both under "Keys and Endpoint" in the Azure portal.'
      : result.status === 429 ? 'Azure rate limit or quota reached. Try again later.'
      : provider.lastError || 'Azure did not return audio.';
    return { ok: false, error };
  }, 'settings');
  handle(CHANNELS.setVoiceActive, (event, payload: unknown) => {
    let active = false;
    let target: 'overlay' | 'chat' | null = null;

    if (typeof payload === 'boolean') {
      active = payload;
      const callerWin = BrowserWindow.fromWebContents(event.sender);
      const callerKind = callerWin ? windowKinds.get(callerWin) : undefined;
      target = active ? (callerKind === 'overlay' ? 'overlay' : 'chat') : null;
    } else if (payload && typeof payload === 'object') {
      const p = payload as { active?: boolean; target?: 'overlay' | 'chat' };
      active = Boolean(p.active);
      if (active) {
        if (p.target === 'overlay' || p.target === 'chat') {
          target = p.target;
        } else {
          const callerWin = BrowserWindow.fromWebContents(event.sender);
          const callerKind = callerWin ? windowKinds.get(callerWin) : undefined;
          target = callerKind === 'overlay' ? 'overlay' : 'chat';
        }
      } else {
        target = null;
      }
    }

    state.voiceCallActive = active;
    state.voiceActiveTarget = target;
    publish();
    return { ok: true, target: state.voiceActiveTarget };
  });
  // Compatibility only: speech state is owned by CHANNELS.speechEvent below.
  handle(CHANNELS.setIsSpeaking, () => ({ ok: true }));
  ipcMain.on(CHANNELS.speechEvent, (event, payload: unknown) => {
    authorize(event, ['overlay', 'chat']);
    const evt = parseSpeechEvent(payload);
    if (!evt) return;
    if (evt.type !== 'level') console.info(`[TTS] speech:${evt.type}${evt.type === 'stop' ? ` reason=${evt.reason}` : ''}`);
    const senderId = event.sender.id;
    if (evt.type === 'start') {
      activeSpeech = { id: evt.id, senderId };
      event.sender.once('destroyed', () => {
        // Window closed mid-speech: nobody else will ever send the stop.
        if (activeSpeech && activeSpeech.senderId === senderId) applySpeechEvent({ type: 'stop', id: activeSpeech.id, reason: 'window-closed' });
      });
    } else if (!activeSpeech || activeSpeech.id !== evt.id) {
      return; // stale event from a superseded utterance
    }
    applySpeechEvent(evt);
  });
  handle(CHANNELS.transcribeAudio, async (_event: IpcMainInvokeEvent, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'No audio provided' };
    const { base64Audio, mimeType, language, hint } = payload as { base64Audio?: string; mimeType?: string; language?: string; hint?: string };
    if (typeof base64Audio !== 'string' || !base64Audio) return { ok: false, error: 'No audio provided' };
    const base64 = base64Audio.includes('base64,') ? base64Audio.split('base64,')[1] : base64Audio;
    const sttHint = typeof hint === 'string' ? hint.replace(/[^\p{L}\p{N}\s,.'-]/gu, ' ').slice(0, 300).trim() : '';
    // Gemini first (best on Urdu / Roman Urdu), then Groq Whisper, then OpenAI; keys come from per-provider storage.
    const sttStarted = Date.now();
    let clipLevel = '';
    try {
      const pcm = Buffer.from(base64, 'base64');
      const samples = Math.floor((pcm.length - 44) / 2);
      let peak = 0, sum = 0;
      for (let i = 0; i < samples; i++) { const v = Math.abs(pcm.readInt16LE(44 + i * 2)) / 32768; if (v > peak) peak = v; sum += v * v; }
      clipLevel = samples > 0 ? ` sec=${(samples / 16000).toFixed(1)} peak=${peak.toFixed(2)} rms=${Math.sqrt(sum / samples).toFixed(3)}` : '';
    } catch { /* level logging is best effort */ }
    const result = await stt().transcribe({
      base64,
      mimeType: typeof mimeType === 'string' ? mimeType : 'audio/wav',
      language: typeof language === 'string' ? language : undefined,
      hint: sttHint || undefined,
    });
    console.info(`[STT] ok=${result.ok} provider=${result.provider ?? '-'} ms=${Date.now() - sttStarted} audioKB=${Math.round(base64.length * 0.75 / 1024)}${clipLevel}${result.ok ? '' : ` err=${result.error}`}`);
    if (result.ok) return { ok: true, text: result.text, scriptWarning: result.scriptWarning };
    return { ok: false, error: result.error ?? 'Could not transcribe speech.', fallbackToBrowser: true, rateLimited: Boolean(result.rateLimited) };
  });
  handle(CHANNELS.playAudio, async (_event, dataUri: unknown) => {
    if (typeof dataUri !== 'string' || !dataUri) return { ok: false, error: 'Invalid audio' };
    try {
      const base64 = dataUri.includes('base64,') ? dataUri.split('base64,')[1] : dataUri;
      const buffer = Buffer.from(base64, 'base64');
      const ext = dataUri.includes('audio/webm') ? 'webm' : dataUri.includes('audio/ogg') ? 'ogg' : 'wav';
      const tmpPath = join(tmpdir(), `sudo_preview_${Date.now()}.${ext}`);
      await (await import('node:fs/promises')).writeFile(tmpPath, buffer);
      const { exec } = await import('node:child_process');
      exec(
        `pw-play "${tmpPath}" 2>/dev/null || paplay "${tmpPath}" 2>/dev/null || aplay "${tmpPath}" 2>/dev/null`,
        { env: process.env }
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  handle(CHANNELS.quit, () => app.quit(), 'settings');
  ipcMain.on(CHANNELS.caption, (event, visible: unknown) => {
    authorize(event, 'overlay');
    const next = Boolean(visible);
    if (Boolean(state.captionVisible) !== next) { state.captionVisible = next; publish(); }
  });
  ipcMain.on(CHANNELS.interactive, (event, interactive: unknown) => {
    authorize(event, 'overlay');
    if (typeof interactive === 'boolean' && process.platform !== 'linux') {
      ignoreMouse = !interactive; overlay.setIgnoreMouseEvents(ignoreMouse, { forward: true });
    }
  });
}
async function start() {
  store = new Store<StoreSchema>({
    defaults: {
      // Smoke runs must never open the real microphone or grab the user's global shortcut.
      settings: smokeTest ? { ...DEFAULT_SETTINGS, wakeWordEnabled: false, shortcut: 'Control+Alt+Shift+F24' } : DEFAULT_SETTINGS,
      mode: 'local',
      model: 'qwen2.5:0.5b',
      position: null,
    },
  });
  // Never call safeStorage here: on this Linux setup isEncryptionAvailable() can block forever on the
  // keyring, which stopped every window from opening. Encryption happens only when the user saves a key.
  try {
    const migrated = migrateProviders(store.get('cloud'), store.get('providers') as ProviderMap | undefined, keyCodec, false);
    if (migrated) store.set('providers', migrated as Record<string, StoredProvider | undefined>);
  } catch {
    // key migration is best effort
  }
  const saved = store.get('settings');
  const savedMode = store.get('mode');
  if (savedMode === 'local' || savedMode === 'cloud') aiState.mode = savedMode;
  const model = store.get('model');
  if (typeof model === 'string' && model.length > 0 && model.length <= 200) aiState.model = model;
  const savedCloud = store.get('cloud');
  if (savedCloud && typeof savedCloud === 'object') {
    const provider = (savedCloud.provider && ['gemini', 'groq', 'openai', 'openrouter', 'custom'].includes(savedCloud.provider))
      ? savedCloud.provider
      : 'gemini';
    const endpoint = typeof savedCloud.endpoint === 'string' && savedCloud.endpoint.trim()
      ? savedCloud.endpoint.trim()
      : CLOUD_PRESETS[provider].endpoint;
    const cloudModel = typeof savedCloud.model === 'string' && savedCloud.model.trim()
      ? savedCloud.model.trim()
      : CLOUD_PRESETS[provider].defaultModel;
    const key = decryptApiKey(savedCloud);
    aiState.cloud = {
      provider,
      endpoint,
      model: cloudModel,
      apiKeySet: Boolean(key),
      maskedKey: maskApiKey(key),
    };
  }
  state = { settings: validSettings(saved) ? saved : { ...DEFAULT_SETTINGS }, paused: false, mood: 'calm', speech: '', overlayVisible: true, shortcutAvailable: false, platform: process.platform, displayBackend: process.platform === 'linux' ? nativeWayland ? 'Wayland (experimental)' : wayland ? 'XWayland compatibility' : 'X11' : process.platform, loginSupported: app.isPackaged, voiceCallActive: false, voiceActiveTarget: null };
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'media' && !smokeTest));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'media' && !smokeTest);
  setupIPC();
  overlay = createWindow('overlay'); positionOverlay();
  // Reminders start a few seconds after the windows exist, so a reminder that came due while the app was closed can still be shown and spoken.
  setTimeout(() => reminderService().start(), 4000);
  app.on('before-quit', () => reminders?.stop());
  overlay.setIgnoreMouseEvents(false);
  overlay.on('resize', updateOverlayShape);
  overlay.once('ready-to-show', showOverlay);
  // `moved` is macOS/Windows-only; `move` also fires on Linux/XWayland.
  overlay.on('move', () => {
    clearTimeout(positionTimer);
    positionTimer = setTimeout(() => { positionTimer = undefined; saveOverlayPosition(); }, 200);
  });
  // X11's native shape routes input directly; never disable the entire Linux
  // overlay while waiting for a cursor sample to make it interactive again.
  state.shortcutAvailable = registerShortcut(state.settings.shortcut);
  const icon = nativeImage.createFromPath(join(directory, '../../build/icon.png'));
  if (!smokeHidden) {
    tray = new Tray(icon.isEmpty() ? nativeImage.createFromDataURL(TRAY_ICON) : icon.resize({ width: 22, height: 22 }));
    tray.setToolTip('Sudo-chan · Local companion'); tray.on('click', openChat); updateTray();
  }
  const adjustDisplay = () => { clearTimeout(displayTimer); displayTimer = setTimeout(() => { positionOverlay(); }, 250); };
  screen.on('display-removed', adjustDisplay); screen.on('display-metrics-changed', adjustDisplay);
  app.on('activate', showOverlay);
  if (smokeTest) console.log('SUDO_CHAN_READY', JSON.stringify({ backend: state.displayBackend, shortcut: state.shortcutAvailable }));
  if (smokeTest) void runSmoke();
  void checkAI().catch(() => {});

  pomodoroTimer = new PomodoroTimer({
    onBreak: msg => setHappy(msg, 7000),
    onFocus: msg => setHappy(msg, 5000),
  });
  pomodoroTimer.start();

  healthMonitor = new SystemHealthMonitor({
    onHeavyLoad: msg => {
      state.mood = 'worried';
      state.speech = msg;
      publish();
      setTimeout(() => {
        state.mood = 'calm';
        state.speech = '';
        publish();
      }, 7000);
    },
  });
  healthMonitor.start();

  setInterval(() => {
    if (!quitting) publish();
  }, 2000);
}
// A tiny embedded PNG also keeps the tray recoverable if an install loses its icon.
const TRAY_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (overlay) { showOverlay(); openChat(); } });
  app.whenReady().then(start).catch(error => { console.error('Sudo-chan startup failed:', error); app.quit(); });
}
app.on('window-all-closed', () => { /* Keep the companion available in the tray. */ });
app.on('before-quit', () => {
  conversation.stop();
  pomodoroTimer?.stop();
  healthMonitor?.stop();
  quitting = true; globalShortcut.unregisterAll();
  if (resetInterval) clearInterval(resetInterval);
  clearTimeout(happyTimer); clearTimeout(positionTimer); clearTimeout(displayTimer);
  saveOverlayPosition();
  tray?.destroy();
});
