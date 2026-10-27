import test from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_INTERVAL_MS, RETRY_AFTER_FAILURE_MS, checkForUpdate, compareVersions, newestRelease, parseVersion } from '../src/main/update-check.ts';

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
