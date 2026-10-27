import test from 'node:test';
import assert from 'node:assert/strict';

// ---- Fake Web Audio + fake main-process TTS so the REAL tts-player and speech modules run under node ----
const events = [];
const synthCalls = [];
let audioTime = 0;
let lastSource = null;
const sources = [];
class FakeSource {
  constructor() { this.onended = null; this.stopped = false; this.startOffset = null; }
  connect() {}
  disconnect() {}
  start(_when, offset) { this.startOffset = offset ?? 0; this.started = true; }
  stop() { this.stopped = true; }
  finish() { this.ended = true; const f = this.onended; this.onended = null; f?.(); }
}
class FakeAudioContext {
  constructor() { this.state = 'running'; this.destination = {}; }
  get currentTime() { return audioTime; }
  createAnalyser() { return { fftSize: 0, connect() {}, getFloatTimeDomainData(buf) { buf.fill(0.1); } }; }
  createBufferSource() { lastSource = new FakeSource(); sources.push(lastSource); return lastSource; }
  resume() { return Promise.resolve(); }
  async decodeAudioData() { return { duration: 6 }; }
}
globalThis.window = {
  AudioContext: FakeAudioContext,
  addEventListener() {},
  companion: {
    emitSpeechEvent: e => events.push(e),
    playSpeech: async ({ text }) => { synthCalls.push(text); return { ok: true, dataUri: 'data:audio/mp3;base64,AAAA' }; },
  },
};

const player = await import('../src/renderer/tts-player.ts');
const speech = await import('../src/renderer/speech.ts');

let now = 1_000_000;
speech.setSpeechClockForTests(() => now);
test.after(() => { player.stopSpeaking('stop-button'); });
const tick = (ms = 12) => new Promise(r => setTimeout(r, ms));
const REPLY = '[warm] First thing I wanted to tell you is this. [calm] Second thing is a bit longer than the first one. [excited] Third thing is the last one!';

function reset() {
  player.stopSpeaking('stop-button');
  speech.clearInterruptedSpeech();
  events.length = 0;
  synthCalls.length = 0;
  sources.length = 0;
  lastSource = null;
  audioTime = 0;
  now = 1_000_000;
}

/** Starts a reply and returns once sentence `n` (1-based) is the one playing. */
async function playUntilSentence(n) {
  void speech.speak(REPLY);
  await tick();
  for (let i = 1; i < n; i++) {
    audioTime += 6;
    lastSource.finish();
    await tick();
  }
}

test('a reply is split into several sentences (test fixture sanity)', async () => {
  reset();
  await playUntilSentence(1);
  assert.equal(synthCalls.length >= 2, true, 'next sentence is prefetched');
  assert.equal(speech.hasInterruptedSpeech(), false);
});

test('barge-in during sentence 2 saves the place; resume continues that sentence at the exact moment (minus a short rewind), then the rest', async () => {
  reset();
  await playUntilSentence(2);
  audioTime = 10;            // sentence 2 started...
  sources[1].started = true;
  // sentence 2's source was created at audioTime 6; emulate 2.5 s of it heard
  audioTime = 6 + 2.5;
  player.stopSpeaking('barge-in');
  assert.equal(speech.hasInterruptedSpeech(), true);
  const synthBefore = synthCalls.length;

  assert.equal(speech.resumeInterruptedSpeech(), true);
  await tick();
  assert.ok(lastSource.started, 'resumed audio started');
  assert.ok(Math.abs(lastSource.startOffset - (2.5 - 0.4)) < 0.001, `resume offset should be 2.1 s, got ${lastSource.startOffset}`);
  assert.equal(synthCalls.slice(synthBefore).some(t => t.includes('Second thing')), false, 'the interrupted sentence is replayed from its buffer, not re-synthesized');
  // finishing sentence 2 moves on to sentence 3
  audioTime += 4; lastSource.finish(); await tick();
  assert.equal(lastSource.startOffset, 0, 'the next sentence starts from its beginning');
  assert.equal(events.filter(e => e.type === 'stop').length >= 1, true);
  player.stopSpeaking('stop-button');
});

test('only a barge-in creates the saved state; stop button, mute, window close and errors do not', async () => {
  for (const reason of ['stop-button', 'mute', 'window-closed', 'error', 'app-quit']) {
    reset();
    await playUntilSentence(2);
    player.stopSpeaking(reason);
    assert.equal(speech.hasInterruptedSpeech(), false, `${reason} must not be resumable`);
    assert.equal(speech.resumeInterruptedSpeech(), false);
  }
});

test('a barge-in when nothing is being spoken saves nothing', async () => {
  reset();
  player.stopSpeaking('barge-in');
  assert.equal(speech.hasInterruptedSpeech(), false);
  assert.equal(speech.resumeInterruptedSpeech(), false);
});

test('an explicit stop after a barge-in forgets the interruption', async () => {
  reset();
  await playUntilSentence(2);
  player.stopSpeaking('barge-in');
  assert.equal(speech.hasInterruptedSpeech(), true);
  player.stopSpeaking('stop-button');
  assert.equal(speech.hasInterruptedSpeech(), false);
});

test('a new reply replaces the interruption', async () => {
  reset();
  await playUntilSentence(2);
  player.stopSpeaking('barge-in');
  assert.equal(speech.hasInterruptedSpeech(), true);
  void speech.speak('[warm] A completely new reply for you.');
  await tick();
  assert.equal(speech.hasInterruptedSpeech(), false);
  assert.equal(speech.resumeInterruptedSpeech(), false);
  player.stopSpeaking('stop-button');
});

test('resume expires after 20 seconds', async () => {
  reset();
  await playUntilSentence(2);
  player.stopSpeaking('barge-in');
  now += 19_000;
  assert.equal(speech.hasInterruptedSpeech(), true);
  now += 2_000;
  assert.equal(speech.hasInterruptedSpeech(), false);
  const startedBefore = sources.length;
  assert.equal(speech.resumeInterruptedSpeech(), false);
  await tick();
  assert.equal(sources.length, startedBefore, 'nothing is played after expiry');
});

test('resume is capped at 2 per reply and a resumed reply can be interrupted again', async () => {
  reset();
  await playUntilSentence(2);
  audioTime = 7;
  player.stopSpeaking('barge-in');
  assert.equal(speech.resumeInterruptedSpeech(), true);          // resume 1
  await tick();
  audioTime = 9;
  player.stopSpeaking('barge-in');                                 // interrupted again
  assert.equal(speech.hasInterruptedSpeech(), true);
  assert.equal(speech.resumeInterruptedSpeech(), true);          // resume 2
  await tick();
  audioTime = 11;
  player.stopSpeaking('barge-in');                                 // third interruption
  assert.equal(speech.hasInterruptedSpeech(), false, 'cap reached');
  assert.equal(speech.resumeInterruptedSpeech(), false);
});

test('no double speaking: resuming while something plays cuts the old audio first', async () => {
  reset();
  await playUntilSentence(2);
  player.stopSpeaking('barge-in');
  assert.equal(speech.resumeInterruptedSpeech(), true);
  await tick();
  const active = sources.filter(s => s.started && !s.stopped && !s.ended);
  assert.equal(active.length, 1, 'exactly one audible source');
  player.stopSpeaking('stop-button');
});
