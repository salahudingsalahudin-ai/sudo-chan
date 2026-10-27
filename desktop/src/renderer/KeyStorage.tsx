import { useEffect, useState } from 'react';
import type { KeyStorageInfo } from '../shared/types';

/**
 * Shown until the main process answers. Honest on every platform: it says nothing about encryption.
 * The real wording comes from describeKeyStorage() in the main process (src/main/key-storage.ts), so it cannot drift.
 */
const PENDING: KeyStorageInfo = {
  encrypted: false,
  hint: 'Saved on this computer in a file only your user can read. Never sent to Sudo-chan servers.',
  detail: 'API keys are saved on this computer in a file that only your user account can read. They are never sent to Sudo-chan servers, only to the provider you chose.',
  fact: 'API keys kept in a private file on this computer',
};

export function useKeyStorageInfo(): KeyStorageInfo {
  const [info, setInfo] = useState<KeyStorageInfo>(PENDING);
  useEffect(() => {
    let alive = true;
    void window.companion?.getKeyStorageInfo().then(value => { if (alive && value) setInfo(value); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return info;
}

/** Click, then click again to confirm. Nothing is deleted on the first click. */
export function RemoveKeysRow() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  const click = async () => {
    if (!confirming) { setConfirming(true); setMessage(''); return; }
    setBusy(true);
    try {
      const result = await window.companion?.clearSavedKeys();
      setFailed(!result?.ok);
      setMessage(result?.ok ? (result.notice ?? 'Saved keys removed.') : (result?.error ?? 'Could not remove the saved keys.'));
    } catch {
      setFailed(true);
      setMessage('Could not remove the saved keys.');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="privacy-bottom remove-keys">
      <span>{message ? <span role={failed ? 'alert' : 'status'}>{message}</span> : 'Remove every saved API key (Groq, Gemini, Azure...) from this computer?'}</span>
      <span className="remove-keys-actions">
        <button className="text-button" type="button" disabled={busy} onClick={() => void click()}>{confirming ? 'Yes, remove all saved keys' : 'Remove saved keys'}</button>
        {confirming && <button className="text-button" type="button" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>}
      </span>
    </div>
  );
}
