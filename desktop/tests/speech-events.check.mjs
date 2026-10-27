import test from 'node:test';
import assert from 'node:assert/strict';
import { LipSyncModel, UtteranceTracker, LIP_SYNC_WATCHDOG_MS } from '../src/shared/speech-events.ts';

// ---- Fake Web Audio so the REAL tts-player module can run under node ----
const events = [];
class FakeSource {
  constructor() { this.onended = null; this.stopped = false; }
  connect() {}
  disconnect() {}
  start() { this.started = true; }
  stop() { this.stopped = true; }
  finish() { this.onended?.(); }
}
let lastSource = null;
class FakeAudioContext {
  constructor() { this.state = 'running'; this.destination = {}; }
  createAnalyser() { return { fftSize: 0, connect() {}, getFloatTimeDomainData(buf) { buf.fill(0.1); } }; }
  createBufferSource() { lastSource = new FakeSource(); return lastSource; }
  resume() { return Promise.resolve(); }
}
globalThis.window = {
  AudioContext: FakeAudioContext,
  addEventListener() {},
  companion: { emitSpeechEvent: e => events.push(e) },
};
const player = await import('../src/renderer/tts-player.ts');

const stops = () => events.filter(e => e.type === 'stop');
const tick = () => new Promise(r => setTimeout(r, 5));

for (const reason of ['stop-button', 'barge-in', 'new-reply', 'error', 'mute', 'window-closed', 'app-quit']) {
  test(`stopSpeaking('${reason}') stops audio and emits speech:stop exactly once`, async () => {
    events.length = 0;
    const gen = player.beginPlayback();
    const played = player.playBuffer({}, gen);
    await tick();
    assert.equal(player.isSpeakingNow(), true);
    assert.equal(events[0].type, 'start');

    player.stopSpeaking(reason);
    player.stopSpeaking(reason); // idempotent: second call must not emit again
    player.stopSpeaking('stop-button');

    assert.equal(await played, false);
    assert.equal(lastSource.stopped, true);
    assert.equal(stops().length, 1);
    assert.equal(stops()[0].reason, reason);
    assert.equal(player.isSpeakingNow(), false);
  });
}

test('natural finish emits exactly one speech:stop and levels come from the output signal', async () => {
  events.length = 0;
  const gen = player.beginPlayback();
  const played = player.playBuffer({}, gen);
  await tick();
  await new Promise(r => setTimeout(r, 80));
  assert.ok(events.some(e => e.type === 'level' && e.level > 0), 'level events should be emitted from the analyser');
  lastSource.finish();
  assert.equal(await played, true);
  player.finishPlayback(gen);
  player.finishPlayback(gen);
  assert.equal(stops().length, 1);
  assert.equal(stops()[0].reason, 'finish');
});

test('a new reply cuts the previous one and keeps start/stop paired', async () => {
  events.length = 0;
  const g1 = player.beginPlayback();
  const p1 = player.playBuffer({}, g1);
  await tick();
  const g2 = player.beginPlayback(); // stops reply 1 with 'new-reply'
  assert.equal(await p1, false);
  assert.equal(await player.playBuffer({}, g1), false, 'stale generation must not play');
  const p2 = player.playBuffer({}, g2);
  await tick();
  player.stopSpeaking('stop-button');
  await p2;
  assert.equal(events.filter(e => e.type === 'start').length, 2);
  assert.equal(stops().length, 2);
});

test('UtteranceTracker: level before start is ignored, stop without start is a no-op', () => {
  const out = [];
  const t = new UtteranceTracker(e => out.push(e));
  t.level(0.5);
  assert.equal(t.end('finish'), false);
  assert.equal(out.length, 0);
});

test('LipSyncModel: mouth follows level, closes on stop, and watchdog closes after 500ms of silence', () => {
  const m = new LipSyncModel();
  m.apply({ type: 'start', id: 1 }, 0);
  m.apply({ type: 'level', id: 1, level: 0.6 }, 10);
  assert.equal(m.speaking, true);
  assert.equal(m.level, 0.6);
  assert.equal(m.tick(10 + LIP_SYNC_WATCHDOG_MS - 1), false);
  assert.equal(m.tick(10 + LIP_SYNC_WATCHDOG_MS + 1), true);
  assert.equal(m.speaking, false);
  assert.equal(m.level, 0);

  m.apply({ type: 'start', id: 2 }, 1000);
  m.apply({ type: 'level', id: 2, level: 0.4 }, 1010);
  m.apply({ type: 'stop', id: 2, reason: 'barge-in' }, 1020);
  assert.equal(m.speaking, false);
  assert.equal(m.level, 0);
});

test('LipSyncModel ignores events from a superseded utterance', () => {
  const m = new LipSyncModel();
  m.apply({ type: 'start', id: 5 }, 0);
  m.apply({ type: 'level', id: 4, level: 0.9 }, 5);
  assert.equal(m.level, 0);
  m.apply({ type: 'stop', id: 4, reason: 'finish' }, 6);
  assert.equal(m.speaking, true);
});
