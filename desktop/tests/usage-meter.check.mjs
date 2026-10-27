import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AZURE_FREE_CHARS_PER_MONTH, GEMINI_TTS_DAILY_ESTIMATE, KEEP_DAYS, UsageTracker, estimateAudioSeconds, formatResetLabel,
  localDayKey, parseRateLimitHeaders, parseResetDuration, parseUsageData, tokensFromChatPayload,
} from '../src/shared/usage.ts';
import { TtsRouter } from '../src/main/tts-provider.ts';
import { AzureTtsProvider } from '../src/main/azure-provider.ts';
import { SttRouter } from '../src/main/stt.ts';
import { UsageFile } from '../src/main/usage-store.ts';
import { DEFAULT_SETTINGS, validSettings } from '../src/shared/validation.ts';
import { LocalAI } from '../dist/main/local-ai.js';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const at = (y, mo, d, h = 10, mi = 0) => new Date(y, mo - 1, d, h, mi, 0).getTime();
const flags = { gemini: true, groq: true, azure: true };
const row = (summary, id) => summary.rows.find(r => r.id === id);
function clock(start) {
  const c = { t: start, now: () => c.t };
  return c;
}

const pcm = Buffer.alloc(4800, 1);
const geminiOk = () => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }],
}), { status: 200 });
const googleOk = () => new Response(Buffer.from('ID3fake'), { status: 200 });
function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url) => {
    const u = String(url);
    calls.push(u);
    return (u.includes('generativelanguage') ? handlers.gemini : handlers.google)();
  };
  fn.gemini = () => calls.filter(c => c.includes('generativelanguage')).length;
  fn.google = () => calls.filter(c => c.includes('translate_tts')).length;
  return fn;
}

// ---------- counters, rollover, pruning ----------

test('day rollover: a new local day starts from zero and yesterday is kept', () => {
  const c = clock(at(2026, 10, 27, 23, 50));
  const u = new UsageTracker({ now: c.now });
  u.geminiTts(); u.geminiTts(); u.googleFallback();
  assert.equal(row(u.summary(flags), 'geminiTts').used, 2);
  assert.equal(u.summary(flags).basicVoiceToday, 1);
  c.t = at(2026, 10, 28, 0, 20);
  const next = u.summary(flags);
  assert.equal(row(next, 'geminiTts').used, 0);
  assert.equal(next.basicVoiceToday, 0);
  assert.equal(next.day, '2026-10-28');
  u.geminiTts();
  const data = u.serialize();
  assert.equal(data.days['2026-10-27'].geminiTts, 2);
  assert.equal(data.days['2026-10-28'].geminiTts, 1);
});

test('month rollover: Azure characters count per month against the 500,000 free tier', () => {
  const c = clock(at(2026, 10, 31, 22, 0));
  const u = new UsageTracker({ now: c.now });
  u.azureChars(120_000);
  const oct = row(u.summary(flags), 'azureTts');
  assert.equal(oct.used, 120_000);
  assert.equal(oct.allowance, AZURE_FREE_CHARS_PER_MONTH);
  assert.equal(oct.remaining, 380_000);
  assert.equal(oct.resetsAt, new Date(2026, 10, 1).getTime(), 'renews at the start of next month');
  c.t = at(2026, 11, 1, 0, 5);
  assert.equal(row(u.summary(flags), 'azureTts').used, 0);
  u.azureChars(50);
  const data = u.serialize();
  assert.equal(data.months['2026-10'].azureChars, 120_000);
  assert.equal(data.months['2026-11'].azureChars, 50);
});

test('pruning keeps 31 local days and drops older ones, also when loading an old file', () => {
  const c = clock(at(2026, 10, 27));
  const old = { version: 1, days: {}, months: {}, blocks: {} };
  for (let i = 0; i < 45; i++) old.days[localDayKey(new Date(2026, 9, 27 - i, 12).getTime())] = { geminiTts: 1 };
  const u = new UsageTracker({ now: c.now, initial: old });
  const kept = Object.keys(u.serialize().days).sort();
  assert.equal(kept.length, KEEP_DAYS);
  assert.equal(kept[kept.length - 1], '2026-10-27');
  assert.equal(kept[0], localDayKey(new Date(2026, 9, 27 - (KEEP_DAYS - 1), 12).getTime()));
  assert.equal(old.days['2026-10-27'].geminiTts, 1, 'the input object is not modified');
  // Recording on a later day prunes again.
  c.t = at(2026, 12, 20);
  u.geminiStt();
  assert.deepEqual(Object.keys(u.serialize().days), ['2026-12-20']);
});

test('parseUsageData keeps only known numeric counters (no foreign fields, no secrets)', () => {
  const dirty = {
    apiKey: 'AIzaSECRET', version: 9,
    days: { '2026-10-27': { geminiTts: 3, apiKey: 'gsk_SECRET', groqChat: 'x', groqSttSeconds: -4 }, 'not-a-day': { geminiTts: 1 } },
    months: { '2026-10': { azureChars: 9, key: 'k' } },
    groqChat: { at: 5, remainingRequests: 7, token: 'gsk_x' },
    blocks: { geminiTts: 123, extra: 1 },
  };
  const clean = parseUsageData(dirty);
  const text = JSON.stringify(clean);
  assert.equal(/SECRET|gsk_|AIza|apiKey|token/.test(text), false, text);
  assert.equal(clean.days['2026-10-27'].geminiTts, 3);
  assert.equal(clean.days['2026-10-27'].groqChat, 0);
  assert.equal(clean.days['2026-10-27'].groqSttSeconds, 0);
  assert.equal(clean.days['not-a-day'], undefined);
  assert.deepEqual(clean.blocks, { geminiTts: 123 });
  assert.deepEqual(parseUsageData('garbage'), { version: 1, days: {}, months: {}, blocks: {} });
});

// ---------- 429 handling ----------

test('a 429 marks Gemini voice blocked until the reset time, shows it, then clears itself', () => {
  const c = clock(at(2026, 10, 27, 14, 0));
  const u = new UsageTracker({ now: c.now });
  for (let i = 0; i < 4; i++) u.geminiTts();
  assert.equal(row(u.summary(flags), 'geminiTts').blocked, false);
  assert.equal(u.summary(flags).geminiVoiceBlockedUntil, null);
  const until = c.t + (7 * 3600 + 11 * 60) * 1000;
  u.geminiTtsLimit(until);
  const s = u.summary(flags);
  assert.equal(row(s, 'geminiTts').blocked, true);
  assert.equal(row(s, 'geminiTts').resetsAt, until);
  assert.equal(row(s, 'geminiTts').source, 'estimate', 'the allowance is never presented as exact');
  assert.equal(s.geminiVoiceBlockedUntil, until);
  assert.equal(formatResetLabel(until, c.t), '21:11');
  assert.equal(u.geminiTtsBlockedUntil(), until);
  // The block survives a restart (serialize -> new tracker) and ends by itself.
  const reloaded = new UsageTracker({ now: c.now, initial: u.serialize() });
  assert.equal(reloaded.geminiTtsBlockedUntil(), until);
  c.t = until + 1;
  assert.equal(reloaded.geminiTtsBlockedUntil(), 0);
  assert.equal(row(reloaded.summary(flags), 'geminiTts').blocked, false);
  u.clearGeminiTtsBlock();
  assert.equal(u.summary(flags).geminiVoiceBlockedUntil, null);
});

test('formatResetLabel: same day HH:MM, next day says tomorrow', () => {
  const now = at(2026, 10, 27, 9, 5);
  assert.equal(formatResetLabel(at(2026, 10, 27, 9, 45), now), '09:45');
  assert.equal(formatResetLabel(at(2026, 10, 28, 5, 0), now), 'tomorrow 05:00');
  assert.match(formatResetLabel(at(2026, 10, 30, 5, 0), now), /^[A-Z][a-z]{2} 05:00$/);
});

test('Gemini TTS summary: used vs the ESTIMATED allowance, with a note once it is passed', () => {
  const u = new UsageTracker({ now: clock(at(2026, 10, 27)).now });
  for (let i = 0; i < GEMINI_TTS_DAILY_ESTIMATE; i++) u.geminiTts();
  const r = row(u.summary(flags), 'geminiTts');
  assert.equal(r.allowance, GEMINI_TTS_DAILY_ESTIMATE);
  assert.equal(r.remaining, 0);
  assert.equal(r.fraction, 1);
  assert.equal(r.blocked, false, 'only a real 429 blocks');
  assert.match(r.detail, /not refused yet/);
});

// ---------- Groq headers ----------

test('reset durations: 2m59.56s, 7.66s, 250ms, 1h2m3s and plain seconds', () => {
  assert.equal(parseResetDuration('2m59.56s'), 179_560);
  assert.equal(parseResetDuration('7.66s'), 7660);
  assert.equal(parseResetDuration('250ms'), 250);
  assert.equal(parseResetDuration('1h2m3s'), 3_723_000);
  assert.equal(parseResetDuration('12'), 12_000);
  assert.equal(parseResetDuration(''), undefined);
  assert.equal(parseResetDuration('soon'), undefined);
});

test('Groq x-ratelimit headers are parsed into a snapshot with absolute reset times', () => {
  const headers = new Headers({
    'x-ratelimit-limit-requests': '14400', 'x-ratelimit-remaining-requests': '14370',
    'x-ratelimit-limit-tokens': '6000', 'x-ratelimit-remaining-tokens': '5900',
    'x-ratelimit-reset-requests': '2m59.56s', 'x-ratelimit-reset-tokens': '7.66s',
  });
  const snap = parseRateLimitHeaders(headers, 1_000_000);
  assert.deepEqual(snap, {
    at: 1_000_000, limitRequests: 14400, remainingRequests: 14370, limitTokens: 6000, remainingTokens: 5900,
    resetRequestsAt: 1_000_000 + 179_560, resetTokensAt: 1_000_000 + 7660,
  });
  assert.equal(parseRateLimitHeaders(new Headers({ 'content-type': 'x' }), 5), null);
  assert.equal(parseRateLimitHeaders(null, 5), null);
  assert.equal(parseRateLimitHeaders(new Headers({ 'x-ratelimit-limit-requests': 'abc' }), 5), null);
});

test('Groq summary uses the real remaining values (exact), and "limit reached" when remaining is 0', () => {
  const c = clock(at(2026, 10, 27, 11, 0));
  const u = new UsageTracker({ now: c.now });
  u.groqChat(new Headers({ 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '940', 'x-ratelimit-limit-tokens': '6000', 'x-ratelimit-remaining-tokens': '5000' }), true);
  u.groqChatTokens(321);
  let r = row(u.summary(flags), 'groqChat');
  assert.equal(r.source, 'provider');
  assert.equal(r.allowance, 1000);
  assert.equal(r.remaining, 940);
  assert.equal(r.used, 60);
  assert.equal(r.blocked, false);
  assert.match(r.detail, /5000 \/ 6000/);
  assert.match(r.detail, /321 tokens/);
  u.groqChat(new Headers({ 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '30m' }), false);
  r = row(u.summary(flags), 'groqChat');
  assert.equal(r.blocked, true);
  assert.equal(r.resetsAt, c.t + 30 * 60_000);
  // A day later the old snapshot is not trusted any more: counts only, no allowance.
  c.t += 25 * 3600_000;
  r = row(u.summary(flags), 'groqChat');
  assert.equal(r.source, 'estimate');
  assert.equal(r.allowance, null);
  assert.equal(r.blocked, false);
});

test('a failed Groq request updates the remaining quota but is not counted as used', () => {
  const u = new UsageTracker({ now: clock(at(2026, 10, 27)).now });
  u.groqStt(12, new Headers({ 'x-ratelimit-limit-requests': '2000', 'x-ratelimit-remaining-requests': '1999' }), true);
  u.groqStt(30, new Headers({ 'x-ratelimit-limit-requests': '2000', 'x-ratelimit-remaining-requests': '1999' }), false);
  const data = u.serialize();
  assert.equal(data.days['2026-10-27'].groqStt, 1);
  assert.equal(data.days['2026-10-27'].groqSttSeconds, 12);
});

test('chat payload tokens: usage.total_tokens or x_groq.usage.total_tokens', () => {
  assert.equal(tokensFromChatPayload({ usage: { total_tokens: 120 } }), 120);
  assert.equal(tokensFromChatPayload({ x_groq: { usage: { total_tokens: 45 } } }), 45);
  assert.equal(tokensFromChatPayload({ choices: [] }), 0);
  assert.equal(tokensFromChatPayload(null), 0);
});

test('audio seconds: exact for WAV headers, a rough guess for compressed audio', () => {
  const wav = Buffer.alloc(44 + 32000 * 3);
  wav.write('RIFF', 0); wav.writeUInt32LE(32000, 28);
  assert.equal(Math.round(estimateAudioSeconds(wav.toString('base64'), 'audio/wav')), 3);
  assert.ok(estimateAudioSeconds(Buffer.alloc(60000).toString('base64'), 'audio/webm') > 5);
  assert.equal(estimateAudioSeconds('', 'audio/wav'), 0);
});

// ---------- router: voice policy ----------

test("ttsQuality 'best': Gemini is used for a one-word reply; 'save' skips it", async () => {
  const bestFetch = fakeFetch({ gemini: geminiOk, google: googleOk });
  const best = new TtsRouter({ getKey: () => 'k', getPreferred: () => 'auto', getQuality: () => 'best', fetchFn: bestFetch });
  const a = await best.synthesize({ text: 'Haan', lang: 'hi' });
  assert.equal(a.provider, 'gemini');
  assert.equal(bestFetch.gemini(), 1);
  assert.equal(best.stats.skippedShort, 0);

  const defaultFetch = fakeFetch({ gemini: geminiOk, google: googleOk });
  const dflt = new TtsRouter({ getKey: () => 'k', getPreferred: () => 'auto', fetchFn: defaultFetch });
  assert.equal((await dflt.synthesize({ text: 'Ji', lang: 'hi' })).provider, 'gemini', 'no quality function = best');

  const saveFetch = fakeFetch({ gemini: geminiOk, google: googleOk });
  const save = new TtsRouter({ getKey: () => 'k', getPreferred: () => 'auto', getQuality: () => 'save', fetchFn: saveFetch });
  const b = await save.synthesize({ text: 'Haan', lang: 'hi' });
  assert.equal(b.provider, 'google');
  assert.equal(saveFetch.gemini(), 0);
  assert.equal(save.stats.skippedShort, 1);
  const longer = await save.synthesize({ text: 'Haan theek hai Sid', lang: 'hi' });
  assert.equal(longer.provider, 'gemini', 'longer replies still use Gemini under save');
});

test('router feeds the meter: counts Gemini calls, remembers a 429 across a restart, counts basic-voice fallbacks', async () => {
  const c = clock(at(2026, 10, 27, 15, 0));
  const meter = new UsageTracker({ now: c.now });
  let quota = false;
  const f = fakeFetch({ gemini: () => (quota ? new Response('{}', { status: 429, headers: { 'retry-after': '3600' } }) : geminiOk()), google: googleOk });
  const router = new TtsRouter({ getKey: () => 'k', getPreferred: () => 'auto', fetchFn: f, now: c.now, usage: meter });
  assert.equal((await router.synthesize({ text: 'Pehla jumla', lang: 'hi' })).provider, 'gemini');
  assert.equal(row(meter.summary(flags), 'geminiTts').used, 1);
  assert.equal(meter.summary(flags).basicVoiceToday, 0);

  quota = true;
  const limited = await router.synthesize({ text: 'Doosra jumla', lang: 'hi' });
  assert.equal(limited.provider, 'google', 'falls through to the basic voice');
  assert.equal(meter.geminiTtsBlockedUntil(), c.t + 3600_000);
  assert.equal(row(meter.summary(flags), 'geminiTts').used, 1, 'a refused call is not counted as used');
  assert.equal(meter.summary(flags).basicVoiceToday, 1);

  // A fresh router (app restart) with the reloaded meter does not even try Gemini while blocked.
  const calls = f.gemini();
  const restarted = new UsageTracker({ now: c.now, initial: meter.serialize() });
  const router2 = new TtsRouter({ getKey: () => 'k', getPreferred: () => 'auto', fetchFn: f, now: c.now, usage: restarted });
  assert.equal((await router2.synthesize({ text: 'Teesra jumla', lang: 'hi' })).provider, 'google');
  assert.equal(f.gemini(), calls);
  c.t += 3601_000;
  quota = false;
  assert.equal((await router2.synthesize({ text: 'Chautha jumla', lang: 'hi' })).provider, 'gemini');
  assert.equal(restarted.geminiTtsBlockedUntil(), 0);
});

test('forced Google voice is not a fallback; saving a key (resetBackoff) lifts the remembered block', async () => {
  const c = clock(at(2026, 10, 27));
  const meter = new UsageTracker({ now: c.now });
  const f = fakeFetch({ gemini: geminiOk, google: googleOk });
  const forced = new TtsRouter({ getKey: () => 'k', getPreferred: () => 'google', fetchFn: f, now: c.now, usage: meter });
  await forced.synthesize({ text: 'Sirf Google voice', lang: 'en' });
  assert.equal(meter.summary(flags).basicVoiceToday, 0);
  meter.geminiTtsLimit(c.t + 3600_000);
  const router = new TtsRouter({ getKey: () => 'k', getPreferred: () => 'auto', fetchFn: f, now: c.now, usage: meter });
  router.resetBackoff();
  assert.equal(meter.geminiTtsBlockedUntil(), 0);
});

test('Azure characters reach the meter through onChars', async () => {
  const seen = [];
  const azure = new AzureTtsProvider({
    getKey: () => 'a'.repeat(32), getRegion: () => 'eastus', getVoice: () => 'auto', getRomanRoute: () => 'hi',
    onChars: n => seen.push(n),
    fetchFn: async () => new Response(Buffer.alloc(400, 2), { status: 200 }),
  });
  const r = await azure.synthesize({ text: 'Hello there friend', lang: 'en' });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['Hello there friend'.length]);
  const failing = new AzureTtsProvider({
    getKey: () => 'a'.repeat(32), getRegion: () => 'eastus', getVoice: () => 'auto', getRomanRoute: () => 'hi',
    onChars: n => seen.push(n), fetchFn: async () => new Response('no', { status: 429 }),
  });
  assert.equal((await failing.synthesize({ text: 'Hello there friend', lang: 'en' })).ok, false);
  assert.equal(seen.length, 1, 'failed requests are not counted');
});

// ---------- STT + chat wiring ----------

test('STT router counts Gemini clips and Groq requests (with audio seconds) and keeps Groq headers', async () => {
  const c = clock(at(2026, 10, 27));
  const meter = new UsageTracker({ now: c.now });
  const wav = Buffer.alloc(44 + 32000 * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(32000, 28);
  const groqHeaders = new Headers({ 'x-ratelimit-limit-requests': '2000', 'x-ratelimit-remaining-requests': '1990' });
  const fetchStub = async url => String(url).includes('groq.com')
    ? { ok: true, status: 200, headers: groqHeaders, json: async () => ({ text: 'kya haal hai sudo' }) }
    : { ok: true, status: 200, headers: new Headers(), json: async () => ({ candidates: [{ content: { parts: [{ text: 'theek hai shukriya' }] } }] }) };
  const fast = new SttRouter({ fetch: fetchStub, getKey: id => (id === 'groq' || id === 'gemini' ? 'k' : ''), now: c.now, getMode: () => 'fast', usage: meter });
  const out = await fast.transcribe({ base64: wav.toString('base64'), mimeType: 'audio/wav', language: 'ur' });
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'whisper');
  let s = meter.summary(flags);
  assert.equal(row(s, 'groqStt').source, 'provider');
  assert.equal(row(s, 'groqStt').remaining, 1990);
  assert.equal(meter.serialize().days['2026-10-27'].groqStt, 1);
  assert.equal(Math.round(meter.serialize().days['2026-10-27'].groqSttSeconds), 2);

  const accurate = new SttRouter({ fetch: fetchStub, getKey: id => (id === 'gemini' ? 'k' : ''), now: c.now, getMode: () => 'accurate', usage: meter });
  assert.equal((await accurate.transcribe({ base64: wav.toString('base64'), mimeType: 'audio/wav', language: 'ur' })).provider, 'gemini');
  s = meter.summary(flags);
  assert.equal(row(s, 'geminiStt').used, 1);

  // A 429 from Gemini listening is shown as limit reached until the router's own pause ends.
  const limited = new SttRouter({ fetch: async () => ({ ok: false, status: 429, headers: new Headers(), json: async () => ({}) }), getKey: id => (id === 'gemini' ? 'k' : ''), now: c.now, getMode: () => 'accurate', usage: meter });
  await limited.transcribe({ base64: wav.toString('base64'), mimeType: 'audio/wav' });
  assert.equal(row(meter.summary(flags), 'geminiStt').blocked, true);
  assert.equal(row(meter.summary(flags), 'geminiStt').resetsAt, c.t + 60_000);
});

test('Groq chat: headers, request count and streamed token usage reach the meter; other providers do not', async () => {
  const meter = new UsageTracker({ now: clock(at(2026, 10, 27)).now });
  const sseWithUsage = () => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'Salam!' } }] })}\n\ndata: ${JSON.stringify({ choices: [], x_groq: { usage: { total_tokens: 77 } } })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream', 'x-ratelimit-limit-requests': '14400', 'x-ratelimit-remaining-requests': '14399' } },
  );
  const ai = new LocalAI(async () => sseWithUsage());
  ai.usage = meter;
  const cloud = { provider: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.1-8b-instant', apiKey: 'gsk_test' };
  const out = [];
  await ai.stream('', [{ role: 'user', content: 'hi' }], new AbortController().signal, t => out.push(t), { mode: 'cloud', cloud });
  assert.deepEqual(out, ['Salam!']);
  const data = meter.serialize();
  assert.equal(data.days['2026-10-27'].groqChat, 1);
  assert.equal(data.days['2026-10-27'].groqChatTokens, 77);
  assert.equal(data.groqChat.remainingRequests, 14399);

  const other = new LocalAI(async () => sseWithUsage());
  const meter2 = new UsageTracker({ now: clock(at(2026, 10, 27)).now });
  other.usage = meter2;
  await other.stream('', [{ role: 'user', content: 'hi' }], new AbortController().signal, () => {}, { mode: 'cloud', cloud: { ...cloud, provider: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions' } });
  assert.deepEqual(meter2.serialize().days, {});
});

test('Groq tool-loop (non-streaming) responses are counted with their token usage', async () => {
  const meter = new UsageTracker({ now: clock(at(2026, 10, 27)).now });
  const ai = new LocalAI(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Aap ka OS linux hai.' } }], usage: { total_tokens: 210 } }), {
    status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '998' },
  }));
  ai.usage = meter;
  const tools = { definitions: [{ type: 'function', function: { name: 'x', description: 'x', parameters: { type: 'object', properties: {} } } }], execute: async () => 'ok' };
  const cloud = { provider: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'm', apiKey: 'gsk_test' };
  const out = [];
  await ai.stream('', [{ role: 'user', content: 'hi' }], new AbortController().signal, t => out.push(t), { mode: 'cloud', cloud, tools });
  assert.deepEqual(out, ['Aap ka OS linux hai.']);
  await new Promise(resolve => setTimeout(resolve, 20));
  const data = meter.serialize();
  assert.equal(data.days['2026-10-27'].groqChat, 1);
  assert.equal(data.days['2026-10-27'].groqChatTokens, 210);
});

test('Groq screenshot (vision) turns are counted too, using the global fetch as before', async () => {
  const meter = new UsageTracker({ now: clock(at(2026, 10, 27)).now });
  const ai = new LocalAI(async () => { throw new Error('unused'); });
  ai.usage = meter;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Screen par terminal hai.' } }] }), {
    status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-limit-requests': '500', 'x-ratelimit-remaining-requests': '499' },
  });
  try {
    const target = { provider: 'groq', model: 'm', endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKey: 'gsk_test' };
    const out = [];
    await ai.stream('', [{ role: 'user', content: 'screen par kya hai' }], new AbortController().signal, t => out.push(t), {
      mode: 'cloud', cloud: { provider: 'groq', endpoint: target.endpoint, model: 'm', apiKey: 'gsk_test' },
      vision: { dataUri: 'data:image/png;base64,AAAA', targets: [target], fallbackText: 'f' },
    });
    assert.deepEqual(out, ['Screen par terminal hai.']);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(meter.serialize().days['2026-10-27'].groqChat, 1);
  assert.equal(meter.serialize().groqChat.remainingRequests, 499);
});

// ---------- file + privacy ----------

test('UsageFile: debounced atomic write, survives garbage, and nothing but counters is on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-meter-'));
  try {
    const file = new UsageFile(join(dir, 'usage.json'), 15);
    assert.equal(file.read(), undefined, 'missing file starts from zero');
    const meter = new UsageTracker({ now: clock(at(2026, 10, 27)).now, onChange: () => file.schedule(() => meter.serialize()) });
    const router = new TtsRouter({ getKey: () => 'AIzaSECRETKEY123', getPreferred: () => 'auto', fetchFn: fakeFetch({ gemini: geminiOk, google: googleOk }), usage: meter });
    for (let i = 0; i < 5; i++) await router.synthesize({ text: `Jumla number ${i}`, lang: 'hi' });
    assert.equal(existsSync(join(dir, 'usage.json')), false, 'not written immediately');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(readdirSync(dir), ['usage.json'], 'no leftover temp file');
    const text = readFileSync(join(dir, 'usage.json'), 'utf8');
    assert.equal(/AIza|SECRET|gsk_|Bearer/.test(text), false);
    assert.equal(JSON.parse(text).days['2026-10-27'].geminiTts, 5);
    assert.equal(new UsageTracker({ initial: file.read(), now: clock(at(2026, 10, 27)).now }).serialize().days['2026-10-27'].geminiTts, 5);
    // flush() writes a pending change immediately (used on quit).
    meter.googleFallback();
    file.flush();
    assert.equal(JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')).days['2026-10-27'].googleFallback, 1);
    // A damaged file does not crash the app.
    rmSync(join(dir, 'usage.json'));
    const broken = new UsageFile(join(dir, 'usage.json'));
    broken.schedule(() => ({ ok: true }));
    broken.flush();
    assert.deepEqual(broken.read(), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the summary the window receives is plain data with no key anywhere', async () => {
  const meter = new UsageTracker({ now: clock(at(2026, 10, 27)).now });
  const router = new TtsRouter({ getKey: () => 'AIzaSECRETKEY123', getPreferred: () => 'auto', fetchFn: fakeFetch({ gemini: geminiOk, google: googleOk }), usage: meter });
  await router.synthesize({ text: 'Salam Sid', lang: 'hi' });
  meter.groqChat(new Headers({ 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '9' }), true);
  const wire = JSON.stringify(meter.summary(flags));
  assert.equal(/AIza|SECRET|gsk_|Bearer|apiKey/i.test(wire), false);
  assert.deepEqual(JSON.parse(wire).rows.map(r => r.id), ['geminiTts', 'geminiStt', 'groqStt', 'groqChat', 'azureTts']);
});

// ---------- settings + wiring ----------

test("ttsQuality setting: default 'best', validated like the other settings", () => {
  assert.equal(DEFAULT_SETTINGS.ttsQuality, 'best');
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, ttsQuality: 'best' }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, ttsQuality: 'save' }), true);
  const { ttsQuality, ...legacy } = DEFAULT_SETTINGS;
  assert.equal(validSettings(legacy), true, 'settings saved before this feature still load');
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, ttsQuality: 'cheap' }), false);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, ttsQuality: 1 }), false);
});

test('wiring: usage channel is guarded for settings + chat, exposed by preload, shown in Settings and Chat', () => {
  const index = read('../src/main/index.ts');
  const preload = read('../src/preload/index.ts');
  const types = read('../src/shared/types.ts');
  const app = read('../src/renderer/App.tsx');
  const panel = read('../src/renderer/UsageSettings.tsx');
  assert.match(types, /usage: 'companion:usage'/);
  assert.match(types, /getUsage\(\): Promise<UsageSummary>/);
  assert.match(preload, /getUsage: \(\) => ipcRenderer\.invoke\(CHANNELS\.usage\)/);
  const handler = index.slice(index.indexOf('handle(CHANNELS.usage'), index.indexOf('handle(CHANNELS.azureGet'));
  assert.match(handler, /\['settings', 'chat'\]\);\s*$/);
  assert.match(index, /getQuality: \(\) => state\.settings\.ttsQuality/);
  assert.match(index, /usageFile\?\.flush\(\)/);
  assert.match(index, /new UsageFile\(join\(app\.getPath\('userData'\), 'usage\.json'\)\)/);
  assert.equal(/config\.json/.test(read('../src/main/usage-store.ts')), false, 'the meter does not share config.json');
  assert.match(app, /<UsageSettings settings=\{settings\} setSettings=\{setSettings\}\/>/);
  assert.match(app, /Realistic voice limit reached today - using basic voice until/);
  const note = app.indexOf('Realistic voice limit reached today');
  assert.ok(note > app.indexOf('function Chat(') && note < app.indexOf('function SettingsView('), 'the notice lives in the Chat window only');
  assert.equal(app.split('Realistic voice limit reached today').length, 2, 'and nowhere else (the overlay stays free of it)');
  assert.match(panel, /Free usage/);
  assert.match(panel, /Best voice while free quota lasts/);
  assert.match(panel, /Save quota/);
  assert.match(panel, /Limit reached - resets at/);
  assert.match(panel, /'estimate'/);
});
