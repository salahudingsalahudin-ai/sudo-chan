import { describe, expect, it } from 'vitest';
import { fetchLatestRelease, formatBytes, parseRelease, pickLatest, platformForAsset } from '../lib/releases';

const asset = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  browser_download_url: `https://github.com/salahudingsalahudin-ai/sudo-chan/releases/download/v0.1.0/${name}`,
  size: 123_456_789,
  ...extra,
});

const release = (overrides: Record<string, unknown> = {}) => ({
  tag_name: 'v0.1.0',
  name: 'Sudo-chan 0.1.0',
  html_url: 'https://github.com/salahudingsalahudin-ai/sudo-chan/releases/tag/v0.1.0',
  draft: false,
  prerelease: true,
  published_at: '2026-11-01T10:00:00Z',
  assets: [
    asset('Sudo-chan-0.1.0-linux-x86_64.AppImage', { digest: `sha256:${'a'.repeat(64)}` }),
    asset('Sudo-chan-0.1.0-linux-amd64.deb'),
    asset('SHA256SUMS.txt'),
    asset('notes.zip'),
  ],
  ...overrides,
});

describe('release parsing', () => {
  it('maps installers by extension and ignores unknown files', () => {
    expect(platformForAsset('x.AppImage')).toBe('linux-appimage');
    expect(platformForAsset('x.deb')).toBe('linux-deb');
    expect(platformForAsset('x.exe')).toBe('windows');
    expect(platformForAsset('x.dmg')).toBe('macos');
    expect(platformForAsset('x.zip')).toBeNull();
  });

  it('parses a published release with assets, digest and checksums file', () => {
    const parsed = parseRelease(release());
    expect(parsed?.version).toBe('0.1.0');
    expect(parsed?.prerelease).toBe(true);
    expect(parsed?.assets.map(a => a.platform)).toEqual(['linux-appimage', 'linux-deb']);
    expect(parsed?.assets[0].sha256).toBe('a'.repeat(64));
    expect(parsed?.checksumsUrl).toContain('SHA256SUMS.txt');
  });

  it('rejects drafts, odd tags and non-GitHub download links', () => {
    expect(parseRelease(release({ draft: true }))).toBeNull();
    expect(parseRelease(release({ tag_name: 'nightly' }))).toBeNull();
    expect(parseRelease(release({ html_url: 'https://evil.example.com/x' }))).toBeNull();
    const withBadAsset = parseRelease(release({ assets: [{ name: 'a.exe', browser_download_url: 'https://evil.example.com/a.exe', size: 1 }] }));
    expect(withBadAsset?.assets).toEqual([]);
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease('x')).toBeNull();
  });

  it('picks the newest usable release and returns null for empty or invalid lists', () => {
    expect(pickLatest([release({ draft: true }), release({ tag_name: 'v0.2.0' })])?.version).toBe('0.2.0');
    expect(pickLatest([])).toBeNull();
    expect(pickLatest({ message: 'Not Found' })).toBeNull();
  });
});

describe('fetchLatestRelease', () => {
  it('returns the release when GitHub answers', async () => {
    const fake = (async () => new Response(JSON.stringify([release()]), { status: 200 })) as typeof fetch;
    expect((await fetchLatestRelease(fake))?.version).toBe('0.1.0');
  });

  it('falls back to null when there is no release yet, on errors, and when offline', async () => {
    const empty = (async () => new Response('[]', { status: 200 })) as typeof fetch;
    const notFound = (async () => new Response('{}', { status: 404 })) as typeof fetch;
    const rateLimited = (async () => new Response('{}', { status: 403 })) as typeof fetch;
    const offline = (async () => { throw new Error('offline'); }) as typeof fetch;
    const broken = (async () => new Response('not json', { status: 200 })) as typeof fetch;
    for (const fake of [empty, notFound, rateLimited, offline, broken]) {
      expect(await fetchLatestRelease(fake)).toBeNull();
    }
  });
});

describe('formatBytes', () => {
  it('formats sizes for humans', () => {
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(124_902_915)).toBe('119 MB');
    expect(formatBytes(5_400_000)).toBe('5.1 MB');
  });
});
