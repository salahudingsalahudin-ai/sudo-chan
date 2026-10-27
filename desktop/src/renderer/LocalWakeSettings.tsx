import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Settings } from '../shared/types.ts';
import { EnrollmentSession, TARGET_SAMPLES, parseProfile, profileLabels, summariseSelfTest, withLabel, withoutLabel } from '../shared/local-wake/enrollment.ts';
import type { WordLabel } from '../shared/local-wake/enrollment.ts';
import { createDetector } from '../shared/local-wake/registry.ts';
import { evaluateNow } from '../shared/local-wake/runtime.ts';
import { DEFAULT_LOCAL_WAKE_SENSITIVITY } from '../shared/local-wake/types.ts';
import type { LocalWakeMode, LocalWakeProfile } from '../shared/local-wake/types.ts';
import { recordWord } from './local-wake-recorder.ts';

function Row({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="setting-row"><div><h3>{title}</h3><p>{description}</p></div>{children}</div>;
}

const MODE_TEXT: Record<LocalWakeMode, string> = {
  off: 'Off: the cloud listens to every speech clip that passes the quota saver, as before.',
  assist: 'Assist: clips that sound like your "Sudo" are always sent. Other clips are sent only while your free Groq allowance is healthy.',
  strict: 'Strict: only clips that sound like your "Sudo" are sent. Saves the most requests; if she misses you, say it again or switch to Assist.',
};

type Phase = { kind: 'idle' } | { kind: 'enroll'; label: WordLabel } | { kind: 'test' };

/**
 * Settings > Voice > "On-device name check". Optional and quiet: nothing here runs unless a button is pressed, nothing is shown on the overlay.
 * Recordings are turned into numbers (a few hundred per take) in memory; only those numbers are stored, in a 0600 file in the app's data folder.
 */
export function LocalWakeSettings({ settings, setSettings }: { settings: Settings; setSettings: (next: Settings) => void }) {
  const api = window.companion;
  const [profile, setProfile] = useState<LocalWakeProfile | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [session, setSession] = useState<EnrollmentSession | null>(null);
  const [count, setCount] = useState(0);
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cancel = useRef(false);
  const mode = settings.localWake ?? 'off';

  const reload = useCallback(async () => {
    try {
      const info = await api?.getLocalWakeProfile();
      setProfile(info ? parseProfile(info.profile) : undefined);
    } catch {
      setProfile(undefined);
    }
  }, [api]);
  useEffect(() => { void reload(); return () => { cancel.current = true; }; }, [reload]);

  const labels = profileLabels(profile);
  const taught = labels.length > 0;
  const say = (text: string, bad = false) => { setMessage(text); setFailed(bad); };

  const startEnroll = (label: WordLabel) => {
    cancel.current = false;
    setSession(new EnrollmentSession());
    setCount(0);
    setPhase({ kind: 'enroll', label });
    say(`Say "${label === 'sudo' ? 'Sudo' : 'Sid'}" in your normal voice after pressing Record. About ${TARGET_SAMPLES} times, with small breaks.`);
  };

  const leave = () => { cancel.current = true; setPhase({ kind: 'idle' }); setSession(null); setRecording(false); setLevel(0); };

  const takeOne = async () => {
    if (phase.kind !== 'enroll' || !session || recording) return;
    cancel.current = false;
    setRecording(true);
    say('Listening... say it now.');
    try {
      const take = await recordWord(setLevel, () => cancel.current);
      if (take.outcome === 'cancelled') return;
      if (take.outcome === 'timeout') { say('I did not hear anything. Try again.', true); return; }
      const result = session.add(take.samples, take.sampleRate);
      setCount(session.count);
      if (result.accepted) say(session.full ? 'That is plenty. Press Done.' : session.canFinish ? `Got it (${session.count}). You can press Done, or add a few more for a steadier result.` : `Got it (${session.count} of ${TARGET_SAMPLES}).`);
      else say(result.advice ?? 'Try that once more.', true);
    } catch {
      say('The microphone is not available right now.', true);
    } finally {
      setRecording(false);
    }
  };

  const finishEnroll = async () => {
    if (phase.kind !== 'enroll' || !session || !api) return;
    const built = session.finish();
    if (!built.ok || !built.label) {
      say(built.error === 'inconsistent' ? 'The samples did not sound alike enough. Please start over and say it the same way each time.'
        : built.error === 'odd-sample' ? 'One take sounded different from the others. Please record one or two more and press Done again.'
        : 'I need a few more samples first.', true);
      if (built.error === 'inconsistent') { setSession(new EnrollmentSession()); setCount(0); }
      return;
    }
    const next = withLabel(profile, phase.label, built.label, Date.now());
    const saved = await api.saveLocalWakeProfile(next);
    if (!saved.ok) { say(saved.error ?? 'Could not save.', true); return; }
    await reload();
    setSession(null);
    setPhase({ kind: 'idle' });
    say(`Saved. ${built.dropped.length ? 'One sample sounded different and was left out. ' : ''}Now try the test below.`);
  };

  const selfTest = async () => {
    if (!taught || recording) return;
    const detector = createDetector(profile);
    if (!detector) { say('The saved voice data could not be read. Teach her again.', true); return; }
    detector.setSensitivity(settings.localWakeSensitivity ?? DEFAULT_LOCAL_WAKE_SENSITIVITY);
    cancel.current = false;
    setPhase({ kind: 'test' });
    setRecording(true);
    const verdicts = [];
    try {
      for (let i = 1; i <= 3; i++) {
        say(`Say her name (${i} of 3).`);
        const take = await recordWord(setLevel, () => cancel.current);
        if (take.outcome === 'cancelled') return;
        verdicts.push(take.outcome === 'done' ? evaluateNow(detector, take.samples, take.sampleRate) : { candidate: false });
      }
      const summary = summariseSelfTest(verdicts);
      say(summary.message, summary.heard === 0);
    } catch {
      say('The microphone is not available right now.', true);
    } finally {
      setRecording(false);
      setPhase({ kind: 'idle' });
    }
  };

  const remove = async (label?: string) => {
    if (!api) return;
    if (!label && !confirmDelete) { setConfirmDelete(true); return; }
    setConfirmDelete(false);
    const next = label ? withoutLabel(profile, label, Date.now()) : undefined;
    const result = next ? await api.saveLocalWakeProfile(next) : await api.deleteLocalWakeProfile();
    await reload();
    say(result.ok ? 'Your voice samples are deleted from this computer.' : result.error ?? 'Could not delete.', !result.ok);
  };

  const sensitivity = settings.localWakeSensitivity ?? DEFAULT_LOCAL_WAKE_SENSITIVITY;
  const wordName = (label: string) => (label === 'sudo' ? 'Sudo' : label === 'sid' ? 'Sid' : label);
  return <>
    <Row title="On-device name check" description={`${MODE_TEXT[mode]} Off by default. ${taught || mode === 'off' ? '' : 'Teach her your voice below first, or this does nothing.'}`}>
      <select className="wake-word-input" aria-label="On-device name check" value={mode} onChange={event => setSettings({ ...settings, localWake: event.target.value as LocalWakeMode })}>
        <option value="off">Off</option>
        <option value="assist">Assist (recommended to try)</option>
        <option value="strict">Strict (fewest cloud requests)</option>
      </select>
    </Row>
    {mode !== 'off' && <Row title="Name check sensitivity" description={`How readily she decides it was your "Sudo" (${Math.round(sensitivity * 100)}%). Raise it if she misses you, lower it if she wakes for other words.`}>
      <label className="shortcut-label"><span className="sr-only">Name check sensitivity</span><input type="range" min={0} max={100} step={5} value={Math.round(sensitivity * 100)} onChange={event => setSettings({ ...settings, localWakeSensitivity: Number(event.target.value) / 100 })}/></label>
    </Row>}
    <Row title="Teach her your voice" description={taught ? `Taught: ${labels.map(l => `${wordName(l.label)} (${l.samples} samples)`).join(', ')}. Only numbers that describe your voice are stored on this computer, never a recording.` : 'Optional. Record your own "Sudo" a few times so she can recognise it on this computer without asking the cloud first. Only numbers that describe your voice are stored, never a recording.'}>
      {phase.kind === 'idle' ? <span className="remove-keys-actions">
        <button type="button" className="soft-button" onClick={() => startEnroll('sudo')}>{taught ? 'Teach her again: Sudo' : 'Teach her your voice saying Sudo'}</button>
        <button type="button" className="text-button" onClick={() => startEnroll('sid')}>{labels.some(l => l.label === 'sid') ? 'Redo Sid' : 'Also teach: Sid'}</button>
      </span> : <button type="button" className="text-button" onClick={leave}>Cancel</button>}
    </Row>
    {phase.kind === 'enroll' && <div className="setting-row"><div style={{ width: '100%' }}>
      <div className="usage-bar" role="progressbar" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}><i style={{ width: `${Math.round(level * 100)}%` }}/></div>
      <p>{count} of {TARGET_SAMPLES} recorded (5 to 8 work).</p>
      <span className="remove-keys-actions">
        <button type="button" className="soft-button" disabled={recording || session?.full} onClick={() => void takeOne()}>{recording ? 'Listening...' : 'Record'}</button>
        <button type="button" className="text-button" disabled={recording || count === 0} onClick={() => { session?.undo(); setCount(session?.count ?? 0); }}>Undo last</button>
        <button type="button" className="soft-button" disabled={recording || count < 5} onClick={() => void finishEnroll()}>Done</button>
      </span>
    </div></div>}
    {taught && phase.kind !== 'enroll' && <Row title="Accuracy self-test" description="Say her name three times; she tells you how many she heard. Nothing is sent anywhere.">
      <button type="button" className="soft-button" disabled={recording} onClick={() => void selfTest()}>{phase.kind === 'test' ? 'Listening...' : 'Test (3 times)'}</button>
    </Row>}
    {phase.kind === 'test' && <div className="usage-bar" role="progressbar" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}><i style={{ width: `${Math.round(level * 100)}%` }}/></div>}
    {message && <p role={failed ? 'alert' : 'status'} className={failed ? 'inline-error' : 'usage-note'}>{message}</p>}
    {taught && phase.kind === 'idle' && <div className="privacy-bottom remove-keys"><span>Remove your voice samples from this computer?</span>
      <span className="remove-keys-actions"><button type="button" className="text-button" onClick={() => void remove()}>{confirmDelete ? 'Confirm: delete my voice samples' : 'Delete my voice samples'}</button>{confirmDelete && <button type="button" className="text-button" onClick={() => setConfirmDelete(false)}>Keep them</button>}</span></div>}
  </>;
}
