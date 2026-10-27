import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { AIState, AppState, BotSize, ChatState, Settings, ToolApprovalRequest, VoiceLanguage } from '../shared/types';
import { DEFAULT_SETTINGS, MAX_MESSAGE_LENGTH } from '../shared/validation';
import { Bot } from './Bot';
import { SonicOrb } from './SonicOrb';
import { AISettings } from './AISettings';
import { AzureVoiceSettings } from './AzureVoiceSettings';
import { UsageSettings } from './UsageSettings';
import { useLipSync } from './lipsync';
import { escapeAction, panelPlan } from '../shared/overlay-panels.ts';
import { ConversationWindow, DEFAULT_WAKE_ALIASES, WakeGate, buildWakeHint, matchWakeWord } from '../shared/wake-word.ts';
import { ClipGate, WAKE_TRIM_MS, formatGateLine } from '../shared/clip-gate.ts';
import { LocalWakeController, decideWakeClip } from '../shared/local-wake/runtime.ts';
import { parseProfile } from '../shared/local-wake/enrollment.ts';
import { LocalWakeSettings } from './LocalWakeSettings';
import { approvalHeadline, approvalSecondsLeft, approvalSpokenLine, mergeApprovals, reduceApprovals } from '../shared/approval-ui.ts';
import { clearInterruptedSpeech, getLastBotSpeech, getMutedPreference, hasInterruptedSpeech, resumeInterruptedSpeech, setMutedPreference, speak, stopSpeech } from './speech';
import { isStopCommand, unclearAction } from '../shared/stop-intent.ts';
import { routeSpeech } from '../shared/intent.ts';
import { RemoveKeysRow, useKeyStorageInfo } from './KeyStorage';
import { UpdateSettings } from './UpdateSettings';
import { runChatVoiceTurn } from '../shared/chat-voice-turn.ts';
import { DEFAULT_BARGE_IN_SENSITIVITY } from '../shared/barge-in.ts';
import { formatResetLabel } from '../shared/usage.ts';
import { TasksPanel } from './TasksPanel.tsx';
import { MIC_CONFIRM_MS, changedSettings, micDotPress, micDotView } from '../shared/mic-control.ts';
import { getLastStop, isSpeakingNow, stopSpeaking } from './tts-player';
import { isPhantomTranscript, isSelfEchoTranscript } from '../shared/stt-hallucination.ts';
import { AwarenessPanel, ScreenPanel } from './ScreenPanel';
import { runLiveStop, runLiveTeardown, stopWordAction } from '../shared/live-talk.ts';
import type { LiveStopReason } from '../shared/live-talk.ts';
import { VoiceSession, type BargeInInfo, getVoiceProfile, isSpeakerMatch, recordVoiceSample } from './voice-engine';
import type { VoiceProfile } from './voice-engine';

const api = window.companion;
const initialState: AppState = { settings: DEFAULT_SETTINGS, paused: false, mood: 'calm', speech: '', overlayVisible: true, shortcutAvailable: false, platform: '', displayBackend: '', loginSupported: false, voiceActiveTarget: null };
function Icon({ name, size = 18 }: { name: 'close' | 'settings' | 'send' | 'spark' | 'chat' | 'pause' | 'arrow' | 'shield' | 'reset' | 'power' | 'volume' | 'volume-off' | 'voice-call' | 'phone-off' | 'mic' | 'mic-off'; size?: number }) {
  const paths: Record<string, string> = {
    close: 'm6 6 12 12M6 18 18 6',
    settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
    send: 'm5 12 14-7-5 14-2-7-7 0Zm7 0 7-7',
    spark: 'm12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z',
    chat: 'M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 3V11.5A7.5 7.5 0 0 1 9.5 4h3a7.5 7.5 0 0 1 7.5 7.5Z',
    pause: 'M9 5v14M15 5v14',
    arrow: 'M5 12h14m-6-6 6 6-6 6',
    shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6',
    reset: 'M4 10a8 8 0 1 1 0 5M4 4v6h6',
    power: 'M12 3v9M7 5a8 8 0 1 0 10 0',
    volume: 'M11 5L6 9H2v6h4l5 4V5zm4.5 3.5a5 5 0 0 1 0 7m3.5-10.5a10 10 0 0 1 0 14',
    'volume-off': 'M11 5L6 9H2v6h4l5 4V5zm12 4l-6 6m0-6l6 6',
    'voice-call': 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v4 M8 23h8',
    'phone-off': 'M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 11.38 11.38 0 0 0 3.58.57 2 2 0 0 1 2 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 2 11.36 11.36 0 0 0 .57 3.57 2 2 0 0 1-.45 2.12l-1.27 1.28M1 1l22 22',
    mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v4 M8 23h8',
    'mic-off': 'M1 1l22 22M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6M19 10v2a7 7 0 0 1-.12 1.28M5 10v2a7 7 0 0 0 11.83 5.09M12 19v4M8 23h8',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}

function ThinkingIndicator() {
  return (
    <div className="thinking-motion" role="status" aria-label="Sudo-chan is thinking with you">
      <div className="thinking-avatar-pulse">
        <span className="pulse-ring pulse-ring-1" />
        <span className="pulse-ring pulse-ring-2" />
        <div className="pulse-core">
          <Icon name="spark" size={13} />
        </div>
      </div>
      <div className="thinking-text-wrap">
        <span className="thinking-label">Thinking with you</span>
        <div className="thinking-dots">
          <span className="dot dot-1" />
          <span className="dot dot-2" />
          <span className="dot dot-3" />
        </div>
      </div>
    </div>
  );
}
function useCompanion() {
  const [state, setState] = useState(initialState);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!api) { setError('Open this preview in the Sudo-chan desktop app.'); return; }
    let subscribed = true;
    const unsubscribe = api.onState(next => { if (subscribed) setState(next); });
    void api.getState().then(next => { if (subscribed) setState(next); }).catch(() => { if (subscribed) setError('Could not connect to your companion. Please restart the app.'); });
    return () => { subscribed = false; unsubscribe(); };
  }, []);
  return { state, error };
}
function WindowHeader({ subtitle, settings = false }: { subtitle: string; settings?: boolean }) {
  return <header className="window-header"><div className="brand-mark">s<span/></div><div className="header-brand"><b>Sudo-chan</b><span>{subtitle}</span></div><div className="header-actions">{!settings && <button className="icon-button" aria-label="Open settings" onClick={() => void api?.openSettings()}><Icon name="settings"/></button>}<button className="icon-button" aria-label="Hide window" onClick={() => void api?.hideWindow()}><Icon name="close"/></button></div></header>;
}
declare global { interface Window { __bargeInLatency?: Array<{ speechToDetectMs: number; detectToStoppedMs: number }> } }
// Barge-in: user speech detected while the bot talks -> stop audio, clear queue, abort the LLM stream.
function handleBargeIn(info?: BargeInInfo) {
  const detectedAt = info?.detectedAt ?? performance.now();
  stopSpeaking('barge-in');
  // The user is probably asking a follow-up about the same screen: keep the (in-memory) screenshot.
  void api?.stopReply({ keepScreen: true });
  const stoppedAt = performance.now();
  const speechToDetectMs = Math.round(detectedAt - (info?.speechStartedAt ?? detectedAt));
  const detectToStoppedMs = Math.round(stoppedAt - detectedAt);
  console.info(`[barge-in] speech→detect ${speechToDetectMs}ms, detect→stopped ${detectToStoppedMs}ms`);
  (window.__bargeInLatency ??= []).push({ speechToDetectMs, detectToStoppedMs });
}
/** True if this transcript is Whisper noise (prompt leak, subtitle junk) or the bot's own name coming back through the speakers. */
function isPhantomOrSelfEcho(text: string, settings: Settings): boolean {
  const names = [settings.customWakeWord ?? '', ...(settings.wakeAliases ?? [])].filter(Boolean);
  if (isPhantomTranscript(text, { names })) {
    console.info('[voice] transcript ignored: looks like a speech-to-text hallucination');
    return true;
  }
  const lastStop = getLastStop();
  const sinceMs = isSpeakingNow() ? 0 : lastStop ? Date.now() - lastStop.at : Number.POSITIVE_INFINITY;
  if (isSelfEchoTranscript(text, getLastBotSpeech(), sinceMs, { names })) {
    console.info('[voice] transcript ignored: matches the bot\'s own last words (self-echo)');
    return true;
  }
  return false;
}
/** One approval card per risky action. Only a click on these buttons approves; speech never does. */
function ToolApprovalCards({ approvals, busy }: { approvals: ToolApprovalRequest[]; busy: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const seen = useRef(new Map<string, number>());
  for (const request of approvals) if (!seen.current.has(request.id)) seen.current.set(request.id, Date.now());
  useEffect(() => {
    if (!approvals.length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [approvals.length]);
  if (!approvals.length && !busy) return null;
  const answer = (id: string, decision: 'allow' | 'allow-chat' | 'deny') => { void api?.respondToolApproval(id, decision); };
  return <div className="tool-cards" role="region" aria-label="Actions waiting for your approval">
    {approvals.map(request => {
      const left = Math.max(0, Math.ceil((request.expiresInMs - (now - (seen.current.get(request.id) ?? now))) / 1000));
      return <article key={request.id} className={`tool-card ${request.elevated ? 'is-elevated' : ''}`} role="alertdialog" aria-label={request.title}>
        <h3>{request.elevated ? '⚠ ' : ''}Sudo-chan wants to: {request.title}</h3>
        <pre className="tool-detail">{request.detail}</pre>
        <div className="tool-actions">
          <button type="button" className="primary-button" onClick={() => answer(request.id, 'allow')}>Allow once</button>
          {request.allowForChat && <button type="button" className="soft-button" onClick={() => answer(request.id, 'allow-chat')}>Allow for this chat</button>}
          <button type="button" className="soft-button" onClick={() => answer(request.id, 'deny')}>Deny</button>
          <span className="tool-timer">Auto-denies in {left}s</span>
        </div>
        <p className="tool-note">Approve with a click only. Saying "yes" out loud does not approve anything.</p>
      </article>;
    })}
    <button type="button" className="text-button tool-stop" onClick={() => void api?.stopAllTools()}>⛔ Stop all actions</button>
  </div>;
}
/** After a barge-in: a stop command stays stopped; anything else is a new request that replaces the old reply. */
function handleStopCommand(text: string): boolean {
  clearInterruptedSpeech();
  if (!isStopCommand(text)) return false;
  if (isSpeakingNow()) stopSpeaking('stop-button');
  void api?.stopReply();
  console.info(`[barge-in] stop command "${text.trim()}" -> stay stopped`);
  return true;
}
/** The interruption could not be understood: carry on where she was, unless it was too short to be anything but a command. */
function handleUnclear(info: { clipMs: number }) {
  const action = unclearAction(info.clipMs, hasInterruptedSpeech());
  if (action === 'none') return;
  if (action === 'stay-stopped') {
    clearInterruptedSpeech();
    console.info(`[barge-in] unclear clip=${info.clipMs}ms -> stay stopped`);
    return;
  }
  const resumed = resumeInterruptedSpeech();
  console.info(`[barge-in] unclear clip=${info.clipMs}ms -> ${resumed ? 'resume' : 'stay stopped'}`);
}
/** Compact approval panel on the desktop bot. Only these buttons (or Esc = deny) answer; speech never does. */
function OverlayApproval({ request }: { request: ToolApprovalRequest }) {
  const shownAt = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    shownAt.current = Date.now();
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.id]);
  const left = approvalSecondsLeft(request, shownAt.current, now);
  const answer = (decision: 'allow' | 'allow-chat' | 'deny') => { void api?.respondToolApproval(request.id, decision); };
  return <div className={`overlay-approval ${request.elevated ? 'is-elevated' : ''}`} role="alertdialog" aria-label={request.title} data-interactive>
    <div className="approval-title">{approvalHeadline(request)}</div>
    <pre className="approval-detail">{request.detail}</pre>
    <div className="approval-actions">
      <button type="button" className="approval-allow" onClick={() => answer('allow')}>Allow once</button>
      {request.allowForChat && <button type="button" className="approval-chat" onClick={() => answer('allow-chat')}>This chat</button>}
      <button type="button" className="approval-deny" onClick={() => answer('deny')}>Deny</button>
    </div>
    <div className="approval-timer">{left}s mein khud Deny</div>
  </div>;
}
function Overlay({ state }: { state: AppState }) {
  const [arriving, setArriving] = useState(false);
  const [cursorOffset, setCursorOffset] = useState<{ x: number; y: number } | undefined>(undefined);
  const [overlayAudioLevel, setOverlayAudioLevel] = useState(0);
  // Only the bot the user is actually talking to moves its mouth (overlay = Live Talk on the desktop bot).
  const lip = useLipSync(state.voiceActiveTarget === 'overlay');
  const lastSpokenOverlayId = useRef<string | null>(null);
  const [caption, setCaption] = useState<{ you: string; bot: string }>({ you: '', bot: '' });
  // Tool approval cards also appear on the desktop bot, because that is where the user is talking.
  const [approvals, setApprovals] = useState<ToolApprovalRequest[]>([]);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const off = api.onToolApproval(event => setApprovals(previous => reduceApprovals(previous, event)));
    void api.getToolApprovals().then(list => { if (alive) setApprovals(previous => mergeApprovals(list, previous)); }).catch(() => {});
    return () => { alive = false; off(); };
  }, []);
  const approval = approvals[0];
  const spokenApproval = useRef<string | null>(null);
  useEffect(() => {
    if (!approval || spokenApproval.current === approval.id) return;
    spokenApproval.current = approval.id;
    // One short spoken line; approving still needs a click.
    if (state.voiceActiveTarget === 'overlay') void speak(approvalSpokenLine(approval)).catch(() => {});
  }, [approval?.id]);
  // A reminder came due: it is also a desktop notification; here she says it out loud.
  useEffect(() => {
    if (!api) return;
    return api.onReminder(reminder => { void speak(`${reminder.late ? 'Der se yaad dila rahi hoon: ' : 'Yaad dilana: '}${reminder.text}`).catch(() => {}); });
  }, []);
  const toolsWorking = state.toolStatus === 'working';
  const isOverlayVoiceActiveForCaption = state.voiceActiveTarget === 'overlay';
  const captionText = toolsWorking ? 'Kaam kar rahi hoon...' : (caption.bot || caption.you);
  const captionWanted = (isOverlayVoiceActiveForCaption && Boolean(caption.bot || caption.you)) || toolsWorking;
  // Main resolves the same priority from the published flags (captionVisible etc.), so the native window shape matches this plan.
  useEffect(() => { api?.setCaptionVisible(captionWanted); }, [captionWanted]);
  const plan = panelPlan({ approvalPending: Boolean(approval), awarenessPending: Boolean(state.awarenessPrompt), screenStatus: state.screenStatus, captionWanted, speechWanted: Boolean(state.speech) && !isOverlayVoiceActiveForCaption });
  // Esc only refuses or cancels the visible prompt: deny the approval, decline the consent, cancel a pending capture.
  useEffect(() => {
    const action = escapeAction(plan.active);
    if (!action) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (action === 'deny-approval' && approval) void api?.respondToolApproval(approval.id, 'deny');
      else if (action === 'decline-consent') void api?.screenConsent(false);
      else if (action === 'cancel-screen') void api?.cancelScreen();
      else if (action === 'dismiss-awareness') void api?.liveAwarenessConsent(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [plan.active, approval?.id]);
  const isOverlayVoiceActive = state.voiceActiveTarget === 'overlay';
  const overlaySessionRef = useRef<VoiceSession | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;
  const isOverlayVoiceActiveRef = useRef(isOverlayVoiceActive);
  isOverlayVoiceActiveRef.current = isOverlayVoiceActive;

  useEffect(() => {
    if (state.mood === 'happy') {
      setArriving(true);
      const timer = setTimeout(() => setArriving(false), 900);
      return () => clearTimeout(timer);
    }
  }, [state.mood]);

  // Wake word + Live Talk listener for the overlay.
  // Privacy first: the mic is only open when "Listen for my name" is ON (and not paused) or Live Talk is active.
  const wakeEnabled = state.settings.wakeWordEnabled ?? true;
  const wakeGate = useRef(new WakeGate(2000));
  // Quota saver: decides locally whether a wake-mode clip is worth a cloud request (never consulted during Live Talk).
  const clipGate = useRef(new ClipGate());
  // On-device name check (Settings > Voice > "On-device name check", default off). Decides locally whether a wake-mode clip is a candidate.
  const localWake = useRef(new LocalWakeController({ now: () => performance.now(), yieldNow: () => new Promise<void>(resolve => setTimeout(resolve, 0)) }));
  const localWakeMode = state.settings.localWake ?? 'off';
  useEffect(() => { localWake.current.configure(localWakeMode, state.settings.localWakeSensitivity); }, [localWakeMode, state.settings.localWakeSensitivity]);
  useEffect(() => {
    if (localWakeMode === 'off') { localWake.current.setProfile(undefined); return; }
    let live = true;
    void api?.getLocalWakeProfile().then(info => { if (live) localWake.current.setProfile(parseProfile(info.profile)); }, () => { if (live) localWake.current.setProfile(undefined); });
    return () => { live = false; };
  }, [localWakeMode, state.localWakeRevision]);
  const wakeWindow = useRef(new ConversationWindow());
  const wakeOpened = useRef(false);
  // Is a cloud reply in flight? (only known while Live Talk is on the desktop bot; used to tell "cut her" from "we are done" on a stop word)
  const replyBusyRef = useRef(false);
  // One log line per decision class a minute, counts only: `[gate] skipped=N sent=M reason=...`.
  useEffect(() => {
    const timer = setInterval(() => {
      for (const line of clipGate.current.flushStats(performance.now())) console.info(formatGateLine(line));
      const local = localWake.current.flushStats(performance.now());
      if (local) console.info(local);
    }, 60_000);
    return () => clearInterval(timer);
  }, []);
  const shouldListen = isOverlayVoiceActive || wakeEnabled;
  // The mic dot: turning the mic OFF takes two clicks within 3 s (the first one only arms it), see shared/mic-control.ts.
  const [micArmedAt, setMicArmedAt] = useState<number | null>(null);
  useEffect(() => {
    if (micArmedAt === null) return;
    const timer = setTimeout(() => setMicArmedAt(null), MIC_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [micArmedAt]);
  useEffect(() => setMicArmedAt(null), [wakeEnabled, isOverlayVoiceActive]);
  const micView = micDotView({ wakeEnabled, liveActive: isOverlayVoiceActive, paused: state.paused, armed: micArmedAt !== null });
  // Click-to-stop is instant: audio first (synchronously), then the pending clip, the mic (unless standby needs it), the reply, then the state.
  const endOverlayLive = (reason: LiveStopReason) => {
    runLiveStop({
      cutSpeech: () => stopSpeaking('stop-button'),
      forgetInterrupted: clearInterruptedSpeech,
      discardPendingStt: () => overlaySessionRef.current?.cancelPending(),
      closeMic: () => { overlaySessionRef.current?.stop(); overlaySessionRef.current = null; },
      abortReply: () => { void api?.stopReply(); },
      setLiveOff: r => { void api?.setVoiceActive(false, 'overlay', r); },
    }, reason, { standbyWanted: stateRef.current.settings.wakeWordEnabled ?? true });
  };
  // The bot's main talk button: one click starts Live Talk right now (no name, no dialog), the next click stops it right now.
  const toggleOverlayLive = () => {
    if (isOverlayVoiceActiveRef.current) { endOverlayLive('click'); return; }
    wakeOpened.current = false; // started by hand: the 30 s conversation window does not apply
    void api?.setVoiceActive(true, 'overlay');
    void api?.welcome(); // a little wave (visual only: no spoken greeting, no extra voice quota)
  };
  // Live Talk ended from outside (the other window took over, quit...): cut whatever this window was saying or hearing, no replay.
  const wasOverlayLive = useRef(false);
  useEffect(() => {
    if (wasOverlayLive.current && !isOverlayVoiceActive) {
      runLiveTeardown({ cutSpeech: () => stopSpeaking('stop-button'), forgetInterrupted: clearInterruptedSpeech, discardPendingStt: () => overlaySessionRef.current?.cancelPending() });
    }
    wasOverlayLive.current = isOverlayVoiceActive;
  }, [isOverlayVoiceActive]);
  const pressMicDot = () => {
    const result = micDotPress({ wakeEnabled, liveActive: isOverlayVoiceActive, armedAt: micArmedAt, now: Date.now() });
    setMicArmedAt(result.armedAt);
    if (result.action === 'end-live') endOverlayLive('click');
    else if (result.action === 'enable' || result.action === 'disable') void api?.saveSettings({ wakeWordEnabled: result.action === 'enable' }, 'dot');
  };

  useEffect(() => {
    // If Chat window is actively having a voice session, Overlay yields the mic to Chat
    if (state.voiceActiveTarget === 'chat' || !shouldListen) {
      if (overlaySessionRef.current) {
        overlaySessionRef.current.stop();
        overlaySessionRef.current = null;
      }
      return;
    }

    let session = overlaySessionRef.current;
    if (!session) {
      session = new VoiceSession();
      overlaySessionRef.current = session;
    }

    session.start({
      isSpeaking: () => Boolean(stateRef.current.isSpeaking),
      language: stateRef.current.settings.voiceLanguage,
      // Standby only needs the name: short clips, rate-limited, hinted with the name and aliases.
      maxClipMs: isOverlayVoiceActive ? undefined : WAKE_TRIM_MS,
      sttHint: isOverlayVoiceActive ? undefined : buildWakeHint(stateRef.current.settings.customWakeWord, stateRef.current.settings.wakeAliases),
      // On-device check: only in wake mode (Live Talk and the conversation window are never gated), never for barge-in clips.
      localWake: (clip, rate) => (isOverlayVoiceActiveRef.current ? Promise.resolve(undefined) : localWake.current.evaluate(clip, rate)),
      decideClip: (features, local) => decideWakeClip({ features, local, live: isOverlayVoiceActiveRef.current, now: performance.now(), clipGate: clipGate.current, wakeGate: wakeGate.current, controller: localWake.current }),
      onTranscribeResult: (outcome, info) => {
        if (!isOverlayVoiceActiveRef.current) wakeGate.current.report(performance.now(), outcome);
        if (info?.quotaPressure !== undefined) clipGate.current.setQuotaPressure(info.quotaPressure);
      },
      onAudioLevel: level => {
        setOverlayAudioLevel(level);
      },
      getBargeInSensitivity: () => stateRef.current.settings.bargeInSensitivity ?? DEFAULT_BARGE_IN_SENSITIVITY,
      onBargeIn: handleBargeIn,
      onError: message => {
        console.warn(`[voice] overlay mic error: ${message}`);
        if (isOverlayVoiceActiveRef.current) endOverlayLive('error');
      },
      onUnclear: info => {
        if (!isOverlayVoiceActiveRef.current) { clipGate.current.noteResult(false); localWake.current.noteOutcome(false); }
        handleUnclear(info);
      },
      onFinal: (text, features) => {
        if (!text.trim()) return;
        const currentLive = isOverlayVoiceActiveRef.current;
        const currentSettings = stateRef.current.settings;
        if (isPhantomOrSelfEcho(text, currentSettings)) {
          if (!currentLive) { clipGate.current.noteResult(false); localWake.current.noteOutcome(false); }
          return;
        }

        if (!currentLive) {
          // Standby: fuzzy-match the assistant's name or aliases; ignore everything else.
          const match = matchWakeWord(text, currentSettings.customWakeWord, currentSettings.wakeAliases);
          // The hit rate tunes the quota saver: a run of clips without the name makes it stricter, a hit loosens it.
          clipGate.current.noteResult(match.matched);
          localWake.current.noteOutcome(match.matched);
          if (!match.matched) return;

          // If personal voice lock is enabled, additionally verify the speaker is Sid
          const profile = getVoiceProfile();
          if (currentSettings.voiceLockEnabled && profile) {
            if (!isSpeakerMatch(features ?? {}, profile)) return;
          }

          // "Sudo, ruko": a stop command right after the name only stops (speech, reply, pending screenshot); it never captures the screen.
          if (match.rest && handleStopCommand(match.rest)) return;

          // Name heard: bot reacts, a 30 s conversation window opens where no name is needed.
          wakeOpened.current = true;
          wakeWindow.current.open(performance.now());
          void api?.welcome();
          void api?.setVoiceActive(true, 'overlay');
          // Only words that clearly point at the screen ("meri screen dekho", "ye kya hai") start the screenshot flow; "kaise ho" and
          // "notes.txt bana do" go to the normal chat / tool path. A bare name keeps its old behaviour (see src/shared/intent.ts).
          if (routeSpeech(match.rest, { screenAssist: Boolean(currentSettings.screenAssistEnabled), afterWake: true }) === 'screen') {
            // If the screenshot cannot be taken (Local mode, cooldown...), still answer what was said.
            // When the reason was already shown and spoken on the overlay (declined, sensitive window, failed capture), do not also send the words as a blind chat message.
            void api?.sendScreen({ text: match.rest, source: 'wake' }).then(result => { if (!result.ok && !result.handled && match.rest) void api?.sendMessage(match.rest, true); });
          }
          else if (match.rest) void api?.sendMessage(match.rest, true);
        } else {
          // In Live Talk: respond to whatever is spoken, and keep the wake window alive.
          wakeWindow.current.touch(performance.now());
          // Stop word: busy -> cut her voice and the reply, Live Talk carries on; idle -> "we are done", Live Talk ends.
          if (isStopCommand(text)) {
            const busy = isSpeakingNow() || replyBusyRef.current || hasInterruptedSpeech();
            if (stopWordAction({ mode: 'live-overlay', busy }) === 'end-live') { clearInterruptedSpeech(); console.info(`[barge-in] stop command "${text.trim()}" while idle -> ending Live Talk`); endOverlayLive('stopword'); }
            else handleStopCommand(text);
            return;
          }
          // "meri screen dekho" inside the 30 s window uses the same consent / countdown / guard flow as the wake word; everything else is chat.
          if (routeSpeech(text, { screenAssist: Boolean(currentSettings.screenAssistEnabled), afterWake: false }) === 'screen') {
            void api?.sendScreen({ text: text.trim(), source: 'wake' }).then(result => { if (!result.ok && !result.handled) void api?.sendMessage(text.trim(), true); });
          } else void api?.sendMessage(text.trim(), true);
        }
      },
    });

    return () => {
      if (stateRef.current.voiceActiveTarget === 'chat') {
        overlaySessionRef.current?.stop();
        overlaySessionRef.current = null;
      }
    };
  }, [state.voiceActiveTarget === 'chat', shouldListen, isOverlayVoiceActive]);

  // The wake window ends Live Talk that the wake word started (never one the user started by hand).
  useEffect(() => {
    if (!isOverlayVoiceActive) {
      wakeOpened.current = false;
      wakeWindow.current.close();
      return;
    }
    const timer = setInterval(() => {
      if (!wakeOpened.current) return;
      const now = performance.now();
      if (stateRef.current.isSpeaking) wakeWindow.current.touch(now);
      else if (!wakeWindow.current.isOpen(now)) {
        wakeOpened.current = false;
        endOverlayLive('timeout');
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [isOverlayVoiceActive]);

  // Spoken reply playback when conversation updates in overlay mode
  useEffect(() => {
    // ONLY speak in overlay if OVERLAY is the designated active voice target!
    console.info(`[voice] overlay target=${state.voiceActiveTarget ?? 'none'}`);
    if (!api || state.voiceActiveTarget !== 'overlay') return;
    const unsub = api.onChat(chatState => {
      replyBusyRef.current = chatState.busy;
      const last = chatState.messages[chatState.messages.length - 1];
      // Show what was said and what she answers right on the desktop bot, so the chat window is never needed.
      const lastUser = [...chatState.messages].reverse().find(m => m.role === 'user');
      const trim = (t: string) => (t.length > 160 ? `${t.slice(0, 157)}...` : t);
      setCaption({ you: lastUser ? trim(lastUser.text) : '', bot: last && last.role === 'assistant' ? trim(last.text) : '' });
      if (last && last.role === 'assistant' && last.status === 'complete' && last.text) {
        if (lastSpokenOverlayId.current !== last.id) {
          lastSpokenOverlayId.current = last.id;
          console.info('[voice] overlay got a complete reply, speaking');
          void speak(last.spoken ?? last.text).catch(error => console.error('[voice] speak failed', String(error)));
        }
      }
    });
    return () => { unsub(); replyBusyRef.current = false; setCaption({ you: '', bot: '' }); };
  }, [state.voiceActiveTarget]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const target = event.target;
      api?.setInteractive(target instanceof Element && Boolean(target.closest('[data-interactive]')));
      const w = window.innerWidth || 220;
      const h = window.innerHeight || 260;
      const normX = (event.clientX - w / 2) / (w / 2);
      const normY = (event.clientY - h / 2) / (h / 2);
      setCursorOffset({ x: Math.max(-1, Math.min(1, normX)), y: Math.max(-1, Math.min(1, normY)) });
    };
    const leave = () => {
      api?.setInteractive(false);
      setCursorOffset(undefined);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerleave', leave);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerleave', leave); };
  }, []);
  return <main className="overlay-room" aria-label="Sudo-chan desktop companion">
    {/* One panel slot: approval > consent > countdown > notice > looking > caption > hint > greeting. See shared/overlay-panels.ts. */}
    {plan.active === 'approval' && approval && <OverlayApproval request={approval} />}
    {plan.active === 'awareness' && <AwarenessPanel />}
    {(plan.active === 'consent' || plan.active === 'countdown' || plan.active === 'notice' || plan.active === 'capturing' || plan.active === 'hint') && <ScreenPanel state={state} speakAloud={isOverlayVoiceActive} />}
    {plan.active === 'caption' && <div className="overlay-caption" role="status" aria-live="polite" data-interactive>{plan.chip && <span className="caption-chip">{plan.chip === 'cached' ? '📎 Purani screen par based' : '📸 Screen bheji gayi'}</span>}<span className={toolsWorking || caption.bot ? 'caption-bot' : 'caption-you'}>{captionText}</span></div>}
    {plan.active === 'speech' && <div className="overlay-speech" role="status" data-interactive>{state.speech}</div>}

    <div className="overlay-grip" data-interactive title="Drag to make yourself at home" aria-label="Drag companion"><span/><span/><span/></div>
    {shouldListen && !state.paused && (
      <div
        className={`overlay-glow ${lip.speaking ? 'is-speaking' : isOverlayVoiceActive ? 'is-live' : 'is-standby'}`}
        style={{ ['--glow' as string]: String(Math.min(1, lip.speaking ? lip.level : overlayAudioLevel)) }}
        aria-hidden="true"
      />
    )}
    <div
      className={`overlay-bot ${arriving ? 'bot-arriving' : ''} ${micView.mode === 'off' ? 'is-mic-off' : ''}`}
      data-interactive
      role="button"
      aria-label={isOverlayVoiceActive ? 'Stop Live Talk' : 'Start Live Talk'}
      title={isOverlayVoiceActive ? 'Live Talk is on. Click me to stop.' : 'Click me to start Live Talk.'}
      onClick={toggleOverlayLive}
    >
      {(state.settings.voiceVisualizerMode ?? 'bot') === 'orb' ? (
        <SonicOrb
          isSpeaking={lip.speaking}
          audioLevel={lip.speaking ? lip.level : overlayAudioLevel}
          size={140}
        />
      ) : (
        <Bot
          mood={state.mood}
          paused={state.paused}
          cursorOffset={cursorOffset}
          voiceActive={isOverlayVoiceActive}
          isSpeaking={lip.speaking}
          audioLevel={lip.speaking ? lip.level : overlayAudioLevel}
          glasses={state.settings.glassesEnabled ?? true}
          onToggleVoice={toggleOverlayLive}
          onOpenSettings={() => void api?.openSettings()}
        />
      )}
    </div>
    <div className="overlay-dock" data-interactive>
      {/* The mic switch is its own button, outside the chat pill, with a gap, so a click on the pill can never reach it. */}
      <button type="button" className="mic-switch" title={micView.title} aria-label={micView.title} onClick={pressMicDot}>
        <span className={`mic-dot is-${micView.mode}`} aria-hidden="true"/>
      </button>
      <button className="companion-pill" onClick={() => void api?.openChat()}>
        {state.paused
          ? 'Taking a breath'
          : isOverlayVoiceActive
            ? '✨ Live Talk'
            : state.pomodoro && state.pomodoro.status !== 'idle' && (state.pomodoro.minutesLeft > 0 || state.pomodoro.secondsLeft > 0)
              ? `⏳ ${state.pomodoro.minutesLeft}:${state.pomodoro.secondsLeft < 10 ? '0' : ''}${state.pomodoro.secondsLeft}`
              : 'Right here'}
        <Icon name="chat" size={13}/>
      </button>
    </div>
  </main>;
}
function Chat({ state }: { state: AppState }) {
  const [conversation, setConversation] = useState<ChatState>({ messages: [], busy: false, error: '', revision: -1 });
  const [ai, setAI] = useState<AIState>({
    mode: 'local',
    model: '',
    models: [],
    modelSizes: {},
    connected: false,
    error: '',
    cloud: {
      provider: 'gemini',
      endpoint: '',
      model: '',
      apiKeySet: false,
      maskedKey: '',
    },
  });
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [confirmHeavy, setConfirmHeavy] = useState<string | null>(null);
  const [toolApprovals, setToolApprovals] = useState<ToolApprovalRequest[]>([]);
  const viewport = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Set only while a 429 says the realistic (Gemini) voice is out of quota; the chat shows one calm line then.
  const [voiceLimitUntil, setVoiceLimitUntil] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () => { void api?.getUsage().then(summary => { if (alive) setVoiceLimitUntil(summary.geminiVoiceBlockedUntil); }).catch(() => {}); };
    check();
    const timer = setInterval(check, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, [conversation.busy]);
  const alive = useRef(true);
  const sending = submitting || conversation.busy;
  const [muted, setMuted] = useState(getMutedPreference);
  const lastSpokenId = useRef<string | null>(null);

  const isVoiceMode = state.voiceActiveTarget === 'chat';
  const [activeVisualizer, setActiveVisualizer] = useState<'bot' | 'orb'>(() => state.settings.voiceVisualizerMode ?? 'bot');
  const [userSubtitle, setUserSubtitle] = useState('');
  const [botSubtitle, setBotSubtitle] = useState('');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [audioLevel, setAudioLevel] = useState(0);
  // Chat widget Live Talk: only this window's bot lip-syncs, never the overlay.
  const lip = useLipSync(state.voiceActiveTarget === 'chat');
  const [micMuted, setMicMuted] = useState(false);
  const voiceSessionRef = useRef<VoiceSession | null>(null);

  useEffect(() => {
    if (state.settings.voiceVisualizerMode) {
      setActiveVisualizer(state.settings.voiceVisualizerMode);
    }
  }, [state.settings.voiceVisualizerMode]);

  const isSpeakingRef = useRef(state.isSpeaking);
  isSpeakingRef.current = state.isSpeaking;
  const settingsRef = useRef(state.settings);
  settingsRef.current = state.settings;
  const conversationBusyRef = useRef(conversation.busy);
  conversationBusyRef.current = conversation.busy;

  // Typing is the default: the mic stays closed until the user clicks the Voice button (or Ctrl+M). That click starts Live Talk HERE.
  const startChatLive = () => {
    setMicMuted(false);
    void api?.setVoiceActive(true, 'chat');
  };
  // Same instant stop as the desktop bot: audio cut now, pending clip dropped, mic closed, reply aborted, then the state.
  const endChatLive = (reason: LiveStopReason) => {
    runLiveStop({
      cutSpeech: () => stopSpeaking('stop-button'),
      forgetInterrupted: clearInterruptedSpeech,
      discardPendingStt: () => voiceSessionRef.current?.cancelPending(),
      closeMic: () => { voiceSessionRef.current?.stop(); voiceSessionRef.current = null; },
      abortReply: () => { void api?.stopReply(); },
      setLiveOff: r => { void api?.setVoiceActive(false, 'chat', r); },
    }, reason, { standbyWanted: false });
  };
  // Live Talk here ended from outside (the desktop bot took over, the window was closed, quit): cut what this window was saying or hearing.
  const wasVoiceMode = useRef(false);
  useEffect(() => {
    if (wasVoiceMode.current && !isVoiceMode) {
      runLiveTeardown({ cutSpeech: () => stopSpeaking('stop-button'), forgetInterrupted: clearInterruptedSpeech, discardPendingStt: () => voiceSessionRef.current?.cancelPending() });
      setMicMuted(false);
      setUserSubtitle('');
      setLiveTranscript('');
    }
    wasVoiceMode.current = isVoiceMode;
  }, [isVoiceMode]);

  // Global Ctrl+M shortcut to toggle mic / voice talk
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        if (!isVoiceMode) {
          startChatLive();
        } else {
          setMicMuted(prev => !prev);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isVoiceMode]);

  useEffect(() => {
    if (!isVoiceMode) {
      if (voiceSessionRef.current) {
        voiceSessionRef.current.stop();
        voiceSessionRef.current = null;
      }
      return;
    }

    let session = voiceSessionRef.current;
    if (!session) {
      session = new VoiceSession();
      voiceSessionRef.current = session;
    }

    if (!micMuted) {
      session.start({
        isSpeaking: () => Boolean(isSpeakingRef.current),
        language: state.settings.voiceLanguage,
        onInterim: text => {
          setUserSubtitle(text);
          setLiveTranscript(text);
        },
        onFinal: text => {
          if (text.trim() && isPhantomOrSelfEcho(text, settingsRef.current)) { setLiveTranscript(''); return; }
          setUserSubtitle(text);
          setLiveTranscript('');
          if (text.trim() && isStopCommand(text)) {
            const busy = isSpeakingNow() || conversationBusyRef.current || hasInterruptedSpeech();
            if (stopWordAction({ mode: 'live-chat', busy }) === 'end-live') { clearInterruptedSpeech(); console.info(`[barge-in] stop command "${text.trim()}" while idle -> ending Live Talk`); endChatLive('stopword'); }
            else handleStopCommand(text);
            return;
          }
          if (text.trim() && !conversationBusyRef.current) {
            setBotSubtitle('');
            // Same routing as the overlay: only a clear screen request (and only with screen assist ON) starts the screenshot flow.
            runChatVoiceTurn(text, Boolean(settingsRef.current.screenAssistEnabled), api);
          }
        },
        onAudioLevel: level => {
          setAudioLevel(level);
        },
        getBargeInSensitivity: () => settingsRef.current.bargeInSensitivity ?? DEFAULT_BARGE_IN_SENSITIVITY,
        onBargeIn: handleBargeIn,
        onUnclear: handleUnclear,
        onError: message => {
          console.warn(`[voice] chat mic error: ${message}`);
          setError('The microphone could not start. Check the microphone permission and try again.');
          endChatLive('error');
        },
      });
    } else {
      session.stop();
      voiceSessionRef.current = null;
    }

    return () => {
      if (!isVoiceMode) {
        voiceSessionRef.current?.stop();
        voiceSessionRef.current = null;
      }
    };
  }, [isVoiceMode, micMuted, state.settings.voiceLanguage]);

  useEffect(() => {
    const last = conversation.messages[conversation.messages.length - 1];
    if (last && last.role === 'assistant') {
      setBotSubtitle(last.text || (conversation.busy ? 'Thinking with you...' : ''));
    }
  }, [conversation.messages, conversation.busy]);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setMutedPreference(next);
    if (next) stopSpeaking('mute');
  };

  useEffect(() => {
    if (muted) return;
    // CRUCIAL: If Overlay is in Live Talk, do NOT duplicate speech from Chat window!
    if (state.voiceActiveTarget === 'overlay') return;
    const lastMsg = conversation.messages[conversation.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.status === 'complete' && lastMsg.text) {
      if (lastSpokenId.current !== lastMsg.id) {
        lastSpokenId.current = lastMsg.id;
        void speak(lastMsg.spoken ?? lastMsg.text);
      }
    }
  }, [conversation.messages, muted, state.voiceActiveTarget]);

  useEffect(() => {
    if (!api) return;
    alive.current = true;
    const update = (next: ChatState) => { if (alive.current) setConversation(previous => next.revision >= previous.revision ? next : previous); };
    const unsubscribeChat = api.onChat(update);
    const unsubscribeAI = api.onAI(next => { if (alive.current) setAI(next); });
    const unsubscribeTools = api.onToolApproval(event => {
      if (!alive.current) return;
      setToolApprovals(previous => event.type === 'request'
        ? [...previous.filter(request => request.id !== event.request.id), event.request]
        : previous.filter(request => request.id !== event.id));
    });
    void api.getToolApprovals().then(list => { if (alive.current) setToolApprovals(list); }).catch(() => {});
    void api.getMessages().then(update).catch(() => setError('Your conversation could not be opened.'));
    const refreshAI = () => { void api.getAI().then(next => { if (alive.current) setAI(next); }).catch(() => {}); };
    const focus = () => { input.current?.focus(); refreshAI(); };
    void api.checkAI().then(next => { if (alive.current) setAI(next); }).catch(() => {});
    window.addEventListener('focus', focus); focus();
    return () => {
      alive.current = false;
      unsubscribeChat();
      unsubscribeAI();
      unsubscribeTools();
      window.removeEventListener('focus', focus);
    };
  }, []);

  useEffect(() => { viewport.current?.scrollTo({ top: viewport.current.scrollHeight, behavior: 'instant' }); }, [conversation]);

  const send = async (event: FormEvent) => {
    event.preventDefault(); if (!api || !draft.trim() || sending) return;
    const text = draft.trim(); setSubmitting(true); setError('');
    try {
      const result = await api.sendMessage(text);
      if (alive.current) { if (result.ok) setDraft(''); else setError(result.error ?? 'Could not send your message.'); }
    } catch { if (alive.current) setError('Could not send your message. Please try again.'); }
    finally { if (alive.current) { setSubmitting(false); input.current?.focus(); } }
  };

  const retry = () => {
    const last = [...conversation.messages].reverse().find(message => message.role === 'user');
    if (last) { setDraft(last.text); setError(''); input.current?.focus(); }
  };

  const toggleMode = async () => {
    if (!api) return;
    const nextMode = ai.mode === 'local' ? 'cloud' : 'local';
    try {
      const res = await api.setAIMode(nextMode);
      if (res.ok) setAI(prev => ({ ...prev, mode: nextMode }));
      else setError(res.error ?? 'Could not switch mode.');
    } catch {
      setError('Could not switch AI mode.');
    }
  };

  const applyModel = async (selectedModel: string) => {
    if (!api) return;
    setConfirmHeavy(null);
    try {
      const res = await api.selectModel(selectedModel);
      if (res.ok) setAI(prev => ({ ...prev, model: selectedModel }));
      else setError(res.error ?? 'Could not change model.');
    } catch {
      setError('Could not change model.');
    }
  };

  const handleModelSelect = (selectedModel: string) => {
    if (!selectedModel) return;
    const meta = ai.modelSizes[selectedModel];
    if (meta?.heavy) {
      setConfirmHeavy(selectedModel);
    } else {
      void applyModel(selectedModel);
    }
  };

  const isCloudReady = ai.cloud.apiKeySet;
  const isOnline = ai.mode === 'cloud' ? isCloudReady : ai.connected;

  return <main className="app-window chat-window">
    <WindowHeader subtitle="A little closer, when it counts"/>
    <div className="preview-bar">
      <span className={`presence-dot ${isOnline ? '' : 'is-paused'}`} />
      <button
        type="button"
        className="chat-mode-pill"
        onClick={() => void toggleMode()}
        title={`Click to switch to ${ai.mode === 'local' ? 'Cloud API' : 'Local Ollama'}`}
      >
        {ai.mode === 'local' ? 'LOCAL' : 'CLOUD'}
      </button>

      {ai.mode === 'local' ? (
        <select
          id="chat-model-select"
          className="chat-model-select"
          value={ai.models.includes(ai.model) ? ai.model : ''}
          disabled={conversation.busy || !ai.connected || !ai.models.length}
          onChange={e => handleModelSelect(e.target.value)}
          title="Switch local model"
          aria-label="Local AI model"
        >
          {!ai.models.includes(ai.model) && <option value="">Select model…</option>}
          {ai.models.map(m => {
            const meta = ai.modelSizes[m];
            const isRecommended = /3b|2b/i.test(m);
            const badge = meta ? ` (${isRecommended ? 'Recommended · ' : meta.heavy ? 'Heavy · ' : ''}${meta.sizeLabel})` : '';
            return <option key={m} value={m}>{m}{badge}</option>;
          })}
        </select>
      ) : (
        <div className="chat-cloud-info" title={`${ai.cloud.provider} · ${ai.cloud.model}`}>
          <span>{ai.cloud.model || 'Cloud API'}</span>
          {!isCloudReady && (
            <button type="button" className="chat-cloud-action" onClick={() => void api?.openSettings()}>
              Add API key
            </button>
          )}
        </div>
      )}

      {state.systemMemory && (
        <span
          className={`chat-stat-badge ${state.systemMemory.isHeavy ? 'heavy' : ''}`}
          title={`Laptop Memory Usage: ${Math.round(state.systemMemory.percent)}%`}
        >
          RAM {Math.round(state.systemMemory.percent)}%
        </span>
      )}
      {state.pomodoro && state.pomodoro.status !== 'idle' && (
        <span
          className="chat-stat-badge pomodoro"
          title={`Focus session timer: ${state.pomodoro.minutesLeft}m ${state.pomodoro.secondsLeft}s left`}
        >
          ⏳ {state.pomodoro.minutesLeft}:{state.pomodoro.secondsLeft < 10 ? '0' : ''}{state.pomodoro.secondsLeft}
        </span>
      )}

      {state.settings.screenAssistEnabled && (
        <button
          type="button"
          className="icon-button chat-voice-btn"
          aria-label="Look at my screen"
          title="👀 Meri screen dekho (screenshot AI ko bheja jata hai)"
          disabled={sending}
          onClick={() => {
            void api?.sendScreen({ text: draft.trim(), source: 'button' }).then(result => {
              if (result.ok) setDraft('');
              else setError(result.error ?? 'Screen capture failed.');
            });
          }}
        >
          <span aria-hidden="true">👀</span>
        </button>
      )}

      <button
        type="button"
        className={`icon-button chat-voice-btn ${muted ? 'is-muted' : ''}`}
        aria-label={muted ? 'Unmute Sudo-chan voice' : 'Mute Sudo-chan voice'}
        onClick={toggleMute}
        title={muted ? 'Sudo-chan Voice is muted (click to unmute)' : 'Sudo-chan Voice is active (click to mute)'}
      >
        <Icon name={muted ? 'volume-off' : 'volume'} size={15} />
      </button>

      <button className="icon-button chat-ai-settings-btn" aria-label="AI Settings" onClick={() => void api?.openSettings()}>
        <Icon name="settings" size={14} />
      </button>
    </div>

    {voiceLimitUntil !== null && voiceLimitUntil > Date.now() && (
      <div className="chat-usage-note" role="status">Realistic voice limit reached today - using basic voice until {formatResetLabel(voiceLimitUntil, Date.now())}</div>
    )}

    {confirmHeavy && (
      <div className="chat-heavy-banner" role="alert">
        <p>
          {ai.modelSizes[confirmHeavy]?.warning ||
            `⚠️ ${confirmHeavy} bohot heavy hai, laptop hang ho sakta hai. Fast chalane ke liye qwen2.5:0.5b ya Cloud API use karein.`}
        </p>
        <div className="chat-heavy-actions">
          <button type="button" className="heavy-btn confirm" onClick={() => void applyModel(confirmHeavy)}>
            Switch anyway
          </button>
          <button type="button" className="heavy-btn cancel" onClick={() => setConfirmHeavy(null)}>
            Cancel
          </button>
        </div>
      </div>
    )}

    {isVoiceMode ? (
      <div className="chat-voice-stage" role="region" aria-label="Voice conversation with Sudo-chan">
        <div className={`voice-status-pill ${state.isSpeaking ? 'speaking' : conversation.busy ? 'thinking' : 'listening'}`}>
          <span className="voice-status-dot" />
          {state.isSpeaking
            ? '🔊 Sudo-chan bol rahi hai...'
            : conversation.busy
            ? '✨ Soch rahi hai...'
            : '🎙️ Sid bolain, Sudo-chan sun rahi hai'}
        </div>

        {/* Live Talk Visualizer Mode Switcher (Sudo-chan Character / ChatGPT Sonic Orb) */}
        <div className="voice-visualizer-toggle">
          <button
            type="button"
            className={`viz-toggle-btn ${activeVisualizer === 'bot' ? 'active' : ''}`}
            onClick={() => {
              setActiveVisualizer('bot');
              void api?.saveSettings({ voiceVisualizerMode: 'bot' }, 'chat');
            }}
            title="Sudo-chan Bot Character"
          >
            🤖 Sudo-chan
          </button>
          <button
            type="button"
            className={`viz-toggle-btn ${activeVisualizer === 'orb' ? 'active' : ''}`}
            onClick={() => {
              setActiveVisualizer('orb');
              void api?.saveSettings({ voiceVisualizerMode: 'orb' }, 'chat');
            }}
            title="ChatGPT Sonic Fluid Orb"
          >
            🫧 Sonic Orb
          </button>
        </div>

        <div className="voice-avatar-stage">
          {activeVisualizer === 'orb' ? (
            <SonicOrb
              isSpeaking={lip.speaking}
              isBusy={conversation.busy}
              audioLevel={lip.speaking ? lip.level : audioLevel}
              size={210}
              onClick={() => setMicMuted(prev => !prev)}
            />
          ) : (
            <>
              <div className="voice-ripples">
                <span className="voice-ripple voice-ripple-1" />
                <span className="voice-ripple voice-ripple-2" />
                <span className="voice-ripple voice-ripple-3" />
              </div>
              <Bot
                mood={state.mood}
                paused={state.paused}
                voiceActive={true}
                isSpeaking={lip.speaking}
                audioLevel={lip.speaking ? lip.level : audioLevel}
                glasses={state.settings.glassesEnabled ?? true}
              />
            </>
          )}
        </div>

        <div className="voice-wave-dots">
          {[1, 2, 3, 4, 5].map(i => (
            <span
              key={i}
              className={`wave-dot ${state.isSpeaking || audioLevel > 0.05 ? 'dancing' : ''}`}
            />
          ))}
        </div>

        <div className="voice-subtitles-card">
          <div className="voice-subtitle-item">
            <span className="voice-subtitle-speaker user">🗣️ Aap (Sid):</span>
            <div className="voice-subtitle-text">{userSubtitle || 'Kuch bolain ya sawal poochein...'}</div>
          </div>
          <div className="voice-subtitle-item">
            <span className="voice-subtitle-speaker">💙 Sudo-chan:</span>
            <div className="voice-subtitle-text">
              {conversation.busy
                ? '✨ Soch rahi hoon...'
                : (botSubtitle || (conversation.error ? `⚠️ ${conversation.error}` : 'Main sun rahi hoon, boliye Sid!'))}
            </div>
          </div>
        </div>

        <div className="voice-controls">
          <button
            type="button"
            className="voice-ctrl-btn"
            onClick={() => setMicMuted(prev => !prev)}
            title={micMuted ? 'Unmute microphone' : 'Mute microphone'}
          >
            <Icon name={micMuted ? 'mic-off' : 'mic'} size={15} />
            {micMuted ? 'Mic Unmute' : 'Mic Mute'}
          </button>
          <button
            type="button"
            className="voice-ctrl-btn end-call"
            onClick={() => endChatLive('click')}
            title="End Live Talk now and go back to typing"
          >
            <Icon name="phone-off" size={15} />
            End Live Talk
          </button>
        </div>
      </div>
    ) : (
      <>
        <TasksPanel/>
        <div className="chat-viewport soft-scroll" ref={viewport} role="log" aria-label="Your conversation" aria-live="polite">
          {!conversation.messages.length ? (
            <div className="chat-welcome">
              <div className="welcome-orbit">
                <Bot mood={state.mood} paused={state.paused} glasses={state.settings.glassesEnabled ?? true} />
                <span className="orbit-spark"><Icon name="spark" size={15} /></span>
              </div>
              <span className="eyebrow">YOUR LITTLE CORNER OF CALM</span>
              <h1>Big thoughts.<br /><em>A little company.</em></h1>
              <p>Real AI, right here on your computer.<br />Start wherever you are.</p>
              <div className="suggestion-list">
                {['Assalam o Alaikum! Kya haal hai?', 'Mujhe thori encouragement do', 'Help me break a task into steps'].map(text => (
                  <button key={text} onClick={() => { setDraft(text); input.current?.focus(); }}>{text}<Icon name="arrow" size={15} /></button>
                ))}
              </div>
            </div>
          ) : (
            <div className="message-list">
              {conversation.messages.map(message => (
                <article key={message.id} className={`message message-${message.role}`}>
                  <span className="message-author">
                    {message.role === 'user' ? 'YOU' : 'SUDO-CHAN'}
                    {message.status === 'stopped' && <span>STOPPED</span>}
                    {message.status === 'error' && <span>INCOMPLETE</span>}
                  </span>
                  {message.attachment && (
                    <figure className="message-shot">
                      <img src={message.attachment.thumbnail} alt="Screenshot sent to the AI" />
                      <figcaption>📸 Ye screen AI provider ko bheji gayi</figcaption>
                    </figure>
                  )}
                  {message.text ? (
                    <p>{message.text}</p>
                  ) : message.status === 'streaming' ? (
                    <ThinkingIndicator />
                  ) : (
                    <p>{message.status === 'stopped' ? 'Reply stopped.' : 'No reply received.'}</p>
                  )}
                </article>
              ))}
              {liveTranscript && (
                <article className="message message-user live-transcript-bubble">
                  <span className="message-author">
                    YOU <span className="voice-badge">🎙️ Voice input...</span>
                  </span>
                  <p>{liveTranscript}</p>
                </article>
              )}
            </div>
          )}
        </div>
        <ToolApprovalCards approvals={toolApprovals} busy={Boolean(state.settings.toolsEnabled) && sending} />
        <div className="composer-area">
          {(error || conversation.error) && (
            <div className="chat-error">
              <p className="inline-error" role="alert">{error || conversation.error}</p>
              {!sending && conversation.error && <button type="button" className="text-button" onClick={retry}>Use last message again</button>}
              <button type="button" className="text-button" onClick={() => void api?.openSettings()}>AI settings</button>
            </div>
          )}
          <form className="composer" onSubmit={send}>
            <label className="sr-only" htmlFor="message">Your message</label>
            <textarea
              id="message"
              ref={input}
              value={draft}
              onChange={event => setDraft(event.target.value)}
              maxLength={MAX_MESSAGE_LENGTH}
              rows={2}
              placeholder="What’s on your mind? Roman Urdu ya English..."
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="composer-bottom">
              <span>
                <Icon name="shield" size={13}/>
                {ai.mode === 'local' ? 'Local · session only' : 'Cloud API · direct HTTPS'}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  type="button"
                  className="composer-call-btn composer-voice-btn"
                  onClick={startChatLive}
                  aria-label="Live Talk here"
                  title="Live Talk here: talk to her by voice in this window. Typing stays the default; the mic opens only when you click this."
                >
                  <Icon name="mic" size={14} />
                  Voice
                </button>
                {conversation.busy ? (
                  <button className="stop-button" type="button" onClick={() => void api?.stopReply().catch(() => setError('Could not stop the reply. Try again.'))}>
                    Stop reply
                  </button>
                ) : (
                  <button className="send-button" type="submit" disabled={!draft.trim() || submitting} aria-label="Send message">
                    <Icon name="send" size={18}/>
                  </button>
                )}
              </div>
            </div>
          </form>

          {/* Voice States Bar under the input: Listening / Thinking / Speaking */}
          <div className="voice-state-bar">
            {state.isSpeaking ? (
              <>
                <span className="voice-state-badge speaking">
                  <span className="state-pulse" />
                  🔊 Speaking...
                </span>
                <div className="voice-state-actions">
                  <button
                    type="button"
                    className="voice-pill-btn danger"
                    onClick={() => {
                      stopSpeech();
                      void api?.stopReply();
                    }}
                  >
                    Stop speaking
                  </button>
                </div>
              </>
            ) : conversation.busy ? (
              <>
                <span className="voice-state-badge thinking">
                  <span className="state-pulse" />
                  ✨ Thinking...
                </span>
                <div className="voice-state-actions">
                  <button
                    type="button"
                    className="voice-pill-btn"
                    onClick={() => void api?.stopReply()}
                  >
                    Stop
                  </button>
                </div>
              </>
            ) : (isVoiceMode && !micMuted) ? (
              <>
                <span className="voice-state-badge listening">
                  <span className="state-pulse" />
                  🎙️ Listening...
                  <span className="voice-meter-mini" title={`Mic level: ${Math.round(audioLevel * 100)}%`}>
                    <span className="voice-meter-fill" style={{ width: `${Math.round(audioLevel * 100)}%` }} />
                  </span>
                </span>
                <div className="voice-state-actions">
                  <span style={{ fontSize: '10px', color: '#64748b' }}>Ctrl+M to mute</span>
                  <button
                    type="button"
                    className="voice-pill-btn"
                    onClick={() => setMicMuted(true)}
                  >
                    Mute
                  </button>
                </div>
              </>
            ) : null}
          </div>

          <p className="composer-note">AI can make mistakes. The microphone stays closed while you type; it opens only when you click Voice.</p>
        </div>
      </>
    )}
  </main>;
}
function SettingRow({ title, description, children }: { title: string; description: string; children: ReactNode }) { return <div className="setting-row"><div><h3>{title}</h3><p>{description}</p></div>{children}</div>; }
function SettingsView({ state }: { state: AppState }) {
  const [settings, setSettings] = useState<Settings>(state.settings);
  const [notice, setNotice] = useState('');
  const [isError, setIsError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const keyStorage = useKeyStorageInfo();
  const [activeSection, setActiveSection] = useState('presence');
  const settingsScroll = useRef<HTMLDivElement>(null);

  const [recordingSample, setRecordingSample] = useState(false);
  const [recordRemaining, setRecordRemaining] = useState(5);
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfile | null>(getVoiceProfile);
  const [playingSample, setPlayingSample] = useState(false);

  const startRecordVoice = async () => {
    if (recordingSample) return;
    setRecordingSample(true);
    setRecordRemaining(5);
    try {
      const result = await recordVoiceSample(5000, sec => setRecordRemaining(sec));
      setVoiceProfile(result.profile);
      const updated = {
        ...settings,
        registeredVoiceSample: result.profile.id,
      };
      setSettings(updated);
      void api?.saveSettings({ registeredVoiceSample: result.profile.id }, 'settings');
      setNotice("Sid's voice profile recorded and registered successfully!");
      setIsError(false);
    } catch (e) {
      setIsError(true);
      setNotice('Microphone access failed: ' + (e as Error).message);
    } finally {
      setRecordingSample(false);
    }
  };

  const playRecordedSample = async () => {
    if (!voiceProfile?.audioDataUri || playingSample) return;
    setPlayingSample(true);
    try {
      if (api?.playAudio) {
        await api.playAudio(voiceProfile.audioDataUri);
      }
      try {
        const audio = new Audio(voiceProfile.audioDataUri);
        await audio.play();
      } catch {}
    } finally {
      setTimeout(() => setPlayingSample(false), 2500);
    }
  };

  const dirty = settings.botSize !== state.settings.botSize ||
    settings.shortcut !== state.settings.shortcut ||
    settings.launchAtLogin !== state.settings.launchAtLogin ||
    settings.pomodoroEnabled !== state.settings.pomodoroEnabled ||
    settings.pomodoroMinutes !== state.settings.pomodoroMinutes ||
    settings.voiceLockEnabled !== state.settings.voiceLockEnabled ||
    settings.registeredVoiceSample !== state.settings.registeredVoiceSample ||
    settings.customWakeWord !== state.settings.customWakeWord ||
    settings.wakeWordEnabled !== state.settings.wakeWordEnabled ||
    settings.voiceLanguage !== state.settings.voiceLanguage ||
    settings.screenAssistEnabled !== state.settings.screenAssistEnabled ||
    settings.screenAssistCountdown !== state.settings.screenAssistCountdown ||
    settings.liveAwareness !== state.settings.liveAwareness ||
    settings.liveKeepAnEye !== state.settings.liveKeepAnEye ||
    settings.sttSpeed !== state.settings.sttSpeed ||
    JSON.stringify(settings.wakeAliases) !== JSON.stringify(state.settings.wakeAliases) ||
    settings.voiceVisualizerMode !== state.settings.voiceVisualizerMode ||
    settings.glassesEnabled !== state.settings.glassesEnabled ||
    settings.toolsEnabled !== state.settings.toolsEnabled ||
    settings.bargeInSensitivity !== state.settings.bargeInSensitivity ||
    settings.localWake !== state.settings.localWake ||
    settings.localWakeSensitivity !== state.settings.localWakeSensitivity ||
    settings.updateCheckEnabled !== state.settings.updateCheckEnabled ||
    settings.ttsProvider !== state.settings.ttsProvider ||
    settings.ttsQuality !== state.settings.ttsQuality ||
    settings.ttsGeminiVoice !== state.settings.ttsGeminiVoice ||
    settings.ttsAzureVoice !== state.settings.ttsAzureVoice ||
    settings.ttsAzureRomanUrdu !== state.settings.ttsAzureRomanUrdu ||
    settings.ttsSpeed !== state.settings.ttsSpeed;
  useEffect(() => setSettings(state.settings), [
    state.settings.botSize,
    state.settings.shortcut,
    state.settings.launchAtLogin,
    state.settings.pomodoroEnabled,
    state.settings.pomodoroMinutes,
    state.settings.voiceLockEnabled,
    state.settings.registeredVoiceSample,
    state.settings.customWakeWord,
    state.settings.wakeWordEnabled,
    state.settings.voiceLanguage,
    state.settings.screenAssistEnabled,
    state.settings.screenAssistCountdown,
    state.settings.liveAwareness,
    state.settings.liveKeepAnEye,
    state.settings.sttSpeed,
    JSON.stringify(state.settings.wakeAliases),
    state.settings.voiceVisualizerMode,
    state.settings.glassesEnabled,
    state.settings.toolsEnabled,
    state.settings.bargeInSensitivity,
    state.settings.localWake,
    state.settings.localWakeSensitivity,
    state.settings.updateCheckEnabled,
    state.settings.ttsProvider,
    state.settings.ttsQuality,
    state.settings.ttsGeminiVoice,
    state.settings.ttsAzureVoice,
    state.settings.ttsAzureRomanUrdu,
    state.settings.ttsSpeed,
  ]);
  useEffect(() => {
    const root = settingsScroll.current;
    if (!root) return;
    const observer = new IntersectionObserver(entries => {
      const visible = entries.find(entry => entry.isIntersecting);
      if (visible) setActiveSection(visible.target.id);
    }, { root, rootMargin: '-12% 0px -58% 0px', threshold: 0 });
    const selectFirstAtTop = () => { if (root.scrollTop < 32) setActiveSection('presence'); };
    root.querySelectorAll('.settings-card').forEach(section => observer.observe(section));
    root.addEventListener('scroll', selectFirstAtTop, { passive: true });
    return () => { observer.disconnect(); root.removeEventListener('scroll', selectFirstAtTop); };
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!api || saving) return;
    setSaving(true); setNotice('');
    try { const result = await api.saveSettings(changedSettings(state.settings, settings), 'settings'); setIsError(!result.ok); setNotice(result.ok ? 'All settled. Your space, your way.' : result.error ?? 'Could not save settings.'); }
    catch { setIsError(true); setNotice('Could not save. Please try again.'); }
    finally { setSaving(false); }
  };
  const clear = async () => {
    if (!confirmClear) { setConfirmClear(true); return; }
    try { await api?.clearMessages(); setNotice('Conversation cleared from this session.'); setIsError(false); setConfirmClear(false); }
    catch { setNotice('Could not clear your conversation.'); setIsError(true); }
  };
  return <main className="app-window settings-window"><WindowHeader subtitle="Your companion studio" settings/>
    <div className="settings-scroll soft-scroll" ref={settingsScroll}>
      <section className="settings-hero"><div className="settings-hero-copy"><span className="eyebrow"><span className="tiny-star" aria-hidden="true">✧</span>MAKE ROOM FOR A LITTLE MAGIC</span><h1>Quietly <em>yours.</em></h1><p>A little company. A space that feels like you.</p><span className="phase-pill"><span className={`presence-dot ${state.paused ? 'is-paused' : ''}`}/>{state.paused ? 'Taking a breath' : 'Here with you'}<span className="phase-divider"/>LOCAL AI</span></div><div className="settings-hero-stage"><span className="hero-orbit" aria-hidden="true"/><span className="hero-spark" aria-hidden="true">✦</span><div className="settings-hero-bot" data-size={settings.botSize}><Bot mood={state.paused ? 'calm' : 'happy'} paused={state.paused} glasses={settings.glassesEnabled ?? true}/></div><span className="hero-caption">YOUR DESKTOP, A LITTLE WARMER</span></div></section>
      <nav className="section-tabs" aria-label="Settings sections">{[{ id: 'presence', title: 'Your companion', icon: 'spark' as const }, { id: 'rhythm', title: 'Your rhythm', icon: 'pause' as const }, { id: 'voice-identity', title: 'Voice Identity', icon: 'voice-call' as const }, { id: 'usage', title: 'Free usage', icon: 'spark' as const }, { id: 'ai', title: 'Local AI', icon: 'chat' as const }, { id: 'privacy', title: 'Your privacy', icon: 'shield' as const }].map(section => <a key={section.id} href={`#${section.id}`} aria-current={activeSection === section.id ? 'location' : undefined} onClick={() => setActiveSection(section.id)}><Icon name={section.icon} size={16}/>{section.title}</a>)}</nav>
      <form id="settings-form" onSubmit={save}>
        <section id="presence" className="settings-card scroll-reveal"><div className="card-heading"><span className="section-icon mint"><Icon name="spark"/></span><div><span className="eyebrow">01 / A LITTLE PRESENCE</span><h2>Your companion</h2></div></div>
          <SettingRow title="A comfortable size" description="A small friend, with just enough room to glow."><div className="size-picker" role="group" aria-label="Companion size">{(['small', 'medium', 'large'] as BotSize[]).map(size => <button type="button" key={size} aria-label={size} className={settings.botSize === size ? 'selected' : ''} aria-pressed={settings.botSize === size} onClick={() => setSettings({ ...settings, botSize: size })}><span className={`size-orb size-${size}`}/>{size}</button>)}</div></SettingRow>
          <SettingRow title="Cute white glasses" description="Give Sudo-chan her signature round smart glasses.">
            <div className="switch-control">
              <span>{(settings.glassesEnabled ?? true) ? 'On' : 'Off'}</span>
              <button
                className="switch"
                type="button"
                role="switch"
                aria-label="Glasses on/off"
                aria-checked={settings.glassesEnabled ?? true}
                onClick={() => setSettings({ ...settings, glassesEnabled: !(settings.glassesEnabled ?? true) })}
              >
                <span/>
              </button>
            </div>
          </SettingRow>
          <SettingRow title="Back to a familiar place" description="Move her to the bottom-right of your main screen."><button className="soft-button" type="button" onClick={() => void api?.resetPosition()}><Icon name="reset" size={15}/>Reset position</button></SettingRow>
          <div className="gentle-note"><Icon name="chat" size={16}/><p>Drag the three little dots above her head. Click her to say hello; double-click to chat.</p></div>
        </section>
        <section id="rhythm" className="settings-card scroll-reveal"><div className="card-heading"><span className="section-icon lilac"><Icon name="pause"/></span><div><span className="eyebrow">02 / AT YOUR OWN PACE</span><h2>Your rhythm</h2></div></div>
          <SettingRow title="One shortcut away" description="Open your chat from anywhere. Use modifier + key."><label className="shortcut-label"><span className="sr-only">Chat shortcut</span><input aria-describedby="shortcut-help" value={settings.shortcut} onChange={event => setSettings({ ...settings, shortcut: event.target.value })} spellCheck={false}/></label></SettingRow><p id="shortcut-help" className={`field-hint ${!state.shortcutAvailable ? 'warning' : ''}`}>{state.shortcutAvailable ? 'Current shortcut is ready. Example: Control+Shift+Space' : 'The current shortcut is unavailable. Choose another, or open chat from the tray.'}</p>
          <SettingRow title="Let Sudo-chan use tools" description="Off by default. When on, she can read files in your home folder, and ask to write files, run one program, or open links. Every risky action shows a card and waits for your click (auto-denied after 60 s). Voice never approves. Secrets (.ssh, .env, browser data) are blocked. Every call is logged on this device. Works with cloud models only.">
            <div className="switch-control"><span>{settings.toolsEnabled ? 'On' : 'Off'}</span><button className="switch" type="button" role="switch" aria-label="Let Sudo-chan use tools" aria-checked={Boolean(settings.toolsEnabled)} onClick={() => setSettings({ ...settings, toolsEnabled: !settings.toolsEnabled })}><span/></button></div>
          </SettingRow>
          <SettingRow title="Stop all actions" description="Cancels anything waiting for approval or still running, right now.">
            <button type="button" className="soft-button" onClick={() => void api?.stopAllTools()}>⛔ Stop all actions</button>
          </SettingRow>
          <SettingRow title="Start the day together" description={state.loginSupported ? 'Open Sudo-chan when you sign in.' : 'Available after installing the desktop app.'}><div className="switch-control"><span>{settings.launchAtLogin ? 'On' : 'Off'}</span><button className="switch" type="button" role="switch" aria-label="Launch at login" aria-checked={settings.launchAtLogin} disabled={!state.loginSupported} onClick={() => setSettings({ ...settings, launchAtLogin: !settings.launchAtLogin })}><span/></button></div></SettingRow>
          <SettingRow title="Focus Reminder (Pomodoro)" description="Remind you to rest your eyes and drink water after focused work.">
            <div className="switch-control">
              <span>{(settings.pomodoroEnabled ?? true) ? 'On' : 'Off'}</span>
              <button
                className="switch"
                type="button"
                role="switch"
                aria-label="Toggle focus reminders"
                aria-checked={settings.pomodoroEnabled ?? true}
                onClick={() => setSettings({ ...settings, pomodoroEnabled: !(settings.pomodoroEnabled ?? true) })}
              >
                <span/>
              </button>
            </div>
          </SettingRow>
          <SettingRow title="Focus Session Duration" description={`Timer duration before break reminder (Current: ${settings.pomodoroMinutes ?? 25} minutes).`}>
            <div className="duration-picker">
              {[15, 20, 25, 45, 60].map(mins => (
                <button
                  type="button"
                  key={mins}
                  className={`duration-chip ${(settings.pomodoroMinutes ?? 25) === mins ? 'selected' : ''}`}
                  onClick={() => setSettings({ ...settings, pomodoroMinutes: mins })}
                >
                  {mins}m
                </button>
              ))}
              <input
                type="number"
                min={1}
                max={180}
                className="custom-mins-input"
                value={settings.pomodoroMinutes ?? 25}
                onChange={e => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val) && val >= 1 && val <= 180) {
                    setSettings({ ...settings, pomodoroMinutes: val });
                  }
                }}
                title="Custom minutes"
              />
              <span className="mins-label">mins</span>
            </div>
          </SettingRow>
          <SettingRow title="Take a little pause" description="Close her eyes and pause animation. Chat stays available."><div className="switch-control"><span>{state.paused ? 'Paused' : 'Active'}</span><button className="switch" type="button" role="switch" aria-label="Pause companion preview" aria-checked={state.paused} onClick={() => void api?.setPaused(!state.paused)}><span/></button></div></SettingRow>
        </section>
        <section id="voice-identity" className="settings-card scroll-reveal">
          <div className="card-heading">
            <span className="section-icon mint"><Icon name="voice-call"/></span>
            <div>
              <span className="eyebrow">03 / YOUR VOICE & IDENTITY</span>
              <h2>Voice Lock & Wake Word</h2>
            </div>
          </div>
          <div className="voice-record-card">
            <div className="voice-record-row">
              <div>
                <h4 style={{ margin: '0 0 4px', fontSize: '13px', color: '#e8f1f5' }}>Sid's Voice Sample (Acoustic Fingerprint)</h4>
                <p style={{ margin: 0, fontSize: '11px', color: '#92abb2' }}>
                  5 seconds ka sample record karein taake Sudo-chan aapki awaz pehchan sake.
                </p>
              </div>
              <button
                type="button"
                className={`voice-record-btn ${recordingSample ? 'recording' : ''}`}
                onClick={() => void startRecordVoice()}
                disabled={recordingSample}
              >
                <Icon name="mic" size={14} />
                {recordingSample ? `Recording... ${recordRemaining}s` : voiceProfile ? 'Re-record Voice' : 'Record My Voice (5s)'}
              </button>
            </div>
            {voiceProfile && (
              <div className="voice-record-row" style={{ paddingTop: '8px', borderTop: '1px solid #1f3745' }}>
                <span className="voice-sample-badge">
                  ✓ Sid's Voice Profile Registered ({voiceProfile.avgPitch} Hz fundamental pitch)
                </span>
                {voiceProfile.audioDataUri && (
                  <button type="button" className="voice-play-btn" onClick={playRecordedSample} disabled={playingSample}>
                    {playingSample ? '🔊 Playing...' : '▶ Listen Preview'}
                  </button>
                )}
              </div>
            )}
          </div>
          <SettingRow
            title="Personal Voice Activation (Voice Lock)"
            description="Sirf aapki (Sid ki registered awaz) sun kar bot active hogi."
          >
            <div className="switch-control">
              <span>{(settings.voiceLockEnabled ?? false) ? 'On' : 'Off'}</span>
              <button
                className="switch"
                type="button"
                role="switch"
                aria-label="Toggle personal voice lock"
                aria-checked={settings.voiceLockEnabled ?? false}
                onClick={() => setSettings({ ...settings, voiceLockEnabled: !(settings.voiceLockEnabled ?? false) })}
              >
                <span/>
              </button>
            </div>
          </SettingRow>
          <SettingRow title="Listen for my name" description="Off by default. When on, the mic listens locally and only short clips with speech are sent to speech-to-text. Pause any time from the bot's indicator.">
            <div className="switch-control"><span>{(settings.wakeWordEnabled ?? true) ? 'On' : 'Off'}</span><button className="switch" type="button" role="switch" aria-label="Listen for my name" aria-checked={Boolean(settings.wakeWordEnabled)} onClick={() => setSettings({ ...settings, wakeWordEnabled: !settings.wakeWordEnabled })}><span/></button></div>
          </SettingRow>
          <LocalWakeSettings settings={settings} setSettings={setSettings}/>
          <SettingRow title="Let Sudo-chan look at my screen" description="Off by default. When on, saying her name (or pressing the eye button in chat) takes ONE screenshot and sends it to your cloud AI provider so she can explain what you are working on. Never on a timer, never saved. Close password or banking windows first.">
            <div className="switch-control"><span>{settings.screenAssistEnabled ? 'On' : 'Off'}</span><button className="switch" type="button" role="switch" aria-label="Let Sudo-chan look at my screen" aria-checked={Boolean(settings.screenAssistEnabled)} onClick={() => setSettings({ ...settings, screenAssistEnabled: !settings.screenAssistEnabled })}><span/></button></div>
          </SettingRow>
          <SettingRow title="Countdown before the first screenshot" description="Shows 'Screenshot in 3...' with a cancel button before the first capture of a session, so you can close a sensitive window. She also refuses to capture when a password manager, bank, login or private window is visible (only windows that expose accessibility information can be seen).">
            <div className="switch-control"><span>{(settings.screenAssistCountdown ?? true) ? 'On' : 'Off'}</span><button className="switch" type="button" role="switch" aria-label="Countdown before the first screenshot" aria-checked={settings.screenAssistCountdown ?? true} onClick={() => setSettings({ ...settings, screenAssistCountdown: !(settings.screenAssistCountdown ?? true) })}><span/></button></div>
          </SettingRow>
          <SettingRow title="Let her know which window I am using (Live Talk)" description="Off by default. When on, during Live Talk she is told only the app name and window title in front of you (no screenshot, no screen contents), so she can help like someone sitting next to you. Windows that look like a password manager, bank or login are skipped. Never saved, never on a timer outside Live Talk.">
            <div className="switch-control"><span>{settings.liveAwareness === 'window' ? 'On' : 'Off'}</span><button className="switch" type="button" role="switch" aria-label="Let her know which window I am using during Live Talk" aria-checked={settings.liveAwareness === 'window'} onClick={() => setSettings({ ...settings, liveAwareness: settings.liveAwareness === 'window' ? 'off' : 'window' })}><span/></button></div>
          </SettingRow>
          <SettingRow
            title="Assistant name"
            description="The name you call her by. Spoken names are matched loosely (small mishearings are fine)."
          >
            <input
              type="text"
              className="wake-word-input"
              value={settings.customWakeWord ?? 'Sudo-chan'}
              onChange={e => setSettings({ ...settings, customWakeWord: e.target.value })}
              placeholder="e.g. Sudo"
            />
          </SettingRow>
          <SettingRow
            title="Name aliases"
            description="Other ways you call her, comma separated. Very short aliases must match exactly."
          >
            <input
              type="text"
              className="wake-word-input"
              value={(settings.wakeAliases ?? DEFAULT_WAKE_ALIASES).join(', ')}
              onChange={e => setSettings({ ...settings, wakeAliases: e.target.value.split(',').map(a => a.trim()).filter(Boolean).slice(0, 20) })}
              placeholder="Sudo, Sid, Sudo-chan"
            />
          </SettingRow>
          <SettingRow title="Speech recognition speed" description="Fast answers sooner (about 0.5 s) but may mishear Urdu. Accurate understands Urdu and Roman Urdu better but takes 2-3 s.">
            <select
              className="wake-word-input"
              value={settings.sttSpeed ?? 'fast'}
              onChange={e => setSettings({ ...settings, sttSpeed: e.target.value as 'accurate' | 'fast' })}
              aria-label="Speech recognition speed"
            >
              <option value="fast">Fast (Whisper first, Gemini if unsure)</option>
              <option value="accurate">Accurate (Gemini first)</option>
            </select>
          </SettingRow>
          <SettingRow
            title="Voice Recognition Language"
            description="Whisper & Live Talk transcription language preference (Auto-detects Urdu, Roman Urdu & English)."
          >
            <select
              className="wake-word-input"
              value={settings.voiceLanguage ?? 'auto'}
              onChange={e => setSettings({ ...settings, voiceLanguage: e.target.value as VoiceLanguage })}
              aria-label="Voice language"
            >
              <option value="auto">Auto</option>
              <option value="en">English</option>
              <option value="ur">Urdu</option>
            </select>
          </SettingRow>
        </section>
        <section id="companion-features" className="settings-card scroll-reveal">
          <div className="card-heading"><span className="section-icon mint"><Icon name="spark"/></span><div><span className="eyebrow">LIVE COMPANION TOOLS</span><h2>Voice, Focus & Laptop Health</h2></div></div>
          <SettingRow title="Voice Output (TTS)" description="Sudo-chan speaks replies aloud in natural Roman Urdu and English.">
            <button type="button" className="soft-button" onClick={() => void speak('Assalam o Alaikum Sid! Main Sudo-chan hoon, aapki desktop companion.')}>
              🔊 Test Voice Sound
            </button>
          </SettingRow>
          <SettingRow title="Voice engine" description="Auto tries Gemini first (very natural, but its free tier is only about 10 requests a day), then Azure Speech if you added a key below, then Google (unlimited but flat). A forced engine still falls back to Google if it fails.">
            <select className="wake-word-input" aria-label="Voice engine" value={settings.ttsProvider ?? 'auto'} onChange={event => setSettings({ ...settings, ttsProvider: event.target.value as Settings['ttsProvider'] })}>
              <option value="auto">Auto (Gemini, Azure, Google)</option>
              <option value="gemini">Gemini only</option>
              <option value="azure">Azure Speech only</option>
              <option value="google">Google only</option>
            </select>
          </SettingRow>
          <SettingRow title="Gemini voice" description="Voice used by the Gemini engine.">
            <select className="wake-word-input" aria-label="Gemini voice" value={settings.ttsGeminiVoice ?? 'Kore'} onChange={event => setSettings({ ...settings, ttsGeminiVoice: event.target.value })}>
              {['Kore', 'Puck', 'Zephyr', 'Aoede', 'Leda', 'Charon', 'Fenrir'].map(voice => <option key={voice} value={voice}>{voice}</option>)}
            </select>
          </SettingRow>
          <AzureVoiceSettings settings={settings} setSettings={setSettings}/>
          <SettingRow title="Speaking speed" description={`Gemini and Azure voice pace (${(settings.ttsSpeed ?? 1).toFixed(1)}x). Not applied to the Google engine.`}>
            <label className="shortcut-label"><span className="sr-only">Speaking speed</span><input type="range" min={0.7} max={1.4} step={0.1} value={settings.ttsSpeed ?? 1} onChange={event => setSettings({ ...settings, ttsSpeed: Number(event.target.value) })}/></label>
          </SettingRow>
          <SettingRow title="Barge-in sensitivity" description={`How easily you can interrupt Sudo-chan while she speaks (${Math.round((settings.bargeInSensitivity ?? DEFAULT_BARGE_IN_SENSITIVITY) * 100)}%). Raise it for headphones, lower it on speakers.`}>
            <label className="shortcut-label"><span className="sr-only">Barge-in sensitivity</span><input type="range" min={0} max={100} step={5} value={Math.round((settings.bargeInSensitivity ?? DEFAULT_BARGE_IN_SENSITIVITY) * 100)} onChange={event => setSettings({ ...settings, bargeInSensitivity: Number(event.target.value) / 100 })}/></label>
          </SettingRow>
          <SettingRow title="Pomodoro Focus Reminders" description={`25 min focus / 5 min break timer. ${state.pomodoro ? `${state.pomodoro.minutesLeft}m ${state.pomodoro.secondsLeft}s remaining` : 'Active'}.`}>
            <button type="button" className="soft-button" onClick={() => void api?.testFeature('break')}>
              🍵 Test Break Bubble
            </button>
          </SettingRow>
          <SettingRow title="System RAM Monitor" description={`Live laptop memory check. Current usage: ${state.systemMemory ? `${Math.round(state.systemMemory.percent)}%` : 'Active'}.`}>
            <button type="button" className="soft-button" onClick={() => void api?.testFeature('heavy')}>
              ⚠️ Test Heavy RAM Alert
            </button>
          </SettingRow>
        </section>
        <UsageSettings settings={settings} setSettings={setSettings}/>
        <AISettings/>
        <section id="privacy" className="settings-card privacy-card scroll-reveal">
          <div className="card-heading"><span className="section-icon peach"><Icon name="shield"/></span><div><span className="eyebrow">04 / YOUR SPACE STAYS YOURS</span><h2>Nothing behind the curtain.</h2></div></div>
          <p>In <strong>Local mode</strong>, your messages never leave this computer — all generation runs via Ollama on device with zero telemetry. In <strong>Cloud mode</strong>, your messages are sent securely via HTTPS directly to your chosen provider (Google Gemini, Groq, OpenAI, or OpenRouter) using your own API key. Keys are never sent to Sudo-chan servers.</p>
          <p className="key-storage-detail"><strong>How keys are stored:</strong> {keyStorage.detail}</p>
          <p><strong>Mic:</strong> only while listening is on. <strong>Screen:</strong> only after you click Allow and only while screen assist is on; the image goes to your cloud model and is never saved. <strong>Files:</strong> only while tools are on, and risky actions ask you first.</p>
          <div className="privacy-facts">
            <span><i/>Local chat stays on your machine</span>
            <span><i/>Cloud uses direct provider HTTPS</span>
            <span><i/>{keyStorage.fact}</span>
            <span><i/>Chat kept in memory until Quit</span>
          </div>
          <UpdateSettings settings={settings} setSettings={setSettings}/>
          <RemoveKeysRow/>
          <div className="privacy-bottom"><span>Want a fresh start?</span><button className="text-button" type="button" onClick={() => void clear()}>{confirmClear ? 'Confirm clear conversation' : 'Clear conversation'}</button></div>
        </section>
      </form>
      <footer className="settings-footer"><div className="brand-mark small">s<span/></div><div><b>A little less alone in it.</b><p>Sudo-chan · Made with care · {state.displayBackend || 'Desktop preview'}</p></div><button className="icon-button" aria-label="Quit Sudo-chan" onClick={() => void api?.quit()}><Icon name="power"/></button></footer>
    </div>
    <div className="save-bar"><p className={isError ? 'inline-error' : ''} role={isError ? 'alert' : 'status'}><span className={`save-indicator ${dirty ? 'has-changes' : ''}`} aria-hidden="true"/>{notice || (dirty ? 'A little change. Ready when you are.' : 'Your space. Saved on this device.')}</p><button type="submit" form="settings-form" className="primary-button" disabled={saving}>{saving ? 'Settling in…' : 'Save changes'}<Icon name="arrow" size={17}/></button></div>
  </main>;
}
export default function App() {
  const { state, error } = useCompanion();
  const [kind] = useState(() => location.hash.slice(1));
  useEffect(() => {
    document.body.dataset.window = kind;
    // Closing a panel can return keyboard focus to the companion while Escape
    // is still held. The persistent companion must never dismiss itself here.
    const keydown = (event: KeyboardEvent) => {
      if (kind === 'overlay' || event.key !== 'Escape' || event.repeat || event.isComposing) return;
      event.preventDefault();
      void api?.hideWindow();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [kind]);
  if (error) return <main className="bridge-error"><Bot/><h1>A little connection trouble.</h1><p role="alert">{error}</p></main>;
  if (kind === 'overlay') return <Overlay state={state}/>;
  if (kind === 'chat') return <Chat state={state}/>;
  return <SettingsView state={state}/>;
}
