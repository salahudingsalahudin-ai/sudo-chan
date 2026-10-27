#!/usr/bin/env node
// Synthetic benchmark of the on-device wake word: how many ms of CPU per second of clip audio, and what that means as a share of one core.
//   node --experimental-strip-types scripts/local-wake-bench.mjs
// Uses synthetic clips only (tests/helpers/synth-speech.mjs). Real speech costs the same: the work depends on length, not on content.
import { EnrollmentSession, withLabel } from '../src/shared/local-wake/enrollment.ts';
import { createDetector } from '../src/shared/local-wake/registry.ts';
import { evaluateNow } from '../src/shared/local-wake/runtime.ts';
import { makeClip, rngFrom, speakerFrom, repeatOf, noiseClip } from '../tests/helpers/synth-speech.mjs';

const RATE = 48000;
const rng = rngFrom(99);
const me = speakerFrom(rng);
const session = new EnrollmentSession();
while (session.count < 6) session.add(makeClip(['sudo'], repeatOf(me, rng), { rng }), RATE);
const detector = createDetector(withLabel(undefined, 'sudo', session.finish().label, 1));

const cases = [
  ['"Sudo" alone', makeClip(['sudo'], me, { rng })],
  ['"Sudo kaise ho"', makeClip(['sudo', 'kaise', 'ho'], me, { rng })],
  ['5 words (3.7 s)', makeClip(['sudo', 'kaise', 'ho', 'theek', 'hello'], me, { rng, tailMs: 600 })],
  ['10 s chatter (capped at 4.5 s)', makeClip(['mera', 'naam', 'radio', 'music', 'salam', 'bolo', 'theek', 'hello', 'khol', 'banao', 'suno'], me, { rng, gapMs: 200 })],
  ['fan noise 3 s', noiseClip(3000, RATE, rng)],
];
for (const [, clip] of cases) for (let i = 0; i < 3; i++) evaluateNow(detector, clip, RATE); // warm up
console.log('clip'.padEnd(34), 'audio s', 'ms/clip', 'ms per s of audio');
const perClip = [];
for (const [name, clip] of cases) {
  const runs = 20;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) evaluateNow(detector, clip, RATE);
  const ms = (performance.now() - t0) / runs;
  const seconds = clip.length / RATE;
  perClip.push(ms);
  console.log(name.padEnd(34), seconds.toFixed(2).padStart(7), ms.toFixed(1).padStart(7), (ms / seconds).toFixed(1).padStart(8));
}
const worst = Math.max(...perClip);
for (const clipsPerMinute of [5, 15, 30]) console.log(`${clipsPerMinute} clips a minute at the worst case ${worst.toFixed(0)} ms = ${((clipsPerMinute * worst) / 600).toFixed(2)} % of one core`);
