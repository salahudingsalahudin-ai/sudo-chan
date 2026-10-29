import Link from 'next/link';
import { INSTALL_COPY } from '../lib/installGuide';
import InstallGuide, { type GuideRelease } from './InstallGuide';
import ThemeToggle from './ThemeToggle';
import styles from './InstallGuide.module.css';

// Decorative companion, same palette as the hero SVG. Pure SVG, no animation library.
function Mascot() {
  return (
    <div className={styles.mascot} aria-hidden="true">
      <svg viewBox="0 0 200 200" focusable="false">
        <defs>
          <radialGradient id="im-glow" cx="50%" cy="50%" r="50%"><stop offset="0" stopColor="currentColor" stopOpacity=".38" /><stop offset=".7" stopColor="currentColor" stopOpacity=".08" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></radialGradient>
          <linearGradient id="im-hair" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#5a5fd0" /><stop offset=".5" stopColor="#33337f" /><stop offset="1" stopColor="#262768" /></linearGradient>
          <linearGradient id="im-skin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff2ec" /><stop offset="1" stopColor="#f6d3d0" /></linearGradient>
          <linearGradient id="im-iris" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#171b52" /><stop offset=".55" stopColor="#2a56b8" /><stop offset="1" stopColor="#4ee6f0" /></linearGradient>
        </defs>
        <g className={styles.mAura}>
          <circle cx="100" cy="100" r="98" fill="url(#im-glow)" />
          <circle cx="100" cy="100" r="82" fill="none" stroke="currentColor" strokeOpacity=".5" strokeWidth="1.5" />
          <circle cx="100" cy="100" r="92" fill="none" stroke="currentColor" strokeOpacity=".22" strokeWidth="1" strokeDasharray="2 7" />
        </g>
        <path d="M46 200c3-22 22-36 54-36s51 14 54 36z" fill="#e3e8f6" /><path d="M86 164l14 16 14-16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M44 112c-2-44 22-70 56-70s58 26 56 70c-2 26-8 36-14 44H58c-6-8-12-18-14-44Z" fill="url(#im-hair)" />
        <path d="M56 106c0-26 18-44 44-44s44 18 44 44c0 28-20 48-44 48s-44-20-44-48Z" fill="url(#im-skin)" />
        <path d="M54 96c6-26 24-40 46-40s40 14 46 40c-12-12-26-18-46-18s-34 6-46 18Z" fill="url(#im-hair)" />
        <g className={styles.mEye}><ellipse cx="80" cy="112" rx="9" ry="12" fill="#fff" /><ellipse cx="80" cy="114" rx="6.5" ry="9.5" fill="url(#im-iris)" /><circle cx="78" cy="110" r="2.2" fill="#fff" /></g>
        <g className={styles.mEye}><ellipse cx="120" cy="112" rx="9" ry="12" fill="#fff" /><ellipse cx="120" cy="114" rx="6.5" ry="9.5" fill="url(#im-iris)" /><circle cx="118" cy="110" r="2.2" fill="#fff" /></g>
        <path d="M91 134q9 7 18 0" fill="none" stroke="#b9575f" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="68" cy="128" r="5" fill="#ff9aa8" opacity=".35" /><circle cx="132" cy="128" r="5" fill="#ff9aa8" opacity=".35" />
        <path d="M42 108a8 8 0 0 1 8 8v14a8 8 0 0 1-8-8zM158 108a8 8 0 0 0-8 8v14a8 8 0 0 0 8-8z" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </div>
  );
}

/** The whole /download page body. Only reachable when RELEASE_PUBLISHED is true (app/download/page.tsx decides). */
export default function DownloadExperience({ release }: { release: GuideRelease }) {
  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <Link className={styles.brand} href="/"><span className={styles.brandMark} aria-hidden="true">S</span>Sudo-chan</Link>
          <div className={styles.topActions}>
            <Link className={styles.back} href="/">Back to Sudo-chan</Link>
            <ThemeToggle />
          </div>
        </header>
        <main id="main">
          <section className={styles.hero} aria-labelledby="install-title">
            <div className={styles.heroCopy}>
              <p className={styles.eyebrow}>Early version · Linux</p>
              <h1 id="install-title">Install <span className={styles.nowrap}>Sudo-chan</span> in 4 steps</h1>
              <p className={styles.lead}>Choose your computer, download one file, check it is genuine, then install and open her. No account needed.</p>
            </div>
            <Mascot />
          </section>
          <p className={styles.early}><strong>Early version.</strong> {INSTALL_COPY.earlyNote}</p>
          <InstallGuide release={release} />
        </main>
      </div>
    </div>
  );
}
