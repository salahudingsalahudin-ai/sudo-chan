import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Settings, UpdateNotice } from '../shared/types.ts';

/**
 * The only place an update is ever mentioned: a calm line in Settings, plus the switch that turns the daily check off.
 * The page never fetches anything. The main process asks GitHub and hands over just a version number.
 */
export function UpdateSettings({ settings, setSettings }: { settings: Settings; setSettings: Dispatch<SetStateAction<Settings>> }) {
  const [notice, setNotice] = useState<UpdateNotice | null>(null);
  useEffect(() => {
    let alive = true;
    void window.companion?.getUpdateNotice().then(value => { if (alive) setNotice(value); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const on = settings.updateCheckEnabled ?? true;
  const line = !on
    ? 'Update check is off. Sudo-chan never contacts GitHub.'
    : notice?.available
      ? `Version ${notice.version} is available. Get it from the Sudo-chan releases page on GitHub. Nothing is downloaded for you.`
      : 'You are up to date as far as we know. Checked at most once a day.';
  return <div className="setting-row update-row">
    <div><h3>Check for new versions</h3><p role="status">{line}</p></div>
    <div className="switch-control">
      <span>{on ? 'On' : 'Off'}</span>
      <button className="switch" type="button" role="switch" aria-label="Check for updates on/off" aria-checked={on} onClick={() => setSettings({ ...settings, updateCheckEnabled: !on })}><span/></button>
    </div>
  </div>;
}
