// Live Talk instant stop at the microphone: VoiceSession.cancelPending() / stop() throw away the half-recorded clip and any speech-to-text request
// that is still in flight, so words spoken before the stop can never become a new turn afterwards (synthetic audio, no microphone, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession } from '../src/renderer/voice-engine.ts';

const SAMPLE_RATE = 48000;
const FRAME = 1024;
const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000;

/** Speech-like frame: a few harmonics around 140 Hz with a syllable-rate envelope, amplitude 0.2 (well above the VAD threshold). */
function voicedFrame(index, amplitude = 0.2) {
  const frame = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    const t = (index * FRAME + i) / SAMPLE_RATE;
    const envelope = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t);
    frame[i] = amplitude * envelope * (Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 280 * t) + 0.25 * Math.sin(2 * Math.PI * 560 * t)) / 1.75;
  }
  return frame;
}
const silentFrame = () => new Float32Array(FRAME);

// ---- Fake browser audio stack -------------------------------------------------------------------------------
let processor = null;
let currentFrame = silentFrame();
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
    blob.arrayBuffer().then(buffer => {
      this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
      this.onloadend?.({});
    });
  }
}
const transcribeCalls = [];
let transcribeImpl = async () => ({ ok: false, error: 'Could not transcribe speech.' });
globalThis.window = { AudioContext: FakeAudioContext, companion: { transcribeAudio: async (...args) => { transcribeCalls.push(args); return transcribeImpl(...args); } } };
globalThis.FileReader = FakeFileReader;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } } });

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
function feed(frame) {
  currentFrame = frame;
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => frame } });
}
async function newSession(callbacks) {
  transcribeCalls.length = 0;
  const session = new VoiceSession();
  session.start({ ...callbacks });
  await tick(10);
  assert.ok(processor, 'session should have created its audio processor');
  return session;
}
/** `ms` of speech followed by one silent frame; the VoiceSession then waits ~500 ms of real time before dispatching. */
function speak(ms) {
  const frames = Math.round(ms / FRAME_MS);
  for (let i = 0; i < frames; i++) feed(voicedFrame(i));
  feed(silentFrame());
}

test('cancelPending(): a clip whose speech-to-text answer arrives AFTER the stop is ignored (no onFinal, no onUnclear)', async () => {
  const finals = [], unclear = [];
  let release;
  transcribeImpl = () => new Promise(resolve => { release = () => resolve({ ok: true, text: 'meri screen dekho' }); });
  const session = await newSession({ onFinal: t => finals.push(t), onUnclear: i => unclear.push(i) });
  speak(700);
  await tick(900);
  assert.equal(transcribeCalls.length, 1, 'the clip is in flight');
  session.cancelPending(); // what runLiveStop does
  release();
  await tick(60);
  assert.deepEqual(finals, []);
  assert.deepEqual(unclear, []);
  session.stop();
});

test('cancelPending(): a clip that is still being recorded is dropped, and the session keeps working for the next utterance', async () => {
  const finals = [];
  transcribeImpl = async () => ({ ok: true, text: 'dobara bolo' });
  const session = await newSession({ onFinal: t => finals.push(t) });
  const frames = Math.round(700 / FRAME_MS);
  for (let i = 0; i < frames; i++) feed(voicedFrame(i)); // still speaking...
  session.cancelPending();                                 // ...and Live Talk is stopped
  feed(silentFrame());
  await tick(750);
  assert.equal(transcribeCalls.length, 0, 'the half-recorded clip was never sent');
  speak(700);                                              // the next conversation
  await tick(900);
  assert.equal(transcribeCalls.length, 1);
  assert.deepEqual(finals, ['dobara bolo']);
  session.stop();
});

test('stop(): an answer that arrives after the mic was closed is ignored', async () => {
  const finals = [];
  let release;
  transcribeImpl = () => new Promise(resolve => { release = () => resolve({ ok: true, text: 'hello' }); });
  const session = await newSession({ onFinal: t => finals.push(t) });
  speak(700);
  await tick(900);
  session.stop();
  release();
  await tick(60);
  assert.deepEqual(finals, []);
});

test('an utterance that finishes normally still reaches onFinal (the guard only drops cancelled work)', async () => {
  const finals = [];
  transcribeImpl = async () => ({ ok: true, text: 'sudo kaise ho' });
  const session = await newSession({ onFinal: t => finals.push(t) });
  speak(700);
  await tick(900);
  assert.deepEqual(finals, ['sudo kaise ho']);
  session.stop();
});
