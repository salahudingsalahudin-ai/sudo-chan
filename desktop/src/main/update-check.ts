// Update CHECK only. It never downloads or runs anything: it asks GitHub for the newest published
// release, compares versions, and tells the caller whether a newer one exists and where to read about it.
// Pure logic with injected dependencies so it can be unit-tested without Electron or the network.

export const UPDATE_REPO = 'salahudingsalahudin-ai/sudo-chan';
export const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=10`;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

export interface UpdateInfo {
  available: boolean;
  version?: string;
  url?: string;
  /** Why no network call was made or why nothing is available, for diagnostics and Settings text. */
  reason?: 'opt-out' | 'throttled' | 'offline' | 'no-release' | 'up-to-date' | 'newer';
  checkedAt?: number;
}

export interface UpdateState {
  lastCheckedAt?: number;
  lastAttemptAt?: number;
  last?: { version: string; url: string };
}

export interface UpdateDeps {
  fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  now(): number;
  /** The running app's version, e.g. app.getVersion(). */
  currentVersion(): string;
  /** The user's opt-out. Return false to make the checker do nothing at all. */
  isEnabled(): boolean;
  readState(): UpdateState | undefined;
  writeState(state: UpdateState): void;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

export function parseVersion(input: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ? match[4].split('.') : [] };
}

/** Semver precedence: <0 if a is older than b, 0 if equal, >0 if newer. Returns NaN if either is not a version. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return Number.NaN;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return x[key] - y[key];
  }
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1; // a release is newer than its prerelease
  if (!y.pre.length) return -1;
  const length = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < length; i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pNum = /^\d+$/.test(p);
    const qNum = /^\d+$/.test(q);
    if (pNum && qNum) {
      if (Number(p) !== Number(q)) return Number(p) - Number(q);
    } else if (pNum !== qNum) {
      return pNum ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

function isGithubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com';
  } catch {
    return false;
  }
}

/** Newest non-draft release from the GitHub list endpoint. Only github.com links are ever returned. */
export function newestRelease(list: unknown): { version: string; url: string } | null {
  if (!Array.isArray(list)) return null;
  let best: { version: string; url: string } | null = null;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as { tag_name?: unknown; html_url?: unknown; draft?: unknown };
    if (r.draft === true || typeof r.tag_name !== 'string' || typeof r.html_url !== 'string') continue;
    if (!parseVersion(r.tag_name) || !isGithubUrl(r.html_url)) continue;
    const version = r.tag_name.replace(/^v/, '');
    if (!best || compareVersions(version, best.version) > 0) best = { version, url: r.html_url };
  }
  return best;
}

function describe(current: string, latest: { version: string; url: string } | undefined, checkedAt: number): UpdateInfo {
  if (!latest) return { available: false, reason: 'no-release', checkedAt };
  const newer = compareVersions(latest.version, current) > 0;
  return newer
    ? { available: true, version: latest.version, url: latest.url, reason: 'newer', checkedAt }
    : { available: false, version: latest.version, reason: 'up-to-date', checkedAt };
}

/**
 * Checks at most once per 24 h (a failed attempt is retried after 1 h). `force` is for an explicit
 * "Check for updates" button and bypasses the throttle, but never the opt-out. Fails silently offline.
 */
export async function checkForUpdate(deps: UpdateDeps, options: { force?: boolean } = {}): Promise<UpdateInfo> {
  if (!deps.isEnabled()) return { available: false, reason: 'opt-out' };

  const now = deps.now();
  const current = deps.currentVersion();
  const state = deps.readState() ?? {};

  if (!options.force) {
    if (state.lastCheckedAt !== undefined && now - state.lastCheckedAt < CHECK_INTERVAL_MS) {
      // Still inside the 24 h window: answer from what we learned last time, without any network call.
      return describe(current, state.last, state.lastCheckedAt);
    }
    if (state.lastAttemptAt !== undefined && now - state.lastAttemptAt < RETRY_AFTER_FAILURE_MS) {
      return { available: false, reason: 'throttled' };
    }
  }

  try {
    const response = await deps.fetch(UPDATE_API, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error('bad status');
    const latest = newestRelease(await response.json()) ?? undefined;
    deps.writeState({ lastCheckedAt: now, lastAttemptAt: now, last: latest });
    return describe(current, latest, now);
  } catch {
    deps.writeState({ ...state, lastAttemptAt: now });
    return { available: false, reason: 'offline' };
  }
}
