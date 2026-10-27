// Hardware-free regression test of the voice pipeline: synthetic audio frames -> VoiceSession (VAD, minimum voiced
// audio, clip cap, rate-limit gate) -> WAV encoder -> window.companion.transcribeAudio -> the REAL SttRouter with a
// mocked fetch -> callbacks (onFinal / onUnclear) -> stop-intent decisions. No microphone, speaker or network needed
// (one optional test uses the network and skips itself when offline).
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession, encodeWav } from '../src/renderer/voice-engine.ts';
import { SttRouter } from '../src/main/stt.ts';
import { dataUriToBytes } from '../src/shared/audio-data.ts';
import { isStopCommand, unclearAction, SHORT_INTERRUPTION_MS } from '../src/shared/stop-intent.ts';

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
const wavInfo = dataUri => {
  const bytes = dataUriToBytes(dataUri);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at, n) => String.fromCharCode(...bytes.slice(at, at + n));
  return { riff: text(0, 4), wave: text(8, 4), sampleRate: view.getUint32(24, true), samples: view.getUint32(40, true) / 2, bytes };
};

test('encodeWav: 16 kHz mono PCM, correct length, quiet audio boosted but never past full scale', async () => {
  const tone = new Float32Array(SAMPLE_RATE); // 1 s at 48 kHz, peak 0.1 (quiet)
  for (let i = 0; i < tone.length; i++) tone[i] = 0.1 * Math.sin(2 * Math.PI * 440 * (i / SAMPLE_RATE));
  const blob = encodeWav(tone, SAMPLE_RATE);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint16(34, true), 16);
  const samples = view.getUint32(40, true) / 2;
  assert.ok(Math.abs(samples - 16000) <= 2, `1 s should become ~16000 samples, got ${samples}`);
  let peak = 0;
  for (let i = 44; i < bytes.length; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
  assert.ok(peak > 0.1 * 32767 * 4 && peak <= 32767, `quiet audio should be boosted (peak ${peak})`);
  const silence = new Uint8Array(await encodeWav(new Float32Array(SAMPLE_RATE), SAMPLE_RATE).arrayBuffer());
  assert.ok(silence.slice(44).every(b => b === 0), 'silence must stay silence');
});

test('a short noise blip (< 220 ms of voiced audio) is never sent to speech-to-text', async () => {
  const session = await newSession({});
  // Real life: the mic has been idle, so the ~340 ms pre-roll is already full when the click arrives.
  for (let i = 0; i < 24; i++) feed(silentFrame());
  speak(90);
  await tick(750);
  assert.equal(transcribeCalls.length, 0);
  session.stop();
});

test('a real utterance is sent once as a valid 16 kHz WAV and its text reaches onFinal', async () => {
  const finals = [];
  transcribeImpl = async () => ({ ok: true, text: 'sudo kaise ho' });
  const session = await newSession({ onFinal: text => finals.push(text), language: 'auto', sttHint: 'name is Sudo' });
  speak(700);
  await tick(900);
  assert.equal(transcribeCalls.length, 1);
  const [dataUri, mime, language, hint] = transcribeCalls[0];
  assert.equal(mime, 'audio/wav');
  assert.equal(language, 'auto');
  assert.equal(hint, 'name is Sudo');
  const wav = wavInfo(dataUri);
  assert.equal(wav.riff, 'RIFF');
  assert.equal(wav.wave, 'WAVE');
  assert.equal(wav.sampleRate, 16000);
  assert.ok(wav.samples > 0.7 * 16000 && wav.samples < 1.6 * 16000, `clip length ${wav.samples} samples`);
  assert.deepEqual(finals, ['sudo kaise ho']);
  session.stop();
});

test('standby clip cap: maxClipMs limits what is uploaded, and a rate-limited clip is dropped without onUnclear', async () => {
  const unclear = [];
  transcribeImpl = async () => ({ ok: true, text: 'sudo' });
  let allow = false;
  const session = await newSession({ maxClipMs: 300, shouldTranscribe: () => allow, onUnclear: info => unclear.push(info) });
  speak(900);
  await tick(900);
  assert.equal(transcribeCalls.length, 0, 'gate closed: nothing sent');
  assert.equal(unclear.length, 0, 'a gated clip is not an unclear interruption');
  allow = true;
  speak(900);
  await tick(900);
  assert.equal(transcribeCalls.length, 1, 'the session recovered after a gated clip (no stuck "processing" flag)');
  assert.ok(wavInfo(transcribeCalls[0][0]).samples <= 0.3 * 16000 + 4, 'clip is capped to 300 ms');
  session.stop();
});

test('unclear speech calls onUnclear with the voiced length, and the stop-intent rule decides resume vs stay stopped', async () => {
  const unclear = [];
  transcribeImpl = async () => ({ ok: false, error: 'Could not transcribe speech.' });
  const session = await newSession({ onUnclear: info => unclear.push(info) });
  speak(1500);
  await tick(900);
  assert.equal(unclear.length, 1);
  assert.ok(unclear[0].clipMs >= 1300 && unclear[0].clipMs <= 1700, `clipMs ${unclear[0].clipMs}`);
  assert.equal(unclearAction(unclear[0].clipMs, true), 'resume');
  assert.equal(unclearAction(SHORT_INTERRUPTION_MS - 1, true), 'stay-stopped');
  assert.equal(unclearAction(5000, false), 'none');
  session.stop();
});

test('a transcription exception does not leave the session deaf (the old stuck-flag bug)', async () => {
  const finals = [];
  transcribeImpl = async () => { throw new Error('network down'); };
  const session = await newSession({ onFinal: text => finals.push(text), onUnclear: () => {} });
  speak(700);
  await tick(900);
  transcribeImpl = async () => ({ ok: true, text: 'dobara suno' });
  speak(700);
  await tick(900);
  assert.deepEqual(finals, ['dobara suno']);
  session.stop();
});

test('stop commands never reach the chat; real sentences and longer requests do', () => {
  for (const stop of ['ruko', 'ruko ruko', 'stop', 'bas karo', 'chup']) assert.equal(isStopCommand(stop), true, stop);
  for (const keep of ['ruko mujhe ek sawal poochna hai', 'what is the weather today', 'sudo kaise ho']) assert.equal(isStopCommand(keep), false, keep);
});

test('end to end: encoded clip -> real SttRouter (mocked fetch): fast mode asks Whisper first, short junk skips Gemini, Arabic-script falls back', async () => {
  const clip = Float32Array.from({ length: 24000 }, (_, i) => 0.3 * Math.sin(i / 7)); // 0.5 s
  const wavBase64 = Buffer.from(await encodeWav(clip, SAMPLE_RATE).arrayBuffer()).toString('base64');
  const seen = [];
  const answers = { groq: { text: 'kya haal hai bhai' }, gemini: 'kya haal hai bhai' };
  const makeFetch = groqText => async (url, init) => {
    const isGroq = url.includes('groq');
    seen.push({ provider: isGroq ? 'groq' : 'gemini', formFile: init.body instanceof FormData ? init.body.get('file')?.size : undefined });
    return isGroq
      ? { status: 200, ok: true, json: async () => ({ text: groqText }), text: async () => '' }
      : { status: 200, ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: answers.gemini }] } }] }), text: async () => '' };
  };
  const route = (mode, groqText) => new SttRouter({ fetch: makeFetch(groqText), getKey: () => 'test-key', now: () => 0, getMode: () => mode });
  const req = { base64: wavBase64, mimeType: 'audio/wav', language: 'auto' };

  seen.length = 0;
  let out = await route('fast', 'Sudo kaise ho aap').transcribe(req);
  assert.equal(out.ok, true);
  assert.deepEqual(seen.map(s => s.provider), ['groq']);
  assert.ok(seen[0].formFile > 1000, 'the encoded WAV bytes really reach the upload');

  seen.length = 0;
  out = await route('fast', 'Hmm.').transcribe(req);
  assert.equal(out.ok, false);
  assert.deepEqual(seen.map(s => s.provider), ['groq'], 'short junk must not trigger a slow second opinion');

  seen.length = 0;
  out = await route('fast', 'تم بول کھینڈے میرے ساتھ').transcribe(req);
  assert.equal(out.ok, true);
  assert.deepEqual(seen.map(s => s.provider), ['groq', 'gemini'], 'Urdu-script garbage gets a Gemini second opinion');

  seen.length = 0;
  await route('accurate', 'x y z').transcribe(req);
  assert.equal(seen[0].provider, 'gemini', 'accurate mode asks Gemini first');
});

test('optional (needs network): a Google TTS mp3 survives the data-URI round trip used by playback', async t => {
  let response;
  try {
    response = await fetch('https://translate.google.com/translate_tts?ie=UTF-8&q=Hello%20from%20the%20verify%20harness&tl=en&client=tw-ob', { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' }, signal: AbortSignal.timeout(6000) });
  } catch {
    return t.skip('offline');
  }
  if (!response.ok) return t.skip(`Google TTS answered ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const decoded = dataUriToBytes(`data:audio/mp3;base64,${buffer.toString('base64')}`);
  assert.equal(decoded.length, buffer.length);
  const head = decoded[0] === 0x49 && decoded[1] === 0x44 && decoded[2] === 0x33; // "ID3"
  const sync = decoded[0] === 0xff && (decoded[1] & 0xe0) === 0xe0; // MPEG frame sync
  assert.ok(head || sync, 'looks like an MP3');
});

test('quota saver: decideClip sees real clip measurements, can drop the clip locally, and can trim the upload', async () => {
  const seen = [];
  const results = [];
  transcribeImpl = async () => ({ ok: true, text: 'sudo', quotaPressure: 0.6 });
  let send = false;
  const session = await newSession({
    decideClip: features => { seen.push(features); return send ? { send: true, trimMs: 400 } : { send: false }; },
    onTranscribeResult: (outcome, info) => results.push([outcome, info?.quotaPressure]),
    onUnclear: () => assert.fail('a locally dropped clip is not an unclear interruption'),
  });
  speak(900);
  await tick(900);
  assert.equal(transcribeCalls.length, 0, 'gate said no: nothing leaves the machine');
  assert.equal(seen.length, 1);
  const f = seen[0];
  assert.ok(f.voicedMs > 700 && f.voicedMs < 1100, `voicedMs ${f.voicedMs}`);
  assert.ok(f.durationMs >= f.voicedMs, 'clip includes pre-roll and the trailing silence');
  assert.ok(f.rms > 0.02 && f.peak > f.rms && f.peak <= 0.25, `rms ${f.rms} peak ${f.peak}`);
  assert.ok(f.zcrPerSec > 100 && f.zcrPerSec < 4000, `harmonic voice, zcr ${f.zcrPerSec}`);
  assert.ok(f.runs >= 1 && f.bargeInFired === false && f.overlappedPlayback === false);
  send = true;
  speak(900);
  await tick(900);
  assert.equal(transcribeCalls.length, 1, 'the session recovered after a gated clip');
  assert.ok(wavInfo(transcribeCalls[0][0]).samples <= 0.4 * 16000 + 4, 'upload trimmed to the gate\'s 400 ms');
  assert.deepEqual(results, [['ok', 0.6]], 'the main process\' quota pressure reaches the caller');
  session.stop();
});
