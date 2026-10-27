import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenFlow, ScreenCache, isScreenFollowUp, CACHE_TTL_MS, COUNTDOWN_IDLE_RESET_MS, NOTICES, captureNotice } from '../src/shared/screen-flow.ts';

const SHOT = { dataUri: 'data:image/jpeg;base64,AAAA', thumbnail: 'data:image/jpeg;base64,BB' };

function makeFlow(options = {}) {
  const calls = { capture: 0, consentAsked: 0, saved: 0, cancelConsent: 0, statuses: [], sleeps: [], ticks: [], guard: 0 };
  const clock = { now: options.start ?? 1_000_000 };
  const state = { consent: options.consent ?? false, enabled: options.enabled ?? true, countdown: options.countdown ?? true };
  const deps = {
    now: () => clock.now,
    sleep: ms => {
      calls.sleeps.push(ms);
      if (ms === 2500) return new Promise(resolve => setTimeout(() => { clock.now += ms; resolve(); }, 25)); // guard time limit: a short real delay
      if (ms === 1000 && options.manualTicks) return new Promise(resolve => { calls.ticks.push(() => { clock.now += ms; resolve(); }); }); // countdown ticks the test releases by hand
      clock.now += ms;
      return Promise.resolve();
    },
    isEnabled: () => state.enabled,
    countdownEnabled: () => state.countdown,
    hasConsent: () => state.consent,
    saveConsent: () => { state.consent = true; calls.saved++; },
    askConsent: async source => { calls.consentAsked++; calls.consentSource = source; return typeof options.grant === 'function' ? options.grant() : (options.grant ?? true); },
    cancelConsent: () => { calls.cancelConsent++; },
    setStatus: (status, extra) => { calls.statuses.push([status, extra]); },
    capture: async () => { calls.capture++; return options.capture ? options.capture() : { ok: true, shot: SHOT }; },
    checkWindows: () => { calls.guard++; return options.guardHang ? new Promise(() => {}) : Promise.resolve(options.guard ?? { status: 'clear' }); },
  };
  const flow = new ScreenFlow(deps);
  return { flow, calls, clock, state };
}

test('consent is asked once, saved, and a wake request then captures', async () => {
  const { flow, calls } = makeFlow({ countdown: false });
  const first = await flow.request('wake');
  assert.equal(first.kind, 'proceed');
  assert.equal(calls.consentAsked, 1);
  assert.equal(calls.consentSource, 'wake');
  assert.equal(calls.saved, 1);
  assert.equal(calls.capture, 1);
  assert.equal(calls.statuses[0][0], 'consent');
  // Second request (after the cooldown) must not ask again.
  const again = makeFlow({ countdown: false, consent: true });
  await again.flow.request('wake');
  assert.equal(again.calls.consentAsked, 0);
});

test('declined consent: nothing is captured, nothing is saved, a clear notice is shown', async () => {
  const { flow, calls } = makeFlow({ grant: false });
  const result = await flow.request('wake');
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'no-consent');
  assert.equal(result.notice, NOTICES['no-consent']);
  assert.equal(calls.capture, 0);
  assert.equal(calls.saved, 0);
  assert.deepEqual(calls.statuses.at(-1), ['notice', { notice: NOTICES['no-consent'] }]);
});

test('consent can only come from askConsent resolving true: cancelling the prompt never grants and never captures', async () => {
  let release;
  const { flow, calls, state } = makeFlow({ grant: () => new Promise(resolve => { release = resolve; }) });
  const pending = flow.request('wake');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(flow.busy, true);
  flow.cancel(); // e.g. "Sudo, ruko" or the stop button while the panel is open
  assert.equal(calls.cancelConsent, 1);
  release(true); // even a late "true" must not be honoured after cancel
  const result = await pending;
  assert.equal(result.kind, 'cancelled');
  assert.equal(calls.capture, 0);
  assert.equal(state.consent, false);
  assert.equal(flow.busy, false);
});

test('disabled setting: no consent prompt, no capture', async () => {
  const { flow, calls } = makeFlow({ enabled: false });
  const result = await flow.request('wake');
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'disabled');
  assert.equal(calls.consentAsked, 0);
  assert.equal(calls.capture, 0);
});

test('first capture of a session shows a 3-2-1 countdown; the next one (within 10 min) does not; after 10 idle minutes it returns', async () => {
  const { flow, calls, clock } = makeFlow({ consent: true });
  const first = await flow.request('wake');
  assert.equal(first.kind, 'proceed');
  const countdowns = calls.statuses.filter(([s]) => s === 'countdown').map(([, extra]) => extra.countdown);
  assert.deepEqual(countdowns, [3, 2, 1]);

  calls.statuses.length = 0;
  clock.now += 15_000; // past the wake cooldown
  const second = await flow.request('wake');
  assert.equal(second.kind, 'proceed');
  assert.equal(second.cached, false);
  assert.equal(calls.statuses.filter(([s]) => s === 'countdown').length, 0);

  calls.statuses.length = 0;
  clock.now += COUNTDOWN_IDLE_RESET_MS + 1000;
  await flow.request('wake');
  assert.equal(calls.statuses.filter(([s]) => s === 'countdown').length, 3);
});

test('countdown setting OFF skips the countdown', async () => {
  const { flow, calls } = makeFlow({ consent: true, countdown: false });
  await flow.request('button');
  assert.equal(calls.statuses.filter(([s]) => s === 'countdown').length, 0);
  assert.equal(calls.capture, 1);
});

test('cancel during the countdown: nothing captured, cache cleared, status reset', async () => {
  const { flow, calls } = makeFlow({ consent: true, manualTicks: true });
  const pending = flow.request('wake');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls.ticks.length, 1, 'first countdown tick is waiting');
  assert.deepEqual(calls.statuses.at(-1), ['countdown', { countdown: 3 }]);
  flow.cancel(); // the user clicks the badge or says "ruko"
  calls.ticks[0]();
  const result = await pending;
  assert.equal(result.kind, 'cancelled');
  assert.equal(calls.capture, 0);
  assert.equal(calls.statuses.at(-1)[0], null);
  assert.equal(flow.cache.has(1_000_000), false);
});

test('cooldown: a repeat inside 10 s re-uses the cached screenshot (marked cached); without a cache it is refused', async () => {
  const { flow, calls, clock } = makeFlow({ consent: true, countdown: false });
  const first = await flow.request('wake');
  assert.equal(first.kind, 'proceed');
  clock.now += 4000;
  const repeat = await flow.request('wake');
  assert.equal(repeat.kind, 'proceed');
  assert.equal(repeat.cached, true);
  assert.equal(repeat.ageSeconds, 4);
  assert.equal(calls.capture, 1);

  const other = makeFlow({ consent: true, countdown: false });
  await other.flow.request('wake');
  other.flow.cache.clear(); // e.g. after a stop
  other.clock.now += 4000;
  const refused = await other.flow.request('wake');
  assert.equal(refused.kind, 'skipped');
  assert.equal(refused.reason, 'cooldown');
});

test('stop / "ruko" (cancel) drops the cached screenshot; a barge-in (keepCache) keeps it', async () => {
  const { flow } = makeFlow({ consent: true, countdown: false });
  await flow.request('wake');
  assert.equal(flow.cache.has(1_000_000 + 1), true);
  flow.cancel(true);
  assert.equal(flow.cache.has(1_000_000 + 1), true, 'barge-in keeps the screenshot for the follow-up');
  flow.cancel();
  assert.equal(flow.cache.has(1_000_000 + 1), false, 'a real stop forgets it');
});

test('turning the feature off drops the cache and resets the session', async () => {
  const { flow, calls, state, clock } = makeFlow({ consent: true });
  await flow.request('wake');
  flow.disable();
  assert.equal(flow.cache.has(clock.now), false);
  state.enabled = true;
  calls.statuses.length = 0;
  clock.now += 20_000;
  await flow.request('wake');
  assert.equal(calls.statuses.filter(([s]) => s === 'countdown').length, 3, 'a new session shows the countdown again');
});

test('the cache expires after two minutes and only follow-up phrases reuse it', async () => {
  const { flow, clock, state } = makeFlow({ consent: true, countdown: false });
  await flow.request('wake');
  clock.now += 30_000;
  const hit = flow.followUp('aur is error ka fix batao');
  assert.ok(hit);
  assert.equal(hit.ageSeconds, 30);
  assert.equal(flow.followUp('aaj mausam kaisa hai'), null, 'unrelated turn: no screenshot attached');
  state.enabled = false;
  assert.equal(flow.followUp('aur is error ka fix batao'), null, 'feature off: never');
  state.enabled = true;
  clock.now += CACHE_TTL_MS;
  assert.equal(flow.followUp('aur is error ka fix batao'), null, 'older than two minutes: gone');
});

test('follow-up detection is conservative', () => {
  for (const yes of ['aur is error ka fix batao', 'ye kya hai?', 'iska matlab kya hai', 'what does this mean', 'upar wali line theek karo', 'screen par kya likha hai']) {
    assert.equal(isScreenFollowUp(yes), true, yes);
  }
  for (const no of ['kaise ho', 'aaj mausam kaisa hai', 'aur batao', 'thank you', 'ek joke sunao', '']) {
    assert.equal(isScreenFollowUp(no), false, no);
  }
});

test('sensitive window: nothing leaves, nothing is cached', async () => {
  const { flow, calls } = makeFlow({ consent: true, countdown: false, guard: { status: 'sensitive', matched: 'bank' } });
  const result = await flow.request('wake');
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'sensitive');
  assert.equal(result.notice, NOTICES.sensitive);
  assert.equal(flow.cache.has(1_000_000), false);
  assert.equal(calls.statuses.at(-1)[0], 'notice');
});

test('sensitive window seen during the countdown: no capture at all', async () => {
  const { flow, calls } = makeFlow({ consent: true, guard: { status: 'sensitive', matched: 'password' } });
  const result = await flow.request('wake');
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'sensitive');
  assert.equal(calls.capture, 0);
});

test('guard unknown (no accessibility info) still captures, because the countdown covers it', async () => {
  const { flow, calls } = makeFlow({ consent: true, countdown: false, guard: { status: 'unknown' } });
  const result = await flow.request('wake');
  assert.equal(result.kind, 'proceed');
  assert.equal(calls.capture, 1);
});

test('slow guard does not hold the screenshot back for more than its time limit', async () => {
  const { flow, calls } = makeFlow({ consent: true, countdown: false, guardHang: true });
  const started = Date.now();
  const result = await flow.request('button');
  assert.equal(result.kind, 'proceed');
  assert.equal(calls.guard, 1);
  assert.ok(Date.now() - started < 1000, 'the guard time limit (not the hung guard) decides');
});

test('capture failure: a spoken-friendly reason, no cache', async () => {
  const { flow } = makeFlow({ consent: true, countdown: false, capture: () => ({ ok: false, reason: 'no-python-gi' }) });
  const result = await flow.request('wake');
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'capture-failed');
  assert.match(result.notice, /python3-gi/);
  assert.equal(flow.cache.has(1_000_000), false);
  assert.match(captureNotice('portal-timeout'), /der lag/);
  assert.match(captureNotice('blank-frame'), /khaali/);
});

test('a second request while one is running is refused as busy', async () => {
  let release;
  const { flow } = makeFlow({ consent: true, countdown: false, capture: () => new Promise(resolve => { release = () => resolve({ ok: true, shot: SHOT }); }) });
  const first = flow.request('wake');
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await flow.request('button');
  assert.equal(second.kind, 'skipped');
  assert.equal(second.reason, 'busy');
  release();
  assert.equal((await first).kind, 'proceed');
});

test('ScreenCache keeps the screenshot in memory only and forgets it on clear/expiry', () => {
  const cache = new ScreenCache();
  cache.set(SHOT, 100);
  assert.equal(cache.get(100 + 1000).ageSeconds, 1);
  assert.equal(cache.get(100 + CACHE_TTL_MS + 1), null);
  assert.equal(cache.has(100 + 1000), false, 'expiry cleared it');
  cache.set(SHOT, 500);
  cache.clear();
  assert.equal(cache.get(501), null);
});
