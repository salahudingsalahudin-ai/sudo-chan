/**
 * Per-provider API key storage logic, kept free of Electron so it can be unit tested.
 * `cloud` is the ACTIVE chat provider. `providers` holds one entry per provider so a
 * Gemini key for voice can exist while chat stays on Groq.
 */
export interface StoredKey {
  provider?: string;
  endpoint?: string;
  model?: string;
  encryptedKey?: string;
  rawKey?: string;
}
export type ProviderMap = Record<string, StoredKey | undefined>;
export interface KeyCodec {
  encrypt(key: string): { encryptedKey?: string; rawKey?: string };
  decrypt(stored?: StoredKey): string;
}

/** Key for a provider: its own `providers` entry first, otherwise the active entry if it is that provider. */
export function resolveProviderKey(id: string, active: StoredKey | undefined, providers: ProviderMap | undefined, codec: KeyCodec): string {
  const own = codec.decrypt(providers?.[id]);
  if (own) return own;
  if (active && active.provider === id) return codec.decrypt(active);
  return '';
}

/**
 * Saving a Gemini key while another provider is active must not switch chat to Gemini
 * (free-tier quota is tiny; Groq is the chat default). Everything else activates as before.
 */
export function shouldActivate(activeProvider: string | undefined, incomingProvider: string, makeActive: boolean | undefined): boolean {
  if (makeActive) return true;
  if (incomingProvider === 'gemini' && activeProvider && activeProvider !== 'gemini') return false;
  return true;
}

export function withProviderEntry(providers: ProviderMap | undefined, id: string, entry: StoredKey): ProviderMap {
  return { ...(providers ?? {}), [id]: entry };
}

/**
 * Makes sure the active entry is mirrored under `providers` and that plain base64 entries
 * are re-encrypted when encryption is available. Returns null when nothing changed.
 */
export function migrateProviders(active: StoredKey | undefined, providers: ProviderMap | undefined, codec: KeyCodec, canEncrypt: boolean): ProviderMap | null {
  const next: ProviderMap = { ...(providers ?? {}) };
  let changed = false;
  if (active && active.provider && !next[active.provider] && codec.decrypt(active)) {
    next[active.provider] = { ...active };
    changed = true;
  }
  if (canEncrypt) {
    for (const id of Object.keys(next)) {
      const entry = next[id];
      if (entry && entry.rawKey && !entry.encryptedKey) {
        const plain = codec.decrypt(entry);
        const encrypted = plain ? codec.encrypt(plain) : {};
        if (encrypted.encryptedKey) {
          next[id] = { provider: entry.provider, endpoint: entry.endpoint, model: entry.model, encryptedKey: encrypted.encryptedKey };
          changed = true;
        }
      }
    }
  }
  return changed ? next : null;
}
