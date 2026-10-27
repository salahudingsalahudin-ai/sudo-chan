import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Verdict } from './types.js';

/** Output limits for results fed back to the model. */
export const MAX_RESULT_BYTES = 8 * 1024;
export const MAX_READ_BYTES = 20 * 1024;

export function truncate(text: string, limit = MAX_RESULT_BYTES): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= limit) return text;
  const cut = buffer.subarray(0, limit).toString('utf8').replace(/�$/, '');
  return `${cut}\n[... truncated, ${buffer.length - limit} more bytes]`;
}

// ---------------------------------------------------------------- paths

/** Folders (relative to home) that tools may never touch. */
const DENIED_HOME_DIRS = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store',
  '.config/Sudo-chan', '.config/gh', '.config/gcloud', '.config/google-chrome', '.config/chromium',
  '.config/BraveSoftware', '.config/microsoft-edge', '.config/Bitwarden', '.config/1Password',
  '.mozilla', '.thunderbird', '.local/share/keyrings', '.claude', '.codex', '.gemini', '.copilot', '.cursor',
  'snap/firefox', 'snap/chromium',
];
const DENIED_ABSOLUTE = ['/etc/shadow', '/etc/gshadow', '/etc/sudoers', '/etc/sudoers.d', '/root', '/proc', '/sys', '/dev'];
const DENIED_BASENAMES = new Set([
  '.netrc', '.pgpass', '.git-credentials', '.npmrc', '.pypirc', '.bash_history', '.zsh_history', '.python_history',
  '.node_repl_history', '.psql_history', '.mysql_history', '.lesshst', '.claude.json', 'authorized_keys',
]);

function isDeniedBasename(name: string): boolean {
  const lower = name.toLowerCase();
  if (DENIED_BASENAMES.has(lower)) return true;
  if (lower === '.env' || (lower.startsWith('.env.') && lower !== '.env.example')) return true;
  if (/^(cookies|login data|web data|logins\.json|key[0-9]*\.db)(-journal)?$/.test(lower)) return true;
  if (/\.(pem|p12|pfx|kdbx)$/.test(lower)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(lower)) return true;
  return false;
}

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

export function isSecretPath(absolutePath: string, home = homedir()): boolean {
  if (DENIED_ABSOLUTE.some(folder => within(absolutePath, folder))) return true;
  if (DENIED_HOME_DIRS.some(folder => within(absolutePath, join(home, folder)))) return true;
  return absolutePath.split(sep).some(part => part.length > 0 && isDeniedBasename(part));
}

/** realpath of the path, or of its nearest existing ancestor with the remainder appended (for files not created yet). */
export function realpathLoose(absolutePath: string): string {
  let current = absolutePath;
  const rest: string[] = [];
  for (let guard = 0; guard < 64; guard++) {
    if (existsSync(current)) {
      try {
        return join(realpathSync(current), ...rest.reverse());
      } catch {
        return absolutePath;
      }
    }
    const parent = dirname(current);
    if (parent === current) return absolutePath;
    rest.push(basename(current));
    current = parent;
  }
  return absolutePath;
}

export interface PathCheck extends Verdict {
  /** Fully resolved path (symlinks followed). */
  path: string;
  outsideHome: boolean;
}

export interface PathOptions {
  home?: string;
  /** Reads outside home need confirmation; writes outside home are denied. */
  write?: boolean;
}

export function checkPath(input: string, options: PathOptions = {}): PathCheck {
  const home = realpathLoose(options.home ?? homedir());
  const raw = typeof input === 'string' ? input.trim() : '';
  const fail = (reason: string): PathCheck => ({ verdict: 'deny', reason, path: raw, outsideHome: false });
  if (!raw) return fail('Empty path.');
  if (raw.includes('\0')) return fail('Invalid path.');
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
  const lexical = resolve(isAbsolute(expanded) ? expanded : join(home, expanded));
  const real = realpathLoose(lexical);

  // Check both the typed path and where it really leads, so a symlink cannot smuggle in a secret.
  for (const candidate of [lexical, real]) {
    if (isSecretPath(candidate, home)) {
      return { verdict: 'deny', reason: 'That location holds secrets or private data and is blocked.', path: real, outsideHome: false };
    }
  }
  const outsideHome = !within(real, home);
  if (outsideHome) {
    if (options.write) return { verdict: 'deny', reason: 'Writing outside the home folder is not allowed.', path: real, outsideHome: true };
    return { verdict: 'confirm', reason: 'This path is outside your home folder.', elevated: true, path: real, outsideHome: true };
  }
  return { verdict: 'allow', path: real, outsideHome: false };
}

// ------------------------------------------------------------- commands

export class CommandParseError extends Error {}

/**
 * Splits a command string into argv WITHOUT any shell interpretation. Pipes, redirects, command
 * substitution and chaining are rejected rather than silently passed on as literal arguments.
 */
export function tokenizeCommand(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) { out.push(current); current = ''; started = false; }
      continue;
    }
    if ('|;&<>`'.includes(ch) || (ch === '$' && text[i + 1] === '(')) {
      throw new CommandParseError('Shell features (pipes, redirects, ;, &&, backticks, $(...)) are not supported. Run one program with plain arguments.');
    }
    current += ch;
    started = true;
  }
  if (quote) throw new CommandParseError('Unclosed quote in command.');
  if (started) out.push(current);
  return out;
}

const DESTRUCTIVE_PROGRAMS = new Set([
  'mkfs', 'fdisk', 'sfdisk', 'parted', 'wipefs', 'shutdown', 'reboot', 'poweroff', 'halt', 'init',
  'cryptsetup', 'losetup', 'mount', 'umount', 'iptables', 'nft', 'passwd', 'chpasswd', 'useradd', 'userdel', 'visudo',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh']);

export interface CommandCheck extends Verdict {
  program: string;
  args: string[];
}

export function checkCommand(program: string, args: string[], cwd: string, options: { home?: string } = {}): CommandCheck {
  const home = options.home ?? homedir();
  const name = basename(program);
  const base: CommandCheck = { verdict: 'confirm', program, args };
  const deny = (reason: string): CommandCheck => ({ verdict: 'deny', reason, program, args });
  if (!program || program.includes('\0') || args.some(a => a.includes('\0'))) return deny('Invalid command.');
  const joined = [program, ...args].join(' ');

  if (/:\(\)\s*\{.*\}\s*;?\s*:/.test(joined)) return deny('Fork bombs are blocked.');
  if (DESTRUCTIVE_PROGRAMS.has(name) || /^mkfs\./.test(name)) return deny(`"${name}" is blocked because it can destroy data or change the system.`);
  if (SHELLS.has(name) && args.some(a => a === '-c' || a === '--command')) return deny('Running shell -c strings is blocked. Run the program directly with arguments.');
  if (name === 'eval' || name === 'exec') return deny(`"${name}" is blocked.`);
  if (name === 'dd' && args.some(a => /^of=\/dev\//.test(a))) return deny('Writing to a device with dd is blocked.');
  if (name === 'chmod' || name === 'chown') {
    const recursive = args.some(a => /^-[a-zA-Z]*R/.test(a) || a === '--recursive');
    if (recursive && args.some(a => a === '/' || a === '/*' || a === '~' || a === home || a === `${home}/`)) {
      return deny(`Recursive ${name} on / or the home folder is blocked.`);
    }
  }
  if (name === 'rm' || name === 'rmdir' || name === 'shred' || name === 'trash') {
    if (args.includes('--no-preserve-root')) return deny('--no-preserve-root is blocked.');
    const strong = args.some(a => /^-[a-zA-Z]*[rRf]/.test(a) || a === '--recursive' || a === '--force');
    for (const target of args.filter(a => !a.startsWith('-'))) {
      const expanded = target === '~' ? home : target.startsWith('~/') ? join(home, target.slice(2)) : target;
      const abs = resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
      if (abs === '/' || target === '/*' || target === '~/*' || abs === home || home.startsWith(abs + sep)) {
        return deny('Deleting / or your whole home folder is blocked.');
      }
      if (strong && isSecretPath(abs, home)) return deny('That location holds secrets and is protected.');
    }
  }
  const secretArg = args.find(a => !a.startsWith('-') && /(^|\/)(\.ssh|\.gnupg|\.env[^/]*|\.aws|Sudo-chan|\.bash_history|id_rsa|id_ed25519)(\/|$)/.test(a));
  if (secretArg) return deny('The command touches a protected secrets location.');
  if (name === 'sudo' || name === 'su' || name === 'doas' || name === 'pkexec') {
    return { ...base, elevated: true, reason: 'Runs with administrator rights.' };
  }
  return base;
}

/** Environment passed to child processes: strips anything that looks like a credential. */
export function sanitizedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Only http(s) URLs may be opened. */
export function checkUrl(value: string): { ok: boolean; url?: string; reason?: string } {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'Only http and https links can be opened.' };
    return { ok: true, url: url.toString() };
  } catch {
    return { ok: false, reason: 'That is not a valid URL.' };
  }
}

export function checkAppName(value: string): { ok: boolean; reason?: string } {
  if (SHELLS.has(value) || DESTRUCTIVE_PROGRAMS.has(value)) return { ok: false, reason: 'That program cannot be opened this way.' };
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value)
    ? { ok: true }
    : { ok: false, reason: 'Use a plain application name (letters, digits, dot, dash).' };
}
