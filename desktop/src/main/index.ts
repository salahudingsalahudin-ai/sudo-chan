import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, safeStorage, screen, session, Tray } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import Store from 'electron-store';
import { setLaunchAtLogin } from './autostart.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appendFileSync, existsSync, mkdtempSync, promises as fsp } from 'node:fs';
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
import { migrateProviders, resolveProviderKey, shouldActivate, stripAllKeys, withProviderEntry } from './provider-keys.js';
import type { KeyCodec, ProviderMap } from './provider-keys.js';
import { SttRouter } from './stt.js';
import { wavClipStats } from '../shared/clip-stats.js';
import { BOT_ECHO_GUARD_MS } from '../shared/stt-retry.js';
import type { ClipInfo } from '../shared/stt-retry.js';
import type { SpeechEvent, StopReason } from '../shared/speech-events.js';
import { installHiddenWindows, runSmoke, smokeApprovalTimeoutMs } from './smoke.js';
import { overlayShape } from '../shared/overlay-shape.js';
import { mergeSettings, micChangeLine, parseSaveRequest, resolveMicSource } from '../shared/mic-control.js';
import { activePanelForState } from '../shared/overlay-panels.js';
import { decodeKey, describeKeyStorage, encodeKey, keyStoragePlan } from './key-storage.js';
import { hardenKeyFiles } from './key-files.js';
import { LocalAI, normalizeCloudModel } from './local-ai.js';
import { UsageTracker } from '../shared/usage.js';
import { UsageFile } from './usage-store.js';
import { LocalWakeFile } from './local-wake-store.ts';
import { ChatSession } from './chat-session.js';
import { ApprovalManager } from './tools/approval.js';
import { routeApprovalClose, routeApprovalRequest, type ApprovalPort } from '../shared/approval-ui.js';
import { AuditLog, redact } from './tools/audit.js';
import * as toolPolicy from './tools/policy.js';
import { createRegistry, nodeOpenDetached, nodeRunProgram, toDefinitions } from './tools/registry.js';
import { ToolRuntime } from './tools/runtime.js';
import { createNoteSpecs, createReminderSpecs, createTaskSpecs } from './tools/extra-tools.js';
import { TaskFile, TaskService } from './tasks-store.js';
import type { TasksView } from '../shared/tasks.js';
import { NotesStore } from './tools/notes.js';
import { Reminders, type Reminder } from './tools/reminders.js';
import { PomodoroTimer } from './pomodoro.js';
import { SystemHealthMonitor } from './system-health.js';
import { captureScreen } from './screen-capture.ts';
import { DEFAULT_SCREEN_PROMPT, pickVisionTargets, VISION_DEFAULT_MODELS } from '../shared/screen-assist.ts';
import { ScreenFlow } from '../shared/screen-flow.ts';
import { checkForUpdate, toNotice, type UpdateInfo, type UpdateState } from '../shared/update-check.ts';
import type { FlowStatus } from '../shared/screen-flow.ts';
import { checkVisibleWindows, listWindows } from './screen-guard.ts';
import { AWARENESS_IDLE_MS, AWARENESS_POLL_MS, awarenessChangeAllowed, LiveAwareness } from '../shared/live-awareness.ts';
import { isLiveStopReason, liveStartLine, liveStopLine } from '../shared/live-talk.ts';
import { shouldShowOnboarding } from '../shared/onboarding.ts';
import type { LiveStopReason } from '../shared/live-talk.ts';
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
  /** The one-time "may she know my window name?" question was answered or dismissed with Not now (click-only). Asked once, then only Settings changes it. */
  liveAwarenessAsked?: boolean;
  /** When the update check last ran and what it found (a version number and a github.com link; no keys, no identifiers). */
  updates?: UpdateState;
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
/** When the bot's speech last started or stopped (ms); the STT retry never fires while the mic can still hear the bot. */
let lastSpeechEventAt = 0;
let pomodoroTimer: PomodoroTimer | undefined;
let healthMonitor: SystemHealthMonitor | undefined;
const localAI = new LocalAI();
/** Free-quota meter: counters in userData/usage.json (no keys). Created on first use so smoke runs use their own userData. */
let usageMeter: UsageTracker | undefined;
let usageFile: UsageFile | undefined;
function usage(): UsageTracker {
  if (!usageMeter) {
    usageFile = new UsageFile(join(app.getPath('userData'), 'usage.json'));
    const file = usageFile;
    const tracker: UsageTracker = new UsageTracker({ initial: file.read(), onChange: () => file.schedule(() => tracker.serialize()) });
    usageMeter = tracker;
  }
  return usageMeter;
}
/** On-device wake profile (userData/local-wake.json, feature vectors only). Created on first use so smoke runs use their own userData. */
let localWakeFile: LocalWakeFile | undefined;
function localWake(): LocalWakeFile {
  localWakeFile ??= new LocalWakeFile(join(app.getPath('userData'), 'local-wake.json'));
  return localWakeFile;
}
/** Update CHECK only (see shared/update-check.ts): the fetch happens here in the main process, the pages never get network access. */
let lastUpdateInfo: UpdateInfo | undefined;
let updateTimer: ReturnType<typeof setInterval> | undefined;
async function runUpdateCheck(): Promise<void> {
  try {
    lastUpdateInfo = await checkForUpdate({
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
      currentVersion: () => app.getVersion(),
      isEnabled: () => state.settings.updateCheckEnabled !== false,
      readState: () => store.get('updates'),
      writeState: next => store.set('updates', next),
    });
  } catch {
    // Best effort: a failed check must never disturb the app.
  }
}
function startUpdateChecks(): void {
  // Never in smoke runs (they must not touch the network). The first check waits a little so startup stays quiet.
  if (smokeTest) return;
  setTimeout(() => void runUpdateCheck(), 20_000);
  // The checker itself allows a real request at most once per 24 h (and one retry per hour after a failure).
  updateTimer = setInterval(() => void runUpdateCheck(), 60 * 60 * 1000);
}
localAI.usage = {
  groqChat: (headers, ok) => usage().groqChat(headers, ok),
  groqChatTokens: tokens => usage().groqChatTokens(tokens),
};

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
  sttRouter ??= new SttRouter({ fetch: (url, init) => fetch(url, init as RequestInit), getKey: id => getProviderKey(id), now: () => Date.now(), getMode: () => state.settings.sttSpeed ?? 'fast', usage: usage() });
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
    onChars: chars => usage().azureChars(chars),
  });
  return azureProvider;
}
function ttsRouter(): TtsRouter {
  router ??= new TtsRouter({ getKey: geminiKey, getPreferred: () => state.settings.ttsProvider, getQuality: () => state.settings.ttsQuality, azure: azure(), usage: usage() });
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
// "Aaj ka kaam": tasks.json in userData. The assistant's task tools and the chat window's panel share this one service.
// Like reminders, the file works with tools OFF (the panel is manual); only the assistant's tools need the switch.
let lastTurnVoice = false;
let taskService: TaskService | undefined;
function tasksService(): TaskService {
  taskService ??= new TaskService({
    storage: new TaskFile(join(app.getPath('userData'), 'tasks.json')),
    now: () => Date.now(),
    // The new list goes to the chat window ONLY: the overlay never receives task titles.
    onChange: view => { if (chat && !chat.isDestroyed()) chat.webContents.send(CHANNELS.tasksState, view); },
  });
  return taskService;
}
let toolRuntime: ToolRuntime | undefined;
function tools(): ToolRuntime {
  if (!toolRuntime) {
    const specs = [
      ...createRegistry(toolPolicy, { home: homedir(), runProgram: nodeRunProgram, openDetached: nodeOpenDetached }),
      ...createNoteSpecs(new NotesStore(join(app.getPath('userData'), 'notes'))),
      ...createReminderSpecs(reminderService(), () => Date.now(), tasksService()),
      ...createTaskSpecs(tasksService(), reminderService(), () => (lastTurnVoice ? 'voice' : 'chat')),
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
  lastSpeechEventAt = Date.now();
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
/**
 * For one-way messages (ipcMain.on): there is no caller to reject to, so a throw becomes an uncaught exception in the main
 * process and Electron shows an error dialog. A window that is closing (pagehide -> speech stop) is no longer "known" at that
 * moment, so unauthorised or late messages are dropped quietly instead.
 */
function authorizeOrDrop(event: Electron.IpcMainEvent, kind?: WindowKind | WindowKind[]): boolean {
  try {
    authorize(event, kind);
    return true;
  } catch {
    return false;
  }
}
function createWindow(kind: WindowKind) {
  const isOverlay = kind === 'overlay';
  const [width, height] = isOverlay ? BOT_DIMENSIONS[state.settings.botSize] : kind === 'chat' ? [460, 650] : state.setupActive ? SETUP_WINDOW_SIZE : [780, 760];
  const work = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width: Math.min(width, work.width), height: Math.min(height, work.height), minWidth: isOverlay ? undefined : Math.min(kind === 'settings' && state.setupActive ? SETUP_MIN_SIZE[0] : 360, work.width), minHeight: isOverlay ? undefined : Math.min(kind === 'settings' && state.setupActive ? SETUP_MIN_SIZE[1] : 450, work.height),
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
  if (isOverlay) win.on('hide', () => { if (state.voiceActiveTarget === 'overlay') setLiveTarget(null, 'window'); });
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
    // Clicking elsewhere dismisses the chat, except while Live Talk is on in it (she is being talked to and the user may be working).
    if (!smokeTest) chat.on('blur', () => { if (state.voiceActiveTarget !== 'chat') chat?.hide(); });
    // Live Talk "here" ends when the chat window is closed or hidden (but not by the temporary hide of a screenshot).
    chat.on('hide', () => { if (!captureHidden.has(chat!) && state.voiceActiveTarget === 'chat') setLiveTarget(null, 'window'); });
    chat.once('ready-to-show', () => { chat?.show(); chat?.focus(); });
  } else { chat.show(); chat.focus(); }
  const area = screen.getDisplayMatching(overlay.getBounds()).workArea;
  const bounds = chat.getBounds();
  const position = clampPosition({ x: overlay.getBounds().x - bounds.width - 12, y: area.y + area.height - bounds.height - 28 }, area, bounds.width, bounds.height);
  chat.setPosition(position.x, position.y);
}
// ---- First-run setup wizard: a MODE of the Settings window (no new window kind). Pure rules: shared/onboarding.ts ----
const SETUP_WINDOW_SIZE = [600, 720] as const;
const SETUP_MIN_SIZE = [480, 560] as const;
let setupLiveStarted = false;
function applySettingsWindowSize() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  const work = screen.getPrimaryDisplay().workArea;
  const [width, height] = state.setupActive ? SETUP_WINDOW_SIZE : [780, 760];
  const [minWidth, minHeight] = state.setupActive ? SETUP_MIN_SIZE : [360, 450];
  settingsWindow.setMinimumSize(Math.min(minWidth, work.width), Math.min(minHeight, work.height));
  settingsWindow.setSize(Math.min(width, work.width), Math.min(height, work.height));
  settingsWindow.center();
}
function endSetupLive() {
  if (!setupLiveStarted) return;
  setupLiveStarted = false;
  if (state.voiceActiveTarget === 'overlay') setLiveTarget(null, 'click');
}
function setSetupMode(active: boolean) {
  if (Boolean(state.setupActive) === active) return;
  state.setupActive = active;
  if (!active) endSetupLive();
  applySettingsWindowSize();
  publish();
}
/** Closing the wizard window (Esc, the close button, the tray) counts as "skip setup": it is recorded once and never comes back by itself. */
function dismissSetup() {
  if (!state.setupActive) return;
  setSetupMode(false);
  void saveSettings({ onboardingDone: true }, 'settings');
}
function openSettings() {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    settingsWindow = createWindow('settings');
    const created = settingsWindow;
    created.once('ready-to-show', () => { if (state.setupActive) created.center(); created.show(); created.focus(); });
    created.on('hide', () => { if (!quitting && !captureHidden.has(created)) dismissSetup(); });
  } else { settingsWindow.show(); settingsWindow.focus(); }
}
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Sudo-chan · Local AI', enabled: false }, { type: 'separator' },
    { label: state.overlayVisible ? 'Hide companion' : 'Show companion', click: () => { if (state.overlayVisible) { overlay.hide(); state.overlayVisible = false; publish(); } else showOverlay(); } },
    { label: 'Microphone: listen for my name', type: 'checkbox', checked: state.settings.wakeWordEnabled ?? true, click: item => { void saveSettings({ wakeWordEnabled: item.checked }, 'tray'); } },
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
  toolsEnabled: () => state.settings.toolsEnabled === true,
  countdownEnabled: () => state.settings.screenAssistCountdown !== false,
  hasConsent: () => Boolean(store.get('screenAssistConsent')),
  saveConsent: () => { store.set('screenAssistConsent', true); },
  askConsent: source => (source === 'wake' ? askConsentOnOverlay() : consentDialog()),
  cancelConsent: cancelScreenConsent,
  setStatus: setScreenStatus,
  capture: async () => {
    // Hide our own panels so the screenshot shows the user's work. The small overlay bot stays visible (it carries the indicator).
    const hidden = [chat, settingsWindow].filter((w): w is BrowserWindow => Boolean(w && !w.isDestroyed() && w.isVisible()));
    // Their 'hide' event must not end Live Talk: this hide lasts a moment.
    for (const win of hidden) captureHidden.add(win);
    for (const win of hidden) win.hide();
    if (hidden.length) await new Promise(resolve => setTimeout(resolve, 350));
    try {
      const shot = await captureScreen();
      lastCaptureTimings = shot.ok ? { portalMs: shot.portalMs, resizeMs: shot.resizeMs } : null;
      if (!shot.ok) console.info(`[Screen] capture failed reason=${shot.reason}`);
      return shot.ok ? { ok: true as const, shot: { dataUri: shot.dataUri, thumbnail: shot.thumbnail } } : { ok: false as const, reason: shot.reason };
    } finally {
      for (const win of hidden) if (!win.isDestroyed()) win.showInactive();
      setTimeout(() => { for (const win of hidden) captureHidden.delete(win); }, 600);
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
  lastTurnVoice = isVoice;
  const effectiveCloud = aiState.mode === 'cloud' ? {
    provider: aiState.cloud.provider,
    endpoint: aiState.cloud.endpoint,
    model: aiState.cloud.model,
    apiKey: decryptApiKey(store.get('cloud')),
  } : undefined;
  // Live Talk awareness: the current window-name line (or null) goes into this turn's system prompt only. Never waits, never stored.
  const live = state.voiceActiveTarget !== null;
  if (live) { lastLiveTurnAt = Date.now(); void awareness.refresh(); }
  const result = conversation.send(text, aiState.model, {
    mode: aiState.mode,
    awareness: live && effectiveCloud ? awareness.current() : null,
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
// ---- Live Talk: one target at a time, one instant stop (see desktop/LIVE-TALK-FLOW.md) ----
/** Windows hidden for a moment by a screenshot: their 'hide' event must not end Live Talk. */
const captureHidden = new WeakSet<BrowserWindow>();
/** Layer 1 awareness: the focused window's name and title, in memory only, only while Live Talk is on and the user said yes. */
const awareness = new LiveAwareness({ now: () => Date.now(), listWindows: () => listWindows(), log: line => console.info(line) });
let awarenessTimer: ReturnType<typeof setInterval> | undefined;
let awarenessPromptTimer: ReturnType<typeof setTimeout> | undefined;
let awarenessPromptShownAt = 0;
let lastLiveTurnAt = 0;
function awarenessUsable(): boolean {
  return state.voiceActiveTarget !== null && state.settings.liveAwareness === 'window' && aiState.mode === 'cloud';
}
/** Switch awareness on or off (and its slow poll) after Live Talk starts or stops, or the setting / AI mode changes. */
function syncAwareness() {
  const usable = awarenessUsable();
  awareness.setEnabled(usable);
  if (usable && !awarenessTimer) {
    awarenessTimer = setInterval(() => { if (Date.now() - lastLiveTurnAt <= AWARENESS_IDLE_MS) void awareness.refresh(); }, AWARENESS_POLL_MS);
    void awareness.refresh();
  } else if (!usable && awarenessTimer) { clearInterval(awarenessTimer); awarenessTimer = undefined; }
}
function clearAwarenessPrompt() {
  clearTimeout(awarenessPromptTimer);
  awarenessPromptTimer = undefined;
  if (state.awarenessPrompt) state.awarenessPrompt = false;
}
/** The question is asked once, on the desktop bot, and never blocks Live Talk. Timing out does not count as an answer. */
function maybeAskAwareness() {
  if (state.voiceActiveTarget !== 'overlay' || state.settings.liveAwareness === 'window' || store.get('liveAwarenessAsked')) return;
  state.awarenessPrompt = true;
  awarenessPromptShownAt = Date.now();
  clearTimeout(awarenessPromptTimer);
  awarenessPromptTimer = setTimeout(() => { if (state.awarenessPrompt) { state.awarenessPrompt = false; publish(); } }, 25_000);
}
/**
 * The ONLY place Live Talk starts, ends or switches in the main process. Ending (or switching away) aborts the cloud reply, tools and
 * screenshot flow, so nothing is spoken afterwards, and writes one count-only line. The renderers cut their own audio and mic
 * immediately (shared/live-talk.ts runLiveStop); this makes it true for every other path (other window, window close, quit).
 */
function setLiveTarget(target: 'overlay' | 'chat' | null, reason: LiveStopReason = 'click') {
  const previous = state.voiceActiveTarget ?? null;
  if (previous === target) return;
  if (previous) {
    console.info(liveStopLine(target ? 'switch' : reason));
    cancelScreenCapture();
    conversation.stop();
    stopAllTools();
    awareness.end();
    clearAwarenessPrompt();
  }
  state.voiceActiveTarget = target;
  state.voiceCallActive = target !== null;
  if (target) {
    console.info(liveStartLine(target));
    lastLiveTurnAt = Date.now();
    awareness.begin(awarenessUsable());
    maybeAskAwareness();
  }
  syncAwareness();
  publish();
}
/** `patch` holds only the fields the caller changed; everything else comes from the CURRENT settings, so a stale form can never flip the mic. */
async function saveSettings(patch: unknown, source: string = 'unknown') {
  const candidate: unknown = typeof patch === 'object' && patch !== null && !Array.isArray(patch) ? mergeSettings(state.settings, patch as Record<string, unknown>) : patch;
  if (!validSettings(candidate)) return { ok: false, error: 'Choose a valid shortcut and companion size.' };
  // Window-name awareness can only be switched ON by a click in Settings (or the overlay question): no other window can do it.
  if (!awarenessChangeAllowed(state.settings.liveAwareness, candidate.liveAwareness, source)) candidate.liveAwareness = state.settings.liveAwareness ?? 'off';
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
  const micLine = micChangeLine(previous.wakeWordEnabled, candidate.wakeWordEnabled, source);
  if (micLine) console.info(micLine);
  // Turning tools off cancels anything waiting for approval or still running.
  if (previous.toolsEnabled === true && candidate.toolsEnabled !== true) stopAllTools();
  if (candidate.pomodoroEnabled !== undefined) {
    pomodoroTimer?.setEnabled(candidate.pomodoroEnabled);
  }
  if (typeof candidate.pomodoroMinutes === 'number') {
    pomodoroTimer?.setDuration(candidate.pomodoroMinutes * 60 * 1000);
  }
  syncAwareness();
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
  handle(CHANNELS.save, (event, value) => {
    const request = parseSaveRequest(value);
    if (!request) return { ok: false, error: 'Choose a valid shortcut and companion size.' };
    return saveSettings(request.patch, resolveMicSource(request.source, windowKinds.get(BrowserWindow.fromWebContents(event.sender)!)));
  }, ['settings', 'chat', 'overlay']);
  handle(CHANNELS.reset, () => { resetOverlayPosition(); showOverlay(); }, 'settings');
  handle(CHANNELS.messages, () => conversation.snapshot(), 'chat');
  // "Aaj ka kaam" panel: chat window only (the overlay/voice side has no way to reach tasks.json; the assistant uses the tools).
  handle(CHANNELS.tasksList, () => tasksService().view(), 'chat');
  handle(CHANNELS.tasksAdd, (_e, value) => tasksService().addFromText(value), 'chat');
  handle(CHANNELS.tasksAct, (_e, value) => {
    const done = tasksService().panelAction(value);
    // Finishing or removing a task also cancels the reminder that was set for it.
    const id = (value as { id?: unknown } | null)?.id;
    if (done.ok && done.reminderId && typeof id === 'string') reminderService().cancelForTask(id);
    return { ok: done.ok, error: done.error, view: done.view };
  }, 'chat');
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
  // The calm "newer version" line in Settings. Only a version number crosses to the page; no URL, no network from the renderer.
  handle(CHANNELS.updateNotice, () => toNotice(lastUpdateInfo, state.settings.updateCheckEnabled !== false), 'settings');
  // How keys are stored, in words (single source: describeKeyStorage). Never calls safeStorage.
  handle(CHANNELS.keyStorageInfo, () => describeKeyStorage(keyPlan, process.platform), 'settings');
  // "Remove saved keys": click + confirm in Settings. Clears every provider key (chat, Gemini, Groq, Azure ...) from disk and memory.
  handle(CHANNELS.clearKeys, () => {
    try {
      cancelScreenCapture();
      conversation.stop();
      const result = stripAllKeys(store.get('cloud'), store.get('providers') as ProviderMap | undefined);
      if (result.cloud) store.set('cloud', result.cloud as StoredCloud);
      store.set('providers', result.providers as Record<string, StoredProvider | undefined>);
      aiState.cloud = { ...aiState.cloud, apiKeySet: false, maskedKey: '' };
      router?.resetBackoff();
      if (azureProvider) azureProvider.lastError = '';
      publishAI();
      return { ok: true, removed: result.removed, notice: result.removed ? `Removed ${result.removed} saved key${result.removed === 1 ? '' : 's'} from this computer.` : 'No saved keys were found.' };
    } catch {
      return { ok: false, error: 'Could not remove the saved keys. Please try again.' };
    }
  }, 'settings');
  // On-device wake word profile (feature vectors only, never audio).
  handle(CHANNELS.localWakeGet, () => ({ profile: localWake().read() ?? null, revision: state.localWakeRevision ?? 0 }), ['overlay', 'settings']);
  handle(CHANNELS.localWakeSave, (_e, value: unknown) => {
    if (!localWake().write(value)) return { ok: false, error: 'That voice profile could not be saved.' };
    state.localWakeRevision = (state.localWakeRevision ?? 0) + 1; publish();
    return { ok: true };
  }, 'settings');
  handle(CHANNELS.localWakeDelete, () => {
    const removed = localWake().delete();
    state.localWakeRevision = (state.localWakeRevision ?? 0) + 1; publish();
    return removed ? { ok: true } : { ok: false, error: 'Could not delete the file. Remove local-wake.json from the app folder by hand.' };
  }, 'settings');
  // Counters and reset times only (no keys); Settings shows the full list, Chat one calm line.
  handle(CHANNELS.usage, () => usage().summary({ gemini: Boolean(geminiKey()), groq: Boolean(getProviderKey('groq')), azure: azure().hasKey() }), ['settings', 'chat']);
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
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    const callerKind = callerWin ? windowKinds.get(callerWin) : undefined;
    const p = (typeof payload === 'boolean' ? { active: payload } : payload && typeof payload === 'object' ? payload : {}) as { active?: unknown; target?: unknown; reason?: unknown };
    const requested = p.target === 'overlay' || p.target === 'chat' ? p.target : undefined;
    if (p.active === true) {
      // Only ONE target is live; starting one ends the other (setLiveTarget logs the switch).
      setLiveTarget(requested ?? (callerKind === 'overlay' ? 'overlay' : 'chat'));
    } else if (!requested || requested === state.voiceActiveTarget) {
      // A late "end" from a window that is no longer the target must not end the other window's Live Talk.
      setLiveTarget(null, isLiveStopReason(p.reason) ? p.reason : 'click');
    }
    return { ok: true, target: state.voiceActiveTarget };
  }, ['overlay', 'chat']);
  // Click-only: nothing spoken can reach this handler. It only does anything while the one-time window-name question is on screen.
  handle(CHANNELS.liveAwarenessConsent, (_e, granted) => {
    if (!state.awarenessPrompt || Date.now() - awarenessPromptShownAt < 400) return;
    clearAwarenessPrompt();
    store.set('liveAwarenessAsked', true);
    if (granted === true) void saveSettings({ liveAwareness: 'window' }, 'awareness-prompt');
    else publish();
  }, 'overlay');
  // Setup wizard: Settings window only. Entering needs nothing; the live demo works only while the wizard is open.
  handle(CHANNELS.setupMode, (_e, active) => {
    if (typeof active !== 'boolean') return { ok: false, error: 'Invalid request.' };
    setSetupMode(active);
    return { ok: true };
  }, 'settings');
  handle(CHANNELS.setupLive, (_e, active) => {
    if (typeof active !== 'boolean') return { ok: false, error: 'Invalid request.' };
    if (!state.setupActive) return { ok: false, error: 'Setup is not open.' };
    if (active) {
      // The wizard already asked about the window name (or the person skipped it): no second question on the desktop bot during the demo.
      store.set('liveAwarenessAsked', true);
      setupLiveStarted = true;
      setLiveTarget('overlay');
    } else endSetupLive();
    return { ok: true };
  }, 'settings');
  // Compatibility only: speech state is owned by CHANNELS.speechEvent below.
  handle(CHANNELS.setIsSpeaking, () => ({ ok: true }));
  ipcMain.on(CHANNELS.speechEvent, (event, payload: unknown) => {
    if (!authorizeOrDrop(event, ['overlay', 'chat'])) return;
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
    let clip: ClipInfo | undefined;
    try {
      const stats = wavClipStats(Buffer.from(base64, 'base64'));
      if (stats) {
        clipLevel = ` sec=${stats.seconds.toFixed(1)} peak=${stats.peak.toFixed(2)} rms=${stats.rms.toFixed(3)} voiced=${stats.voicedMs}`;
        clip = { seconds: stats.seconds, rms: stats.rms, voicedMs: stats.voicedMs, botActive: activeSpeech !== null || Boolean(state.isSpeaking) || Date.now() - lastSpeechEventAt < BOT_ECHO_GUARD_MS };
      }
    } catch { /* level logging is best effort */ }
    const result = await stt().transcribe({
      base64,
      mimeType: typeof mimeType === 'string' ? mimeType : 'audio/wav',
      language: typeof language === 'string' ? language : undefined,
      hint: sttHint || undefined,
      clip,
    });
    console.info(`[STT] ok=${result.ok} provider=${result.provider ?? '-'}${result.retried ? ' retried=1' : ''} ms=${Date.now() - sttStarted} audioKB=${Math.round(base64.length * 0.75 / 1024)}${clipLevel}${result.ok ? '' : ` err=${result.error}`}`);
    // A single 0..1 number (never counts or keys) so the voice engine can ration speculative wake-mode clips; see QUOTA-SAVER.md.
    const quotaPressure = usage().sttQuotaPressure();
    if (result.ok) return { ok: true, text: result.text, scriptWarning: result.scriptWarning, quotaPressure };
    return { ok: false, error: result.error ?? 'Could not transcribe speech.', fallbackToBrowser: true, rateLimited: Boolean(result.rateLimited), quotaPressure };
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
    if (!authorizeOrDrop(event, 'overlay')) return;
    const next = Boolean(visible);
    if (Boolean(state.captionVisible) !== next) { state.captionVisible = next; publish(); }
  });
  ipcMain.on(CHANNELS.interactive, (event, interactive: unknown) => {
    if (!authorizeOrDrop(event, 'overlay')) return;
    if (typeof interactive === 'boolean' && process.platform !== 'linux') {
      ignoreMouse = !interactive; overlay.setIgnoreMouseEvents(ignoreMouse, { forward: true });
    }
  });
}
async function start() {
  // Keys live in config.json: make the folder 700 before the store creates the file, and the file 600 (best effort, never throws or blocks).
  const configDir = app.getPath('userData');
  // Fresh install = no config.json yet. Looked at BEFORE the store creates it (see shared/onboarding.ts shouldShowOnboarding).
  const configExisted = existsSync(join(configDir, 'config.json'));
  const freshInstall = !configExisted && !smokeTest;
  hardenKeyFiles(configDir, ['config.json'], process.platform);
  store = new Store<StoreSchema>({
    configFileMode: 0o600,
    defaults: {
      // Smoke runs must never open the real microphone or grab the user's global shortcut.
      settings: smokeTest ? { ...DEFAULT_SETTINGS, wakeWordEnabled: false, shortcut: 'Control+Alt+Shift+F24' } : freshInstall ? { ...DEFAULT_SETTINGS, wakeWordEnabled: false, onboardingStep: 'welcome' as const } : DEFAULT_SETTINGS,
      mode: 'local',
      model: 'qwen2.5:0.5b',
      position: null,
    },
  });
  hardenKeyFiles(configDir, ['config.json'], process.platform); // also fixes a config.json that an older version left world-readable
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
  // A brand new install opens the setup wizard (the microphone stays closed until the wizard asks); everyone with a config already never sees it.
  const providersSaved = store.get('providers') as Record<string, unknown> | undefined;
  state.setupActive = shouldShowOnboarding({
    configExisted,
    settings: validSettings(saved) ? saved : undefined,
    hasSavedKeys: Boolean(store.get('cloud')) || Boolean(providersSaved && Object.keys(providersSaved).length > 0),
    smokeRun: smokeTest,
  });
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'media' && !smokeTest));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'media' && !smokeTest);
  setupIPC();
  overlay = createWindow('overlay'); positionOverlay();
  // Reminders start a few seconds after the windows exist, so a reminder that came due while the app was closed can still be shown and spoken.
  setTimeout(() => reminderService().start(), 4000);
  app.on('before-quit', () => { reminders?.stop(); usageFile?.flush(); });
  overlay.setIgnoreMouseEvents(false);
  overlay.on('resize', updateOverlayShape);
  overlay.once('ready-to-show', showOverlay);
  if (state.setupActive) overlay.once('ready-to-show', () => setTimeout(openSettings, 500));
  // `moved` is macOS/Windows-only; `move` also fires on Linux/XWayland.
  overlay.on('move', () => {
    clearTimeout(positionTimer);
    positionTimer = setTimeout(() => { positionTimer = undefined; saveOverlayPosition(); }, 200);
  });
  // X11's native shape routes input directly; never disable the entire Linux
  // overlay while waiting for a cursor sample to make it interactive again.
  state.shortcutAvailable = registerShortcut(state.settings.shortcut);
  const icon = nativeImage.createFromPath(join(directory, '../../assets/icon.png'));
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
  startUpdateChecks();

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
  setLiveTarget(null, 'quit');
  conversation.stop();
  pomodoroTimer?.stop();
  healthMonitor?.stop();
  quitting = true; globalShortcut.unregisterAll();
  if (resetInterval) clearInterval(resetInterval);
  if (updateTimer) clearInterval(updateTimer);
  clearTimeout(happyTimer); clearTimeout(positionTimer); clearTimeout(displayTimer);
  saveOverlayPosition();
  tray?.destroy();
});
