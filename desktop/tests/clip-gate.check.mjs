// Quota saver: unit tests for the pure ClipGate plus a deterministic simulator that replays synthetic clip streams
// (quiet room, room talk, TV, "Sudo, kaise ho?" every 2 min, rapid conversation, echo tail, low quota) through the old
// behaviour (every clip >= 220 ms voiced, WakeGate 2 s minimum interval) and the new one (ClipGate + WakeGate), and
// compares the number of cloud requests. No audio, no network, no clock: time is a number we pass in.
// Set GATE_SIM_REPORT=1 to print the table that QUOTA-SAVER.md quotes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ClipGate, ClipFeatureAccumulator, frameStats, junkReason, pressureFromRemaining, formatGateLine,
  GATE_FLOOR_MS, WAKE_TRIM_MS,
} from '../src/shared/clip-gate.ts';
import { WakeGate } from '../src/shared/wake-word.ts';
import { UsageTracker } from '../src/shared/usage.ts';

// ------------------------------------------------------------------------------------------ synthetic clips
function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (rng, lo, hi) => lo + (hi - lo) * rng();

/** Features of ordinary speech of a given voiced length. `phraseBreaks`: natural pauses inside it. */
function speech(rng, voicedMs, extra = {}) {
  const runs = Math.max(1, Math.round(voicedMs / between(rng, 900, 1800)));
  const leadRunMs = runs === 1 ? voicedMs : Math.min(voicedMs, between(rng, 250, 2200));
  const rms = between(rng, 0.03, 0.08);
  return {
    durationMs: voicedMs + 340 + 500, voicedMs, spanMs: voicedMs + (runs - 1) * 200,
    peak: rms * between(rng, 3.5, 9), rms, envCv: between(rng, 0.55, 1.1), zcrPerSec: between(rng, 1500, 4500),
    runs, leadRunMs, leadGapMs: runs === 1 ? 0 : between(rng, 120, 450),
    overlappedPlayback: false, bargeInFired: false, ...extra,
  };
}
/** "Sudo, kaise ho?" / "Sid" / "Sudo what time is it": a 0.3-0.5 s name, an optional short pause, a short request. */
function wakeUtterance(rng, kind = 'phrase') { // 'alone' | 'pause' (name, pause, request) | 'phrase' (35% one-breath)
  if (kind === 'alone') return speech(rng, between(rng, 280, 520), { runs: 1 });
  const name = between(rng, 280, 500);
  const rest = between(rng, 500, 1400);
  // Many people say it without any pause: "Sudo kaise ho" is one voiced stretch.
  if (kind === 'phrase' && rng() < 0.35) return speech(rng, name + rest, { runs: 1 });
  return { ...speech(rng, name + rest), runs: 2, leadRunMs: name, leadGapMs: between(rng, 120, 300) };
}
const impulse = rng => speech(rng, between(rng, 220, 400), { peak: 0.6, rms: 0.03, envCv: 1.4, runs: 1 });
const hiss = rng => speech(rng, between(rng, 500, 1500), { zcrPerSec: between(rng, 11000, 16000), envCv: between(rng, 0.2, 0.4), runs: 1 });

/** event: { t (ms), features, wake (bool) } */
function stream(events) {
  return events.sort((a, b) => a.t - b.t);
}

/** Room talk shaped like the measured idle log: ~5 clips a minute, in conversation bursts of 2-5 clips. */
function roomTalk(rng, minutes, { clipsPerMin = 5 } = {}) {
  const events = [];
  const end = minutes * 60000;
  let t = between(rng, 2000, 15000);
  while (t < end) {
    const n = 2 + Math.floor(rng() * 4);
    for (let i = 0; i < n && t < end; i++) {
      const roll = rng();
      const voiced = roll < 0.55 ? between(rng, 500, 2500) : roll < 0.9 ? between(rng, 2500, 7000) : between(rng, 8000, 14000);
      events.push({ t, features: speech(rng, voiced), wake: false });
      t += voiced + 340 + 500 + between(rng, 900, 3000);
    }
    t += between(rng, 10000, 2 * (60000 / clipsPerMin) * 3.5);
  }
  return events;
}

/** TV: dialogue scenes (clips back to back with ~1-2 s gaps) with 8-25 s lulls between scenes. */
function tvTalk(rng, minutes, { lulls = true } = {}) {
  const events = [];
  const end = minutes * 60000;
  let t = 1000;
  while (t < end) {
    const n = 4 + Math.floor(rng() * 6);
    for (let i = 0; i < n && t < end; i++) {
      const roll = rng();
      const voiced = roll < 0.3 ? between(rng, 400, 1500) : roll < 0.85 ? between(rng, 1500, 6000) : between(rng, 8000, 16000);
      events.push({ t, features: speech(rng, voiced, { envCv: between(rng, 0.45, 0.9) }), wake: false });
      t += voiced + 840 + between(rng, 600, 2000);
    }
    t += lulls ? between(rng, 8000, 25000) : between(rng, 600, 1200);
  }
  return events;
}

/** The user says it every `everyMs`. During a TV lull when `intoLulls`, otherwise at the exact time. */
function userWakes(rng, minutes, everyMs, startMs = 50000) {
  const events = [];
  for (let t = startMs; t < minutes * 60000; t += everyMs) {
    const features = wakeUtterance(rng, rng() < 0.3 ? 'alone' : 'phrase');
    // "Loose" = said in one breath with no pause after the name and longer than a bare name; room talk looks exactly like it.
    events.push({ t, features, wake: true, loose: features.runs === 1 && features.voicedMs > 900 });
  }
  return events;
}
/** Move wake utterances to the nearest quiet moment (>= 4.1 s from any other clip), the way a person waits for a lull. */
function intoQuiet(events) {
  const others = events.filter(e => !e.wake);
  // `t` is the moment a clip ends (when the engine decides); it started `durationMs` earlier.
  return events.map(e => {
    if (!e.wake) return e;
    const wd = e.features.durationMs;
    let t = e.t;
    for (let guard = 0; guard < 400; guard++) {
      const clash = others.find(o => t - wd < o.t + 4100 && t > o.t - o.features.durationMs - 4100);
      if (!clash) break;
      t = clash.t + 4200 + wd;
    }
    return { ...e, t };
  });
}

// ------------------------------------------------------------------------------------------ replay
const MIN_VOICED = 220;
/** Old behaviour: the engine's 220 ms minimum, then WakeGate (>= 2 s between sends). */
function replayOld(events) {
  const wg = new WakeGate(2000);
  let sent = 0, wakeSent = 0;
  for (const e of stream(events)) {
    if (e.features.voicedMs < MIN_VOICED) continue;
    if (!wg.allow(e.t)) continue;
    sent++;
    if (e.wake) wakeSent++;
  }
  return { sent, wakeSent };
}
/** New behaviour, wired like App.tsx: ClipGate first, WakeGate second (refund when it refuses), result fed back. */
function replayNew(events, { pressure = 0, liveUntil = () => false, gate = new ClipGate() } = {}) {
  const wg = new WakeGate(2000);
  gate.setQuotaPressure(pressure);
  const sentTimes = [];
  const out = { sent: 0, wakeSent: 0, wakes: 0, strictWakes: 0, strictSent: 0, looseWakes: 0, looseSent: 0, liveSent: 0, liveGated: 0, liveClips: 0, sentTimes, gate };
  for (const e of stream(events)) {
    if (e.features.voicedMs < MIN_VOICED) continue;
    if (e.wake) { out.wakes++; if (e.loose) out.looseWakes++; else out.strictWakes++; }
    const live = liveUntil(e.t);
    if (live) {
      out.liveClips++;
      const d = gate.decide(e.features, { now: e.t, live: true });
      if (d.send) out.liveSent++; else out.liveGated++;
      continue;
    }
    const d = gate.decide(e.features, { now: e.t, live: false });
    if (!d.send) continue;
    if (!wg.allow(e.t)) { gate.refund(d); continue; }
    out.sent++;
    sentTimes.push(e.t);
    if (e.wake) { out.wakeSent++; if (e.loose) out.looseSent++; else out.strictSent++; }
    gate.noteResult(e.wake);
  }
  return out;
}
const reduction = (before, after) => (before === 0 ? 1 : 1 - after / before);

const REPORT = [];
const LOOSE = []; // first-attempt rate of the one-breath wake form: [room talk, TV with lulls]
function report(name, minutes, before, after, wakes) {
  REPORT.push({ scenario: name, minutes, before: before.sent, after: after.sent, reduction: Math.round(reduction(before.sent, after.sent) * 100), wakes: `${after.wakeSent}/${wakes}` });
}

// ------------------------------------------------------------------------------------------ unit tests
const baseClip = () => speech(rngFrom(7), 1500);

test('live clips are never gated and never touch the budget', () => {
  const gate = new ClipGate();
  for (let i = 0; i < 50; i++) {
    const d = gate.decide(baseClip(), { now: i * 1000, live: true });
    assert.equal(d.send, true);
    assert.equal(d.reason, 'live');
    assert.equal(d.spent, 0);
  }
  assert.equal(gate.flushStats(60000, 60000, true).length, 0, 'live decisions are not even counted');
  assert.equal(gate.decide(baseClip(), { now: 100000, live: false }).send, true, 'the full burst is still there afterwards');
});

test('a barge-in clip is always sent, a bare name is always sent after quiet', () => {
  const gate = new ClipGate();
  for (let i = 0; i < 20; i++) gate.decide(speech(rngFrom(i), 3000), { now: i * 4000, live: false });
  assert.equal(gate.decide(speech(rngFrom(1), 400, { bargeInFired: true }), { now: 90000, live: false }).send, true);
  const gate2 = new ClipGate();
  const d = gate2.decide(speech(rngFrom(2), 300, { runs: 1 }), { now: 10000, live: false });
  assert.deepEqual([d.send, d.reason], [true, 'isolated']);
  assert.equal(d.trimMs, WAKE_TRIM_MS);
});

test('junk rules: clicks, hiss and steady noise are skipped; speech and a short bare name are not', () => {
  const rng = rngFrom(3);
  assert.equal(junkReason(impulse(rng)), 'impulse');
  assert.equal(junkReason(hiss(rng)), 'hiss');
  assert.equal(junkReason(speech(rng, 6000, { envCv: 0.12, runs: 1 })), 'steady-noise');
  assert.equal(junkReason(speech(rng, 6000, { envCv: 0.12, runs: 6 })), null, 'steady level but many pauses: leave it to the budget');
  for (let i = 0; i < 200; i++) {
    assert.equal(junkReason(speech(rngFrom(100 + i), between(rngFrom(i), 250, 9000))), null);
    assert.equal(junkReason(wakeUtterance(rngFrom(300 + i), i % 2 ? 'alone' : 'phrase')), null);
  }
});

test('feature extraction from real PCM: vowel-like speech is not junk, white noise and a click are', () => {
  const sampleRate = 48000;
  const frame = 1024;
  const frameMs = (frame / sampleRate) * 1000;
  const run = (make, frames, thresholdRms = 0.009) => {
    const acc = new ClipFeatureAccumulator();
    let n = 0;
    for (let k = 0; k < frames; k++) {
      const buf = new Float32Array(frame);
      for (let i = 0; i < frame; i++) buf[i] = make(n++);
      let sum = 0;
      for (let i = 0; i < frame; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / frame);
      const stats = frameStats(buf, sampleRate);
      acc.push({ rms, peak: stats.peak, zcrPerSec: stats.zcrPerSec, frameMs, voiced: rms > thresholdRms });
    }
    return acc.finish({ durationMs: frames * frameMs, overlappedPlayback: false, bargeInFired: false });
  };
  const rng = rngFrom(11);
  // "Sudo, kaise ho": two syllable bursts with a pause, harmonic voice at 140 Hz.
  const speechFeatures = run(i => {
    const t = i / sampleRate;
    const env = (t % 0.9) < 0.35 || ((t % 0.9) > 0.5 && (t % 0.9) < 0.85) ? 0.5 + 0.5 * Math.sin(2 * Math.PI * 5 * t) ** 2 : 0;
    return 0.2 * env * (Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 420 * t) + 0.3 * Math.sin(2 * Math.PI * 980 * t)) / 1.8;
  }, 90);
  assert.ok(speechFeatures.voicedMs > 500, `voiced ${speechFeatures.voicedMs}`);
  assert.ok(speechFeatures.zcrPerSec < 4000, `zcr ${speechFeatures.zcrPerSec}`);
  assert.ok(speechFeatures.runs >= 2 && speechFeatures.leadGapMs >= 100, `runs ${speechFeatures.runs} gap ${speechFeatures.leadGapMs}`);
  assert.equal(junkReason(speechFeatures), null);
  const noiseFeatures = run(() => (rng() - 0.5) * 0.2, 150);
  assert.ok(noiseFeatures.zcrPerSec > 15000, `white noise zcr ${noiseFeatures.zcrPerSec}`);
  assert.equal(junkReason(noiseFeatures), 'hiss');
  const click = run(i => (i < 30 ? 0.9 * Math.exp(-i / 6) * (i % 2 ? 1 : -1) : 0.0008 * (rng() - 0.5)), 12);
  assert.ok(click.voicedMs < 100);
  const steady = run(i => 0.1 * Math.sin(2 * Math.PI * 220 * (i / sampleRate)) + 0.05 * Math.sin(2 * Math.PI * 330 * (i / sampleRate)), 300);
  assert.ok(steady.envCv < 0.22, `steady cv ${steady.envCv}`);
  assert.equal(junkReason(steady), 'steady-noise');
});

test('long monologues: only a "name, pause" start gets through, and only against two tokens; the floor still lets one per minute pass', () => {
  const rng = rngFrom(5);
  const gate = new ClipGate();
  const mono = () => speech(rng, 12000, { runs: 6, leadRunMs: 1800, leadGapMs: 300 });
  const first = gate.decide(mono(), { now: 20000, live: false });
  assert.deepEqual([first.send, first.reason], [true, 'floor'], 'nothing sent yet, so the minute floor applies');
  const second = gate.decide(mono(), { now: 40000, live: false });
  assert.deepEqual([second.send, second.reason], [false, 'long-talk']);
  const addressed = speech(rng, 12000, { runs: 6, leadRunMs: 450, leadGapMs: 200 });
  const third = gate.decide(addressed, { now: 80000, live: false });
  assert.equal(third.send, true);
  assert.equal(third.trimMs, WAKE_TRIM_MS);
});

test('hit rate: a run of misses slows the refill, a few hits restore it', () => {
  const gate = new ClipGate();
  assert.equal(gate.currentRefillMs(), 15000);
  assert.equal(gate.currentTalkRefillMs(), 90000);
  for (let i = 0; i < 3; i++) gate.noteResult(false);
  assert.equal(gate.currentRefillMs(), 30000, 'the protected lane backs off at most 2x');
  assert.equal(gate.currentTalkRefillMs(), 270000);
  for (let i = 0; i < 5; i++) gate.noteResult(false);
  assert.equal(gate.currentRefillMs(), 30000);
  assert.equal(gate.currentFloorMs(), 180000, 'healthy quota and only misses: speculative sends become rare');
  for (let i = 0; i < 4; i++) gate.noteResult(true);
  assert.equal(gate.currentRefillMs(), 15000);
  assert.equal(gate.currentTalkRefillMs(), 90000);
  assert.equal(gate.currentFloorMs(), 60000);
  assert.ok(gate.hitRate > 0.4);
});

test('quota pressure: 0 above half left, 1 at none; stricter burst and refill, never slower than the floor', () => {
  assert.equal(pressureFromRemaining(1500, 2000), 0);
  assert.equal(pressureFromRemaining(1000, 2000), 0);
  assert.ok(Math.abs(pressureFromRemaining(431, 2000) - 0.569) < 0.01);
  assert.equal(pressureFromRemaining(0, 2000), 1);
  assert.equal(pressureFromRemaining(undefined, 2000), 0);
  assert.equal(pressureFromRemaining(10, 0), 0);
  const gate = new ClipGate();
  gate.setQuotaPressure(1);
  for (let i = 0; i < 8; i++) gate.noteResult(false);
  assert.equal(gate.currentRefillMs(), GATE_FLOOR_MS);
  assert.equal(gate.currentFloorMs(), GATE_FLOOR_MS, 'under pressure the floor stays at one minute');
  gate.setQuotaPressure(5);
  assert.equal(gate.quotaPressure, 1);
});

test('stat lines are counts only and follow the documented format', () => {
  const gate = new ClipGate();
  const rng = rngFrom(9);
  for (let i = 0; i < 12; i++) gate.decide(speech(rng, 3000), { now: 1000 + i * 5000, live: false });
  gate.decide(impulse(rng), { now: 70000, live: false });
  const lines = gate.flushStats(80000, 60000).map(formatGateLine);
  assert.ok(lines.length >= 2);
  for (const line of lines) assert.match(line, /^\[gate\] skipped=\d+ sent=\d+ reason=[a-z-]+$/);
  assert.deepEqual(gate.flushStats(90000, 60000), [], 'flushed');
});

test('usage meter feeds the pressure: Groq headers in, one number out; stale or renewed snapshots count as no pressure', () => {
  let now = Date.parse('2026-10-27T10:00:00');
  const tracker = new UsageTracker({ now: () => now });
  assert.equal(tracker.sttQuotaPressure(), 0, 'nothing known yet');
  const headers = new Map([['x-ratelimit-limit-requests', '2000'], ['x-ratelimit-remaining-requests', '431'], ['x-ratelimit-reset-requests', '6h0m0s']]);
  tracker.groqStt(3, { get: name => headers.get(name) ?? null }, true);
  assert.ok(Math.abs(tracker.sttQuotaPressure() - 0.569) < 0.01, `${tracker.sttQuotaPressure()}`);
  now += 7 * 3600_000;
  assert.equal(tracker.sttQuotaPressure(), 0, 'the allowance renewed');
  headers.set('x-ratelimit-reset-requests', '40h');
  now = Date.parse('2026-10-27T10:00:00');
  tracker.groqStt(3, { get: name => headers.get(name) ?? null }, true);
  now += 25 * 3600_000;
  assert.equal(tracker.sttQuotaPressure(), 0, 'a snapshot older than a day is ignored');
});

// ------------------------------------------------------------------------------------------ simulations
const MIN = 10;

test('sim: quiet room (clicks, hiss, a few mumbles) sends at least 70% fewer requests', () => {
  let totalBefore = 0, totalAfter = 0;
  for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
    const rng = rngFrom(seed);
    const events = [];
    for (let t = 4000; t < MIN * 60000; t += between(rng, 15000, 50000)) {
      const roll = rng();
      events.push({ t, features: roll < 0.5 ? impulse(rng) : roll < 0.8 ? hiss(rng) : speech(rng, between(rng, 250, 900)), wake: false });
    }
    totalBefore += replayOld(events).sent; totalAfter += replayNew(events).sent;
  }
  report('quiet room: 50% clicks, 30% hiss, 20% mumbles (8 seeds)', MIN * 8, { sent: totalBefore }, { sent: totalAfter, wakeSent: 0 }, 0);
  assert.ok(reduction(totalBefore, totalAfter) >= 0.7, `${totalBefore} -> ${totalAfter}`);
});

test('sim: idle room talk (5 clips/min, conversation bursts) with the user saying the name every 2 min', () => {
  let totalBefore = 0, totalAfter = 0, wakeTotal = 0, wakeSent = 0, looseWakes = 0, looseSent = 0;
  for (const seed of [31, 32, 33, 34, 35, 36, 37, 38]) {
    const rng = rngFrom(seed);
    const events = intoQuiet([...roomTalk(rng, MIN), ...userWakes(rng, MIN, 120000)]);
    const before = replayOld(events), after = replayNew(events);
    totalBefore += before.sent; totalAfter += after.sent; wakeTotal += after.wakes; wakeSent += after.wakeSent;
    // The bare name and "name, pause, request" must always go. The one-breath form can be rationed in a busy room (see QUOTA-SAVER.md).
    assert.equal(after.strictSent, after.strictWakes, `seed ${seed}: every bare-name / name+pause utterance must be sent (${after.strictSent}/${after.strictWakes})`);
    looseWakes += after.looseWakes; looseSent += after.looseSent;
  }
  assert.ok(looseSent >= 0.1 * looseWakes, `one-breath wakes sent first time: ${looseSent}/${looseWakes}`);
  LOOSE.push(`${looseSent}/${looseWakes}`);
  const b = { sent: totalBefore }, a = { sent: totalAfter, wakeSent };
  report('idle room talk + "Sudo" every 2 min (8 seeds)', MIN * 8, b, a, wakeTotal);
  assert.ok(reduction(totalBefore, totalAfter) >= 0.7, `${totalBefore} -> ${totalAfter}`);
});

test('sim: TV talk for 10 minutes with scene lulls, user says the name in a lull every 2 min', () => {
  let totalBefore = 0, totalAfter = 0, wakeTotal = 0, wakeSent = 0, looseWakes = 0, looseSent = 0;
  for (const seed of [41, 42, 43, 44, 45, 46, 47, 48]) {
    const rng = rngFrom(seed);
    const events = intoQuiet([...tvTalk(rng, MIN), ...userWakes(rng, MIN, 120000)]);
    const before = replayOld(events), after = replayNew(events);
    totalBefore += before.sent; totalAfter += after.sent; wakeTotal += after.wakes; wakeSent += after.wakeSent;
    // The bare name and "name, pause, request" must always go. The one-breath form can be rationed in a busy room (see QUOTA-SAVER.md).
    assert.equal(after.strictSent, after.strictWakes, `seed ${seed}: every bare-name / name+pause utterance must be sent (${after.strictSent}/${after.strictWakes})`);
    looseWakes += after.looseWakes; looseSent += after.looseSent;
  }
  assert.ok(looseSent >= 0.1 * looseWakes, `one-breath wakes sent first time: ${looseSent}/${looseWakes}`);
  LOOSE.push(`${looseSent}/${looseWakes}`);
  report('TV talk with lulls + "Sudo" every 2 min (8 seeds)', MIN * 8, { sent: totalBefore }, { sent: totalAfter, wakeSent }, wakeTotal);
  assert.ok(reduction(totalBefore, totalAfter) >= 0.7, `${totalBefore} -> ${totalAfter}`);
});

test('sim: TV wall to wall (no lulls at all) still cuts 70%+ and is never silent for more than the floor (3 min with a healthy quota)', () => {
  let totalBefore = 0, totalAfter = 0;
  let longestGap = 0;
  for (const seed of [51, 52, 53, 54]) {
    const rng = rngFrom(seed);
    const events = tvTalk(rng, MIN, { lulls: false });
    const before = replayOld(events), after = replayNew(events);
    totalBefore += before.sent; totalAfter += after.sent;
    for (let i = 1; i < after.sentTimes.length; i++) longestGap = Math.max(longestGap, after.sentTimes[i] - after.sentTimes[i - 1]);
  }
  report('TV wall to wall, no lulls, no user (4 seeds)', MIN * 4, { sent: totalBefore }, { sent: totalAfter, wakeSent: 0 }, 0);
  assert.ok(reduction(totalBefore, totalAfter) >= 0.7, `${totalBefore} -> ${totalAfter}`);
  assert.ok(longestGap <= 3 * GATE_FLOOR_MS + 20000, // healthy quota + only misses: floor 3 min; TV clips here are up to ~19 s apart
     `longest silence between requests ${longestGap} ms`);
});

test('sim: the user says "Sudo, kaise ho?" or "Sid" every 2 minutes in a quiet room: 100% sent', () => {
  const rng = rngFrom(61);
  const events = userWakes(rng, 30, 120000);
  const after = replayNew(events);
  report('quiet room, "Sudo" every 2 min for 30 min', 30, replayOld(events), after, after.wakes);
  assert.equal(after.wakeSent, after.wakes);
  assert.equal(after.wakes, 15);
});

test('sim: a one-breath "Sudo kaise ho" skipped in a busy room is sent when the user says it again a few seconds later', () => {
  let pairs = 0, firstSent = 0, eitherSent = 0;
  for (const seed of [71, 72, 73, 74, 75, 76, 77, 78]) {
    const rng = rngFrom(seed);
    const base = roomTalk(rng, 10);
    const wakes = userWakes(rng, 10, 120000).map(e => ({ ...e, features: wakeUtterance(rng, 'phrase') })).filter(e => e.features.runs === 1);
    const moved = intoQuiet([...base, ...wakes]);
    // Each wake gets a repeat 7 s later (the bot did not answer, so the user tries again); the repeat is also placed in a quiet moment.
    const firsts = moved.filter(e => e.wake);
    const repeats = firsts.map(e => ({ ...e, t: e.t + 7000, features: { ...e.features } }));
    const all = [...base, ...firsts, ...repeats];
    const gate = new ClipGate();
    const wg = new WakeGate(2000);
    const sentAt = new Set();
    for (const e of stream(all)) {
      const d = gate.decide(e.features, { now: e.t, live: false });
      if (!d.send) continue;
      if (!wg.allow(e.t)) { gate.refund(d); continue; }
      if (e.wake) sentAt.add(e);
      gate.noteResult(e.wake);
    }
    firsts.forEach((first, i) => {
      pairs++;
      if (sentAt.has(first)) firstSent++;
      if (sentAt.has(first) || sentAt.has(repeats[i])) eitherSent++;
    });
  }
  assert.ok(pairs >= 8, `${pairs} pairs`);
  assert.equal(eitherSent, pairs, `first attempt ${firstSent}/${pairs}, first or repeat ${eitherSent}/${pairs}`);
});

test('sim: rapid conversation (Live Talk open) is never gated, even with the budget at zero', () => {
  const gate = new ClipGate();
  for (let i = 0; i < 12; i++) gate.noteResult(false);
  const rng = rngFrom(81);
  const events = [];
  for (let t = 1000, i = 0; i < 60; i++, t += between(rng, 2500, 5000)) events.push({ t, features: speech(rng, between(rng, 300, 9000)), wake: false });
  const after = replayNew(events, { gate, liveUntil: () => true, pressure: 1 });
  assert.equal(after.liveClips, 60);
  assert.equal(after.liveSent, 60);
  assert.equal(after.liveGated, 0);
});

test('sim: after the bot spoke (echo tail), tail clips are rationed but a real "Sudo" after a short quiet spell still goes', () => {
  const rng = rngFrom(91);
  const events = [];
  // Five bot replies; each leaves two tail-overlapping clips behind, and the user answers 4 s later.
  for (let k = 0; k < 5; k++) {
    const base = 30000 + k * 120000;
    events.push({ t: base, features: speech(rng, 1800, { overlappedPlayback: true, rms: 0.012 }), wake: false });
    events.push({ t: base + 3000, features: speech(rng, 900, { overlappedPlayback: true, rms: 0.012 }), wake: false });
    events.push({ t: base + 12000, features: wakeUtterance(rng, 'pause'), wake: true });
  }
  const before = replayOld(events), after = replayNew(events);
  report('echo tail after 5 bot replies, user answers 12 s later', 10, before, after, 5);
  assert.equal(after.wakeSent, 5);
  assert.ok(after.sent < before.sent);
});

test('sim: at high quota pressure it is much stricter but still sends at least one speech-like clip a minute', () => {
  const rng = rngFrom(101);
  const events = tvTalk(rng, 12, { lulls: false });
  const before = replayOld(events);
  const after = replayNew(events, { pressure: pressureFromRemaining(60, 2000) });
  report('TV wall to wall at quota pressure ~0.97 (60 of 2000 left)', 12, before, after, 0);
  assert.ok(reduction(before.sent, after.sent) >= 0.85, `${before.sent} -> ${after.sent}`);
  // Never silent for long: the gap between requests is at most the floor plus the spacing of the clips themselves.
  let longest = 0;
  for (let i = 1; i < after.sentTimes.length; i++) longest = Math.max(longest, after.sentTimes[i] - after.sentTimes[i - 1]);
  assert.ok(after.sentTimes.length >= 10, `${after.sentTimes.length} requests in 12 min`);
  assert.ok(longest <= GATE_FLOOR_MS + 20000, `longest gap ${longest} ms`);
});

test('sim: a user wake at 0.57 pressure (431 of 2000 left) after a quiet spell is sent', () => {
  const rng = rngFrom(111);
  const events = intoQuiet([...roomTalk(rng, 10), ...userWakes(rng, 10, 120000)]);
  const after = replayNew(events, { pressure: pressureFromRemaining(431, 2000) });
  assert.equal(after.wakeSent, after.wakes);
});

test.after(() => {
  if (!process.env.GATE_SIM_REPORT) return;
  console.log('\n| scenario | minutes | before | after | reduction | wake sent |\n|---|---|---|---|---|---|');
  for (const r of REPORT) console.log(`| ${r.scenario} | ${r.minutes} | ${r.before} | ${r.after} | ${r.reduction}% | ${r.wakes} |`);
  console.log(`\nOne-breath wake form ("Sudo kaise ho", no pause) sent on the FIRST try: room talk ${LOOSE[0]}, TV with lulls ${LOOSE[1]} (a repeat is always sent, see the repeat test).`);
});
