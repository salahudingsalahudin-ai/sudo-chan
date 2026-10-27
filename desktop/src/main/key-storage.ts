/**
 * How API keys are stored on disk, decided WITHOUT touching Electron's safeStorage.
 *
 * Why: on this project's Linux laptop `safeStorage.isEncryptionAvailable()` blocks forever on the GNOME keyring
 * (verified with a scratch Electron app: no answer after 25 s, SIGTERM ignored). It is a synchronous call, so calling
 * it from the main process froze the whole app, once at startup (fixed earlier) and once when saving a key from Settings.
 * A hang cannot be caught with try/catch or a timeout, so on Linux we never call it.
 *
 * - Linux (default): keys are stored as base64 ("rawKey"). That is obfuscation, NOT encryption: anyone who can read
 *   ~/.config/Sudo-chan/config.json can decode it. Rotate keys if the file is shared.
 * - Windows / macOS: safeStorage is backed by DPAPI / Keychain and does not block, so it is used.
 * - SUDO_CHAN_USE_KEYRING=1 opts a Linux user in (at their own risk of the hang above).
 */
export type KeyStoragePlan = 'safeStorage' | 'base64';

export function keyStoragePlan(platform: string, env: Record<string, string | undefined> = {}, smokeTest = false): KeyStoragePlan {
  if (smokeTest) return 'base64';
  if (platform !== 'linux') return 'safeStorage';
  return env.SUDO_CHAN_USE_KEYRING === '1' ? 'safeStorage' : 'base64';
}

export interface StoredKeyLike {
  encryptedKey?: string;
  rawKey?: string;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Uint8Array;
  decryptString(value: Uint8Array): string;
}

export function encodeBase64Key(key: string): StoredKeyLike {
  return { rawKey: Buffer.from(key, 'utf-8').toString('base64') };
}

/** Encrypts when the plan allows it; otherwise (or on any failure) falls back to base64. Never throws. */
export function encodeKey(key: string, plan: KeyStoragePlan, safeStorage: SafeStorageLike | null | undefined): StoredKeyLike {
  if (!key) return {};
  if (plan === 'safeStorage' && safeStorage) {
    try {
      if (safeStorage.isEncryptionAvailable()) return { encryptedKey: Buffer.from(safeStorage.encryptString(key)).toString('base64') };
    } catch {
      // fall through to base64
    }
  }
  return encodeBase64Key(key);
}

/** Reads a stored key. An `encryptedKey` is only decrypted when the plan allows touching safeStorage. */
export function decodeKey(stored: StoredKeyLike | undefined, plan: KeyStoragePlan, safeStorage: SafeStorageLike | null | undefined): string {
  if (!stored) return '';
  if (stored.encryptedKey && plan === 'safeStorage' && safeStorage) {
    try {
      if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64'));
    } catch {
      // fall through to rawKey if there is one
    }
  }
  if (stored.rawKey) {
    try {
      return Buffer.from(stored.rawKey, 'base64').toString('utf-8');
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * The ONE place that says, in words, how keys are stored. Settings (via IPC), the docs and the tests all read this, so the
 * wording cannot drift from what `keyStoragePlan` really does. Pure: no Electron, no disk, never calls safeStorage.
 *
 * `encrypted` is false whenever a key can end up as base64 in config.json. With the 'safeStorage' plan that is still possible
 * (the OS can report encryption as unavailable and encodeKey then falls back), so the text says so instead of promising.
 */
export interface KeyStorageDescription {
  plan: KeyStoragePlan;
  /** True only when keys are encrypted by the operating system. Never true for the base64 plan. */
  encrypted: boolean;
  /** One sentence for the field hint under the API key box. */
  hint: string;
  /** Full paragraph for the privacy card. */
  detail: string;
  /** Short badge for the privacy card fact list. */
  fact: string;
}

const NEVER_SENT = 'They are never sent to Sudo-chan servers, only to the provider you chose.';

export function describeKeyStorage(plan: KeyStoragePlan, platform: string): KeyStorageDescription {
  if (plan === 'safeStorage') {
    const where = platform === 'win32' ? 'Windows (DPAPI)' : platform === 'darwin' ? 'the macOS Keychain' : 'the system keyring';
    return {
      plan,
      encrypted: true,
      hint: `Encrypted with ${where} when it is available. If it is not, the key is saved as plain text in a file only you can read. Never sent to Sudo-chan servers.`,
      detail: `API keys are encrypted with ${where}, so only your user account can decrypt them. If the system reports that encryption is not available, a key is saved as base64 (not encrypted) in a file that only your user account can read. ${NEVER_SENT}`,
      fact: 'API keys encrypted by your system when available',
    };
  }
  const linux = platform === 'linux';
  return {
    plan,
    encrypted: false,
    hint: `Saved on this computer in a file only your user can read${linux ? '. NOT encrypted on Linux' : ', not encrypted'}. Never sent to Sudo-chan servers.`,
    detail: `API keys are saved on this computer in a file that only your user account can read (permissions 600). ${linux ? 'On Linux they are NOT encrypted: they are only base64-encoded, which anyone who can read that file as you, or a backup of it, can undo. Sudo-chan does not use the system keyring here because asking it can freeze the app on some Linux setups.' : 'They are only base64-encoded, not encrypted.'} If a key may have leaked, delete it in the provider console, create a new one and use "Remove saved keys" below. ${NEVER_SENT}`,
    fact: linux ? 'API keys kept in a private file (not encrypted on Linux)' : 'API keys kept in a private file (not encrypted)',
  };
}
