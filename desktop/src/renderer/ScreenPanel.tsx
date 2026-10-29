import { useEffect, useRef } from 'react';
import type { AppState } from '../shared/types';
import { speak } from './speech';

type Props = {
  state: AppState;
  /** Speak the notice / consent line aloud (only while the user is in a voice conversation with the desktop bot). */
  speakAloud: boolean;
};

const CONSENT_SPOKEN = 'Screen dekhne se pehle aap ki ijazat chahiye. Screen par Allow ya Not now dabayein.';

/**
 * Everything the screen-assist flow shows on the desktop bot: the first-use consent panel, the 3-2-1 countdown
 * before the first capture of a session, the "looking" badge (click = cancel), the "sent" / "old screen" hints and
 * the reason when she cannot look. Voice can NEVER grant consent: only the two buttons below call the main process.
 */
export function ScreenPanel({ state, speakAloud }: Props) {
  const api = window.companion;
  const status = state.screenStatus;
  const spokenFor = useRef<string>('');

  // Speak consent prompts and notices once each (never the countdown or badges).
  useEffect(() => {
    if (!speakAloud) return;
    const line = status === 'consent' ? CONSENT_SPOKEN : status === 'notice' ? state.screenNotice ?? '' : '';
    if (!line || spokenFor.current === `${status}:${line}`) return;
    spokenFor.current = `${status}:${line}`;
    void speak(line).catch(() => {});
  }, [status, state.screenNotice, speakAloud]);
  useEffect(() => { if (!status) spokenFor.current = ''; }, [status]);

  if (!status) return null;

  if (status === 'consent') {
    return <div className="screen-panel is-consent" role="alertdialog" aria-label="Let Sudo-chan look at your screen?" data-interactive>
      <p className="screen-panel-text">Screen dekhun? Ek screenshot internet par aap ke AI provider (Groq/Gemini) ko jayegi. Kuch save nahi hota.</p>
      <div className="screen-panel-actions">
        <button type="button" className="screen-btn is-allow" onClick={() => void api?.screenConsent(true)}>Allow</button>
        <button type="button" className="screen-btn" onClick={() => void api?.screenConsent(false)}>Not now</button>
      </div>
    </div>;
  }

  if (status === 'notice') {
    return <div className="screen-panel is-notice" role="status" data-interactive><p className="screen-panel-text">{state.screenNotice}</p></div>;
  }

  const label = status === 'countdown'
    ? `📸 Screenshot ${state.screenCountdown ?? ''}... ✕`
    : status === 'capturing'
      ? '👀 Dekh rahi hoon... ✕'
      : status === 'cached'
        ? '📎 Purani screen par based'
        : '📸 Screen bheji gayi';
  const cancellable = status === 'countdown' || status === 'capturing';
  return <button
    type="button"
    className={`screen-badge ${status === 'sent' || status === 'cached' ? 'is-sent' : ''}`}
    data-interactive
    onClick={() => { if (cancellable) void api?.cancelScreen(); }}
    title={cancellable ? 'Click to cancel' : status === 'cached' ? 'Re-using the screenshot from the last two minutes' : 'Screenshot was sent to your AI provider'}
  >{label}</button>;
}

/**
 * The one-time question during Live Talk: may she know the NAME and TITLE of the window in front of you (no screenshot)?
 * Click-only: only these two buttons call the main process, nothing spoken can answer it. It never blocks Live Talk (she is
 * already listening), it is not spoken aloud, and it goes away by itself. Same box as the screen consent panel.
 */
export function AwarenessPanel() {
  const api = window.companion;
  return <div className="screen-panel is-consent" role="alertdialog" aria-label="Let Sudo-chan know your window name?" data-interactive>
    <p className="screen-panel-text">Live Talk mein main sirf aap ki window ka naam jaan loon? Sirf app aur title, screenshot nahi. Password ya bank wali window skip hoti hai.</p>
    <div className="screen-panel-actions">
      <button type="button" className="screen-btn is-allow" onClick={() => void api?.liveAwarenessConsent(true)}>Allow</button>
      <button type="button" className="screen-btn" onClick={() => void api?.liveAwarenessConsent(false)}>Not now</button>
    </div>
  </div>;
}
