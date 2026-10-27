/**
 * Sensitive-window guard for screen assist. The window list comes from the accessibility bus (AT-SPI) on this
 * GNOME Wayland machine: Electron cannot read other windows' titles, and org.gnome.Shell.Introspect answers
 * AccessDenied. The list is only inspected locally, never logged and never sent anywhere.
 */

export interface WindowInfo {
  app: string;
  title: string;
  showing: boolean;
  active?: boolean;
}

export type GuardStatus = 'clear' | 'sensitive' | 'unknown';
export interface GuardResult { status: GuardStatus; /** Which keyword matched (never the window title). */ matched?: string }

/** Whole-word / phrase keywords, matched case-insensitively against window titles and app names. */
export const SENSITIVE_KEYWORDS = [
  'password', 'passwords', 'passwd', 'passphrase', 'bitwarden', '1password', 'keepass', 'keepassxc', 'lastpass', 'dashlane', 'enpass', 'proton pass',
  'bank', 'banking', 'netbanking', 'paypal', 'payoneer', 'easypaisa', 'jazzcash', 'credit card', 'cvv',
  'wallet', 'metamask', 'seed phrase', 'recovery phrase', 'private key',
  'otp', 'one-time', 'one time code', '2fa', 'two-factor', 'authenticator', 'verification code',
  'login', 'log in', 'sign in', 'signin', 'sign-in',
  'private browsing', 'private window', 'incognito', 'inprivate',
];

const PATTERNS = SENSITIVE_KEYWORDS.map(keyword => ({
  keyword,
  re: new RegExp(`(?:^|[^\\p{L}\\p{N}])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\s_-]+')}(?:$|[^\\p{L}\\p{N}])`, 'iu'),
}));

/** Windows of Sudo-chan itself are never "sensitive" (they are hidden before a capture anyway). */
function isOwnWindow(w: WindowInfo): boolean {
  return /^sudo-chan/i.test(w.title.trim()) && /electron|sudo-chan/i.test(w.app);
}

/** Only windows that are actually on screen matter: that is what a screenshot would contain. */
export function findSensitive(windows: WindowInfo[]): GuardResult {
  for (const w of windows) {
    if (!w.showing || isOwnWindow(w)) continue;
    const haystack = `${w.title} ${w.app}`;
    for (const { keyword, re } of PATTERNS) {
      if (re.test(haystack)) return { status: 'sensitive', matched: keyword };
    }
  }
  return { status: 'clear' };
}

/** Parses the helper's JSON output. Anything unexpected is "unknown", never "clear". */
export function parseWindowList(stdout: string): WindowInfo[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '');
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: WindowInfo[] = [];
  for (const item of parsed.slice(0, 80)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    out.push({
      app: typeof o.app === 'string' ? o.app.slice(0, 80) : '',
      title: typeof o.title === 'string' ? o.title.slice(0, 160) : '',
      showing: o.showing === true,
      active: o.active === true,
    });
  }
  return out;
}

export function evaluateWindowList(stdout: string): GuardResult {
  const windows = parseWindowList(stdout);
  if (!windows || windows.length === 0) return { status: 'unknown' };
  return findSensitive(windows);
}
