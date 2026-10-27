import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RELEASE_PUBLISHED, RELEASES_LATEST_URL } from '../content';
import DownloadExperience from '../components/DownloadExperience';
import DownloadPanel from '../components/DownloadPanel';
import {
  COMMANDS, OS_CARDS, STEPS, TROUBLE, WIZARD_PREVIEW, activeStepFromTops, buildGuideRelease, detectOs, expectedVerifyLine, fileNames,
  osMessage, recommendedFormat, stepHref,
} from '../lib/installGuide';
import { parseRelease } from '../lib/releases';

const UA = {
  ubuntuFirefox: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  linuxChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
};

const render = (release = { latestUrl: RELEASES_LATEST_URL }) => renderToStaticMarkup(createElement(DownloadExperience, { release }));

describe('install guide logic', () => {
  it('detects the computer from the user agent', () => {
    expect(detectOs(UA.ubuntuFirefox)).toBe('linux');
    expect(detectOs(UA.linuxChrome)).toBe('linux');
    expect(detectOs(UA.windows)).toBe('windows');
    expect(detectOs(UA.mac)).toBe('macos');
    expect(detectOs(UA.android)).toBe('mobile');
    expect(detectOs(UA.iphone)).toBe('mobile');
    expect(detectOs('')).toBe('unknown');
    expect(recommendedFormat(UA.ubuntuFirefox)).toBe('deb');
    expect(recommendedFormat(UA.linuxChrome)).toBeNull();
  });

  it('builds the exact file names the build produces', () => {
    expect(fileNames('0.1.0')).toEqual({ appImage: 'Sudo-chan-0.1.0-linux-x86_64.AppImage', deb: 'Sudo-chan-0.1.0-linux-amd64.deb', checksums: 'SHA256SUMS' });
    expect(fileNames().appImage).toBe('Sudo-chan-<version>-linux-x86_64.AppImage');
    expect(fileNames('not a version').deb).toBe('Sudo-chan-<version>-linux-amd64.deb');
    expect(expectedVerifyLine('Sudo-chan-0.1.0-linux-amd64.deb')).toBe('Sudo-chan-0.1.0-linux-amd64.deb: OK');
  });

  it('keeps the copy-command strings exact', () => {
    expect(COMMANDS.verify).toBe('sha256sum -c SHA256SUMS --ignore-missing');
    expect(COMMANDS.debInstall).toBe('sudo apt install ./Sudo-chan-*.deb');
    expect(COMMANDS.appImageChmod).toBe('chmod +x Sudo-chan-*.AppImage');
    expect(COMMANDS.appImageRun).toBe('./Sudo-chan-*-linux-x86_64.AppImage');
    expect(COMMANDS.fuse).toBe('sudo apt install libfuse2');
    expect(COMMANDS.fixDeps).toBe('sudo apt -f install');
  });

  it('has 4 anchored steps and a clamped step link', () => {
    expect(STEPS.map(s => s.id)).toEqual(['step-1', 'step-2', 'step-3', 'step-4']);
    expect(stepHref(2)).toBe('#step-2');
    expect(stepHref(0)).toBe('#step-1');
    expect(stepHref(9)).toBe('#step-4');
  });

  it('picks the active step from heading positions', () => {
    expect(activeStepFromTops([300, 900, 1500, 2100], 200)).toBe(0);
    expect(activeStepFromTops([-100, 400, 1000, 1600], 200)).toBe(0);
    expect(activeStepFromTops([-900, -300, 150, 800], 200)).toBe(2);
    expect(activeStepFromTops([-3000, -2000, -1000, -10], 200)).toBe(3);
    expect(activeStepFromTops([], 200)).toBe(0);
  });

  it('is honest about Windows and macOS', () => {
    const status = Object.fromEntries(OS_CARDS.map(c => [c.id, c.status]));
    expect(status).toEqual({ linux: 'Available now', windows: 'Not built yet', macos: 'Not built yet' });
    expect(osMessage('windows')).toMatch(/no Windows build yet/);
    expect(osMessage('windows')).toMatch(/SmartScreen/);
    expect(osMessage('macos')).toMatch(/Gatekeeper/);
    expect(osMessage('linux')).toBe('');
  });

  it('has exactly 5 troubleshooting items and 5 wizard preview steps', () => {
    expect(TROUBLE).toHaveLength(5);
    expect(WIZARD_PREVIEW.map(w => w.id)).toEqual(['mic', 'name', 'brain', 'privacy', 'try']);
  });

  it('uses real GitHub data when present and falls back to the latest page', () => {
    expect(buildGuideRelease(null, RELEASES_LATEST_URL)).toEqual({ latestUrl: RELEASES_LATEST_URL });
    const base = 'https://github.com/salahudingsalahudin-ai/sudo-chan/releases/download/v0.1.0/';
    const parsed = parseRelease({
      tag_name: 'v0.1.0', html_url: 'https://github.com/salahudingsalahudin-ai/sudo-chan/releases/tag/v0.1.0', draft: false, prerelease: true,
      assets: [
        { name: 'Sudo-chan-0.1.0-linux-x86_64.AppImage', browser_download_url: `${base}Sudo-chan-0.1.0-linux-x86_64.AppImage`, size: 125_829_120 },
        { name: 'Sudo-chan-0.1.0-linux-amd64.deb', browser_download_url: `${base}Sudo-chan-0.1.0-linux-amd64.deb`, size: 100_663_296 },
        { name: 'SHA256SUMS', browser_download_url: `${base}SHA256SUMS`, size: 200 },
      ],
    });
    const guide = buildGuideRelease(parsed, RELEASES_LATEST_URL);
    expect(guide).toMatchObject({ version: '0.1.0', debUrl: `${base}Sudo-chan-0.1.0-linux-amd64.deb`, appImageUrl: `${base}Sudo-chan-0.1.0-linux-x86_64.AppImage`, checksumsUrl: `${base}SHA256SUMS`, debSize: '96.0 MB', appImageSize: '120 MB' });
  });
});

describe('install guide page (rendered with the switch on, independent of the constant)', () => {
  const html = render();
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('renders all four steps with anchors', () => {
    for (const n of [1, 2, 3, 4]) expect(html).toContain(`id="step-${n}"`);
    expect(html).toContain('href="#step-2"');
    expect(html).toContain('Install Sudo-chan in 4 steps');
    expect(html).toContain('Something went wrong?');
  });

  it('shows the exact file-name patterns, sizes and commands', () => {
    expect(html).toContain('Sudo-chan-&lt;version&gt;-linux-x86_64.AppImage');
    expect(html).toContain('Sudo-chan-&lt;version&gt;-linux-amd64.deb');
    expect(text).toMatch(/about 96 MB/);
    expect(text).toMatch(/about 120 MB/);
    for (const cmd of [COMMANDS.verify, COMMANDS.debInstall, COMMANDS.appImageChmod, COMMANDS.appImageRun, COMMANDS.fuse, COMMANDS.fixDeps]) {
      expect(text).toContain(cmd);
    }
    expect(html).toContain(`aria-label="Copy command: ${COMMANDS.debInstall}"`);
  });

  it('shows the real version in file names when GitHub data is known', () => {
    const real = renderToStaticMarkup(createElement(DownloadExperience, { release: { version: '0.1.0', latestUrl: RELEASES_LATEST_URL } }));
    expect(real).toContain('Sudo-chan-0.1.0-linux-x86_64.AppImage');
    expect(real).toContain('Sudo-chan-0.1.0-linux-amd64.deb: OK');
  });

  it('links to the GitHub latest release, labels the preview as an illustration, marks Windows and macOS not built', () => {
    expect(html).toContain(`href="${RELEASES_LATEST_URL}"`);
    expect(text).toMatch(/Illustration/);
    expect(text.match(/Not built yet/g)).toHaveLength(2);
    expect(text).toMatch(/unsigned|not code-signed/i);
  });

  it('makes no false claims and shows no personal email, counts or reviews', () => {
    expect(text).not.toMatch(/coming soon|not released|no download|not out yet/i);
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
    expect(text).not.toMatch(/downloads?\b.*\b\d[\d,]*\s*(downloads|users)|★|stars|reviews?|verified by|signed by/i);
  });

  it('DownloadPanel on the home page no longer says coming soon and points at the guide', () => {
    const panel = renderToStaticMarkup(createElement(DownloadPanel)).replace(/<[^>]+>/g, ' ');
    expect(panel).not.toMatch(/coming soon|not released|not out yet/i);
    expect(panel).toMatch(/install guide/i);
  });
});

describe('with the switch off (the committed state)', () => {
  it('ships RELEASE_PUBLISHED = false', () => {
    expect(RELEASE_PUBLISHED).toBe(false);
    expect(readFileSync(join(__dirname, '..', 'content.ts'), 'utf8')).toMatch(/RELEASE_PUBLISHED: boolean = false;/);
  });

  it('/download calls notFound() and never fetches GitHub', async () => {
    const { default: DownloadPage } = await import('../app/download/page');
    const realFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return new Response('[]'); }) as typeof fetch;
    try {
      await expect(DownloadPage()).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_NOT_FOUND') });
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('the sitemap does not list /download', async () => {
    const { default: sitemap } = await import('../app/sitemap');
    expect(sitemap().map(e => e.url).some(u => u.endsWith('/download'))).toBe(false);
  });
});
