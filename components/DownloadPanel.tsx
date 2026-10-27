import Link from 'next/link';
import { RELEASES_LATEST_URL, content } from '@/content';

const text = content.download;

// Shown in place of the waitlist only when RELEASE_PUBLISHED is true (content.ts). Static on purpose:
// it links to the "latest release" page, so it never needs the GitHub API and never shows a stale file name.
export default function DownloadPanel() {
  return (
    <div className="download-panel glass-panel">
      <a className="download-panel-button" href={RELEASES_LATEST_URL} rel="noopener">
        <span>{text.button} <i aria-hidden="true">↗</i></span>
        <small>{text.buttonNote}</small>
      </a>
      <p className="download-panel-early">{text.earlyNote}</p>
      <ul className="download-panel-platforms" aria-label={text.platformsLabel}>
        {text.platforms.map(platform => (
          <li key={platform.name}>
            <span>{platform.name}{platform.files ? <small> · {platform.files}</small> : null}</span>
            <b className={platform.ready ? 'is-ready' : ''}>{platform.status}</b>
          </li>
        ))}
      </ul>
      <h3>{text.verifyTitle}</h3>
      <p>{text.verifyBody}</p>
      <code>{text.verifyCommand}</code>
      <p>{text.verifyNote} {text.unsignedNote}</p>
      <p className="download-panel-links">
        <Link href="/download">{text.moreLink}</Link>
        <Link href="/privacy">{content.privacyPage.title}</Link>
      </p>
    </div>
  );
}
