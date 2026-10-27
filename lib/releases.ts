// Reads published GitHub Releases for the download page. Everything here is defensive:
// before the first release exists (or if GitHub is unreachable) callers get `null`, never an error.

export const RELEASES_REPO = 'salahudingsalahudin-ai/sudo-chan';
export const RELEASES_API = `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=10`;
export const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases`;

export type PlatformId = 'linux-appimage' | 'linux-deb' | 'windows' | 'macos';

export interface ReleaseAsset {
  platform: PlatformId;
  name: string;
  url: string;
  size: number;
  sha256?: string;
}

export interface LatestRelease {
  version: string;
  name: string;
  url: string;
  publishedAt?: string;
  prerelease: boolean;
  assets: ReleaseAsset[];
  checksumsUrl?: string;
}

interface GithubAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
  digest?: unknown;
}

interface GithubRelease {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

export function platformForAsset(name: string): PlatformId | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.appimage')) return 'linux-appimage';
  if (lower.endsWith('.deb')) return 'linux-deb';
  if (lower.endsWith('.exe')) return 'windows';
  if (lower.endsWith('.dmg')) return 'macos';
  return null;
}

export function isGithubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com'));
  } catch {
    return false;
  }
}

function sha256FromDigest(digest: unknown): string | undefined {
  if (typeof digest !== 'string') return undefined;
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim());
  return match ? match[1].toLowerCase() : undefined;
}

/** Turns one GitHub API release object into what the page needs, or null if it is unusable. */
export function parseRelease(raw: unknown): LatestRelease | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as GithubRelease;
  if (r.draft === true) return null;
  if (typeof r.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(r.tag_name)) return null;
  if (typeof r.html_url !== 'string' || !isGithubUrl(r.html_url)) return null;

  const assets: ReleaseAsset[] = [];
  let checksumsUrl: string | undefined;
  if (Array.isArray(r.assets)) {
    for (const item of r.assets as GithubAsset[]) {
      if (!item || typeof item.name !== 'string' || typeof item.browser_download_url !== 'string') continue;
      if (!isGithubUrl(item.browser_download_url)) continue;
      if (item.name === 'SHA256SUMS.txt') {
        checksumsUrl = item.browser_download_url;
        continue;
      }
      const platform = platformForAsset(item.name);
      if (!platform) continue;
      assets.push({
        platform,
        name: item.name,
        url: item.browser_download_url,
        size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0,
        sha256: sha256FromDigest(item.digest),
      });
    }
  }

  return {
    version: r.tag_name.replace(/^v/, ''),
    name: typeof r.name === 'string' && r.name ? r.name : `Sudo-chan ${r.tag_name.replace(/^v/, '')}`,
    url: r.html_url,
    publishedAt: typeof r.published_at === 'string' ? r.published_at : undefined,
    prerelease: r.prerelease === true,
    assets,
    checksumsUrl,
  };
}

/** Picks the newest published release (prereleases included: the first builds will be prereleases). */
export function pickLatest(list: unknown): LatestRelease | null {
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    const parsed = parseRelease(item);
    if (parsed) return parsed;
  }
  return null;
}

export async function fetchLatestRelease(
  fetchFn: typeof fetch = fetch,
  options: { revalidateSeconds?: number; timeoutMs?: number } = {},
): Promise<LatestRelease | null> {
  try {
    const response = await fetchFn(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      // Next.js caches this for an hour so the page does not hit the GitHub rate limit.
      next: { revalidate: options.revalidateSeconds ?? 3600 },
    } as RequestInit);
    if (!response.ok) return null;
    return pickLatest(await response.json());
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
