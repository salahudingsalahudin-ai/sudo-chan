import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { AIState, AppState, Settings } from '../shared/types';
import { CLOUD_PRESETS } from '../shared/validation';
import { Bot } from './Bot';
import { LocalWakeSettings } from './LocalWakeSettings';
import { useKeyStorageInfo } from './KeyStorage';
import { startMicProbe } from './setup-mic';
import type { MicProbe } from './setup-mic';
import { parseProfile, profileLabels } from '../shared/local-wake/enrollment.ts';
import {
  KEY_PAGE, KEY_PROVIDERS, KEY_PROVIDER_LABEL, MIC_HEARD_LEVEL, ONBOARDING_STEPS,
  cleanPastedKey, copyFor, fillCopy, initialWizardState, keyErrorKind, keyLooksUsable, localWakeChoice, mascotFor, micErrorKind, micTipKey,
  persistPatch, privacyFromSettings, privacyPatch, stepIndex, summaryLines, wizardProgress, wizardReducer,
} from '../shared/onboarding.ts';
import type { BrainChoice, Choices, KeyProvider, MicErrorKind, OnboardingLanguage, OnboardingStep, PrivacyChoices } from '../shared/onboarding.ts';

const api = window.companion;
const INERT = { inert: '' } as Record<string, string>;
const METER_BARS = 28;

type MicStatus = 'idle' | 'testing' | 'heard' | 'quiet' | MicErrorKind;
type Card = 'signin' | 'key' | 'offline';

// ------------------------------------------------------------------------------------------ small parts

function Check({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4.5 10.5l3.6 3.6 7.4-8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

/** One-of-few choice (language, provider). Arrow keys move the choice, Tab leaves the group. */
function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (event: KeyboardEvent, index: number) => {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !backward) return;
    event.preventDefault();
    const next = (index + (forward ? 1 : options.length - 1)) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return <div className="wiz-seg" role="radiogroup" aria-label={label}>
    {options.map((option, i) => <button key={option.value} ref={el => { refs.current[i] = el; }} type="button" role="radio" aria-checked={value === option.value} tabIndex={value === option.value ? 0 : -1} onClick={() => onChange(option.value)} onKeyDown={event => move(event, i)}>{option.label}</button>)}
  </div>;
}

function SwitchRow({ title, hint, checked, onChange, onLabel, offLabel }: { title: string; hint: string; checked: boolean; onChange: (next: boolean) => void; onLabel: string; offLabel: string }) {
  const id = useId();
  return <div className={`wiz-switch-row ${checked ? 'is-on' : ''}`}>
    <div className="wiz-switch-copy"><h3 id={`${id}-t`}>{title}</h3><p id={`${id}-d`}>{hint}</p></div>
    <div className="wiz-switch-control">
      <span className="wiz-switch-state" aria-hidden="true">{checked ? onLabel : offLabel}</span>
      <button type="button" className="switch wiz-switch" role="switch" aria-checked={checked} aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`} onClick={() => onChange(!checked)}><span/></button>
    </div>
  </div>;
}

function LevelMeter({ level, label }: { level: number; label: string }) {
  const lit = Math.round(level * METER_BARS);
  return <div className="wiz-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
    {Array.from({ length: METER_BARS }, (_, i) => <i key={i} className={i < lit ? 'is-lit' : ''} style={{ height: `${28 + Math.round(Math.sin((i / METER_BARS) * Math.PI) * 52)}%` }}/>)}
  </div>;
}

function Mascot({ step, state, flags }: { step: OnboardingStep; state: AppState; flags: { micBlocked: boolean; micListening: boolean; liveOn: boolean } }) {
  const face = mascotFor(step, flags);
  const look = face.looking === 'up' ? { x: 0.7, y: -0.9 } : face.looking === 'down' ? { x: -0.3, y: 0.9 } : undefined;
  return <div className={`wiz-mascot step-${step} ${face.listening ? 'is-listening' : ''}`} data-mood={face.mood} {...INERT}>
    <span className="wiz-halo" aria-hidden="true"/><span className="wiz-halo wiz-halo-2" aria-hidden="true"/>
    <Bot mood={face.mood} paused={face.sleepy} voiceActive={face.listening} cursorOffset={look} glasses={state.settings.glassesEnabled ?? true}/>
  </div>;
}

// ------------------------------------------------------------------------------------------ the wizard

export function SetupWizard({ state }: { state: AppState }) {
  const [wiz, dispatch] = useReducer(wizardReducer, state.settings, initialWizardState);
  const c = copyFor(wiz.language);
  const keyInfo = useKeyStorageInfo();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  // ---- choices made on the way
  const [micStatus, setMicStatus] = useState<MicStatus>('idle');
  const [micLevel, setMicLevel] = useState(0);
  const [listenForName, setListenForName] = useState(true);
  const probe = useRef<MicProbe | null>(null);
  const probeTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const [teachOpen, setTeachOpen] = useState(false);
  const [taught, setTaught] = useState(false);
  const [selfTestHeard, setSelfTestHeard] = useState(0);
  const [wantsAssist, setWantsAssist] = useState(false);
  const [card, setCard] = useState<Card>('key');
  const [provider, setProvider] = useState<KeyProvider>('groq');
  const [keyText, setKeyText] = useState('');
  const [keyState, setKeyState] = useState<{ kind: 'idle' | 'checking' | 'ok' | 'error'; text?: string }>({ kind: 'idle' });
  const [brain, setBrain] = useState<BrainChoice>('none');
  const [ai, setAi] = useState<AIState | null>(null);
  const [brainLabel, setBrainLabel] = useState('');
  const [ollama, setOllama] = useState<{ kind: 'idle' | 'checking' | 'found' | 'none'; models?: number }>({ kind: 'idle' });
  const [privacy, setPrivacy] = useState<PrivacyChoices>(() => privacyFromSettings(state.settings));
  const [neverOpen, setNeverOpen] = useState(false);
  const liveOn = state.voiceActiveTarget === 'overlay';
  const startedLive = useRef(false);

  // ---- persistence: every move is saved, so closing the app halfway resumes at the same screen
  const savedKey = useRef(JSON.stringify(persistPatch(initialWizardState(state.settings))));
  useEffect(() => {
    if (wiz.outcome !== null) return;
    const patch = persistPatch(wiz);
    const key = JSON.stringify(patch);
    if (key === savedKey.current) return;
    savedKey.current = key;
    void api?.saveSettings(patch, 'settings');
  }, [wiz]);
  useEffect(() => {
    if (wiz.outcome === null) return;
    void (async () => {
      try { await api?.saveSettings(persistPatch(wiz), 'settings'); await api?.setSetupMode(false); } finally { await api?.hideWindow(); }
    })();
  }, [wiz]);

  // ---- focus and announcements
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    headingRef.current?.focus({ preventScroll: true });
  }, [wiz.step]);
  // First Esc inside a text field clears it; Esc anywhere else is handled by the window (App): it closes setup and records it.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (event.key === 'Escape' && target instanceof HTMLInputElement && target.type === 'password' && target.value) {
        event.stopPropagation();
        event.preventDefault();
        setKeyText('');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const stopProbe = useCallback(() => {
    probeTimers.current.forEach(clearTimeout);
    probeTimers.current = [];
    probe.current?.stop();
    probe.current = null;
    setMicLevel(0);
  }, []);
  const endLive = useCallback(() => { if (startedLive.current) { startedLive.current = false; void api?.setupLive(false); } }, []);
  useEffect(() => () => { stopProbe(); endLive(); }, [stopProbe, endLive]);

  const refreshTaught = useCallback(async () => {
    try { const info = await api?.getLocalWakeProfile(); setTaught(profileLabels(info ? parseProfile(info.profile) : undefined).length > 0); } catch { setTaught(false); }
  }, []);
  useEffect(() => { if (wiz.step === 'done') void refreshTaught(); }, [wiz.step, refreshTaught]);
  useEffect(() => { void api?.getAI().then(setAi).catch(() => {}); }, [wiz.step, brain]);

  // ---- microphone step
  const runMicTest = async () => {
    stopProbe();
    setMicStatus('testing');
    let peak = 0;
    try {
      probe.current = await startMicProbe(level => {
        setMicLevel(level);
        peak = Math.max(peak, level);
        if (peak >= MIC_HEARD_LEVEL) setMicStatus(current => (current === 'testing' || current === 'quiet' ? 'heard' : current));
      });
      probeTimers.current.push(setTimeout(() => setMicStatus(current => (current === 'testing' ? 'quiet' : current)), 7000));
      probeTimers.current.push(setTimeout(() => stopProbe(), 30000));
    } catch (error) {
      setMicStatus(micErrorKind((error as { name?: unknown } | null)?.name));
    }
  };
  const micOk = micStatus === 'heard' || micStatus === 'quiet';
  const micBlocked = micStatus === 'denied' || micStatus === 'no-device' || micStatus === 'busy' || micStatus === 'unknown';

  // ---- brain step
  const testKey = async () => {
    if (!api || !keyLooksUsable(keyText)) return;
    const preset = CLOUD_PRESETS[provider];
    setKeyState({ kind: 'checking' });
    try {
      // Main tests the key against the provider and only then stores it (the same path as Settings > Local AI). The renderer never touches the network.
      const result = await api.saveCloudConfig({ provider, endpoint: preset.endpoint, model: preset.defaultModel, apiKey: cleanPastedKey(keyText), makeActive: true });
      if (!result.ok) {
        const kind = keyErrorKind(result.error);
        setKeyState({ kind: 'error', text: kind === 'invalid' ? c.brain.errInvalid : kind === 'network' ? c.brain.errNetwork : kind === 'limit' ? c.brain.errLimit : c.brain.errUnknown });
        return;
      }
      setKeyText('');
      await api.setAIMode('cloud');
      setBrain('key');
      setBrainLabel(KEY_PROVIDER_LABEL[provider]);
      setKeyState({ kind: 'ok', text: c.brain.ok });
    } catch {
      setKeyState({ kind: 'error', text: c.brain.errNetwork });
    }
  };
  const checkOllama = async () => {
    if (!api) return;
    setOllama({ kind: 'checking' });
    try {
      const ai = await api.checkAI();
      if (ai.connected && ai.models.length > 0) {
        await api.setAIMode('local');
        setBrain('offline');
        setOllama({ kind: 'found', models: ai.models.length });
      } else setOllama({ kind: 'none' });
    } catch { setOllama({ kind: 'none' }); }
  };

  // ---- try-it step
  const toggleLive = async () => {
    if (!api) return;
    if (liveOn) { startedLive.current = false; await api.setupLive(false); return; }
    startedLive.current = true;
    await api.setupLive(true);
  };

  // ---- moving between steps
  const leaveStep = () => { stopProbe(); endLive(); };
  /** What a step writes when the person presses Next. Skipping a step writes nothing. */
  const commit = async (step: OnboardingStep) => {
    if (!api) return;
    if (step === 'mic' && micOk) await api.saveSettings({ wakeWordEnabled: listenForName }, 'settings');
    if (step === 'name') {
      const choice = localWakeChoice({ taught, selfTestHeard, wantsAssist });
      if (wantsAssist && choice !== (state.settings.localWake ?? 'off')) await api.saveSettings({ localWake: choice }, 'settings');
    }
    if (step === 'privacy') {
      // Saved through the normal Settings path: tools stay click-to-approve, and turning screen help on still asks for its own confirmation.
      await api.saveSettings(privacyPatch(privacy), 'settings');
      const fresh = await api.getState();
      setPrivacy(privacyFromSettings(fresh.settings));
    }
  };
  const advance = async () => {
    if (busy) return;
    setBusy(true);
    try { await commit(wiz.step); } catch { /* a failed save never blocks the next screen */ } finally { setBusy(false); }
    leaveStep();
    dispatch({ type: 'next' });
  };
  const goBack = () => { leaveStep(); dispatch({ type: 'back' }); };
  const skipStep = () => { leaveStep(); dispatch({ type: 'skip' }); };
  const dismiss = () => { leaveStep(); dispatch({ type: 'dismiss' }); };

  // ---- the primary action of each screen
  // What she can use right now, read from the real AI state so the summary and the demo never claim more than is true.
  const cloudReady = Boolean(ai && ai.mode === 'cloud' && ai.cloud.apiKeySet);
  const localReady = Boolean(ai && ai.mode === 'local' && ai.connected && ai.models.length > 0);
  const choices: Choices = {
    mic: micOk ? 'allowed' : micBlocked ? 'blocked' : 'skipped',
    voiceTaught: taught,
    brain: cloudReady ? 'key' : localReady ? 'offline' : 'none',
    brainLabel: brainLabel || (ai && cloudReady ? CLOUD_PRESETS[ai.cloud.provider].label : ''),
    privacy,
  };
  const primary = (() => {
    if (wiz.step === 'welcome') return { label: c.welcome.primary, run: () => void advance(), disabled: false };
    if (wiz.step === 'done') return { label: c.common.finish, run: () => void advance(), disabled: false };
    if (wiz.step === 'mic' && !micOk) {
      if (micStatus === 'testing') return { label: c.mic.testing, run: () => {}, disabled: true };
      return { label: micBlocked ? c.mic.tryAgain : c.mic.allow, run: () => void runMicTest(), disabled: false };
    }
    return { label: c.common.next, run: () => void advance(), disabled: busy };
  })();
  const progress = wizardProgress(wiz.step);
  const canSkip = wiz.step !== 'welcome' && wiz.step !== 'done';
  const stepLine = `${fillCopy(c.common.stepOf, { n: progress.index + 1, total: progress.total })}: ${c.common.stepNames[wiz.step]}`;

  return <main className={`app-window settings-window setup-window step-${wiz.step}`} aria-label={c.common.wizardLabel} lang={wiz.language === 'en' ? 'en' : 'ur-Latn'}>
    <header className="wiz-header">
      <div className="brand-mark" aria-hidden="true">s<span/></div>
      <div className="wiz-brand"><b>Sudo-chan</b><span>{c.common.wizardLabel}</span></div>
      {wiz.step !== 'done' && <button type="button" className="wiz-link wiz-skip-all" onClick={dismiss}>{c.common.skipAll}</button>}
    </header>

    <div className="wiz-scroll soft-scroll" ref={scrollRef}>
      <section className="wiz-stage" key={wiz.step}>
        <Mascot step={wiz.step} state={state} flags={{ micBlocked, micListening: micStatus === 'testing' || (micOk && micLevel > 0.02), liveOn }}/>
        <p className="wiz-eyebrow" aria-hidden="true">{stepLine}</p>
        <h1 ref={headingRef} tabIndex={-1}>{c[wiz.step].title}</h1>
        {wiz.step === 'welcome' && <WelcomeStep c={c} language={wiz.language} setLanguage={(language: OnboardingLanguage) => dispatch({ type: 'language', language })}/>}
        {wiz.step === 'mic' && <MicStep c={c} status={micStatus} level={micLevel} listen={listenForName} setListen={setListenForName} platform={state.platform}/>}
        {wiz.step === 'name' && <NameStep c={c} settings={state.settings} open={teachOpen} setOpen={setTeachOpen} taught={taught} setTaught={setTaught} heard={selfTestHeard} setHeard={setSelfTestHeard} assist={wantsAssist} setAssist={setWantsAssist}/>}
        {wiz.step === 'brain' && <BrainStep c={c} card={card} setCard={setCard} provider={provider} setProvider={next => { setProvider(next); setKeyState({ kind: 'idle' }); }} keyText={keyText} setKeyText={setKeyText} keyState={keyState} testKey={() => void testKey()} brain={brain} brainLabel={brainLabel} ollama={ollama} checkOllama={() => void checkOllama()}/>}
        {wiz.step === 'privacy' && <PrivacyStep c={c} privacy={privacy} setPrivacy={setPrivacy} neverOpen={neverOpen} setNeverOpen={setNeverOpen} platform={state.platform} keyEncrypted={keyInfo.encrypted} keyHint={keyInfo.hint}/>}
        {wiz.step === 'try' && <TryStep c={c} liveOn={liveOn} startedHere={startedLive.current} toggle={() => void toggleLive()} brainOk={cloudReady || localReady} micOk={micOk || state.settings.wakeWordEnabled === true}/>}
        {wiz.step === 'done' && <DoneStep c={c} lines={summaryLines(choices, wiz.language)} platform={state.platform}/>}
      </section>
    </div>

    <footer className="wiz-footer">
      <ol className="wiz-dots" aria-label={c.common.progress}>
        {ONBOARDING_STEPS.map(step => <li key={step} className={`${stepIndex(step) < progress.index ? 'is-past' : ''} ${step === wiz.step ? 'is-current' : ''} ${wiz.skipped.includes(step) ? 'is-skipped' : ''}`} aria-current={step === wiz.step ? 'step' : undefined}><span className="sr-only">{c.common.stepNames[step]}</span></li>)}
      </ol>
      <div className="wiz-actions">
        {wiz.step !== 'welcome' ? <button type="button" className="wiz-ghost" onClick={goBack}>{c.common.back}</button> : <span/>}
        <div className="wiz-actions-right">
          {canSkip && <button type="button" className="wiz-link" onClick={skipStep}>{c.common.skipStep}</button>}
          <button type="button" className="primary-button wiz-primary" disabled={primary.disabled} onClick={primary.run}>{primary.label}</button>
        </div>
      </div>
    </footer>
    <p className="sr-only" role="status" aria-live="polite">{stepLine}</p>
  </main>;
}

// ------------------------------------------------------------------------------------------ the screens

type Copy = ReturnType<typeof copyFor>;

function WelcomeStep({ c, language, setLanguage }: { c: Copy; language: OnboardingLanguage; setLanguage: (language: OnboardingLanguage) => void }) {
  return <>
    <p className="wiz-lead">{c.welcome.body}</p>
    <div className="wiz-lang">
      <span className="wiz-label" id="wiz-lang-label">{c.welcome.langLabel}</span>
      <Segmented<OnboardingLanguage> label={c.welcome.langLabel} value={language} onChange={setLanguage} options={[{ value: 'en', label: c.welcome.langEn }, { value: 'roman-ur', label: c.welcome.langRo }]}/>
      <span className="wiz-note">{c.welcome.langNote}</span>
    </div>
    <p className="wiz-time">{c.welcome.time}</p>
  </>;
}

function MicStep({ c, status, level, listen, setListen, platform }: { c: Copy; status: MicStatus; level: number; listen: boolean; setListen: (next: boolean) => void; platform: string }) {
  const blocked = status === 'denied' || status === 'no-device' || status === 'busy' || status === 'unknown';
  const ok = status === 'heard' || status === 'quiet';
  const reason = status === 'denied' ? c.mic.denied : status === 'no-device' ? c.mic.noDevice : status === 'busy' ? c.mic.busy : c.mic.unknown;
  const tip = c.mic[micTipKey(platform)];
  return <>
    <p className="wiz-lead">{c.mic.body}</p>
    <div className={`wiz-panel wiz-meter-panel ${ok ? 'is-ok' : ''} ${blocked ? 'is-bad' : ''}`}>
      {!blocked && <LevelMeter level={level} label={c.mic.meter}/>}
      <p className={`wiz-status ${blocked ? 'is-flush' : ''}`} role={blocked ? 'alert' : 'status'}>
        {status === 'idle' && <span className="wiz-muted">{c.mic.meter}</span>}
        {status === 'testing' && <span>{c.mic.testing}</span>}
        {status === 'heard' && <span className="wiz-good"><Check size={16}/> {c.mic.heard}</span>}
        {status === 'quiet' && <span className="wiz-warn">{c.mic.quiet}</span>}
        {blocked && <span className="wiz-bad"><b>{c.mic.blockedTitle}.</b> {reason}</span>}
      </p>
    </div>
    {blocked && <p className="wiz-tip">{tip}</p>}
    {ok && <SwitchRow title={c.mic.listenSwitch} hint={c.mic.listenHint} checked={listen} onChange={setListen} onLabel="On" offLabel="Off"/>}
    <p className="wiz-fine">{c.mic.what}</p>
    <p className="wiz-fine">{c.mic.flow}</p>
  </>;
}

function NameStep({ c, settings, open, setOpen, taught, setTaught, heard, setHeard, assist, setAssist }: {
  c: Copy; settings: Settings; open: boolean; setOpen: (next: boolean) => void; taught: boolean; setTaught: (next: boolean) => void; heard: number; setHeard: (n: number) => void; assist: boolean; setAssist: (next: boolean) => void;
}) {
  const [local, setLocal] = useState<Settings>(settings);
  const unlocked = taught && heard > 0;
  return <>
    <p className="wiz-lead">{c.name.body}</p>
    <p className="wiz-name-words" aria-hidden="true">{c.name.say}</p>
    <div className="wiz-panel">
      <div className="wiz-panel-head">
        {!open && <div><h3>{c.name.teachTitle}</h3><p>{c.name.teachBody}</p></div>}
        <button type="button" className="soft-button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? c.name.teachClose : c.name.teachOpen}</button>
      </div>
      {open && <div className="wiz-teach"><LocalWakeSettings compact settings={local} setSettings={setLocal} onSelfTest={count => setHeard(count)} onProfileChange={setTaught}/></div>}
    </div>
    <SwitchRow title={c.name.assistTitle} hint={unlocked ? c.name.assistHint : c.name.assistLocked} checked={unlocked && assist} onChange={next => unlocked && setAssist(next)} onLabel="On" offLabel="Off"/>
  </>;
}

function BrainStep({ c, card, setCard, provider, setProvider, keyText, setKeyText, keyState, testKey, brain, brainLabel, ollama, checkOllama }: {
  c: Copy; card: Card; setCard: (card: Card) => void; provider: KeyProvider; setProvider: (provider: KeyProvider) => void; keyText: string; setKeyText: (text: string) => void;
  keyState: { kind: 'idle' | 'checking' | 'ok' | 'error'; text?: string }; testKey: () => void; brain: BrainChoice; brainLabel: string; ollama: { kind: 'idle' | 'checking' | 'found' | 'none'; models?: number }; checkOllama: () => void;
}) {
  const refs = useRef<Partial<Record<Card, HTMLDivElement | null>>>({});
  const order: Card[] = ['key', 'offline'];
  const chosenOnce = useRef(false);
  // Bring the chosen card, and then its test result, into view (this screen is the tallest one).
  useEffect(() => {
    if (!chosenOnce.current) { chosenOnce.current = true; return; }
    refs.current[card]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [card]);
  useEffect(() => {
    if (keyState.kind === 'ok' || keyState.kind === 'error' || ollama.kind === 'found' || ollama.kind === 'none') document.querySelector('.wiz-card.is-selected .wiz-result')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [keyState.kind, ollama.kind]);
  const move = (event: KeyboardEvent, from: Card) => {
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    if (!forward && !backward) return;
    event.preventDefault();
    const at = order.indexOf(from);
    const next = order[(at + (forward ? 1 : order.length - 1)) % order.length];
    setCard(next);
    refs.current[next]?.focus();
  };
  const cardKeys = (id: Card) => (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return; // typing inside the card's own fields is not card navigation
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); setCard(id); } else move(event, id);
  };
  return <>
    <p className="wiz-lead">{c.brain.body}</p>
    <div className="wiz-cards" role="radiogroup" aria-label={c.brain.title}>
      <div className="wiz-card is-disabled" role="radio" aria-checked={false} aria-disabled="true" aria-describedby="wiz-signin-d">
        <div className="wiz-card-head"><h3>{c.brain.signinTitle}</h3><span className="wiz-badge">{c.brain.signinBadge}</span></div>
        <p id="wiz-signin-d">{c.brain.signinBody}</p>
      </div>

      <div ref={el => { refs.current.key = el; }} className={`wiz-card ${card === 'key' ? 'is-selected' : ''}`} role="radio" aria-checked={card === 'key'} tabIndex={card === 'key' ? 0 : -1} onClick={() => setCard('key')} onKeyDown={cardKeys('key')}>
        <div className="wiz-card-head"><h3>{c.brain.keyTitle}</h3>{brain === 'key' && <span className="wiz-badge is-good"><Check size={13}/> {c.brain.chosen}{brainLabel ? `: ${brainLabel}` : ''}</span>}</div>
        <p>{c.brain.keyBody}</p>
        {card === 'key' && <div className="wiz-card-body" onClick={event => event.stopPropagation()}>
          <span className="wiz-label">{c.brain.providerLabel}</span>
          <Segmented<KeyProvider> label={c.brain.providerLabel} value={provider} onChange={setProvider} options={KEY_PROVIDERS.map(id => ({ value: id, label: KEY_PROVIDER_LABEL[id] }))}/>
          <label className="wiz-label" htmlFor="wiz-key">{c.brain.fieldLabel}</label>
          <div className="wiz-key-row">
            <input id="wiz-key" className="wiz-input" type="password" name="sudo-chan-provider-key" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} value={keyText} placeholder={c.brain.placeholder} onChange={event => setKeyText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); testKey(); } }}/>
            <button type="button" className="soft-button wiz-test" disabled={!keyLooksUsable(keyText) || keyState.kind === 'checking'} onClick={testKey}>{keyState.kind === 'checking' ? c.brain.checking : c.brain.test}</button>
          </div>
          {keyState.kind !== 'idle' && keyState.kind !== 'checking' && <p className={`wiz-result ${keyState.kind === 'ok' ? 'is-ok' : 'is-bad'}`} role={keyState.kind === 'ok' ? 'status' : 'alert'}>{keyState.kind === 'ok' && <Check size={16}/>} {keyState.text}</p>}
          <details className="wiz-how">
            <summary>{c.brain.howTitle}</summary>
            <p>{provider === 'groq' ? c.brain.howGroq : c.brain.howGemini}</p>
            <p className="wiz-url" aria-label={KEY_PAGE[provider]}>{KEY_PAGE[provider]}</p>
            <p>{c.brain.limits}</p>
          </details>
          <p className="wiz-fine">{c.brain.keyPrivate}</p>
        </div>}
      </div>

      <div ref={el => { refs.current.offline = el; }} className={`wiz-card ${card === 'offline' ? 'is-selected' : ''}`} role="radio" aria-checked={card === 'offline'} tabIndex={card === 'offline' ? 0 : -1} onClick={() => setCard('offline')} onKeyDown={cardKeys('offline')}>
        <div className="wiz-card-head"><h3>{c.brain.offlineTitle}</h3>{brain === 'offline' && <span className="wiz-badge is-good"><Check size={13}/> {c.brain.chosen}</span>}</div>
        <p>{c.brain.offlineBody}</p>
        {card === 'offline' && <div className="wiz-card-body" onClick={event => event.stopPropagation()}>
          <button type="button" className="soft-button" disabled={ollama.kind === 'checking'} onClick={checkOllama}>{ollama.kind === 'checking' ? c.brain.offlineChecking : c.brain.offlineCheck}</button>
          {ollama.kind === 'found' && <p className="wiz-result is-ok" role="status"><Check size={16}/> {fillCopy(c.brain.offlineFound, { n: ollama.models ?? 0 })}</p>}
          {ollama.kind === 'none' && <p className="wiz-result is-warn" role="status">{c.brain.offlineNone}</p>}
        </div>}
      </div>
    </div>
    <p className="wiz-fine">{c.brain.honest}</p>
  </>;
}

function PrivacyStep({ c, privacy, setPrivacy, neverOpen, setNeverOpen, platform, keyEncrypted, keyHint }: {
  c: Copy; privacy: PrivacyChoices; setPrivacy: (next: PrivacyChoices) => void; neverOpen: boolean; setNeverOpen: (open: boolean) => void; platform: string; keyEncrypted: boolean; keyHint: string;
}) {
  const keys = keyEncrypted ? c.privacy.keysEncrypted : platform === 'linux' ? c.privacy.keysLinux : keyHint;
  return <>
    <p className="wiz-lead">{c.privacy.body}</p>
    <div className="wiz-switches">
      <SwitchRow title={c.privacy.tools} hint={c.privacy.toolsHint} checked={privacy.tools} onChange={tools => setPrivacy({ ...privacy, tools })} onLabel={c.privacy.on} offLabel={c.privacy.off}/>
      <SwitchRow title={c.privacy.screen} hint={c.privacy.screenHint} checked={privacy.screen} onChange={screen => setPrivacy({ ...privacy, screen })} onLabel={c.privacy.on} offLabel={c.privacy.off}/>
      <SwitchRow title={c.privacy.windowName} hint={c.privacy.windowNameHint} checked={privacy.windowName} onChange={windowName => setPrivacy({ ...privacy, windowName })} onLabel={c.privacy.on} offLabel={c.privacy.off}/>
    </div>
    <button type="button" className="wiz-link wiz-never-toggle" aria-expanded={neverOpen} aria-controls="wiz-never" onClick={() => setNeverOpen(!neverOpen)}>{neverOpen ? c.privacy.neverClose : c.privacy.neverOpen}</button>
    {neverOpen && <div className="wiz-panel wiz-never" id="wiz-never">
      <h3>{c.privacy.neverTitle}</h3>
      <ul>{c.privacy.never.map(line => <li key={line}><Check size={15}/><span>{line}</span></li>)}<li><Check size={15}/><span>{keys}</span></li></ul>
    </div>}
  </>;
}

function TryStep({ c, liveOn, startedHere, toggle, brainOk, micOk }: { c: Copy; liveOn: boolean; startedHere: boolean; toggle: () => void; brainOk: boolean; micOk: boolean }) {
  return <>
    <p className="wiz-lead">{c.try.body}</p>
    <div className={`wiz-panel wiz-try ${liveOn ? 'is-live' : ''}`}>
      <button type="button" className={`soft-button wiz-live-button ${liveOn ? 'is-live' : ''}`} onClick={toggle}>{liveOn ? c.try.stop : c.try.start}</button>
      <p className="wiz-status" role="status">{liveOn ? (startedHere ? c.try.listening : c.try.awake) : ''}</p>
      {!brainOk && <p className="wiz-fine">{c.try.needsBrain}</p>}
      {!micOk && <p className="wiz-fine">{c.try.needsMic}</p>}
    </div>
    <h2 className="wiz-h2">{c.try.cheatTitle}</h2>
    <ol className="wiz-cheat">{c.try.cheat.map((line, i) => <li key={line}><span className="wiz-num" aria-hidden="true">{i + 1}</span><span>{line}</span></li>)}</ol>
  </>;
}

function DoneStep({ c, lines, platform }: { c: Copy; lines: string[]; platform: string }) {
  return <>
    <p className="wiz-lead">{c.done.body}</p>
    <div className="wiz-panel">
      <h3>{c.done.summaryTitle}</h3>
      <ul className="wiz-summary">{lines.map(line => <li key={line}><Check size={16}/><span>{line}</span></li>)}</ul>
    </div>
    <div className="wiz-panel">
      <h3>{c.done.trayTitle}</h3>
      <p>{c.done.tray}{platform === 'linux' ? ` ${c.done.trayLinux}` : ''}</p>
    </div>
    <p className="wiz-fine">{c.done.later}</p>
  </>;
}

