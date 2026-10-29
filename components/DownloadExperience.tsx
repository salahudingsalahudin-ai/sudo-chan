import Link from 'next/link';
import { INSTALL_COPY } from '../lib/installGuide';
import InstallGuide, { type GuideRelease } from './InstallGuide';
import ThemeToggle from './ThemeToggle';
import styles from './InstallGuide.module.css';

// Decorative companion, matching the desktop companion bot. Pure SVG.
function Mascot() {
  return (
    <div className={styles.mascot} aria-hidden="true">
      <svg viewBox="0 0 200 200" focusable="false">
        <defs>
          <radialGradient id="im-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#38e8ff" stopOpacity=".38" />
            <stop offset=".7" stopColor="#38e8ff" stopOpacity=".08" />
            <stop offset="1" stopColor="#38e8ff" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="im-shell" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="60%" stopColor="#f8fbfd" />
            <stop offset="100%" stopColor="#cfe0e8" />
          </linearGradient>
          <linearGradient id="im-visor" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#213c49" />
            <stop offset="50%" stopColor="#11232e" />
            <stop offset="100%" stopColor="#0a1721" />
          </linearGradient>
          <radialGradient id="im-core">
            <stop offset="0%" stopColor="#efffff" />
            <stop offset="50%" stopColor="#82eef2" />
            <stop offset="100%" stopColor="#30b8c9" />
          </radialGradient>
        </defs>

        {/* Ambient Halo & Orbital Ring */}
        <g className={styles.mAura}>
          <circle cx="100" cy="100" r="94" fill="url(#im-glow)" />
          <ellipse cx="100" cy="98" rx="80" ry="64" fill="none" stroke="#95dce4" strokeOpacity=".45" strokeWidth="1.4" transform="rotate(-24 100 98)" />
          <circle cx="166" cy="62" r="3" fill="#67d6df" />
        </g>

        {/* Top Antenna */}
        <path d="M100 42 V26" stroke="#b1cfd7" strokeWidth="2.8" strokeLinecap="round" />
        <circle cx="100" cy="22" r="5" fill="#88e4eb" />
        <circle cx="99" cy="20.5" r="1.5" fill="#ffffff" />

        {/* Lower Chubby Body Shell */}
        <path d="M72 135 C73 125 127 125 128 135 L133 162 C135 182 120 190 100 190 C80 190 65 182 67 162 Z" fill="url(#im-shell)" stroke="#ffffff" strokeWidth="1.2" />
        {/* Arm Nubs */}
        <path d="M66 146 C50 143 46 156 52 165 C55 168 61 166 66 161 M134 146 C150 143 154 156 148 165 C145 168 139 166 134 161" fill="url(#im-shell)" />

        {/* Chest Power Core */}
        <circle cx="100" cy="160" r="10" fill="#e2f1f2" stroke="#ffffff" strokeWidth="1.2" />
        <circle cx="100" cy="160" r="6" fill="url(#im-core)" />

        {/* Head Shell */}
        <rect x="42" y="38" width="116" height="106" rx="48" fill="url(#im-shell)" stroke="#ffffff" strokeWidth="1.5" />
        {/* Forehead Shine */}
        <path d="M52 66 C57 52 72 45 86 45" stroke="#ffffff" strokeWidth="3.5" strokeLinecap="round" opacity=".9" />

        {/* Dark Obsidian Visor Screen */}
        <rect x="47" y="74" width="106" height="50" rx="24" fill="url(#im-visor)" stroke="#88bbc7" strokeOpacity=".55" />

        {/* Cyan Glowing Eyes */}
        <g className={styles.mEye}>
          <ellipse cx="78" cy="98" rx="8" ry="11.5" fill="#9af6f3" />
          <ellipse cx="80" cy="99" rx="3.6" ry="6.2" fill="#174951" />
          <circle cx="76.5" cy="94" r="2.2" fill="#ffffff" />
        </g>
        <g className={styles.mEye}>
          <ellipse cx="122" cy="98" rx="8" ry="11.5" fill="#9af6f3" />
          <ellipse cx="124" cy="99" rx="3.6" ry="6.2" fill="#174951" />
          <circle cx="120.5" cy="94" r="2.2" fill="#ffffff" />
        </g>

        {/* Sudo-chan Signature Cute Round Smart Glasses */}
        <g pointerEvents="none">
          {/* Left Lens */}
          <rect x="65" y="83" width="26" height="30" rx="10" fill="none" stroke="#ffffff" strokeWidth="1.6" />
          <path d="M68 91 C 69 87, 74 85, 78 85" stroke="#ffffff" strokeWidth="1.1" strokeLinecap="round" fill="none" opacity="0.8" />
          {/* Right Lens */}
          <rect x="109" y="83" width="26" height="30" rx="10" fill="none" stroke="#ffffff" strokeWidth="1.6" />
          <path d="M112 91 C 113 87, 118 85, 122 85" stroke="#ffffff" strokeWidth="1.1" strokeLinecap="round" fill="none" opacity="0.8" />
          {/* Nose Bridge */}
          <path d="M91 97 C 94 94, 106 94, 109 97" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" fill="none" />
          {/* Temples */}
          <path d="M65 97 H 49" stroke="#ffffff" strokeWidth="1.4" strokeLinecap="round" opacity="0.9" />
          <path d="M135 97 H 151" stroke="#ffffff" strokeWidth="1.4" strokeLinecap="round" opacity="0.9" />
        </g>

        {/* Smile */}
        <path d="M93 116 Q100 121 107 116" fill="none" stroke="#9cf3ec" strokeWidth="2.2" strokeLinecap="round" />

        {/* Pink Blush Cheeks */}
        <ellipse cx="61" cy="110" rx="4.5" ry="2.2" fill="#ff9aa8" opacity=".45" />
        <ellipse cx="139" cy="110" rx="4.5" ry="2.2" fill="#ff9aa8" opacity=".45" />
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
