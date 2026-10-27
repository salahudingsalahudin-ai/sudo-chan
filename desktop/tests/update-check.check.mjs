import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, validSettings } from '../src/shared/validation.ts';
import { CHECK_INTERVAL_MS, RETRY_AFTER_FAILURE_MS, checkForUpdate, compareVersions, newestRelease, parseVersion, toNotice } from '../src/shared/update-check.ts';

const release = (tag, extra = {}) => ({ tag_name: tag, html_url: `https://github.com/salahudingsalahudin-ai/sudo-chan/releases/tag/${tag}`, draft: false, ...extra });

function makeDeps({ list = [release('v0.2.0')], ok = true, throws = false, enabled = true, version = '0.1.0', state, now = 1_000_000 } = {}) {
  const calls = [];
  let stored = state;
  let clock = now;
  const deps = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (throws) throw new Error('offline');
      return { ok, json: async () => list };
    },
    now: () => clock,
    currentVersion: () => version,
    isEnabled: () => enabled,
    readState: () => stored,
    writeState: next => { stored = next; },
  };
  return { deps, calls, state: () => stored, advance: ms => { clock += ms; } };
}

test('version parsing and semver ordering, including prereleases', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, pre: [] });
  assert.equal(parseVersion('nightly'), null);
  assert.ok(compareVersions('0.2.0', '0.1.9') > 0);
  assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.1.0', 'v0.1.0'), 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-beta.1') > 0, 'release beats its prerelease');
  assert.ok(compareVersions('1.0.0-beta.2', '1.0.0-beta.1') > 0);
  assert.ok(compareVersions('1.0.0-beta.10', '1.0.0-beta.2') > 0, 'numeric identifiers compare as numbers');
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0-beta.9') > 0);
  assert.ok(Number.isNaN(compareVersions('x', '1.0.0')));
});

test('newestRelease skips drafts and junk and only returns github.com links', () => {
  const list = [
    release('v0.3.0', { draft: true }),
    release('v0.2.0'),
    release('v0.2.1'),
    { tag_name: 'nightly', html_url: 'https://github.com/x/y' },
    release('v9.9.9', { html_url: 'https://evil.example.com/v9.9.9' }),
    null,
  ];
  assert.deepEqual(newestRelease(list), { version: '0.2.1', url: 'https://github.com/salahudingsalahudin-ai/sudo-chan/releases/tag/v0.2.1' });
  assert.equal(newestRelease([]), null);
  assert.equal(newestRelease({ message: 'Not Found' }), null);
});

test('reports a newer release with its page and stores the result', async () => {
  const t = makeDeps();
  const info = await checkForUpdate(t.deps);
  assert.equal(info.available, true);
  assert.equal(info.version, '0.2.0');
  assert.match(info.url, /^https:\/\/github\.com\//);
  assert.equal(t.calls.length, 1);
  assert.equal(t.state().lastCheckedAt, 1_000_000);
});

test('up to date and no release yet are both "not available"', async () => {
  const same = await checkForUpdate(makeDeps({ list: [release('v0.1.0')] }).deps);
  assert.equal(same.available, false);
  assert.equal(same.reason, 'up-to-date');
  const none = await checkForUpdate(makeDeps({ list: [] }).deps);
  assert.equal(none.available, false);
  assert.equal(none.reason, 'no-release');
});

test('at most one network check per 24 hours, answered from the stored result in between', async () => {
  const t = makeDeps();
  await checkForUpdate(t.deps);
  t.advance(CHECK_INTERVAL_MS - 1000);
  const again = await checkForUpdate(t.deps);
  assert.equal(t.calls.length, 1, 'no second request inside the window');
  assert.equal(again.available, true);
  assert.equal(again.version, '0.2.0');
  t.advance(2000);
  await checkForUpdate(t.deps);
  assert.equal(t.calls.length, 2, 'checks again after 24 hours');
});

test('force bypasses the throttle but never the opt-out', async () => {
  const t = makeDeps();
  await checkForUpdate(t.deps);
  await checkForUpdate(t.deps, { force: true });
  assert.equal(t.calls.length, 2);

  const off = makeDeps({ enabled: false });
  const info = await checkForUpdate(off.deps, { force: true });
  assert.equal(info.available, false);
  assert.equal(info.reason, 'opt-out');
  assert.equal(off.calls.length, 0, 'opted out means zero network calls');
  assert.equal(off.state(), undefined);
});

test('fails silently offline or on a bad status, and retries only after an hour', async () => {
  const offline = makeDeps({ throws: true });
  const first = await checkForUpdate(offline.deps);
  assert.deepEqual({ available: first.available, reason: first.reason }, { available: false, reason: 'offline' });
  assert.equal(offline.state().lastCheckedAt, undefined, 'a failure is not recorded as a successful check');
  offline.advance(RETRY_AFTER_FAILURE_MS - 1000);
  const second = await checkForUpdate(offline.deps);
  assert.equal(second.reason, 'throttled');
  assert.equal(offline.calls.length, 1);
  offline.advance(2000);
  await checkForUpdate(offline.deps);
  assert.equal(offline.calls.length, 2);

  const rateLimited = makeDeps({ ok: false });
  assert.equal((await checkForUpdate(rateLimited.deps)).reason, 'offline');
});

test('the request carries no credentials or identifiers', async () => {
  const t = makeDeps();
  await checkForUpdate(t.deps);
  const headers = t.calls[0].init.headers;
  assert.deepEqual(Object.keys(headers).sort(), ['Accept', 'X-GitHub-Api-Version']);
  assert.match(t.calls[0].url, /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases/);
});

test('toNotice hands the Settings window a version number only, and nothing when switched off', async () => {
  const t = makeDeps();
  const info = await checkForUpdate(t.deps);
  assert.deepEqual(toNotice(info, true), { enabled: true, available: true, version: '0.2.0', checkedAt: 1_000_000 });
  assert.equal('url' in toNotice(info, true), false, 'no link crosses to the renderer');
  assert.deepEqual(toNotice(info, false), { enabled: false, available: false });
  assert.deepEqual(toNotice(undefined, true), { enabled: true, available: false });
  const same = await checkForUpdate(makeDeps({ version: '0.2.0' }).deps);
  assert.equal(toNotice(same, true).available, false);
});

test('the 24 h window answers from the stored result without a request, then asks again', async () => {
  const t = makeDeps();
  await checkForUpdate(t.deps);
  t.advance(CHECK_INTERVAL_MS - 1000);
  const cached = await checkForUpdate(t.deps);
  assert.equal(cached.available, true, 'the stored answer is still shown');
  assert.equal(t.calls.length, 1);
  t.advance(2000);
  await checkForUpdate(t.deps);
  assert.equal(t.calls.length, 2);
});

test('the setting defaults to ON, validates as a boolean, and off means no request at all', async () => {
  assert.equal(DEFAULT_SETTINGS.updateCheckEnabled, true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, updateCheckEnabled: false }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, updateCheckEnabled: 'no' }), false);
  const t = makeDeps({ enabled: false });
  assert.equal((await checkForUpdate(t.deps, { force: true })).reason, 'opt-out');
  assert.equal(t.calls.length, 0);
});

// ------------------------------------------------------------------ wiring tripwires (source text, comments stripped)
const src = rel => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('the check lives in the main process; renderer and preload have no network code', () => {
  const index = src('../src/main/index.ts');
  assert.match(index, /handle\(CHANNELS\.updateNotice, \(\) => toNotice\(lastUpdateInfo, state\.settings\.updateCheckEnabled !== false\), 'settings'\);/);
  assert.match(index, /isEnabled: \(\) => state\.settings\.updateCheckEnabled !== false/);
  assert.match(index, /if \(smokeTest\) return;\s*setTimeout\(\(\) => void runUpdateCheck\(\), 20_000\)/, 'first check shortly after startup, never in smoke runs');
  const startBody = index.slice(index.indexOf('async function start()'));
  assert.doesNotMatch(startBody.slice(0, startBody.indexOf('\n}\n')), /runUpdateCheck\(\)/, 'start() never awaits the network');
  for (const file of ['../src/renderer/UpdateSettings.tsx', '../src/preload/index.ts']) assert.doesNotMatch(src(file), /\bfetch\(|XMLHttpRequest|WebSocket|api\.github\.com/, file);
  assert.match(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), /connect-src 'none'/);
});

test('an update is only ever shown in Settings: the overlay and chat code never mention it', () => {
  for (const file of ['../src/renderer/App.tsx']) {
    const app = src(file);
    const uses = [...app.matchAll(/UpdateSettings|getUpdateNotice/g)].length;
    assert.equal(uses, 3, 'one import (name and path) and one use, inside SettingsView');
    const settingsView = app.slice(app.indexOf('function SettingsView'), app.indexOf('export default function App'));
    assert.match(settingsView, /<UpdateSettings /);
  }
  const ui = src('../src/renderer/UpdateSettings.tsx');
  assert.doesNotMatch(ui, /alert\(|Notification|speech|openExternal|window\.open/);
});
