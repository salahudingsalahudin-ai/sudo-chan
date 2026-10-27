import test from 'node:test';
import assert from 'node:assert/strict';
import { BargeInDetector, bargeInMinSpeechMs, bargeInThreshold, clampSensitivity } from '../src/shared/barge-in.ts';
import { DEFAULT_SETTINGS, validSettings } from '../src/shared/validation.ts';

const BASE = 0.009;
const make = (sensitivity = 0.5) => new BargeInDetector({ baseThreshold: BASE, sensitivity });
const FRAME = 21; // ~1024 samples @ 48 kHz

test('playback threshold is higher than idle speech threshold and shrinks with sensitivity', () => {
  for (const s of [0, 0.5, 1]) assert.ok(bargeInThreshold({ baseThreshold: BASE, sensitivity: s }) > BASE);
  assert.ok(bargeInThreshold({ baseThreshold: BASE, sensitivity: 0 }) > bargeInThreshold({ baseThreshold: BASE, sensitivity: 1 }));
  assert.equal(clampSensitivity(5), 1);
  assert.equal(clampSensitivity(NaN), 0.5);
});

test('required continuous speech is 150-250 ms', () => {
  assert.equal(bargeInMinSpeechMs(0), 250);
  assert.equal(bargeInMinSpeechMs(1), 150);
  assert.equal(bargeInMinSpeechMs(0.5), 200);
});

test('single loud frame and short blips do not trigger barge-in', () => {
  const d = make();
  assert.equal(d.feed(0.5, FRAME, 0), false);
  let t = FRAME;
  for (let i = 0; i < 30; i++, t += FRAME) assert.equal(d.feed(0.001, FRAME, t), false);
  // 5 blips of 3 frames (63 ms) separated by 200 ms silence
  for (let b = 0; b < 5; b++) {
    for (let i = 0; i < 3; i++, t += FRAME) assert.equal(d.feed(0.2, FRAME, t), false);
    for (let i = 0; i < 10; i++, t += FRAME) assert.equal(d.feed(0.001, FRAME, t), false);
  }
});

test('echo-level audio below the playback threshold never triggers', () => {
  const d = make();
  const leak = BASE * 1.5; // bot's own voice leaking into the mic
  for (let i = 0; i < 500; i++) assert.equal(d.feed(leak, FRAME, i * FRAME), false);
});

test('tiny gaps inside speech are tolerated, long gaps reset', () => {
  const d = make();
  let t = 0, fired = false;
  for (let i = 0; i < 4; i++, t += FRAME) fired ||= d.feed(0.2, FRAME, t);
  d.feed(0.001, FRAME, t); t += FRAME; // 21 ms dip
  for (let i = 0; i < 10 && !fired; i++, t += FRAME) fired ||= d.feed(0.2, FRAME, t);
  assert.equal(fired, true);

  const e = make();
  t = 0;
  for (let i = 0; i < 5; i++, t += FRAME) e.feed(0.2, FRAME, t);
  for (let i = 0; i < 6; i++, t += FRAME) e.feed(0.001, FRAME, t); // 126 ms silence resets
  assert.equal(e.feed(0.2, FRAME, t), false);
});

test('mock audio: user interrupts while bot speaks, trigger latency < 300 ms at default sensitivity', () => {
  const d = make(0.5);
  const t0 = 1000; // user starts speaking
  let t = 0, triggeredAt = null;
  // 500 ms of bot-only echo leakage, then user speech
  for (; t < t0; t += FRAME) d.feed(BASE * 1.2, FRAME, t);
  for (; t < t0 + 1000 && triggeredAt === null; t += FRAME) {
    if (d.feed(0.15, FRAME, t)) triggeredAt = t;
  }
  assert.notEqual(triggeredAt, null);
  const latency = triggeredAt + FRAME - t0;
  console.log(`measured barge-in detection latency (sensitivity 0.5): ${latency} ms`);
  assert.ok(latency < 300, `latency ${latency}ms`);
  assert.ok(latency >= 150);
  assert.ok(Math.abs(d.speechStartedAt - (t0 - 0)) <= FRAME);
  // Fires once only
  assert.equal(d.feed(0.15, FRAME, t), false);
});

test('mock audio: lowest sensitivity still under 300 ms', () => {
  const d = make(0);
  let t = 0, at = null;
  for (; t < 1000 && at === null; t += FRAME) if (d.feed(0.3, FRAME, t)) at = t + FRAME;
  console.log(`measured barge-in detection latency (sensitivity 0): ${at} ms`);
  assert.ok(at < 300);
});

test('bargeInSensitivity setting is validated', () => {
  assert.equal(DEFAULT_SETTINGS.bargeInSensitivity, 0.5);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, bargeInSensitivity: 0 }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, bargeInSensitivity: 1 }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, bargeInSensitivity: 1.2 }), false);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, bargeInSensitivity: -0.1 }), false);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, bargeInSensitivity: '0.5' }), false);
});
