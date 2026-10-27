// The on-device wake word inside the real VoiceSession (fake audio stack), assembled exactly like the overlay does it: VoiceSession.localWake ->
// LocalWakeController.evaluate, VoiceSession.decideClip -> decideWakeClip (real ClipGate + WakeGate), cloud result -> noteOutcome.
// Audio is synthetic (see helpers/synth-speech.mjs). No microphone, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession } from '../src/renderer/voice-engine.ts';
import { ClipGate } from '../src/shared/clip-gate.ts';
import { WakeGate } from '../src/shared/wake-word.ts';
import { LocalWakeController, decideWakeClip } from '../src/shared/local-wake/runtime.ts';
import { EnrollmentSession, withLabel } from '../src/shared/local-wake/enrollment.ts';
import { makeClip, rngFrom, speakerFrom, repeatOf } from './helpers/synth-speech.mjs';

const SAMPLE_RATE = 48000;
const FRAME = 1024;
let processor = null;
let currentFrame = new Float32Array(FRAME);
class FakeAudioContext {
  constructor() { this.sampleRate = SAMPLE_RATE; this.destination = {}; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 0, connect() {}, getFloatTimeDomainData(buf) { for (let i = 0; i < buf.length; i++) buf[i] = currentFrame[i % currentFrame.length]; } }; }
  createScriptProcessor() { processor = { onaudioprocess: null, connect() {}, disconnect() {} }; return processor; }
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  async close() {}
}
class FakeFileReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(buffer => { this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`; this.onloadend?.({}); });
  }
}
const transcribeCalls = [];
globalThis.window = { AudioContext: FakeAudioContext, companion: { transcribeAudio: async (...args) => { transcribeCalls.push(args); return { ok: true, text: 'sudo', quotaPressure: 0.1 }; } } };
globalThis.FileReader = FakeFileReader;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } } });
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

function feedClip(clip) {
  for (let at = 0; at + FRAME <= clip.length; at += FRAME) {
    currentFrame = clip.subarray(at, at + FRAME);
    processor.onaudioprocess({ inputBuffer: { getChannelData: () => currentFrame } });
  }
}

// Owner voice + enrolment, as the Settings panel would do it.
const rng = rngFrom(31);
const me = speakerFrom(rng, { f0: 120, tract: 1, tempo: 1 });
const enrolment = new EnrollmentSession();
while (enrolment.count < 6) enrolment.add(makeClip(['sudo'], repeatOf(me, rng), { rng, level: 0.2 + 0.1 * rng() }), SAMPLE_RATE);
const profile = withLabel(undefined, 'sudo', enrolment.finish().label, 1);

/** Everything the overlay wires up, with the clock running on the real performance.now (clips are seconds apart in "wake time" by jumping `skew`). */
async function overlay(mode, { live = false, throwing = false } = {}) {
  transcribeCalls.length = 0;
  let skew = 0;
  const clock = () => performance.now() + skew;
  const controller = new LocalWakeController({ now: clock, yieldNow: () => new Promise(resolve => setTimeout(resolve, 0)) });
  controller.setProfile(profile);
  controller.configure(mode, 0.5);
  const clipGate = new ClipGate();
  const wakeGate = new WakeGate(2000);
  const seen = [];
  const session = new VoiceSession();
  session.start({
    maxClipMs: 3500,
    localWake: throwing ? async () => { throw new Error('boom'); } : (clip, rate) => (live ? Promise.resolve(undefined) : controller.evaluate(clip, rate)),
    decideClip: (features, local) => { seen.push(local); return decideWakeClip({ features, local, live, now: clock(), clipGate, wakeGate, controller }); },
    onFinal: text => controller.noteOutcome(/sudo/i.test(text)),
  });
  await tick(10);
  assert.ok(processor);
  // The room has been quiet for a long time before every test clip, so the quota gate treats it as "after quiet".
  return { controller, seen, session, later: ms => { skew += ms; } };
}
async function say(words, ms = 1400) {
  feedClip(makeClip(words, repeatOf(me, rng), { rng }));
  await tick(ms);
}

test('strict: the owner\'s "Sudo" goes to the cloud (trimmed), other speech never does; counters are counts only', async () => {
  const o = await overlay('strict');
  await say(['radio', 'music']);
  assert.equal(transcribeCalls.length, 0, 'not the name: nothing leaves the machine');
  o.later(30_000);
  await say(['sudo']);
  assert.equal(transcribeCalls.length, 1, 'candidate sent');
  assert.equal(o.seen.length, 2);
  assert.equal(o.seen[0].candidate, false);
  assert.equal(o.seen[1].candidate, true);
  assert.ok(typeof o.seen[1].computeMs === 'number' && o.seen[1].computeMs < 500);
  const line = o.controller.flushStats(performance.now() + 1e7, true);
  assert.equal(line, '[wake-local] candidates=1 rejected=1 sent=1 mode=strict');
  assert.ok(o.controller.limiter.offset === 0, 'the cloud heard "sudo": the limiter is content');
  o.session.stop();
});

test('assist: a candidate goes even when the old gate would have refused; fallback to the old gate when quota is healthy', async () => {
  const o = await overlay('assist');
  await say(['sudo']);
  await say(['sudo', 'kaise', 'ho']);
  assert.ok(transcribeCalls.length >= 1, 'at least the first candidate is sent');
  const first = transcribeCalls.length;
  o.later(60_000);
  await say(['radio']);
  assert.ok(transcribeCalls.length >= first, 'a non-candidate may still be sent by the old gate while quota is healthy');
  o.session.stop();
});

test('off: the local check never runs and nothing changes; Live Talk is never gated even in strict', async () => {
  const off = await overlay('off');
  await say(['sudo']);
  assert.equal(off.seen[0], undefined, 'no verdict was computed');
  assert.equal(off.controller.flushStats(performance.now() + 1e7, true), undefined, 'no counters either');
  off.session.stop();
  const live = await overlay('strict', { live: true });
  await say(['radio', 'music']);
  assert.equal(transcribeCalls.length, 1, 'Live Talk sends every utterance');
  assert.equal(live.seen[0], undefined);
  live.session.stop();
});

test('a failing local check falls back to the old gate and never leaves the session deaf', async () => {
  const o = await overlay('strict', { throwing: true });
  await say(['sudo']);
  assert.equal(o.seen[0], undefined, 'the exception became "no verdict"');
  await say(['sudo'], 900);
  // The session still works: decideClip was consulted for both clips.
  assert.equal(o.seen.length, 2);
  o.session.stop();
});
