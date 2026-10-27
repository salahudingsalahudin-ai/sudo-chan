import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Settings, TtsQuality } from '../shared/types.ts';
import { formatResetLabel } from '../shared/usage.ts';
import type { UsageRow, UsageSummary } from '../shared/usage.ts';

function Row({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="setting-row"><div><h3>{title}</h3><p>{description}</p></div>{children}</div>;
}

const NOTES: Record<UsageRow['id'], string> = {
  geminiTts: 'Google does not tell how much is left, so the limit here is only our estimate (about 10 free replies a day). If Google says stop, the basic voice speaks until the limit resets.',
  geminiStt: 'Also an estimate. Google does not report the remaining amount.',
  groqStt: 'Groq reports the real numbers after each request, so these are exact.',
  groqChat: 'Groq reports the real numbers after each request, so these are exact.',
  azureTts: 'The free Azure plan gives 500,000 characters each month. Only characters sent from this app are counted.',
};

function UsageMeterRow({ row, now }: { row: UsageRow; now: number }) {
  const percent = row.fraction === null ? 0 : Math.round(row.fraction * 100);
  const level = row.blocked || percent >= 90 ? 'high' : percent >= 70 ? 'mid' : 'low';
  const tag = row.source === 'estimate' ? 'estimate' : row.source === 'provider' ? 'exact' : 'free plan';
  const amount = row.allowance === null
    ? `${row.used.toLocaleString()} ${row.unit}`
    : `${row.used.toLocaleString()} / ${row.allowance.toLocaleString()} ${row.unit}`;
  return <div className={`usage-row ${row.configured ? '' : 'usage-off'}`}>
    <div className="usage-head">
      <b>{row.label}</b>
      <span className={`usage-tag ${row.source}`}>{tag}</span>
    </div>
    <div className={`usage-bar ${level}`} role="progressbar" aria-label={`${row.label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${row.blocked ? 100 : percent}%` }}/></div>
    <div className="usage-amount">{row.configured ? amount : 'No key saved yet'}</div>
    {row.blocked && row.resetsAt !== null && <div className="usage-blocked" role="status">Limit reached - resets at {formatResetLabel(row.resetsAt, now)}</div>}
    {!row.blocked && row.id === 'azureTts' && row.resetsAt !== null && row.configured && <div className="usage-detail">New month starts {formatResetLabel(row.resetsAt, now)}.</div>}
    {row.detail && <div className="usage-detail">{row.detail}</div>}
    <div className="usage-note">{NOTES[row.id]}</div>
  </div>;
}

/**
 * "Free usage": how much of each free quota is used, what is left, and the voice policy.
 * Everything shown comes from the key-free summary built in the main process.
 */
export function UsageSettings({ settings, setSettings }: { settings: Settings; setSettings: (next: Settings) => void }) {
  const api = window.companion;
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api?.getUsage();
      if (next) { setSummary(next); setFailed(false); }
    } catch {
      setFailed(true);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const quality: TtsQuality = settings.ttsQuality === 'save' ? 'save' : 'best';
  const now = summary?.generatedAt ?? Date.now();
  return <section id="usage" className="settings-card scroll-reveal">
    <div className="card-heading"><span className="section-icon mint"><i aria-hidden="true">%</i></span><div><span className="eyebrow">FREE QUOTA</span><h2>Free usage</h2></div></div>
    <p className="usage-intro">Yahan dikhta hai ke aaj aap ne kitna free quota use kiya aur kitna bacha hai. <b>Estimate</b> ka matlab hai ke provider apni limit nahi batata, to ye sirf andaza hai. <b>Exact</b> ka matlab hai ke provider ne khud batayi hai.</p>
    <Row title="Voice quality" description="Best voice always tries the realistic Gemini voice, even for short replies, until its free quota is used up. Save quota uses it only for longer replies, so it lasts longer.">
      <select className="wake-word-input" aria-label="Voice quality" value={quality} onChange={event => setSettings({ ...settings, ttsQuality: event.target.value === 'save' ? 'save' : 'best' })}>
        <option value="best">Best voice while free quota lasts</option>
        <option value="save">Save quota</option>
      </select>
    </Row>
    <div className="usage-list">
      {summary ? summary.rows.map(row => <UsageMeterRow key={row.id} row={row} now={now}/>) : <p className="usage-intro">{failed ? 'Could not read the usage numbers.' : 'Loading...'}</p>}
    </div>
    {summary && <p className="usage-foot">Basic (flat) voice was used for {summary.basicVoiceToday} {summary.basicVoiceToday === 1 ? 'reply' : 'replies'} today. <button type="button" className="text-button" onClick={() => void refresh()}>Refresh</button></p>}
  </section>;
}
