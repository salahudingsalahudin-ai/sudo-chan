'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  APPROX_SIZE,
  COMMANDS,
  INSTALL_COPY,
  OS_CARDS,
  STEPS,
  TROUBLE,
  WIZARD_PREVIEW,
  activeStepFromTops,
  detectOs,
  expectedVerifyLine,
  fileNames,
  osMessage,
  recommendedFormat,
  stepHref,
  type DetectedOs,
  type GuideRelease,
  type OsId,
  type PackageFormat,
} from '../lib/installGuide';
import styles from './InstallGuide.module.css';

export type { GuideRelease };

const ICON = {
  copy: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>,
  check: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>,
  download: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" /></svg>,
  linux: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="m7 9 3 2.5L7 14m5.5 0H17M9 20.5h6" /></svg>,
  windows: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5 11 4.5v7H4zM13 4.2l7-1.2v8.5h-7zM4 12.5h7v7l-7-1zM13 12.5h7V21l-7-1.2z" /></svg>,
  macos: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>,
};

const WIZ_ICON: Record<string, ReactNode> = {
  mic: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></svg>,
  name: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h16v9H4zM8 12h5" /></svg>,
  brain: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="3" /><path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3M10 12h4" /></svg>,
  privacy: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5.5c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6z" /><path d="m9 12 2.2 2.2L15.5 10" /></svg>,
  try: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v10H11l-4 4v-4H5z" /></svg>,
};

/** Copies text to the clipboard. Falls back to a hidden textarea where the async API is blocked (http, old browsers). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea method
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function CommandBlock({ command, label, output = false }: { command: string; label?: string; output?: boolean }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const onCopy = useCallback(async () => {
    const ok = await copyText(command);
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2200);
  }, [command]);
  return (
    <div className={styles.cmdWrap}>
      {label && <p className={styles.cmdLabel}>{label}</p>}
      <div className={`${styles.cmd} ${output ? styles.cmdOut : ''}`}>
        <code>{command}</code>
        {!output && (
          <>
            <button type="button" className={styles.copy} data-state={state} onClick={onCopy} aria-label={`Copy command: ${command}`}>
              {state === 'copied' ? ICON.check : ICON.copy}
              <span aria-hidden="true">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Press Ctrl+C' : 'Copy'}</span>
            </button>
            <span className={styles.srOnly} role="status">{state === 'copied' ? 'Copied to clipboard.' : state === 'failed' ? 'Could not copy. Select the command and press Ctrl+C.' : ''}</span>
          </>
        )}
      </div>
    </div>
  );
}

function Step({ index, active, children }: { index: number; active: boolean; children: ReactNode }) {
  const info = STEPS[index];
  return (
    <section className={styles.step} aria-labelledby={`${info.id}`} data-active={active}>
      <div className={styles.stepHead}>
        <span className={styles.badge} aria-hidden="true">{info.number}</span>
        <h2 id={info.id}>
          {info.title}
          <a className={styles.anchor} href={stepHref(info.number)} aria-label={`Link to step ${info.number}: ${info.title}`}>#</a>
        </h2>
      </div>
      {children}
      {index < STEPS.length - 1 && (
        <div className={styles.nextRow}>
          <a className={styles.nextLink} href={stepHref(info.number + 1)}>Next: {STEPS[index + 1].title} <span aria-hidden="true">↓</span></a>
        </div>
      )}
    </section>
  );
}

export default function InstallGuide({ release }: { release: GuideRelease }) {
  const [enhanced, setEnhanced] = useState(false);
  const [os, setOs] = useState<OsId>('linux');
  const [detected, setDetected] = useState<DetectedOs>('unknown');
  const [recommended, setRecommended] = useState<PackageFormat | null>(null);
  const [active, setActive] = useState(0);
  const names = fileNames(release.version);
  const message = osMessage(os === 'linux' ? (detected === 'mobile' ? 'mobile' : 'linux') : os);

  useEffect(() => {
    setEnhanced(true);
    const ua = navigator.userAgent || '';
    const found = detectOs(ua);
    setDetected(found);
    setRecommended(recommendedFormat(ua));
    if (found === 'windows' || found === 'macos') setOs(found);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const root = document.documentElement;
    if (!reduce) root.style.scrollBehavior = 'smooth';
    return () => { root.style.scrollBehavior = ''; };
  }, []);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const tops = STEPS.map(s => document.getElementById(s.id)?.getBoundingClientRect().top ?? Infinity);
      const offset = Math.min(window.innerHeight * 0.4, 260);
      setActive(prev => {
        const next = activeStepFromTops(tops, offset);
        return next === prev ? prev : next;
      });
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const debHref = release.debUrl ?? release.latestUrl;
  const appImageHref = release.appImageUrl ?? release.latestUrl;
  const sumsHref = release.checksumsUrl ?? release.latestUrl;
  const debSize = release.debSize || `about ${APPROX_SIZE.deb}`;
  const appImageSize = release.appImageSize || `about ${APPROX_SIZE.appimage}`;
  const exact = Boolean(release.debUrl && release.appImageUrl);

  return (
    <div className={styles.guide} data-js={enhanced} style={{ ['--ig-progress' as string]: String(active / (STEPS.length - 1)) }}>
      <nav className={styles.rail} aria-label="Install steps">
        <ol className={styles.railList}>
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <a className={styles.railLink} href={stepHref(s.number)} aria-current={i === active ? 'step' : undefined} data-done={i < active}>
                <span className={styles.dot} aria-hidden="true">{i < active ? '✓' : s.number}</span>
                <span className={styles.railText}><b>{s.short}</b><small>{s.title}</small></span>
              </a>
            </li>
          ))}
        </ol>
        <p className={styles.railNote}>Nothing on this page asks for an account or for your keys.</p>
      </nav>

      <div className={styles.steps}>
        {/* STEP 1 */}
        <Step index={0} active={active === 0}>
          <p className={styles.intro}>Pick the computer you want to install her on. We guess from your browser, and you can change it.</p>
          <fieldset className={styles.osGroup}>
            <legend>Your computer</legend>
            <div className={styles.osGrid}>
              {OS_CARDS.map(card => (
                <label key={card.id} className={styles.osCard}>
                  <input className={styles.osInput} type="radio" name="computer" value={card.id} checked={os === card.id} onChange={() => setOs(card.id)} />
                  <span className={styles.osBody}>
                    <span className={styles.osTop}>{ICON[card.id]}<span className={styles.osName}>{card.name}</span></span>
                    <span className={`${styles.osStatus} ${card.ready ? styles.osStatusReady : ''}`}>{card.status}</span>
                    <span className={styles.osDetail}>{card.detail}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className={styles.detected} aria-live="polite">
            {enhanced && (detected === 'linux' ? 'Looks like you are on Linux.' : detected === 'windows' ? 'Looks like you are on Windows.' : detected === 'macos' ? 'Looks like you are on macOS.' : '')}
          </p>
          {message && (
            <p className={styles.osMessage} role="note">
              {message} <Link href="/#join">Join the waitlist</Link> to hear when it is ready.
            </p>
          )}
        </Step>

        {/* STEP 2 */}
        <Step index={1} active={active === 1}>
          <p className={styles.intro}>
            Pick one file. If you use Ubuntu, Debian or Linux Mint, the <code>.deb</code> is the easiest. The AppImage runs on most other Linux systems.
            {exact ? '' : ' The links open the latest release page on GitHub; look under "Assets".'}
          </p>
          <div className={styles.options}>
            <div className={styles.option} data-recommended={recommended === 'deb'}>
              <div className={styles.optionHead}><h3>.deb package</h3>{recommended === 'deb' && <span className={styles.tag}>Suggested for you</span>}</div>
              <p className={styles.fileName}>{names.deb}</p>
              <p className={styles.optionText}>For Ubuntu, Debian and friends. Your system installs and removes it like any other app. {debSize}.</p>
              <a className={styles.dlButton} href={debHref} rel="noopener">{ICON.download}<span>Download .deb</span><small>{debSize}</small></a>
            </div>
            <div className={styles.option} data-recommended={false}>
              <div className={styles.optionHead}><h3>AppImage</h3></div>
              <p className={styles.fileName}>{names.appImage}</p>
              <p className={styles.optionText}>One file, no install. For other distributions, or if you do not want to use apt. {appImageSize}.</p>
              <a className={styles.dlButton} href={appImageHref} rel="noopener">{ICON.download}<span>Download AppImage</span><small>{appImageSize}</small></a>
            </div>
          </div>
          <p className={styles.small}>
            Also download <code>{names.checksums}</code> from the same page: you need it in step 3.{' '}
            <a className={styles.subtle} href={sumsHref} rel="noopener">Get {names.checksums}</a>
          </p>
          <p className={styles.small}>Only 64-bit Intel or AMD computers (x86-64) for now. Nothing here costs money or needs an account.</p>
        </Step>

        {/* STEP 3 */}
        <Step index={2} active={active === 2}>
          <p className={styles.intro}>{INSTALL_COPY.checksumWhy}</p>
          <div className={styles.stack}>
            <CommandBlock label={`Open a terminal in the folder where you saved the files (often Downloads):`} command={COMMANDS.openFolder} />
            <CommandBlock label="Then run this. It only checks the files you actually downloaded:" command={COMMANDS.verify} />
            <CommandBlock label="A good result looks like this (one line for each file you downloaded):" command={expectedVerifyLine(names.deb)} output />
          </div>
          <p className={styles.small}>{INSTALL_COPY.checksumFail}</p>
          <p className={styles.callout}><strong>Honest note:</strong> {INSTALL_COPY.unsignedNote}</p>
        </Step>

        {/* STEP 4 */}
        <Step index={3} active={active === 3}>
          <p className={styles.intro}>Use the option that matches the file you downloaded. Run these in the same terminal folder.</p>
          <div className={styles.options}>
            <div className={styles.option} data-recommended={recommended === 'deb'}>
              <div className={styles.optionHead}><h3>If you got the .deb</h3>{recommended === 'deb' && <span className={styles.tag}>Suggested for you</span>}</div>
              <CommandBlock command={COMMANDS.debInstall} />
              <p className={styles.optionText}>Enter your password when asked. Then find <b>Sudo-chan</b> in your app menu and open it.</p>
            </div>
            <div className={styles.option} data-recommended={false}>
              <div className={styles.optionHead}><h3>If you got the AppImage</h3></div>
              <CommandBlock label="1. Allow it to run:" command={COMMANDS.appImageChmod} />
              <CommandBlock label="2. Start it:" command={COMMANDS.appImageRun} />
              <p className={styles.optionText}>You can also double-click the file after step 1. On Ubuntu 22.04 and newer, an AppImage needs <b>libfuse2</b> first:</p>
              <CommandBlock command={COMMANDS.fuse} />
            </div>
          </div>
          <p className={styles.callout}><strong>Ubuntu 24.04:</strong> {INSTALL_COPY.apparmorNote}</p>

          <div className={styles.previewCard}>
            <div className={styles.previewHead}>
              <h3>What happens the first time you open her</h3>
              <span className={styles.illustration}>Illustration</span>
            </div>
            <ol className={styles.wizard}>
              {WIZARD_PREVIEW.map((w, i) => (
                <li key={w.id} className={styles.wizItem}>
                  <span className={styles.wizIcon}>{WIZ_ICON[w.id]}</span>
                  <span className={styles.wizNum}>STEP {i + 1}</span>
                  <span className={styles.wizTitle}>{w.title}</span>
                  <span className={styles.wizBody}>{w.body}</span>
                </li>
              ))}
            </ol>
            <p className={styles.previewNote}>A short setup opens inside the app. This is only a sketch of it: the real screens may look different, and you can change every choice later in Settings.</p>
          </div>
        </Step>

        {/* HELP */}
        <section className={styles.help} aria-labelledby="help">
          <h2 id="help">Something went wrong?</h2>
          <p className={styles.intro}>The five most likely problems, and what fixes them. This is an early version, so rough edges are expected.</p>
          <div className={styles.faq}>
            {TROUBLE.map(item => (
              <details key={item.id} id={item.id}>
                <summary>{item.question}</summary>
                <div className={styles.faqBody}>
                  <p>{item.answer}</p>
                  {item.command && <CommandBlock command={item.command} />}
                  {item.after && <p>{item.after}</p>}
                </div>
              </details>
            ))}
          </div>
          <p className={styles.honest}>{INSTALL_COPY.earlyNote}</p>
          <ul className={styles.footerLinks}>
            <li><a href={release.latestUrl} rel="noopener">All files on GitHub</a></li>
            <li><Link href="/privacy">Privacy policy</Link></li>
            <li><Link href="/#join">Windows and macOS: join the waitlist</Link></li>
          </ul>
        </section>
      </div>
    </div>
  );
}
