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
