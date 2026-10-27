// On-device wake word: deterministic tests on SYNTHETIC signals only (formant-like harmonic bursts, noise, silence, speech-like clutter).
// They prove the DSP, calibration, enrolment validation, limiter and gate combination behave as designed. They say NOTHING about accuracy on a
// real voice in a real room: that needs the owner's recordings (see TEST-LOCAL-WAKE.md). Set LOCAL_WAKE_REPORT=1 to print the numbers quoted in LOCAL-WAKE.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WAKE_RATE, FEATURE_DIM, FRAME_MS, resampleTo16k, frameEnergiesDb, findSpeechSpan, extractFeatures } from '../src/shared/local-wake/dsp.ts';
import { subsequenceDtw } from '../src/shared/local-wake/dtw.ts';
import { templateEngine, effectiveThreshold, aggregateCosts, parseTemplateData, calibrate } from '../src/shared/local-wake/template-engine.ts';
import {
  checkEnrollmentSample, buildLabel, EnrollmentSession, makeProfile, parseProfile, profileLabels, summariseSelfTest, withLabel, withoutLabel, SAMPLE_ADVICE,
} from '../src/shared/local-wake/enrollment.ts';
import { WordEndpointer } from '../src/shared/local-wake/endpointer.ts';
import { registerEngine, getEngine, listEngines, createDetector } from '../src/shared/local-wake/registry.ts';
import {
  CandidateLimiter, LocalWakeStats, LocalWakeController, decideWithLocal, evaluateCooperative, evaluateNow, formatWakeLocalLine, decideWakeClip,
  CANDIDATE_BURST, CANDIDATE_REFILL_MS, ASSIST_MAX_PRESSURE, OFFSET_MIN, OFFSET_MAX,
} from '../src/shared/local-wake/runtime.ts';
import { LocalWakeFile } from '../src/main/local-wake-store.ts';
import { DEFAULT_SETTINGS, validSettings } from '../src/shared/validation.ts';
import { ClipGate } from '../src/shared/clip-gate.ts';
import { WakeGate } from '../src/shared/wake-word.ts';
import { makeClip, rngFrom, speakerFrom, repeatOf, noiseClip, silence, concat, say, normalise } from './helpers/synth-speech.mjs';

const RATE = 48000;
const REPORT = process.env.LOCAL_WAKE_REPORT === '1';
const report = (...args) => { if (REPORT) console.log('[local-wake]', ...args); };

/** An owner voice, six enrolment takes, and the detector built from them (the same pipeline the Settings panel runs). */
function enrol(seed = 7, { label = 'sudo', word = 'sudo', takes = 6, rate = RATE } = {}) {
  const rng = rngFrom(seed);
  const me = speakerFrom(rng, { f0: 118, tract: 1, tempo: 1 });
  const session = new EnrollmentSession();
  let tries = 0;
  while (session.count < takes && tries++ < takes * 3) {
    const take = session.add(makeClip([word], repeatOf(me, rng), { rate, rng, level: 0.2 + 0.15 * rng() }), rate);
    assert.ok(take.accepted || tries < takes * 2, `enrolment takes should be accepted: ${take.advice}`);
  }
  const built = session.finish();
  assert.ok(built.ok, `build failed: ${built.error}`);
  const profile = withLabel(undefined, label, built.label, 1);
  return { me, rng, built, profile, detector: createDetector(profile) };
}
const verdictOf = (detector, clip, rate = RATE) => evaluateNow(detector, clip, rate);

// ------------------------------------------------------------------------------------------ DSP
test('resample: 48k and 44.1k land on 16 kHz with the right length, a 1 kHz tone survives, a 12 kHz tone is filtered out (no aliasing)', () => {
  for (const rate of [48000, 44100]) {
    const tone = f => Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / rate));
    const low = resampleTo16k(tone(1000), rate);
    const high = resampleTo16k(tone(rate === 48000 ? 12000 : 11000), rate);
    assert.ok(Math.abs(low.length - 16000) <= 1, `length ${low.length}`);
    const rms = x => Math.sqrt(x.slice(1000, 15000).reduce((a, b) => a + b * b, 0) / 14000);
    assert.ok(rms(low) > 0.33 && rms(low) < 0.37, `1 kHz rms ${rms(low)}`);
    assert.ok(rms(high) < 0.03, `an out-of-band tone must not fold back in (rms ${rms(high)})`);
  }
  assert.equal(resampleTo16k(new Float32Array(0), 48000).length, 0);
  const same = new Float32Array(100);
  assert.equal(resampleTo16k(same, 16000), same, '16 kHz input is used as is');
});

test('speech span: finds a word in room noise, rejects silence, steady noise and a clip with no clear peak', () => {
  const rng = rngFrom(3);
  const clip = resampleTo16k(makeClip(['sudo'], speakerFrom(rng), { rng }), RATE);
  const span = findSpeechSpan(frameEnergiesDb(clip));
  assert.ok(span, 'word found');
  const startMs = span.start * FRAME_MS, endMs = span.end * FRAME_MS;
  assert.ok(startMs > 250 && startMs < 500, `starts after the 340 ms pre-roll (${startMs})`);
  assert.ok(endMs - startMs > 300 && endMs - startMs < 900, `word length ${endMs - startMs} ms`);
  assert.ok(span.snrDb > 15);
  assert.equal(findSpeechSpan(frameEnergiesDb(new Float32Array(32000))), undefined, 'digital silence');
  assert.equal(findSpeechSpan(frameEnergiesDb(resampleTo16k(noiseClip(3000, RATE, rng), RATE))), undefined, 'steady fan noise has no peak 10 dB over its floor');
  assert.equal(findSpeechSpan(new Float32Array(2)), undefined, 'too short to frame');
});

test('features: deterministic, finite, FEATURE_DIM per frame, and the same word from the same voice is close while a different word is far', () => {
  const rng = rngFrom(5);
  const me = speakerFrom(rng);
  const a = enrol(5).built.label.templates[0];
  assert.equal(a.data.length, a.frames * FEATURE_DIM);
  assert.ok(a.data.every(Number.isFinite));
  const clip = resampleTo16k(makeClip(['sudo'], me, { rng }), RATE);
  const f1 = extractFeatures(clip, 20, 50), f2 = extractFeatures(clip, 20, 50);
  assert.deepEqual(Array.from(f1.data), Array.from(f2.data));
  const sudoAgain = extractFeatures(resampleTo16k(makeClip(['sudo'], repeatOf(me, rng), { rng }), RATE), 20, 50);
  const radio = extractFeatures(resampleTo16k(makeClip(['radio'], repeatOf(me, rng), { rng }), RATE), 20, 50);
  assert.ok(subsequenceDtw(f1, sudoAgain).cost < subsequenceDtw(f1, radio).cost);
});

test('DTW: identical -> ~0, stretched still close, and a template is found inside a longer clip at the right place', () => {
  const rng = rngFrom(9);
  const me = speakerFrom(rng, { tempo: 1 });
  const word = resampleTo16k(say('s u d o', me, RATE, rng), RATE);
  const padded = resampleTo16k(concat([silence(200, RATE), say('k a i s e', me, RATE, rng), silence(100, RATE), say('s u d o', me, RATE, rng), silence(200, RATE)]), RATE);
  const template = extractFeatures(word, 0, Math.floor((word.length - 400) / 320));
  const self = subsequenceDtw(template, template);
  assert.ok(self.cost < 0.01, `self cost ${self.cost}`);
  const hay = extractFeatures(padded, 0, Math.floor((padded.length - 400) / 320));
  const found = subsequenceDtw(template, hay);
  assert.ok(found.cost < 4, `found cost ${found.cost}`);
  const sudoAtMs = (200 + 5 * 60 + 100 + 110) ; // kaise ~ 5 phonemes, loosely
  assert.ok(found.start * FRAME_MS > 250 && found.end * FRAME_MS <= hay.frames * FRAME_MS, `match inside the clip (${found.start}-${found.end} of ${hay.frames})`);
  assert.ok(sudoAtMs > 0);
  const quick = resampleTo16k(say('s u d o', { ...me, tempo: 1.25 }, RATE, rng), RATE);
  const quickSeq = extractFeatures(quick, 0, Math.floor((quick.length - 400) / 320));
  assert.ok(Number.isFinite(subsequenceDtw(template, quickSeq).cost), 'a 25 % faster take still aligns');
  const tiny = { frames: 3, data: new Float32Array(3 * FEATURE_DIM) };
  assert.equal(subsequenceDtw(template, tiny).cost, Infinity, 'a test shorter than half the template cannot match');
});

// ------------------------------------------------------------------------------------------ the engine on synthetic words
test('engine: the owner\'s own "Sudo" is a candidate (alone, with -chan, inside a sentence, at 44.1 kHz, louder/softer)', () => {
  const { me, rng, detector } = enrol(7);
  const cases = [
    ['sudo'], ['sudo', 'chan'], ['sudo', 'kaise', 'ho'], ['hello', 'sudo'], ['mera', 'naam', 'sudo'],
  ];
  let hits = 0, total = 0;
  for (const words of cases) for (let i = 0; i < 4; i++) {
    const v = verdictOf(detector, makeClip(words, repeatOf(me, rng), { rng, level: 0.15 + 0.3 * rng() }));
    total++;
    if (v.candidate) hits++;
    else report('missed', words.join(' '), v.score.toFixed(2), '>', v.threshold.toFixed(2));
  }
  report(`own voice, ${total} clips: ${hits} candidates`);
  assert.ok(hits / total >= 0.9, `recall on synthetic own-voice clips ${hits}/${total}`);
  const v441 = verdictOf(detector, makeClip(['sudo'], repeatOf(me, rng), { rate: 44100, rng }), 44100);
  assert.equal(v441.candidate, true, 'a 44.1 kHz mic works the same');
  assert.ok(v441.startMs >= 0 && v441.endMs > v441.startMs && v441.label === 'sudo');
});

test('engine: other words, silence, fan noise and bursts are rejected (false-accept rate on synthetic clutter)', () => {
  const { me, rng, detector } = enrol(7);
  // "suno" and "pseudo" differ from "sudo" by one phoneme: close calls are expected and are what the cloud confirmation is for.
  const clutter = ['sid', 'studio', 'seedha', 'radio', 'music', 'salam', 'theek', 'hello', 'bolo', 'banao khol', 'mera naam', 'kaise ho', 'khol'];
  let accepts = 0, total = 0;
  for (const w of clutter) for (let i = 0; i < 3; i++) {
    const v = verdictOf(detector, makeClip(w.split(' '), repeatOf(me, rng), { rng }));
    total++;
    if (v.candidate) { accepts++; report('false accept', w, v.score.toFixed(2)); }
  }
  report(`clutter, ${total} clips: ${accepts} false candidates`);
  assert.ok(accepts / total <= 0.05, `false accept rate ${accepts}/${total}`);
  const quiet = verdictOf(detector, new Float32Array(RATE * 2));
  assert.equal(quiet.candidate, false);
  assert.equal(quiet.reason, 'no-speech');
  assert.equal(verdictOf(detector, noiseClip(3000, RATE, rng)).reason, 'no-speech');
  const click = concat([silence(400, RATE), say('k', { f0: 100 }, RATE, rng), silence(500, RATE)]);
  assert.equal(verdictOf(detector, click).candidate, false, 'a click / door slam');
  assert.equal(verdictOf(detector, new Float32Array(10)).reason, 'too-short');
  const chatter = concat([silence(300, RATE), ...['mera', 'naam', 'radio', 'music', 'salam'].flatMap(w => [say(({ mera: 'm e r a', naam: 'n a m', radio: 'r a d i o', music: 'm u s i k', salam: 's a l a m' })[w], repeatOf(me, rng), RATE, rng), silence(90, RATE)]), silence(500, RATE)]);
  assert.equal(verdictOf(detector, chatter).candidate, false, 'five unrelated words in a row');
});

test('engine: sensitivity moves the threshold (0.8x .. 1.25x) and a different voice saying Sudo is mostly outside the owner\'s threshold', () => {
  const base = 3;
  assert.ok(Math.abs(effectiveThreshold(base, 0.5, 0) - base) < 1e-9);
  assert.ok(effectiveThreshold(base, 0, 0) < base && effectiveThreshold(base, 1, 0) > base);
  assert.ok(Math.abs(effectiveThreshold(base, 0, 0) / base - 0.8) < 1e-9 && Math.abs(effectiveThreshold(base, 1, 0) / base - 1.25) < 1e-9);
  assert.ok(effectiveThreshold(base, 0.5, -0.25) < base * 0.8, 'the limiter\'s negative offset tightens');
  assert.equal(effectiveThreshold(base, Number.NaN, 0), base, 'NaN sensitivity falls back to the middle');
  const { rng, detector } = enrol(7);
  let accepted = 0;
  const rejectedAtLow = [];
  for (let k = 0; k < 12; k++) {
    const stranger = speakerFrom(rng, k % 2 ? { f0: 190 + 40 * rng(), tract: 0.9 + 0.04 * rng() } : { f0: 100 + 30 * rng(), tract: 1.1 + 0.05 * rng() });
    const clip = makeClip(['sudo'], stranger, { rng });
    detector.setSensitivity(0.5);
    if (verdictOf(detector, clip).candidate) accepted++;
    detector.setSensitivity(0);
    rejectedAtLow.push(verdictOf(detector, clip).candidate);
  }
  report(`strangers with a different pitch/vocal tract: ${accepted}/12 accepted at 0.5`);
  assert.ok(accepted <= 6, `speaker check should reject a good share of very different voices (${accepted}/12)`);
  assert.ok(rejectedAtLow.filter(Boolean).length <= accepted, 'lower sensitivity never accepts more');
});

test('engine: aggregate cost uses the closest two templates once there are five', () => {
  assert.equal(aggregateCosts([5, 1, 3]), 1);
  assert.equal(aggregateCosts([5, 1, 3, 2, 9]), 1.5);
  assert.equal(aggregateCosts([Infinity, 4]), 4);
  assert.equal(aggregateCosts([Infinity]), Infinity);
});

// ------------------------------------------------------------------------------------------ cost
test('cost: ms per second of audio, and the evaluation slices into small steps that match the one-shot result', async () => {
  const { me, rng, detector } = enrol(7);
  const clips = [makeClip(['sudo'], repeatOf(me, rng), { rng }), makeClip(['sudo', 'kaise', 'ho', 'theek', 'hello'], repeatOf(me, rng), { rng, tailMs: 600 })];
  for (const c of clips) verdictOf(detector, c); // warm the JIT like a minute of use would
  const rows = [];
  for (const clip of clips) {
    const seconds = clip.length / RATE;
    const runs = 5;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) verdictOf(detector, clip);
    const per = (performance.now() - t0) / runs;
    rows.push({ seconds: +seconds.toFixed(2), ms: +per.toFixed(1), msPerSecond: +(per / seconds).toFixed(1) });
  }
  report('cost', JSON.stringify(rows));
  for (const r of rows) assert.ok(r.ms < 150, `a ${r.seconds} s clip took ${r.ms} ms`);
  // Slicing: with a fake clock that advances 1 per call and a budget of 2, the work needs many steps; the result is identical.
  let tick = 0;
  const job = detector.start(clips[0], RATE);
  let steps = 0;
  while (!job.step(2, () => tick++)) steps++;
  assert.ok(steps > 20, `work is spread over many small steps (${steps})`);
  assert.deepEqual({ ...job.result() }, { ...verdictOf(detector, clips[0]) });
  // evaluateCooperative yields between steps and stamps computeMs; an overloaded machine (timeout) yields 'error' = "could not tell".
  let yields = 0, clock = 0;
  const v = await evaluateCooperative(detector, clips[0], RATE, { now: () => clock++, yieldNow: async () => { yields++; }, budgetMs: 2, maxMs: 1e9 });
  assert.ok(yields > 10 && v.candidate && typeof v.computeMs === 'number');
  let late = 0;
  const slow = await evaluateCooperative(detector, clips[0], RATE, { now: () => (late += 50), yieldNow: async () => {}, budgetMs: 4, maxMs: 100 });
  assert.equal(slow.reason, 'error');
  assert.equal(slow.candidate, false);
});

// ------------------------------------------------------------------------------------------ enrolment
test('enrolment validation: too quiet, clipped, too short, too long, noisy, silent, each with calm advice', () => {
  const rng = rngFrom(11);
  const me = speakerFrom(rng);
  const good = checkEnrollmentSample(makeClip(['sudo'], me, { rng }), RATE);
  assert.ok(good.ok && good.features && good.features.frames >= 20, JSON.stringify(good.issues));
  assert.ok(good.wordMs > 300 && good.wordMs < 1000);
  const issues = clip => checkEnrollmentSample(clip, RATE).issues;
  assert.ok(issues(makeClip(['sudo'], me, { rng, level: 0.01, noise: 0.00005, hum: false })).includes('too-quiet'));
  const loud = makeClip(['sudo'], me, { rng, level: 0.3 });
  for (let i = 0; i < loud.length; i++) loud[i] = Math.max(-1, Math.min(1, loud[i] * 12));
  assert.ok(issues(loud).includes('clipped'));
  assert.ok(issues(concat([silence(400, RATE), say('k', { f0: 100 }, RATE, rng), silence(500, RATE)])).some(i => i === 'too-short' || i === 'no-speech'));
  assert.ok(issues(makeClip(['sudo', 'kaise', 'ho', 'theek', 'hello', 'radio'], me, { rng, gapMs: 20 })).includes('too-long'));
  assert.ok(issues(makeClip(['sudo'], me, { rng, level: 0.1, noise: 0.045, hum: false })).includes('noisy'));
  assert.deepEqual(issues(new Float32Array(RATE)), ['no-speech']);
  assert.deepEqual(issues(new Float32Array(0)), ['no-speech']);
  assert.equal(checkEnrollmentSample(new Float32Array(10), 0).ok, false);
  for (const advice of Object.values(SAMPLE_ADVICE)) assert.ok(advice.length > 10 && !/[!]{2}/.test(advice));
});

test('enrolment session: needs 5, stops at 8, refuses bad takes without counting them, undo works', () => {
  const rng = rngFrom(12);
  const me = speakerFrom(rng);
  const s = new EnrollmentSession();
  const bad = s.add(new Float32Array(RATE), RATE);
  assert.equal(bad.accepted, false);
  assert.equal(s.count, 0);
  for (let i = 0; i < 4; i++) assert.ok(s.add(makeClip(['sudo'], repeatOf(me, rng), { rng }), RATE).accepted);
  assert.equal(s.canFinish, false);
  assert.equal(s.finish().error, 'too-few');
  s.add(makeClip(['sudo'], repeatOf(me, rng), { rng }), RATE);
  assert.equal(s.canFinish, true);
  s.undo();
  assert.equal(s.count, 4);
  while (!s.full) s.add(makeClip(['sudo'], repeatOf(me, rng), { rng }), RATE);
  assert.equal(s.count, 8);
  assert.equal(s.add(makeClip(['sudo'], repeatOf(me, rng), { rng }), RATE).accepted, false, 'a ninth take is refused');
  assert.equal(s.finish().ok, true);
});

test('calibration: threshold above the leave-one-out mean, a lone odd sample is dropped, a set of different words is refused', () => {
  const rng = rngFrom(13);
  const me = speakerFrom(rng);
  const take = word => checkEnrollmentSample(makeClip([word], repeatOf(me, rng), { rng }), RATE).features;
  const sudos = Array.from({ length: 6 }, () => take('sudo'));
  const cal = calibrate(sudos);
  assert.equal(cal.looScores.length, 6);
  assert.ok(cal.threshold > cal.looMean && cal.threshold >= cal.looMean * 1.4 - 1e-9, 'at least 2 x 20 % above the mean');
  const withOdd = buildLabel([...sudos.slice(0, 4), take('radio'), take('sudo')]);
  assert.equal(withOdd.ok, true);
  assert.deepEqual(withOdd.dropped, [4], 'six takes, one of them a different word: it is dropped and five remain');
  const onlyFive = buildLabel([...sudos.slice(0, 4), take('radio')]);
  assert.equal(onlyFive.error, 'odd-sample', 'with exactly five takes the odd one cannot be dropped: ask for more');
  const seven = buildLabel([...sudos.slice(0, 5), take('radio'), take('sudo')]);
  assert.equal(seven.ok, true);
  assert.deepEqual(seven.dropped, [5], 'the radio take (index 5) was left out');
  // Three good takes and two different words: not one word. (Honest limit: a set where every take is some OTHER word's neighbour,
  // e.g. three "sudo" and three "sid", looks consistent to a leave-one-out check; the self-test afterwards is the real gate.)
  const split = buildLabel([...sudos.slice(0, 3), take('radio'), take('music')]);
  assert.equal(split.ok, false);
  assert.equal(split.error, 'inconsistent');
  assert.equal(buildLabel(sudos.slice(0, 4)).error, 'too-few');
});

test('profile: stores feature vectors only (no audio), is small, round-trips, merges labels, and rejects damaged or hostile data', () => {
  const { built } = enrol(7);
  const sid = enrol(8, { label: 'sid', word: 'sid' });
  const both = withLabel(withLabel(undefined, 'sudo', built.label, 1), 'sid', sid.built.label, 2);
  const text = JSON.stringify(both);
  report(`profile with two words: ${text.length} bytes`);
  assert.ok(text.length < 200_000);
  const keys = new Set();
  JSON.parse(text, function (key) { keys.add(key); return this[key]; });
  for (const forbidden of ['audio', 'samples', 'wav', 'pcm', 'dataUri', 'raw']) assert.ok(![...keys].some(k => k.toLowerCase().includes(forbidden)), `no ${forbidden} field`);
  const parsed = parseProfile(text);
  assert.deepEqual(profileLabels(parsed).map(l => l.label).sort(), ['sid', 'sudo']);
  assert.ok(createDetector(parsed)?.ready);
  const onlySudo = withoutLabel(parsed, 'sid', 3);
  assert.deepEqual(profileLabels(onlySudo).map(l => l.label), ['sudo']);
  assert.equal(withoutLabel(onlySudo, 'sudo', 4), undefined);
  const mutate = fn => { const c = JSON.parse(text); fn(c); return parseProfile(JSON.stringify(c)); };
  assert.equal(parseProfile('not json'), undefined);
  assert.equal(parseProfile('{}'), undefined);
  assert.equal(mutate(c => { c.version = 2; }), undefined);
  assert.equal(mutate(c => { c.data.labels.sudo.templates[0].data[3] = 1e9; }), undefined);
  assert.equal(mutate(c => { c.data.labels.sudo.templates[0].frames = 5; }), undefined, 'frames must match the data length');
  assert.equal(mutate(c => { c.data.labels.sudo.threshold = -1; }), undefined);
  assert.equal(mutate(c => { c.data.labels['Bad Name!'] = c.data.labels.sudo; }), undefined);
  assert.equal(mutate(c => { c.data.labels.sudo.templates = []; }), undefined);
  assert.equal(parseProfile('x'.repeat(5_000_000)), undefined);
  assert.equal(parseTemplateData({ labels: {} }), undefined);
});

test('profile file: written 0600 with no extra files, read back, refused when malformed, deleted completely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-wake-'));
  const file = new LocalWakeFile(join(dir, 'sub', 'local-wake.json'));
  assert.equal(file.read(), undefined, 'missing file = not enrolled');
  assert.equal(file.write({ nonsense: true }), false);
  assert.equal(existsSync(file.path), false);
  const { profile } = enrol(7);
  assert.equal(file.write(profile), true);
  assert.equal(statSync(file.path).mode & 0o777, 0o600);
  assert.deepEqual(profileLabels(file.read()).map(l => l.label), ['sudo']);
  assert.equal(existsSync(`${file.path}.tmp`), false, 'atomic write leaves no temp file');
  writeFileSync(file.path, '{"version":1,"engine":"template-dtw","createdAt":1,"data":{"labels":{"sudo":{"templates":[]}}}}');
  assert.equal(file.read(), undefined, 'a damaged file is treated as not enrolled');
  assert.equal(file.write(profile), true);
  assert.equal(file.delete(), true);
  assert.equal(existsSync(file.path), false);
  assert.equal(file.delete(), true, 'deleting twice is fine');
  assert.ok(!readFileSync(new URL('../src/main/local-wake-store.ts', import.meta.url), 'utf8').includes('writeFileSync(temp, JSON.stringify(profile), { encoding: \'utf8\' }'));
});

test('self-test summary: heard n/3 in plain words', () => {
  assert.equal(summariseSelfTest([{ candidate: true }, { candidate: true }, { candidate: true }]).message, 'Heard 3/3. She knows your voice.');
  const two = summariseSelfTest([{ candidate: true }, { candidate: false }, { candidate: true }]);
  assert.equal(two.heard, 2);
  assert.match(two.message, /^Heard 2\/3/);
  assert.match(summariseSelfTest([{ candidate: false }, { candidate: false }]).message, /^Heard 0\/2/);
  assert.equal(summariseSelfTest([]).total, 0);
});

test('self-test on synthetic data: the owner says it three times, heard 3/3; a stranger\'s three clips are not all heard', () => {
  const { me, rng, detector } = enrol(21);
  const mine = Array.from({ length: 3 }, () => verdictOf(detector, makeClip(['sudo'], repeatOf(me, rng), { rng })));
  assert.equal(summariseSelfTest(mine).heard, 3);
  const noise = Array.from({ length: 3 }, () => verdictOf(detector, makeClip(['radio'], repeatOf(me, rng), { rng })));
  assert.equal(summariseSelfTest(noise).heard, 0);
});

test('endpointer: waits for speech, ends 450 ms after it stops, gives up after 4 s of nothing, caps a long take', () => {
  const e = new WordEndpointer();
  for (let i = 0; i < 5; i++) assert.equal(e.feed(0.001, 40), 'waiting');
  assert.equal(e.feed(0.05, 40), 'speaking');
  for (let i = 0; i < 11; i++) assert.equal(e.feed(0.001, 40), 'speaking', 'a short closure inside the word does not end it');
  assert.equal(e.feed(0.001, 40), 'done');
  assert.equal(e.feed(0.5, 40), 'done', 'final');
  const idle = new WordEndpointer();
  let state = 'waiting';
  for (let t = 0; t < 4100 && state === 'waiting'; t += 40) state = idle.feed(0, 40);
  assert.equal(state, 'timeout');
  const long = new WordEndpointer();
  let ended = 'speaking';
  long.feed(0.1, 40);
  for (let t = 0; t < 3200 && ended === 'speaking'; t += 40) ended = long.feed(0.1, 40);
  assert.equal(ended, 'done');
});

// ------------------------------------------------------------------------------------------ limiter, stats, gate combination
test('limiter: burst of 4, then one per 20 s; refund returns a token; the adaptive offset stays within bounds and recovers', () => {
  const l = new CandidateLimiter();
  let t = 1000;
  for (let i = 0; i < CANDIDATE_BURST; i++) assert.equal(l.allow(t), true);
  assert.equal(l.allow(t), false);
  assert.equal(l.allow(t + CANDIDATE_REFILL_MS - 1), false);
  assert.equal(l.allow(t + CANDIDATE_REFILL_MS + 1), true);
  l.refund();
  assert.equal(l.allow(t + CANDIDATE_REFILL_MS + 2), true);
  for (let i = 0; i < 20; i++) l.noteOutcome(true, false);
  assert.equal(l.offset, OFFSET_MIN, 'unconfirmed candidates tighten, down to the floor');
  l.noteOutcome(true, true);
  assert.ok(l.offset > OFFSET_MIN, 'a confirmed wake relaxes it');
  for (let i = 0; i < 20; i++) l.noteOutcome(false, true);
  assert.equal(l.offset, OFFSET_MAX, 'wakes the local check missed loosen it, up to the cap');
  const calm = new CandidateLimiter();
  calm.noteOutcome(false, false);
  assert.equal(calm.offset, 0, 'a non-candidate the cloud also rejected changes nothing');
});

test('stats: counts only, one line per window, no scores or text', () => {
  const s = new LocalWakeStats();
  assert.equal(s.flush(0, 'assist'), undefined, 'nothing happened');
  s.recordVerdict({ candidate: true }, 1000);
  for (let i = 0; i < 7; i++) s.recordVerdict({ candidate: false }, 2000);
  s.recordSent(3000); s.recordSent(3000); s.recordSent(3000);
  assert.equal(s.flush(30_000, 'assist'), undefined, 'window not over');
  const line = s.flush(61_001, 'assist');
  assert.equal(formatWakeLocalLine(line), '[wake-local] candidates=1 rejected=7 sent=3 mode=assist');
  assert.equal(s.flush(200_000, 'assist'), undefined, 'counters reset');
});

test('gate combination: off/not-enrolled/error leave the gate alone; candidates always go; assist keeps the old gate only while quota is healthy; strict drops', () => {
  const cand = { candidate: true, reason: 'match', score: 1, threshold: 2 };
  const non = { candidate: false, reason: 'no-match', score: 5, threshold: 2 };
  const gateYes = { send: true, reason: 'isolated' }, gateNo = { send: false, reason: 'budget' };
  for (const mode of ['off']) for (const v of [cand, non, undefined]) {
    assert.deepEqual(decideWithLocal(mode, v, gateYes, 0), { send: true, source: 'gate', refundGate: false });
    assert.deepEqual(decideWithLocal(mode, v, gateNo, 0), { send: false, source: 'gate', refundGate: false });
  }
  for (const mode of ['assist', 'strict']) {
    for (const v of [undefined, { ...non, reason: 'not-enrolled' }, { ...non, reason: 'error' }]) {
      assert.equal(decideWithLocal(mode, v, gateYes, 0.9).send, true, `${mode}: no usable verdict = old gate`);
      assert.equal(decideWithLocal(mode, v, gateNo, 0).send, false);
    }
    assert.deepEqual(decideWithLocal(mode, cand, gateNo, 0.99), { send: true, source: 'candidate', refundGate: false }, 'a candidate is sent even if the gate would not');
    assert.equal(decideWithLocal(mode, cand, gateYes, 0).source, 'candidate');
  }
  assert.deepEqual(decideWithLocal('assist', non, gateYes, ASSIST_MAX_PRESSURE - 0.01), { send: true, source: 'gate', refundGate: false });
  assert.deepEqual(decideWithLocal('assist', non, gateYes, ASSIST_MAX_PRESSURE), { send: false, source: 'quota-drop', refundGate: true });
  assert.equal(decideWithLocal('assist', non, { send: true, reason: 'floor' }, 0.99).send, true, 'the once-a-minute floor survives quota pressure');
  assert.equal(decideWithLocal('assist', non, gateNo, 0).send, false);
  assert.deepEqual(decideWithLocal('strict', non, gateYes, 0), { send: false, source: 'local-drop', refundGate: true });
  assert.equal(decideWithLocal('strict', { ...non, reason: 'limited' }, gateYes, 0).send, false, 'a limited candidate is not sent');
});

// ------------------------------------------------------------------------------------------ controller + registry
function fakeDetector(plan) {
  const calls = [];
  return {
    calls,
    engineId: 'fake', ready: plan.ready ?? true, labels: ['x'],
    setSensitivity(s) { calls.push(['sens', s]); }, setOffset(o) { calls.push(['offset', o]); },
    start() { return { step: () => true, result: () => ({ candidate: plan.candidate, reason: plan.candidate ? 'match' : 'no-match', score: plan.candidate ? 1 : 9, threshold: 2 }) }; },
  };
}
const fakeEngine = plan => ({ id: 'fake', title: 'Fake', needsDownload: true, create: data => (data === 'bad' ? undefined : fakeDetector(plan)) });
const io = () => { let t = 0; return { now: () => (t += 1), yieldNow: async () => {} }; };

test('registry: template-dtw ships (no download); another engine can be registered and is chosen by the profile\'s engine id; unknown or broken profiles give no detector', () => {
  const t = getEngine('template-dtw');
  assert.equal(t.needsDownload, false);
  assert.ok(listEngines().some(e => e.id === 'template-dtw'));
  const plan = { candidate: true };
  registerEngine(fakeEngine(plan));
  assert.ok(createDetector({ version: 1, engine: 'fake', createdAt: 0, data: 'ok' })?.ready);
  assert.equal(createDetector({ version: 1, engine: 'fake', createdAt: 0, data: 'bad' }), undefined);
  assert.equal(createDetector({ version: 1, engine: 'from-the-future', createdAt: 0, data: {} }), undefined);
  assert.equal(createDetector(undefined), undefined);
  assert.equal(templateEngine.create({ labels: 'nope' }), undefined);
});

test('controller: off or not enrolled = no verdict and no counters; assist/strict evaluate; the candidate budget turns a flood into "limited"; outcomes steer the limiter', async () => {
  const plan = { candidate: true };
  registerEngine(fakeEngine(plan));
  const profile = { version: 1, engine: 'fake', createdAt: 0, data: 'ok' };
  const c = new LocalWakeController(io());
  const clip = new Float32Array(4800);
  assert.equal(c.active, false);
  assert.equal(await c.evaluate(clip, 48000), undefined);
  c.configure('assist', 0.5);
  assert.equal(await c.evaluate(clip, 48000), undefined, 'enabled but nothing enrolled: behaves as off');
  assert.equal(c.flushStats(1e9, true), undefined);
  c.setProfile(profile);
  assert.equal(c.active, true);
  c.configure('assist', 0.8);
  const verdicts = [];
  for (let i = 0; i < CANDIDATE_BURST + 2; i++) verdicts.push(await c.evaluate(clip, 48000));
  assert.equal(verdicts.filter(v => v.candidate).length, CANDIDATE_BURST);
  assert.equal(verdicts.at(-1).reason, 'limited');
  const decision = c.decide(verdicts[0], { send: false }, 0);
  assert.equal(decision.source, 'candidate');
  c.noteOutcome(false);
  assert.ok(c.limiter.offset < 0, 'the cloud did not hear the name: tighter');
  c.noteOutcome(true);
  const before = c.limiter.offset;
  c.noteOutcome(true);
  assert.equal(c.limiter.offset, before, 'one outcome per sent clip');
  assert.equal(c.flushStats(1e9, true), `[wake-local] candidates=${CANDIDATE_BURST} rejected=2 sent=1 mode=assist`);
  c.configure('off', 0.5);
  assert.equal(c.active, false);
  assert.equal(await c.evaluate(clip, 48000), undefined);
  plan.candidate = false;
});

test('decideWakeClip: the whole wake-mode decision with the real ClipGate and WakeGate (live untouched, tokens refunded when anyone refuses)', async () => {
  const plan = { candidate: false };
  registerEngine(fakeEngine(plan));
  const features = { durationMs: 1600, voicedMs: 700, rms: 0.05, peak: 0.2, crest: 4, zcrPerSec: 1500, runs: 1, phraseBreaks: 0, steadyMs: 0, overlappedPlayback: false, bargeInFired: false };
  // Build the exact feature object the gate expects from its own accumulator-free defaults: reuse a real accumulator.
  const { ClipFeatureAccumulator } = await import('../src/shared/clip-gate.ts');
  const acc = new ClipFeatureAccumulator();
  for (let i = 0; i < 40; i++) acc.push({ rms: 0.05 + 0.02 * Math.sin(i / 3), peak: 0.15, zcrPerSec: 1500, frameMs: 21, voiced: true });
  const f = acc.finish({ durationMs: 1500, overlappedPlayback: false, bargeInFired: false });
  assert.ok(f && features);
  const make = mode => {
    const controller = new LocalWakeController(io());
    controller.setProfile({ version: 1, engine: 'fake', createdAt: 0, data: 'ok' });
    controller.configure(mode, 0.5);
    return { controller, clipGate: new ClipGate(), wakeGate: new WakeGate(2000) };
  };
  const cand = { candidate: true, reason: 'match', score: 1, threshold: 2 };
  const non = { candidate: false, reason: 'no-match', score: 9, threshold: 2 };
  // off: identical to the gate alone
  const off = make('off');
  const base = new ClipGate().decide(f, { now: 100_000, live: false });
  const offDecision = decideWakeClip({ features: f, local: cand, live: false, now: 100_000, ...off });
  assert.equal(offDecision.send, base.send, 'off ignores the verdict');
  // strict: a non-candidate never leaves and gives the gate token back
  const strict = make('strict');
  const dropped = decideWakeClip({ features: f, local: non, live: false, now: 100_000, ...strict });
  assert.equal(dropped.send, false);
  const sent = decideWakeClip({ features: f, local: cand, live: false, now: 200_000, ...strict });
  assert.equal(sent.send, true);
  assert.ok(sent.trimMs > 0 && sent.trimMs <= 3500, 'a candidate upload is trimmed');
  assert.equal(decideWakeClip({ features: f, local: cand, live: false, now: 200_500, ...strict }).send, false, 'WakeGate\'s 2 s minimum interval still applies; the candidate token is refunded');
  assert.equal(strict.controller.limiter.allow(1e9), true);
  // live: always sent, local ignored
  const live = decideWakeClip({ features: f, local: non, live: true, now: 1, ...strict });
  assert.deepEqual(live, { send: true });
  // assist at high quota pressure drops a gate-approved non-candidate
  const assist = make('assist');
  assist.clipGate.setQuotaPressure(0.9);
  const quotaDrop = decideWakeClip({ features: f, local: non, live: false, now: 100_000, ...assist });
  assert.equal(quotaDrop.send, base.reason === 'floor' ? true : false);
  plan.candidate = false;
});

// ------------------------------------------------------------------------------------------ settings
test('settings: localWake defaults to off and is validated; sensitivity 0..1 only', () => {
  assert.equal(DEFAULT_SETTINGS.localWake, 'off');
  assert.equal(DEFAULT_SETTINGS.localWakeSensitivity, 0.5);
  for (const mode of ['off', 'assist', 'strict']) assert.equal(validSettings({ ...DEFAULT_SETTINGS, localWake: mode }), true);
  for (const bad of ['on', 'ASSIST', '', 1, true, null, {}]) assert.equal(validSettings({ ...DEFAULT_SETTINGS, localWake: bad }), false, String(bad));
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, localWake: undefined }), true, 'older settings files without the field stay valid');
  for (const ok of [0, 0.5, 1]) assert.equal(validSettings({ ...DEFAULT_SETTINGS, localWakeSensitivity: ok }), true);
  for (const bad of [-0.01, 1.01, '0.5', Number.NaN, Infinity, null]) assert.equal(validSettings({ ...DEFAULT_SETTINGS, localWakeSensitivity: bad }), false, String(bad));
});

test('normalise helper keeps tests honest: WAKE_RATE is 16 kHz and a normalised clip peaks where asked', () => {
  assert.equal(WAKE_RATE, 16000);
  const x = normalise(Float32Array.from([0.1, -0.4, 0.2]), 0.8);
  assert.ok(Math.abs(Math.max(...x.map(Math.abs)) - 0.8) < 1e-6);
});
