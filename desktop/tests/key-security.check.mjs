import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, statSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeKeyStorage, keyStoragePlan } from '../src/main/key-storage.ts';
import { hardenKeyFiles } from '../src/main/key-files.ts';
import { stripAllKeys } from '../src/main/provider-keys.ts';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

// ------------------------------------------------------------------ honest wording (one source: describeKeyStorage)
test('Linux default: the text says keys are NOT encrypted, never mentions safeStorage or an encryption promise', () => {
  const d = describeKeyStorage(keyStoragePlan('linux', {}), 'linux');
  assert.equal(d.encrypted, false);
  for (const text of [d.hint, d.detail, d.fact]) {
    assert.doesNotMatch(text, /safeStorage/i);
    assert.doesNotMatch(text, /encrypted (on|via) (this|your) device/i);
  }
  assert.match(d.hint, /NOT encrypted on Linux/);
  assert.match(d.detail, /NOT encrypted/);
  assert.match(d.detail, /base64/);
  assert.match(d.detail, /only your user account can read/);
  assert.match(d.fact, /not encrypted on Linux/);
  assert.match(d.hint + d.detail, /never sent to Sudo-chan servers/i);
});

test('Windows and macOS name the real mechanism and still admit the plain fallback', () => {
  const win = describeKeyStorage(keyStoragePlan('win32', {}), 'win32');
  const mac = describeKeyStorage(keyStoragePlan('darwin', {}), 'darwin');
  assert.equal(win.encrypted, true);
  assert.match(win.detail, /Windows \(DPAPI\)/);
  assert.match(mac.detail, /macOS Keychain/);
  for (const d of [win, mac]) assert.match(d.detail, /not available[^.]*base64 \(not encrypted\)/, 'the fallback is stated, not hidden');
});

test('Linux opt-in keyring (SUDO_CHAN_USE_KEYRING=1) does not overpromise', () => {
  const d = describeKeyStorage(keyStoragePlan('linux', { SUDO_CHAN_USE_KEYRING: '1' }), 'linux');
  assert.match(d.hint, /when it is available/);
  assert.match(d.hint, /plain text/);
});

test('smoke runs and unknown platforms describe the base64 file without the Linux sentence', () => {
  const d = describeKeyStorage(keyStoragePlan('darwin', {}, true), 'darwin');
  assert.equal(d.encrypted, false);
  assert.match(d.hint, /not encrypted/i);
  assert.doesNotMatch(d.detail, /Linux/);
});

test('the UI never hard-codes a storage claim: it renders what describeKeyStorage returned', () => {
  const app = strip(read('../src/renderer/App.tsx'));
  const ai = strip(read('../src/renderer/AISettings.tsx'));
  const ui = strip(read('../src/renderer/KeyStorage.tsx'));
  for (const [name, code] of [['App.tsx', app], ['AISettings.tsx', ai], ['KeyStorage.tsx', ui]]) {
    assert.doesNotMatch(code, /safeStorage/, `${name} must not mention safeStorage`);
    assert.doesNotMatch(code, /encrypted (on|via) (this|your)/i, `${name} must not claim encryption`);
  }
  assert.match(app, /keyStorage\.detail/);
  assert.match(app, /keyStorage\.fact/);
  assert.match(ai, /\{keyStorage\.hint\}/);
  // Until main answers, the placeholder claims nothing about encryption.
  assert.match(ui, /const PENDING/);
  const pending = ui.slice(ui.indexOf('const PENDING'), ui.indexOf('export function useKeyStorageInfo')).replace('encrypted: false,', '');
  assert.doesNotMatch(pending, /encrypt/i);
});

test('the docs repeat the same facts', () => {
  const doc = read('../KEY-ROTATION.md');
  assert.match(doc, /not encrypted on Linux/i);
  assert.match(doc, /Remove saved keys/);
  assert.match(doc, /never paste/i);
});

// ------------------------------------------------------------------ permissions
const mode = path => statSync(path).mode & 0o777;

test('hardenKeyFiles creates the folder 700 and tightens an existing 644 config.json to 600', { skip: process.platform === 'win32' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'sudo-key-'));
  const dir = join(base, 'userdata');
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  const file = join(dir, 'config.json');
  writeFileSync(file, '{"cloud":{}}', { mode: 0o644 });
  chmodSync(file, 0o644);
  const report = hardenKeyFiles(dir, ['config.json'], process.platform);
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(file), 0o600);
  assert.deepEqual(report.fixedFiles, [file]);
  assert.equal(report.dirOk, true);
  // Idempotent: nothing left to fix.
  assert.deepEqual(hardenKeyFiles(dir, ['config.json'], process.platform).fixedFiles, []);
  // A missing folder is created 700 (before the store makes the file).
  const fresh = join(base, 'a', 'b');
  hardenKeyFiles(fresh, ['config.json'], process.platform);
  assert.equal(mode(fresh), 0o700);
  assert.equal(existsSync(join(fresh, 'config.json')), false, 'it never creates the key file itself');
});

test('hardenKeyFiles never throws and never blocks: failing fs, missing file, Windows', () => {
  const boom = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  const report = hardenKeyFiles('/nonexistent/x', ['config.json'], 'linux', { mkdirSync: boom, chmodSync: boom, statSync: boom });
  assert.equal(report.dirOk, false);
  assert.ok(report.failed.length >= 1);
  const win = hardenKeyFiles('C:\\x', ['config.json'], 'win32', { mkdirSync: boom, chmodSync: boom, statSync: boom });
  assert.equal(win.skipped, true);
  const enoent = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  const missing = hardenKeyFiles('/d', ['config.json'], 'linux', { mkdirSync: () => {}, chmodSync: () => {}, statSync: p => { if (p === '/d') return { mode: 0o40700 }; return enoent(); } });
  assert.deepEqual(missing.failed, [], 'a file that does not exist yet is not a failure');
});

test('key-files.ts is synchronous fs only: no safeStorage, no child process, no timers', () => {
  const src = strip(read('../src/main/key-files.ts'));
  assert.doesNotMatch(src, /safeStorage|child_process|spawn|exec\(|setTimeout|await /);
});

// ------------------------------------------------------------------ Remove saved keys
test('stripAllKeys removes every secret, keeps provider/model/region, counts keys once', () => {
  const active = { provider: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'm', rawKey: 'R1' };
  const providers = {
    groq: { provider: 'groq', model: 'm', rawKey: 'R1' },
    gemini: { provider: 'gemini', encryptedKey: 'E2' },
    azure: { provider: 'azure', region: 'eastus', rawKey: 'R3' },
    openai: { provider: 'openai', model: 'x' },
  };
  const out = stripAllKeys(active, providers);
  assert.equal(out.removed, 3, 'groq (active + mirror) counts once');
  assert.deepEqual(out.cloud, { provider: 'groq', endpoint: active.endpoint, model: 'm' });
  assert.equal(out.providers.azure.region, 'eastus');
  assert.equal(out.providers.openai.model, 'x');
  assert.doesNotMatch(JSON.stringify(out), /R1|E2|R3|rawKey|encryptedKey/);
  // The inputs are not mutated.
  assert.equal(active.rawKey, 'R1');
  assert.equal(providers.gemini.encryptedKey, 'E2');
});

test('stripAllKeys is safe on empty / missing data', () => {
  assert.deepEqual(stripAllKeys(undefined, undefined), { cloud: undefined, providers: {}, removed: 0 });
  assert.equal(stripAllKeys({ provider: 'groq' }, {}).removed, 0);
});

// ------------------------------------------------------------------ wiring: settings window only, confirm step, no startup keyring
test('wiring: key-storage info and Remove saved keys are settings-window-only IPC', () => {
  const main = strip(read('../src/main/index.ts'));
  assert.match(main, /handle\(CHANNELS\.clearKeys,[\s\S]*?\}, 'settings'\);/);
  assert.match(main, /handle\(CHANNELS\.keyStorageInfo, \(\) => describeKeyStorage\(keyPlan, process\.platform\), 'settings'\);/);
  const clear = main.slice(main.indexOf('handle(CHANNELS.clearKeys'), main.indexOf('handle(CHANNELS.azureGet'));
  assert.match(clear, /stripAllKeys\(/);
  assert.match(clear, /store\.set\('providers'/);
  assert.match(clear, /apiKeySet: false, maskedKey: ''/);
  assert.match(clear, /conversation\.stop\(\)/);
  assert.doesNotMatch(clear, /console\./);
  // Neither channel is reachable for chat or overlay.
  assert.doesNotMatch(main, /clearKeys[^\n]*\['(chat|overlay)/);
  const types = read('../src/shared/types.ts');
  assert.match(types, /clearKeys: 'companion:clear-keys'/);
  assert.match(read('../src/preload/index.ts'), /clearSavedKeys: \(\) => ipcRenderer\.invoke\(CHANNELS\.clearKeys\)/);
});

test('wiring: the Remove button needs two clicks and the first one deletes nothing', () => {
  const ui = strip(read('../src/renderer/KeyStorage.tsx'));
  const click = ui.slice(ui.indexOf('const click'), ui.indexOf('return (', ui.indexOf('const click')));
  assert.match(click, /if \(!confirming\) \{ setConfirming\(true\); setMessage\(''\); return; \}/);
  assert.ok(click.indexOf('clearSavedKeys') > click.indexOf('if (!confirming)'));
  assert.match(ui, /Yes, remove all saved keys/);
  assert.match(ui, /Cancel/);
  assert.equal((ui.match(/clearSavedKeys\(/g) ?? []).length, 1, 'one call site');
  // Only the Settings window renders it.
  assert.match(strip(read('../src/renderer/App.tsx')), /<RemoveKeysRow\/>/);
  assert.equal((strip(read('../src/renderer/App.tsx')).match(/RemoveKeysRow/g) ?? []).length, 2, 'import + one use (Settings privacy card)');
  // No voice / speech path can reach it.
  for (const f of ['../src/shared/intent.ts', '../src/shared/chat-voice-turn.ts']) assert.doesNotMatch(read(f), /clearSavedKeys|clearKeys/);
});

test('wiring: config.json is created owner-only and startup still never touches safeStorage', () => {
  const main = strip(read('../src/main/index.ts'));
  const start = main.slice(main.indexOf('async function start()'));
  assert.match(start, /hardenKeyFiles\(configDir, \['config\.json'\], process\.platform\);\s*store = new Store/);
  assert.match(start, /configFileMode: 0o600/);
  assert.doesNotMatch(start.slice(0, start.indexOf('app.whenReady') > 0 ? start.indexOf('app.whenReady') : 4000), /safeStorage|isEncryptionAvailable|secret-tool/);
  assert.doesNotMatch(main, /safeStorage\.(isEncryptionAvailable|encryptString|decryptString|getSelectedStorageBackend)/);
  // The libsecret / secret-tool route is intentionally NOT implemented (see KEY-ROTATION.md).
  for (const f of ['../src/main/key-storage.ts', '../src/main/key-files.ts']) assert.doesNotMatch(strip(read(f)), /secret-tool|child_process/);
});
