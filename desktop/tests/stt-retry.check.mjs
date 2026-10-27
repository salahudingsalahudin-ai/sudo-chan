import test from 'node:test';
import assert from 'node:assert/strict';
import { SttRouter } from '../src/main/stt.ts';
import { decideRetry, RETRY_MIN_SECONDS, RETRY_MIN_RMS } from '../src/shared/stt-retry.ts';
import { wavClipStats } from '../src/shared/clip-stats.ts';
import { whisperTextIsSilence, segmentsLookLikeSilence } from '../src/shared/stt-hallucination.ts';
import { UsageTracker } from '../src/shared/usage.ts';

const GOOD = { seconds: 2.4, rms: 0.04, voicedMs: 900, botActive: false };

// ---------- pure policy ----------
test('retry policy: only an empty first result of a clear-speech clip, once', () => {
  assert.equal(decideRetry({ reason: 'empty', clip: GOOD }).retry, true);
  assert.equal(decideRetry({ reason: 'empty', clip: GOOD, alreadyRetried: true }).retry, false);
  for (const reason of ['filtered', 'rate-limited', 'error', 'no-key', 'ok', undefined]) assert.equal(decideRetry({ reason, clip: GOOD }).retry, false, String(reason));
  assert.equal(decideRetry({ reason: 'empty' }).retry, false); // no clip info
  assert.equal(decideRetry({ reason: 'empty', clip: { ...GOOD, seconds: RETRY_MIN_SECONDS - 0.01 } }).retry, false);
  assert.equal(decideRetry({ reason: 'empty', clip: { ...GOOD, rms: RETRY_MIN_RMS - 0.001 } }).retry, false);
  assert.equal(decideRetry({ reason: 'empty', clip: { ...GOOD, voicedMs: 100 } }).retry, false);
  assert.equal(decideRetry({ reason: 'empty', clip: { ...GOOD, botActive: true } }).retry, false);
  assert.equal(decideRetry({ reason: 'empty', clip: GOOD, groqRemainingFraction: 0.24 }).retry, false);
  assert.equal(decideRetry({ reason: 'empty', clip: GOOD, groqRemainingFraction: 0.25 }).retry, true);
  assert.equal(decideRetry({ reason: 'empty', clip: GOOD, groqRemainingFraction: undefined }).retry, true);
});

// ---------- router ----------
const ok = body => ({ ok: true, status: 200, json: async () => body });
const fail = status => ({ ok: false, status, json: async () => ({}) });
const geminiBody = text => ({ candidates: [{ content: { parts: [{ text }] } }] });
function make(handler, { keys = { gemini: 'G', groq: 'W' }, mode = 'fast', fraction } = {}) {
  const calls = [];
  const usage = { geminiStt() { this.g = (this.g ?? 0) + 1; }, geminiSttLimit() {}, groqStt(s, h, okk) { this.w = (this.w ?? 0) + (okk ? 1 : 0); }, groqSttRemainingFraction: () => fraction };
  const r = new SttRouter({
    fetch: async (url, init) => { const form = init.body instanceof FormData ? init.body : null; calls.push({ url, form }); return handler(url, form, calls.length); },
    getKey: id => keys[id] ?? '', now: () => 1000, getMode: () => mode, usage,
  });
  return { r, calls, usage };
}
const base = { base64: Buffer.from('x').toString('base64'), mimeType: 'audio/wav', language: 'auto', hint: 'Short voice command. The speaker may call the assistant by name: Sudo, Sid.' };
const clipReq = (clip = GOOD) => ({ ...base, clip });

test('fast mode: empty Whisper on clear speech -> exactly one retry on Gemini (other provider), without hint', async () => {
  const bodies = [];
  const { r, calls, usage } = make((url, form) => {
    if (form) return ok({ text: '', segments: [{ no_speech_prob: 0.95, avg_logprob: -1.7 }] });
    bodies.push(JSON.parse(String(calls.at(-1).form ?? '{}')));
    return ok(geminiBody('meri screen dekho'));
  });
  const out = await r.transcribe(clipReq());
  assert.equal(out.ok, true);
  assert.equal(out.retried, true);
  assert.equal(out.provider, 'gemini');
  assert.equal(calls.length, 2);
  assert.equal(usage.g, 1); // counted like a normal request
  assert.equal(usage.w, 1);
});

test('retry request carries no hint and no forced language (Gemini prompt is generic)', async () => {
  let geminiPrompt = '';
  const calls = [];
  const r = new SttRouter({
    fetch: async (url, init) => {
      calls.push(url);
      if (init.body instanceof FormData) return ok({ text: '' });
      geminiPrompt = JSON.parse(init.body).contents[0].parts[0].text;
      return ok(geminiBody('ruko'));
    },
    getKey: id => ({ gemini: 'G', groq: 'W' })[id] ?? '', now: () => 1000, getMode: () => 'fast',
  });
  const out = await r.transcribe({ ...clipReq(), language: 'en' });
  assert.equal(out.ok, true);
  assert.doesNotMatch(geminiPrompt, /Sudo, Sid/);
  assert.doesNotMatch(geminiPrompt, /uses English\./);
});

test('retry fails too: still exactly two requests, no loop', async () => {
  const { r, calls } = make((url, form) => (form ? ok({ text: '' }) : ok(geminiBody('[none]'))));
  const out = await r.transcribe(clipReq());
  assert.equal(out.ok, false);
  assert.equal(out.retried, true);
  assert.equal(calls.length, 2);
  await r.transcribe(clipReq());
  assert.equal(calls.length, 4); // two more for the next clip, never more per clip
});

test('Groq only: the retry is the same route WITHOUT prompt and language', async () => {
  const seen = [];
  const { r } = make((url, form) => { seen.push({ lang: form.get('language'), prompt: form.get('prompt') }); return ok({ text: seen.length === 1 ? '' : 'sid kaise ho' }); }, { keys: { groq: 'W' } });
  const out = await r.transcribe({ ...clipReq(), language: 'ur' });
  assert.equal(out.ok, true);
  assert.equal(out.retried, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].lang, 'ur');
  assert.ok(seen[0].prompt);
  assert.equal(seen[1].lang, null);
  assert.equal(seen[1].prompt, null);
});

test('accurate mode: Gemini [none] -> one retry on Whisper', async () => {
  const { r, calls } = make((url, form) => (form ? ok({ text: 'tum kahan ho' }) : ok(geminiBody('[none]'))), { mode: 'accurate' });
  const out = await r.transcribe(clipReq());
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'whisper');
  assert.equal(calls.length, 2);
});

test('no retry: short clip, quiet clip, bot speaking, low Groq quota, no clip info', async () => {
  const cases = [{ ...GOOD, seconds: 0.8 }, { ...GOOD, rms: 0.005 }, { ...GOOD, botActive: true }, undefined];
  for (const clip of cases) {
    const { r, calls } = make((url, form) => (form ? ok({ text: '' }) : ok(geminiBody('[none]'))));
    const out = await r.transcribe({ ...base, clip });
    assert.equal(out.ok, false);
    assert.equal(calls.length, 1, JSON.stringify(clip));
  }
  const low = make((url, form) => (form ? ok({ text: '' }) : ok(geminiBody('[none]'))), { fraction: 0.1 });
  await low.r.transcribe(clipReq());
  assert.equal(low.calls.length, 1);
});

test('no retry on a hallucination-filtered result (prompt leak stays dropped, one request)', async () => {
  for (const text of ['Sudo-chan, Sido-chan,', 'Thanks for watching', 'Sid Sid']) {
    const { r, calls } = make(() => ok({ text }));
    const out = await r.transcribe(clipReq());
    assert.equal(out.ok, false, text);
    assert.equal(calls.length, 1, text);
  }
  // Whisper silence verdict on a leaked name list is 'filtered' too, not 'empty'
  const { r, calls } = make(() => ok({ text: 'Sudo-chan, Sido-chan,', segments: [{ no_speech_prob: 0.93, avg_logprob: -1.5 }] }));
  const out = await r.transcribe(clipReq());
  assert.equal(out.ok, false);
  assert.equal(calls.length, 1);
});

test('no retry on rate limit or errors', async () => {
  const a = make(() => fail(429));
  assert.equal((await a.r.transcribe(clipReq())).rateLimited, true);
  assert.equal(a.calls.length, 3); // whisper + both Gemini models, 429 each (existing behaviour); no extra retry
  const b = make(() => fail(500), { keys: { groq: 'W' } });
  await b.r.transcribe(clipReq());
  assert.equal(b.calls.length, 2); // large-v3 then turbo on a server error (existing behaviour); no retry
});

// ---------- one-word commands and prompt leak through the router ----------
test('a one-word stop command from Whisper is no longer thrown away', async () => {
  for (const text of ['Ruko.', 'रुको', 'رکو', 'Sudo.', 'Bas!']) {
    const { r } = make(() => ok({ text }), { keys: { groq: 'W' } });
    const out = await r.transcribe(clipReq());
    assert.equal(out.ok, true, text);
    assert.equal(out.text, text);
  }
});

test('Arabic-script Whisper result that is a stop word is accepted without asking Gemini', async () => {
  const { r, calls } = make(() => ok({ text: 'رکو' }));
  const out = await r.transcribe(clipReq());
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
});

// ---------- silence rule ----------
test('borderline band keeps a quiet 3+ word sentence; names, short text and clear silence stay rejected', () => {
  const border = [{ no_speech_prob: 0.7, avg_logprob: -1.2 }];
  assert.equal(segmentsLookLikeSilence(border), true);
  assert.equal(whisperTextIsSilence(border, 'meri screen dekho zara'), false);
  assert.equal(whisperTextIsSilence(border, 'Sudo-chan, Sido-chan,'), true);
  assert.equal(whisperTextIsSilence(border, 'Sid ruko'), true);
  assert.equal(whisperTextIsSilence([{ no_speech_prob: 0.93, avg_logprob: -1.2 }], 'meri screen dekho zara'), true);
  assert.equal(whisperTextIsSilence([{ no_speech_prob: 0.7, avg_logprob: -1.9 }], 'meri screen dekho zara'), true);
  assert.equal(whisperTextIsSilence([{ no_speech_prob: 0.7, avg_logprob: -1.2 }], 'Thanks for watching'), true);
  assert.equal(whisperTextIsSilence([{ no_speech_prob: 0.1, avg_logprob: -1.2 }], 'x'), false);
  assert.equal(whisperTextIsSilence(undefined, 'anything'), false);
});

test('router keeps a borderline quiet sentence but rejects the same segments with a name list', async () => {
  const segs = [{ no_speech_prob: 0.72, avg_logprob: -1.3 }];
  const keep = make(() => ok({ text: 'meri screen dekho zara', segments: segs }), { keys: { groq: 'W' } });
  assert.equal((await keep.r.transcribe(clipReq())).ok, true);
  const drop = make(() => ok({ text: 'Sudo-chan, Sido-chan,', segments: segs }), { keys: { groq: 'W' } });
  assert.equal((await drop.r.transcribe(clipReq())).ok, false);
});

// ---------- clip stats and usage ----------
function wav(samples, rate = 16000) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => b.writeInt16LE(Math.round(v * 32767), 44 + i * 2));
  return b;
}

test('wavClipStats: seconds, rms, peak and voiced time', () => {
  const quiet = new Array(16000).fill(0).map((_, i) => 0.002 * Math.sin(i));
  const loud = new Array(16000).fill(0).map((_, i) => 0.1 * Math.sin(i / 3));
  const stats = wavClipStats(wav([...quiet, ...loud]));
  assert.ok(Math.abs(stats.seconds - 2) < 1e-6);
  assert.ok(stats.peak > 0.09 && stats.peak < 0.11);
  assert.ok(stats.voicedMs >= 980 && stats.voicedMs <= 1020, String(stats.voicedMs));
  assert.ok(stats.rms > 0.04 && stats.rms < 0.08);
  assert.equal(wavClipStats(Buffer.from('not a wav')), null);
  assert.equal(wavClipStats(wav([])).seconds, 0);
});

test('usage tracker: Groq remaining fraction from headers, unknown when stale or reset', () => {
  let now = 1_000_000;
  const u = new UsageTracker({ now: () => now });
  assert.equal(u.groqSttRemainingFraction(), undefined);
  const h = values => ({ get: name => values[name] ?? null });
  u.groqStt(2, h({ 'x-ratelimit-limit-requests': '2000', 'x-ratelimit-remaining-requests': '400', 'x-ratelimit-reset-requests': '1h' }), true);
  assert.equal(u.groqSttRemainingFraction(), 0.2);
  now += 2 * 3600_000; // past the reset: old numbers say nothing about the new window
  assert.equal(u.groqSttRemainingFraction(), undefined);
});
