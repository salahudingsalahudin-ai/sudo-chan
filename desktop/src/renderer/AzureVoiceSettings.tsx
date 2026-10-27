import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { AzureStatus, Settings } from '../shared/types.ts';
import { AZURE_VOICES } from '../shared/azure-tts.ts';
import { playDataUriOnce } from './speech';

function Row({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="setting-row"><div><h3>{title}</h3><p>{description}</p></div>{children}</div>;
}

/**
 * Azure Speech (official AI Speech REST API) settings. The key goes to the main process only; this screen
 * only ever sees a masked copy. Voice choices are normal settings saved with the page's Save button.
 */
export function AzureVoiceSettings({ settings, setSettings }: { settings: Settings; setSettings: (next: Settings) => void }) {
  const api = window.companion;
  const [status, setStatus] = useState<AzureStatus | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [regionInput, setRegionInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api?.getAzure();
      if (next) {
        setStatus(next);
        setRegionInput(current => current || next.region);
      }
    } catch {
      // settings still work without the status line
    }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);

  const report = (ok: boolean, text: string) => { setFailed(!ok); setMessage(text); };

  const save = async () => {
    if (!api) return;
    setBusy(true);
    try {
      const result = await api.saveAzure({ apiKey: keyInput.trim() || undefined, region: regionInput.trim() });
      if (result.ok) {
        setKeyInput('');
        report(true, result.notice ?? 'Saved.');
        await refresh();
      } else {
        report(false, result.error ?? 'Could not save.');
      }
    } finally {
      setBusy(false);
    }
  };

  const test = async (sample: 'en' | 'roman') => {
    if (!api) return;
    setBusy(true);
    report(true, 'Asking Azure...');
    try {
      const result = await api.testAzure(sample);
      if (result.ok && result.dataUri) {
        report(true, `Playing with ${result.voice ?? 'Azure voice'}.`);
        await playDataUriOnce(result.dataUri);
      } else {
        report(false, result.error ?? 'Azure did not return audio.');
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const wait = status && status.backoffSeconds > 0 ? ` Azure is paused for about ${Math.ceil(status.backoffSeconds / 60)} min after an error; a successful test or saving the key lifts it.` : '';
  return <>
    <Row
      title="Azure Speech key"
      description={`Official Azure AI Speech (neural voices incl. Urdu). The free tier covers about 500,000 characters a month. In the Azure portal open your Speech resource, then Keys and Endpoint: paste KEY 1 and the Location/Region (for example eastus, uaenorth, southeastasia).${status?.keySet ? ` Saved key: ${status.maskedKey}.` : ''}`}
    >
      <div className="azure-fields">
        <input type="password" autoComplete="off" spellCheck={false} className="wake-word-input" aria-label="Azure Speech key" placeholder={status?.keySet ? 'Key saved (type to replace)' : 'Paste Azure key'} value={keyInput} onChange={e => setKeyInput(e.target.value)}/>
        <input type="text" spellCheck={false} className="wake-word-input" aria-label="Azure region" placeholder="Region, e.g. eastus" value={regionInput} onChange={e => setRegionInput(e.target.value)}/>
        <button type="button" className="soft-button" disabled={busy || !regionInput.trim() || (!keyInput.trim() && !status?.keySet)} onClick={() => void save()}>Save Azure key</button>
      </div>
    </Row>
    <Row title="Azure voice" description="Auto picks an Urdu voice for Urdu and Roman Urdu and an English voice for English. A voice you choose is used for text it can speak; other languages keep the automatic voice.">
      <select className="wake-word-input" aria-label="Azure voice" value={settings.ttsAzureVoice ?? 'auto'} onChange={e => setSettings({ ...settings, ttsAzureVoice: e.target.value })}>
        <option value="auto">Auto (by language)</option>
        {AZURE_VOICES.map(voice => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
      </select>
    </Row>
    <Row title="Roman Urdu on Azure" description="Roman Urdu is Urdu typed in English letters, which no Azure voice reads natively. Try both and keep the one that sounds right; Hindi voices usually cope better with Latin letters.">
      <select className="wake-word-input" aria-label="Roman Urdu voice family" value={settings.ttsAzureRomanUrdu ?? 'hi'} onChange={e => setSettings({ ...settings, ttsAzureRomanUrdu: e.target.value === 'ur' ? 'ur' : 'hi' })}>
        <option value="hi">Hindi voice (Swara / Madhur)</option>
        <option value="ur">Urdu voice (Uzma / Asad)</option>
      </select>
    </Row>
    <Row
      title="Test Azure voice"
      description={`Save settings first so the voice choices apply. About ${(status?.charsUsed ?? 0).toLocaleString()} characters used this session.${wait}${message ? ` ${message}` : ''}`}
    >
      <div className={`azure-fields ${failed ? 'azure-error' : ''}`}>
        <button type="button" className="soft-button" disabled={busy || !status?.keySet} onClick={() => void test('en')}>🔊 English</button>
        <button type="button" className="soft-button" disabled={busy || !status?.keySet} onClick={() => void test('roman')}>🔊 Roman Urdu</button>
      </div>
    </Row>
  </>;
}
