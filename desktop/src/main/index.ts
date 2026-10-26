import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, safeStorage, screen, session, Tray } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import Store from 'electron-store';
import { setLaunchAtLogin } from './autostart.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appendFileSync, mkdtempSync, promises as fsp } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { CHANNELS } from '../shared/types.js';
import type { AIMode, AIState, AppState, CloudConfigInput, CloudProviderId, Settings, WindowKind } from '../shared/types.js';
import { BOT_DIMENSIONS, clampPosition, CLOUD_PRESETS, DEFAULT_SETTINGS, maskApiKey, validCloudConfig, validPosition, validSettings } from '../shared/validation.js';
import { cleanTextForSpeech, detectSentenceLanguage, emotionStyle, EMOTIONS } from '../shared/speech.js';
import type { Emotion } from '../shared/speech.js';
import { TtsRouter } from './tts-provider.js';
import { displayBackend } from '../shared/display-backend.js';
import { migrateProviders, resolveProviderKey, shouldActivate, withProviderEntry } from './provider-keys.js';
import type { KeyCodec, ProviderMap } from './provider-keys.js';
import { SttRouter } from './stt.js';
import type { SpeechEvent, StopReason } from '../shared/speech-events.js';
import { overlayShape } from '../shared/overlay-shape.js';
import { LocalAI, normalizeCloudModel } from './local-ai.js';
import { ChatSession } from './chat-session.js';
import { ApprovalManager } from './tools/approval.js';
import { AuditLog, redact } from './tools/audit.js';
import * as toolPolicy from './tools/policy.js';
import { createRegistry, nodeOpenDetached, nodeRunProgram, toDefinitions } from './tools/registry.js';
import { ToolRuntime } from './tools/runtime.js';
import { PomodoroTimer } from './pomodoro.js';
import { SystemHealthMonitor } from './system-health.js';

interface StoredCloud {
  provider: CloudProviderId;
  endpoint: string;
  model: string;
  encryptedKey?: string;
  rawKey?: string;
}
interface StoreSchema {
  settings: Settings;
  mode: AIMode;
  model: string;
  position: { x: number; y: number } | null;
  cloud?: StoredCloud;
  providers?: Record<string, StoredCloud | undefined>;
}

const smokeTest = process.argv.includes('--smoke-test');
if (smokeTest) app.setPath('userData', mkdtempSync(join(tmpdir(), 'sudo-chan-smoke-')));
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

function encryptApiKey(key: string): { encryptedKey?: string; rawKey?: string } {
  if (!key) return {};
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const buffer = safeStorage.encryptString(key);
      return { encryptedKey: buffer.toString('base64') };
    } catch {
      // Fallback below
    }
  }
  return { rawKey: Buffer.from(key, 'utf-8').toString('base64') };
}

let router: TtsRouter | undefined;
const keyCodec: KeyCodec = { encrypt: encryptApiKey, decrypt: stored => decryptApiKey(stored as StoredCloud | undefined) };
function canEncryptKeys(): boolean {
  try { return Boolean(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
}
/** Key for any provider, whether or not it is the active chat provider. */
function getProviderKey(id: 'gemini' | 'groq' | 'openai' | 'openrouter' | 'custom'): string {
  return resolveProviderKey(id, store.get('cloud'), store.get('providers') as ProviderMap | undefined, keyCodec);
}
function geminiKey(): string {
  return getProviderKey('gemini');
}
let sttRouter: SttRouter | undefined;
function stt(): SttRouter {
  sttRouter ??= new SttRouter({ fetch: (url, init) => fetch(url, init as RequestInit), getKey: id => getProviderKey(id), now: () => Date.now() });
  return sttRouter;
}
function ttsRouter(): TtsRouter {
  router ??= new TtsRouter({ getKey: geminiKey, getPreferred: () => state.settings.ttsProvider });
  return router;
}
function decryptApiKey(stored?: StoredCloud): string {
  if (!stored) return '';
  if (stored.encryptedKey && safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64'));
    } catch {
      // Fall through to rawKey if any
    }
  }
  if (stored.rawKey) {
    try {
      return Buffer.from(stored.rawKey, 'base64').toString('utf-8');
    } catch {
      return '';
    }
  }
  return '';
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

const conversation = new ChatSession(localAI, next => {
  if (chat && !chat.isDestroyed()) chat.webContents.send(CHANNELS.chatState, next);
});
// ---- Tools (files, commands, links) with a click-to-approve card for every risky action ----
const toolApprovals = new ApprovalManager({
  emit: request => {
    openChat();
    if (!chat || chat.isDestroyed()) return false;
    // A freshly created window pulls pending cards itself once it has loaded.
    if (!chat.webContents.isLoading()) chat.webContents.send(CHANNELS.toolApproval, { type: 'request', request });
    return true;
  },
  onClose: id => { if (chat && !chat.isDestroyed()) chat.webContents.send(CHANNELS.toolApproval, { type: 'close', id }); },
});
let toolRuntime: ToolRuntime | undefined;
function tools(): ToolRuntime {
  if (!toolRuntime) {
    const specs = createRegistry(toolPolicy, { home: homedir(), runProgram: nodeRunProgram, openDetached: nodeOpenDetached });
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
  overlay.setShape(overlayShape(width, height, Boolean(state.speech)));
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
    { label: 'Pause companion animation', type: 'checkbox', checked: state.paused, click: item => { state.paused = item.checked; publish(); } },
    { label: 'Open chat', click: openChat }, { label: 'Settings', click: openSettings },
    { type: 'separator' }, { label: 'Quit Sudo-chan', click: () => app.quit() },
  ]));
}
function registerShortcut(shortcut: string) {
  try { return globalShortcut.register(shortcut, openChat); } catch { return false; }
}
async function saveSettings(candidate: unknown) {
  if (!validSettings(candidate)) return { ok: false, error: 'Choose a valid shortcut and companion size.' };
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
      tools: state.settings.toolsEnabled === true && effectiveCloud ? tools() : undefined,
    });
    if (result.ok && !state.voiceCallActive) setHappy('Thinking with you.');
    return result;
  }, ['chat', 'overlay']);
  handle(CHANNELS.stop, () => { conversation.stop(); stopAllTools(); }, 'chat');
  handle(CHANNELS.toolApprovals, () => toolApprovals.list(), 'chat');
  handle(CHANNELS.toolApprovalReply, (_e, value) => {
    const v = value as { id?: unknown; decision?: unknown } | null;
    if (!v || typeof v.id !== 'string' || (v.decision !== 'allow' && v.decision !== 'allow-chat' && v.decision !== 'deny')) return { ok: false, error: 'Invalid answer.' };
    return toolApprovals.respond(v.id, v.decision) ? { ok: true } : { ok: false, error: 'That request already ended.' };
  }, 'chat');
  handle(CHANNELS.toolsStopAll, () => { conversation.stop(); stopAllTools(); }, ['chat', 'overlay', 'settings']);
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
      store.set('providers', withProviderEntry(store.get('providers') as ProviderMap | undefined, value.provider, toStore) as Record<string, StoredCloud | undefined>);
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
    // Synthesis only (all provider calls and keys stay here). Playback, stop and the output level live in the renderer's tts-player.
    const result = await ttsRouter().synthesize({
      text: clean,
      lang,
      style: emotionStyle(emotion, lang),
      voice: state.settings.ttsGeminiVoice,
      speed: state.settings.ttsSpeed,
    });
    console.info(`[TTS] synthesize lang=${lang} chars=${clean.length} ok=${result.ok}${result.ok ? '' : ` status=${result.status ?? '-'}`}`);
    return result.ok ? { ok: true, dataUri: result.dataUri } : { ok: false };
  });
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
    const result = await stt().transcribe({
      base64,
      mimeType: typeof mimeType === 'string' ? mimeType : 'audio/wav',
      language: typeof language === 'string' ? language : undefined,
      hint: sttHint || undefined,
    });
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
      settings: DEFAULT_SETTINGS,
      mode: 'local',
      model: 'qwen2.5:0.5b',
      position: null,
    },
  });
  // Never call safeStorage here: on this Linux setup isEncryptionAvailable() can block forever on the
  // keyring, which stopped every window from opening. Encryption happens only when the user saves a key.
  try {
    const migrated = migrateProviders(store.get('cloud'), store.get('providers') as ProviderMap | undefined, keyCodec, false);
    if (migrated) store.set('providers', migrated as Record<string, StoredCloud | undefined>);
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
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'media');
  setupIPC();
  overlay = createWindow('overlay'); positionOverlay();
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
  tray = new Tray(icon.isEmpty() ? nativeImage.createFromDataURL(TRAY_ICON) : icon.resize({ width: 22, height: 22 }));
  tray.setToolTip('Sudo-chan · Local companion'); tray.on('click', openChat); updateTray();
  const adjustDisplay = () => { clearTimeout(displayTimer); displayTimer = setTimeout(() => { positionOverlay(); }, 250); };
  screen.on('display-removed', adjustDisplay); screen.on('display-metrics-changed', adjustDisplay);
  app.on('activate', showOverlay);
  if (smokeTest) console.log('SUDO_CHAN_READY', JSON.stringify({ backend: state.displayBackend, shortcut: state.shortcutAvailable }));
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
