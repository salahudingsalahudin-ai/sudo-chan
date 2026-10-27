// Deterministic synthetic "speech" for the local wake word tests and benchmark: a glottal pulse train through formant resonators,
// noise bursts for s/k/d, silence for closures. It is NOT real speech and says nothing about accuracy on real voices; it only gives
// words with different formant tracks, speaker variation (pitch, vocal tract length, tempo) and room noise to exercise the DSP.

export function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Vowel formants (F1, F2, F3) in Hz for an average adult male voice; `scale` moves them for other vocal tracts.
const VOWELS = {
  u: [300, 870, 2240], o: [500, 800, 2500], a: [730, 1090, 2440], i: [270, 2290, 3010], e: [530, 1840, 2480],
  A: [660, 1700, 2400], // as in "kaise" second part / short a
  m: [250, 1100, 2200], n: [250, 1400, 2300], r: [400, 1300, 1700], l: [350, 1100, 2700], b: [300, 900, 2200],
};
// Noise consonants: [centre Hz, bandwidth Hz, ms, level]
const NOISE = { s: [5800, 2500, 120, 0.5], h: [1800, 2500, 70, 0.25], k: [2600, 1800, 22, 0.5], d: [2000, 1800, 15, 0.35], t: [3500, 2500, 20, 0.45], g: [1800, 1500, 20, 0.35], p: [900, 1500, 18, 0.35], f: [4500, 3500, 110, 0.35], sh: [3500, 2000, 120, 0.5] };
const CLOSURE = { k: 55, d: 55, t: 55, g: 45, p: 55, b: 40 };
const VOWEL_MS = { u: 130, o: 190, a: 150, i: 130, e: 140, A: 120, m: 90, n: 80, r: 70, l: 80, b: 40 };

/** Phoneme strings ("s u d o") for a few words. Anything else is spelled out by the caller. */
export const WORDS = {
  sudo: 's u d o',
  sid: 's i d',
  chan: 'sh a n',
  kaise: 'k a i s e',
  ho: 'h o',
  theek: 't i k',
  hello: 'h e l o',
  suno: 's u n o',
  radio: 'r a d i o',
  music: 'm u s i k',
  banao: 'b a n a o',
  khol: 'k o l',
  mera: 'm e r a',
  naam: 'n a m',
  bolo: 'b o l o',
  salam: 's a l a m',
  pseudo: 'p s u d o',
  seedha: 's i d a',
  studio: 's t u d i o',
};

function resonator(freq, bw, rate) {
  const r = Math.exp((-Math.PI * bw) / rate);
  const theta = (2 * Math.PI * freq) / rate;
  return { a1: 2 * r * Math.cos(theta), a2: -r * r, gain: 1 - 2 * r * Math.cos(theta) + r * r, y1: 0, y2: 0 };
}
function run(res, x) {
  const y = res.gain * x + res.a1 * res.y1 + res.a2 * res.y2;
  res.y2 = res.y1;
  res.y1 = y;
  return y;
}

/**
 * One speaker saying one phoneme sequence.
 * speaker: { f0 (Hz), tract (formant scale), tempo (1 = normal, 1.2 = faster), jitter }
 */
export function say(phonemes, speaker, rate, rng) {
  const { f0 = 120, tract = 1, tempo = 1, jitter = 0.01, breath = 0.01 } = speaker;
  const out = [];
  const push = (n, fn) => { for (let i = 0; i < n; i++) out.push(fn(i, n)); };
  let phase = 0;
  const parts = phonemes.split(/\s+/).filter(Boolean);
  for (const ph of parts) {
    if (VOWELS[ph]) {
      const ms = (VOWEL_MS[ph] ?? 120) / tempo;
      const n = Math.round((ms / 1000) * rate);
      const f = VOWELS[ph].map(x => x * tract);
      const rs = [resonator(f[0], 80, rate), resonator(f[1], 110, rate), resonator(f[2], 160, rate)];
      const nasal = ph === 'm' || ph === 'n';
      push(n, (i, total) => {
        const t = i / total;
        const env = Math.min(1, t * 6) * Math.min(1, (1 - t) * 6) * (nasal ? 0.5 : 1);
        const period = rate / (f0 * (1 + (rng() - 0.5) * 2 * jitter) * (1 + 0.04 * Math.sin(t * Math.PI)));
        phase += 1;
        let pulse = 0;
        if (phase >= period) { phase -= period; pulse = 1; }
        const src = pulse * 2 + (rng() - 0.5) * breath;
        let y = 0;
        for (const r of rs) y += run(r, src);
        return y * env * 0.5;
      });
    } else if (CLOSURE[ph] || NOISE[ph]) {
      const closure = Math.round(((CLOSURE[ph] ?? 0) / tempo / 1000) * rate);
      push(closure, () => (rng() - 0.5) * 1e-4);
      const noise = NOISE[ph];
      if (noise) {
        const [centre, bw, ms, level] = noise;
        const n = Math.round((ms / tempo / 1000) * rate);
        const hi = resonator(centre, bw, rate);
        push(n, (i, total) => {
          const t = i / total;
          const env = Math.min(1, t * 8) * Math.min(1, (1 - t) * 4);
          return run(hi, rng() - 0.5) * env * level * 2.5;
        });
      }
    }
  }
  return Float32Array.from(out);
}

export function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function silence(ms, rate) {
  return new Float32Array(Math.round((ms / 1000) * rate));
}

export function normalise(x, peak) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  const g = m > 0 ? peak / m : 1;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
  return out;
}

/** A random plausible speaker: pitch 95-230 Hz, vocal tract +-8 %, tempo 0.88-1.15. */
export function speakerFrom(rng, base = {}) {
  return { f0: 95 + 135 * rng(), tract: 0.92 + 0.16 * rng(), tempo: 0.88 + 0.27 * rng(), jitter: 0.008 + 0.01 * rng(), ...base };
}

/** The same speaker saying the same word again: small natural variation only. */
export function repeatOf(speaker, rng) {
  return { ...speaker, f0: speaker.f0 * (0.95 + 0.1 * rng()), tract: speaker.tract * (0.985 + 0.03 * rng()), tempo: speaker.tempo * (0.92 + 0.16 * rng()) };
}

/**
 * A clip as the voice engine produces it: ~340 ms pre-roll of room noise, the speech, ~500 ms of trailing quiet.
 * words: array of phoneme strings (or WORDS keys). gapMs: pause between words. level: peak amplitude of the speech. noise: room noise rms.
 */
export function makeClip(words, speaker, { rate = 48000, rng = rngFrom(1), level = 0.3, noise = 0.0015, gapMs = 120, preMs = 340, tailMs = 500, hum = true } = {}) {
  const parts = [silence(preMs, rate)];
  words.forEach((w, i) => {
    if (i > 0) parts.push(silence(gapMs, rate));
    parts.push(say(WORDS[w] ?? w, speaker, rate, rng));
  });
  parts.push(silence(tailMs, rate));
  const x = concat(parts);
  // Scale only the speech, then lay the room noise over everything.
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  const g = m > 0 ? level / m : 1;
  for (let i = 0; i < x.length; i++) {
    const t = i / rate;
    x[i] = x[i] * g + (rng() - 0.5) * 2 * noise * Math.sqrt(3) + (hum ? 0.0008 * Math.sin(2 * Math.PI * 50 * t) : 0);
  }
  return x;
}

/** Steady noise / fan / hiss clip, for the "not speech" tests. */
export function noiseClip(ms, rate, rng, level = 0.05) {
  const x = new Float32Array(Math.round((ms / 1000) * rate));
  let lp = 0;
  for (let i = 0; i < x.length; i++) { lp += 0.2 * ((rng() - 0.5) - lp); x[i] = lp * level * 6; }
  return x;
}
