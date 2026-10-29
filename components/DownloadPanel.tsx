'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { content } from '@/content';
import styles from './DownloadPanel.module.css';

type PlatformKey = 'windows' | 'macos' | 'linux';

const OS_ICONS = {
  windows: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5.5 11 4.5v7H4zM13 4.2l7-1.2v8.5h-7zM4 12.5h7v7l-7-1zM13 12.5h7V21l-7-1.2z" />
    </svg>
  ),
  macos: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.37c.62-.75 1.04-1.8 0.93-2.85-.9.04-1.99.6-2.63 1.35-.58.67-.99 1.74-.88 2.76 1 .08 2.02-.51 2.58-1.26" />
    </svg>
  ),
  linux: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m7 9 3 2.5L7 14m5.5 0H17M9 20.5h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  lightning: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" fill="currentColor" />
    </svg>
  ),
};

const VERIFY_COMMANDS: Record<PlatformKey, string> = {
  windows: 'Get-FileHash .\\Sudo-chan-0.1.0-win-x64.exe -Algorithm SHA256',
  linux: 'sha256sum -c SHA256SUMS --ignore-missing',
  macos: 'shasum -a 256 -c SHA256SUMS',
};

function detectUserPlatform(): PlatformKey {
  if (typeof window === 'undefined') return 'windows';
  const ua = (navigator.userAgent || '').toLowerCase();
  if (/macintosh|mac os x|macintel/.test(ua)) return 'macos';
  if (/linux|x11|cros/.test(ua)) return 'linux';
  return 'windows';
}

export default function DownloadPanel() {
  const [platform, setPlatform] = useState<PlatformKey>('windows');
  const [verifyTab, setVerifyTab] = useState<PlatformKey>('windows');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const detected = detectUserPlatform();
    setPlatform(detected);
    setVerifyTab(detected);
  }, []);

  const copyVerifyCommand = () => {
    const cmd = VERIFY_COMMANDS[verifyTab];
    if (navigator.clipboard) {
      navigator.clipboard.writeText(cmd).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  return (
    <div className={`download-panel ${styles.panel}`}>
      {/* Header & Status Indicator */}
      <div className={styles.header}>
        <div className={styles.badgeRow}>
          <div className={styles.statusBadge}>
            <span className={styles.pulseDot} />
            <span>v0.1.0 Ready to Download</span>
          </div>
          <span className={styles.versionTag}>Release v0.1.0</span>
        </div>
        <h2 className={styles.title}>Download Sudo-chan Desktop</h2>
        <p className={styles.subtitle}>
          Urdu & English voice companion for your desktop. Direct download, no account required.
        </p>
      </div>

      {/* Hero OS Download Box (Tailored to visitor's detected OS) */}
      <div className={styles.heroCard}>
        <div className={styles.heroTop}>
          <div className={styles.heroIcon}>{OS_ICONS[platform]}</div>
          <div className={styles.heroMeta}>
            <span className={styles.heroTarget}>
              {platform === 'windows' && 'Recommended for Windows (64-bit)'}
              {platform === 'macos' && 'Recommended for macOS (Apple Silicon)'}
              {platform === 'linux' && 'Recommended for Linux (x86-64)'}
            </span>
            <span className={styles.heroHint}>
              {platform === 'windows' && 'Windows 10 / 11 · Direct Installer & Fast Web Setup'}
              {platform === 'macos' && 'macOS Monterey 12+ · Apple Silicon (M1/M2/M3/M4)'}
              {platform === 'linux' && 'Ubuntu, Debian, Linux Mint, Fedora & Arch'}
            </span>
          </div>
        </div>

        <div className={styles.heroButtons}>
          {platform === 'windows' && (
            <>
              <a
                className={styles.primaryBtn}
                href="/api/download?platform=windows"
                download="Sudo-chan-0.1.0-win-x64.exe"
              >
                {OS_ICONS.download}
                <span>Download Setup (.exe · 99 MB)</span>
              </a>
              <a
                className={styles.webInstallerBtn}
                href="/api/download?platform=windows-web"
                download="Sudo-chan-Web-Installer.cmd"
              >
                {OS_ICONS.lightning}
                <span>⚡ Fast Web Installer (~Instant)</span>
              </a>
            </>
          )}

          {platform === 'linux' && (
            <>
              <a
                className={styles.primaryBtn}
                href="/api/download?platform=linux-deb"
                download="Sudo-chan-0.1.0-linux-amd64.deb"
              >
                {OS_ICONS.download}
                <span>Download .deb (95.6 MB)</span>
              </a>
              <a
                className={styles.webInstallerBtn}
                href="/api/download?platform=linux-appimage"
                download="Sudo-chan-0.1.0-linux-x86_64.AppImage"
              >
                {OS_ICONS.download}
                <span>Download .AppImage (119 MB)</span>
              </a>
            </>
          )}

          {platform === 'macos' && (
            <a
              className={styles.primaryBtn}
              href="/api/download?platform=macos"
              download="Sudo-chan-0.1.0-mac-arm64.dmg"
            >
              {OS_ICONS.download}
              <span>Download for macOS (.dmg · 114 MB)</span>
            </a>
          )}
        </div>
      </div>

      {/* Fast Web Bootstrapper Feature Box */}
      <div className={styles.fastBox}>
        <div className={styles.fastIcon}>⚡</div>
        <div className={styles.fastContent}>
          <h3 className={styles.fastTitle}>Looking for the 1-second installer?</h3>
          <p className={styles.fastDesc}>
            Download the lightweight web installer in 1 second. When opened on your computer, it automatically streams
            and sets up Sudo-chan in the background!
          </p>
          <a
            className={styles.fastAction}
            href="/api/download?platform=windows-web"
            download="Sudo-chan-Web-Installer.cmd"
          >
            Get Fast Web Installer (.cmd) <i>↓</i>
          </a>
        </div>
      </div>

      {/* All Available Platforms */}
      <h3 className={styles.platformSectionTitle}>All Builds & Formats</h3>
      <ul className={styles.platformList} aria-label="Available operating systems">
        {/* Windows */}
        <li className={styles.platformItem}>
          <div className={styles.platformInfo}>
            <div className={styles.platformItemIcon}>{OS_ICONS.windows}</div>
            <div className={styles.platformTexts}>
              <span className={styles.platformName}>Windows 10 / 11 (64-bit)</span>
              <span className={styles.platformFormat}>Direct Setup (.exe) & Fast Web Installer</span>
            </div>
          </div>
          <div className={styles.platformActions}>
            <a
              className={styles.downloadPill}
              href="/api/download?platform=windows"
              download="Sudo-chan-0.1.0-win-x64.exe"
            >
              {OS_ICONS.download}
              <span>Setup .exe (99 MB)</span>
            </a>
            <a
              className={styles.downloadPill}
              href="/api/download?platform=windows-web"
              download="Sudo-chan-Web-Installer.cmd"
            >
              ⚡ <span>Web Setup</span>
            </a>
          </div>
        </li>

        {/* macOS */}
        <li className={styles.platformItem}>
          <div className={styles.platformInfo}>
            <div className={styles.platformItemIcon}>{OS_ICONS.macos}</div>
            <div className={styles.platformTexts}>
              <span className={styles.platformName}>macOS (Apple Silicon)</span>
              <span className={styles.platformFormat}>DMG Image (.dmg · M1/M2/M3/M4)</span>
            </div>
          </div>
          <div className={styles.platformActions}>
            <a
              className={styles.downloadPill}
              href="/api/download?platform=macos"
              download="Sudo-chan-0.1.0-mac-arm64.dmg"
            >
              {OS_ICONS.download}
              <span>Download .dmg (114 MB)</span>
            </a>
          </div>
        </li>

        {/* Linux */}
        <li className={styles.platformItem}>
          <div className={styles.platformInfo}>
            <div className={styles.platformItemIcon}>{OS_ICONS.linux}</div>
            <div className={styles.platformTexts}>
              <span className={styles.platformName}>Linux (x86-64)</span>
              <span className={styles.platformFormat}>Ubuntu, Debian, Fedora & AppImage</span>
            </div>
          </div>
          <div className={styles.platformActions}>
            <a
              className={styles.downloadPill}
              href="/api/download?platform=linux-deb"
              download="Sudo-chan-0.1.0-linux-amd64.deb"
            >
              {OS_ICONS.download}
              <span>.deb (95 MB)</span>
            </a>
            <a
              className={styles.downloadPill}
              href="/api/download?platform=linux-appimage"
              download="Sudo-chan-0.1.0-linux-x86_64.AppImage"
            >
              {OS_ICONS.download}
              <span>.AppImage (119 MB)</span>
            </a>
          </div>
        </li>
      </ul>

      {/* Verification & Integrity */}
      <div className={styles.verifySection}>
        <div className={styles.verifyHeader}>
          <span className={styles.verifyTitle}>Verify Package Integrity (SHA-256)</span>
          <div className={styles.verifyTabs}>
            <button
              type="button"
              className={styles.tabBtn}
              data-active={verifyTab === 'windows'}
              onClick={() => setVerifyTab('windows')}
            >
              Windows
            </button>
            <button
              type="button"
              className={styles.tabBtn}
              data-active={verifyTab === 'linux'}
              onClick={() => setVerifyTab('linux')}
            >
              Linux
            </button>
            <button
              type="button"
              className={styles.tabBtn}
              data-active={verifyTab === 'macos'}
              onClick={() => setVerifyTab('macos')}
            >
              macOS
            </button>
          </div>
        </div>

        <div className={styles.codeBox}>
          <code>{VERIFY_COMMANDS[verifyTab]}</code>
          <button type="button" className={styles.copyBtn} onClick={copyVerifyCommand}>
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>

        <p className={styles.securityNote}>
          Early prototype build. Code-signing certificates are being arranged; if Windows SmartScreen or macOS Gatekeeper
          displays a warning, click <em>&ldquo;More info&rdquo;</em> &rarr; <em>&ldquo;Run anyway&rdquo;</em>. Checksums guarantee your file matches our build.
        </p>
      </div>

      {/* Footer Navigation Links */}
      <div className={styles.footerLinks}>
        <Link className={styles.guideLink} href="/download">
          Step-by-step install guide &rarr;
        </Link>
        <Link className={styles.privacyLink} href="/privacy">
          {content.privacyPage.title}
        </Link>
      </div>
    </div>
  );
}
