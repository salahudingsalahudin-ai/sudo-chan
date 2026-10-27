import type { Metadata } from 'next';
import Link from 'next/link';
import { content } from '@/content';
import { RELEASES_PAGE, fetchLatestRelease, formatBytes, type PlatformId } from '@/lib/releases';

const page = content.downloadPage;

// The latest release is read from the GitHub API and cached for an hour.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: `${page.title} | Sudo-chan`,
  description: page.metadataDescription,
  alternates: { canonical: '/download' },
  openGraph: {
    type: 'website',
    title: `${page.title} | Sudo-chan`,
    description: page.metadataDescription,
    url: '/download',
  },
  twitter: {
    card: 'summary_large_image',
    title: `${page.title} | Sudo-chan`,
    description: page.metadataDescription,
  },
};

const platformLabels: Record<PlatformId, string> = {
  'linux-appimage': 'Linux AppImage',
  'linux-deb': 'Linux .deb (Debian, Ubuntu)',
  windows: 'Windows installer',
  macos: 'macOS disk image',
};

export default async function DownloadPage() {
  const release = await fetchLatestRelease();
  const hasLinuxBuild = Boolean(release?.assets.some(asset => asset.platform.startsWith('linux')));

  return (
    <main className="privacy-page download-page">
      <article className="privacy-page-content" aria-labelledby="download-title">
        <Link className="privacy-page-back" href="/">{page.backLink}</Link>
        <h1 id="download-title">{page.title}</h1>
        <p className="privacy-page-intro">{page.intro}</p>
        <p className="privacy-page-notice">{page.statusNotice}</p>

        <section aria-labelledby="latest-title">
          <h2 id="latest-title">{release ? page.latestTitle : page.noReleaseTitle}</h2>
          {release ? (
            <>
              <p className="download-version">
                <strong>{release.name}</strong>
                {release.prerelease && <span className="download-tag">{page.prereleaseTag}</span>}
              </p>
              {hasLinuxBuild ? (
                <ul className="download-list">
                  {release.assets.map(asset => (
                    <li key={asset.name}>
                      <a className="download-button" href={asset.url} rel="noopener">
                        <span>{platformLabels[asset.platform]}</span>
                        <small>{asset.name}{asset.size ? ` · ${formatBytes(asset.size)}` : ''}</small>
                      </a>
                      {asset.sha256 && <code className="download-hash" title="SHA-256">{asset.sha256}</code>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{page.noReleaseBody}</p>
              )}
              <p className="download-links">
                {release.checksumsUrl && <a href={release.checksumsUrl} rel="noopener">{page.checksumsLink}</a>}
                <a href={release.url} rel="noopener">{page.releaseNotesLink}</a>
                <a href={RELEASES_PAGE} rel="noopener">{page.allReleasesLink}</a>
              </p>
            </>
          ) : (
            <p>{page.noReleaseBody}</p>
          )}
          <p>
            <Link className="download-waitlist" href="/#join">{page.waitlistCta} ↗</Link>
          </p>
        </section>

        <section aria-labelledby="platforms-title">
          <h2 id="platforms-title">{page.platformsTitle}</h2>
          <ul className="download-platforms">
            <li><span>{page.platforms.linux.name}</span><b className={hasLinuxBuild ? 'is-ready' : ''}>{hasLinuxBuild ? page.platforms.linux.status : 'Coming soon'}</b></li>
            <li><span>{page.platforms.windows.name}</span><b>{page.platforms.windows.status}</b></li>
            <li><span>{page.platforms.macos.name}</span><b>{page.platforms.macos.status}</b></li>
          </ul>
        </section>

        <section aria-labelledby="linux-install-title">
          <h2 id="linux-install-title">{page.linuxInstallTitle}</h2>
          <ul>
            {page.linuxInstall.map(line => <li key={line}><code>{line}</code></li>)}
          </ul>
        </section>

        <section aria-labelledby="need-title">
          <h2 id="need-title">{page.needTitle}</h2>
          <p>{page.needBody}</p>
        </section>

        <section aria-labelledby="unsigned-title">
          <h2 id="unsigned-title">{page.unsignedTitle}</h2>
          <p>{page.unsignedBody}</p>
          <p>{page.windowsWarning}</p>
          <p>{page.macWarning}</p>
        </section>

        <section aria-labelledby="verify-title">
          <h2 id="verify-title">{page.verifyTitle}</h2>
          <p>{page.verifyBody}</p>
          <ul>
            {page.verifyCommands.map(line => <li key={line}><code>{line}</code></li>)}
          </ul>
        </section>

        <section aria-labelledby="download-privacy-title">
          <h2 id="download-privacy-title">{page.privacyTitle}</h2>
          <ul>
            {page.privacyPoints.map(point => <li key={point}>{point}</li>)}
          </ul>
          <p><Link href="/privacy">{page.privacyLink}</Link></p>
        </section>
      </article>
    </main>
  );
}
