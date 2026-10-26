import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioCache, TtsRouter, GoogleTranslateTtsProvider, quotaBackoffMs, buildGeminiPrompt } from '../src/main/tts-provider.ts';
import { chunkForGoogle, groupForSynthesis, normalizeForSpeech, worthGemini, emotionStyle } from '../src/shared/speech.ts';
import { dataUriToBytes } from '../src/shared/audio-data.ts';

const pcm = Buffer.alloc(4800, 1);
const geminiOk = () => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }],
}), { status: 200 });
const googleOk = () => new Response(Buffer.from('ID3fake'), { status: 200 });
function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    return (u.includes('generativelanguage') ? handlers.gemini : handlers.google)(u);
  };
  fn.calls = calls;
  fn.gemini = () => calls.filter(c => c.url.includes('generativelanguage')).length;
  fn.google = () => calls.filter(c => c.url.includes('translate_tts')).length;
  return fn;
}

test('data URIs decode to bytes without fetch (the renderer CSP blocks fetch of data: URLs)', () => {
  const bytes = dataUriToBytes('data:audio/mp3;base64,' + Buffer.from('hello').toString('base64'));
  assert.equal(Buffer.from(bytes).toString(), 'hello');
  assert.equal(dataUriToBytes('not a data uri'), null);
  assert.equal(dataUriToBytes('data:audio/wav;base64,@@@'), null);
});

test('worthGemini skips 1-2 word replies', () => {
  assert.equal(worthGemini('Haan'), false);
  assert.equal(worthGemini('Theek hai'), false);
  assert.equal(worthGemini('Haan theek hai'), true);
});

test('router does not spend a Gemini call on 1-2 word replies, and says so in stats', async () => {
  const f = fakeFetch({ gemini: geminiOk, google: googleOk });
  const router = new TtsRouter({ getKey: () => 'k', getPreferred: () => 'gemini', fetchFn: f });
  const r = await router.synthesize({ text: 'Theek hai', lang: 'hi' });
  assert.equal(r.provider, 'google');
  assert.equal(f.gemini(), 0);
  assert.equal(router.stats.skippedShort, 1);
});

test('identical requests are served from the cache (no second network call)', async () => {
  const f = fakeFetch({ gemini: geminiOk, google: googleOk });
  const router = new TtsRouter({ getKey: () => 'k', getPreferred: () => 'gemini', fetchFn: f });
  const req = { text: 'Assalam o alaikum Sid', lang: 'hi', voice: 'Kore', style: 'warm' };
  const a = await router.synthesize(req);
  const b = await router.synthesize(req);
  assert.equal(a.provider, 'gemini');
  assert.equal(b.cached, true);
  assert.equal(f.gemini(), 1);
  assert.equal(router.stats.cacheHits, 1);
  const other = await router.synthesize({ ...req, voice: 'Puck' });
  assert.equal(other.cached, undefined, 'a different voice is a different clip');
  assert.equal(f.gemini(), 2);
});

test('a cached Gemini clip is still served while Gemini is in quota back-off', async () => {
  let t = 0;
  let quota = false;
  const f = fakeFetch({ gemini: () => (quota ? new Response('{}', { status: 429, headers: { 'retry-after': '120' } }) : geminiOk()), google: googleOk });
  const router = new TtsRouter({ getKey: () => 'k', getPreferred: () => 'gemini', fetchFn: f, now: () => t });
  const cachedReq = { text: 'Main yahin hoon Sid', lang: 'hi' };
  await router.synthesize(cachedReq);
  quota = true;
  const fresh = await router.synthesize({ text: 'Ek naya jumla yahan', lang: 'hi' });
  assert.equal(fresh.provider, 'google');
  const again = await router.synthesize(cachedReq);
  assert.equal(again.provider, 'gemini');
  assert.equal(again.cached, true);
  t += 119_000;
  await router.synthesize({ text: 'Teesra naya jumla yahan', lang: 'hi' });
  assert.equal(f.gemini(), 2, 'still inside the 120 s Retry-After window');
  t += 2_000;
  await router.synthesize({ text: 'Chautha naya jumla yahan', lang: 'hi' });
  assert.equal(f.gemini(), 3, 'retried once the Retry-After has passed');
});

test('quota back-off honours Retry-After, retryDelay and per-day quotas', () => {
  assert.equal(quotaBackoffMs('30', ''), 30_000);
  assert.equal(quotaBackoffMs(null, '{"retryDelay": "34s"}'), 34_000);
  assert.equal(quotaBackoffMs(null, 'plain'), 60_000);
  assert.equal(quotaBackoffMs(null, 'Quota exceeded ... GenerateRequestsPerDayPerProjectPerModel'), 30 * 60_000);
  assert.equal(quotaBackoffMs('999999', ''), 24 * 60 * 60_000);
  assert.equal(quotaBackoffMs(null, 'You exceeded your quota. Please retry in 7h11m31.9s.'), (7 * 3600 + 11 * 60 + 31.9) * 1000);
  assert.equal(quotaBackoffMs(null, 'Please retry in 45s'), 45_000);
});

test('AudioCache is an LRU bounded by bytes', () => {
  const c = new AudioCache(25);
  c.set('a', '1234567890');
  c.set('b', '1234567890');
  c.get('a');
  c.set('c', '1234567890');
  assert.equal(c.get('b'), undefined, 'least recently used entry evicted');
  assert.ok(c.get('a') && c.get('c'));
  c.set('huge', 'x'.repeat(100));
  assert.equal(c.get('huge'), undefined, 'entries larger than the cap are not stored');
});

test('groupForSynthesis: first sentence alone, then same-emotion sentences batched up to the limit', () => {
  const s = (text, emotion = 'warm') => ({ text, emotion });
  const groups = groupForSynthesis([s('One one one.'), s('Two two two.'), s('Three three.'), s('Four four.', 'excited'), s('Five five.', 'excited')], 250);
  assert.deepEqual(groups.map(g => g.text), ['One one one.', 'Two two two. Three three.', 'Four four. Five five.']);
  const long = Array.from({ length: 6 }, (_, i) => s('x'.repeat(100) + i));
  const grouped = groupForSynthesis(long, 250);
  assert.ok(grouped.every(g => g.text.length <= 250));
  assert.ok(grouped.length < long.length, 'fewer requests than sentences');
  assert.equal(groupForSynthesis([], 250).length, 0);
});

test('chunkForGoogle cuts at sentence ends, then commas, then spaces, never mid-word', () => {
  const text = 'Pehla jumla yahan hai, aur isme kuch alfaaz hain. Doosra jumla bhi kaafi lamba hai, lekin theek hai; tisra hissa yahan se shuru hota hai aur khatam hota hai.';
  const chunks = chunkForGoogle(text, 80);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every(c => c.length <= 80), JSON.stringify(chunks));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text);
  assert.ok(chunks[0].endsWith('.'), 'first cut at the sentence end');
  assert.deepEqual(chunkForGoogle('short', 180), ['short']);
  const noSpaces = chunkForGoogle('a'.repeat(400), 180);
  assert.ok(noSpaces.every(c => c.length <= 180));
});

test('normalizeForSpeech makes symbols, abbreviations and punctuation speakable', () => {
  assert.equal(normalizeForSpeech('RAM 59% hai... theek (shayad)!!!'), 'ram 59 percent hai, theek, shayad,!');
  assert.match(normalizeForSpeech('Tom & Jerry, e.g. cartoons'), /Tom and Jerry, for example, cartoons/);
  assert.match(normalizeForSpeech('wait — what'), /wait, what/);
  assert.equal(normalizeForSpeech('  a   b  '), 'a b');
});

test('Google provider joins chunks in order and runs them in parallel', async () => {
  const f = fakeFetch({ gemini: geminiOk, google: u => new Response(Buffer.from('[' + decodeURIComponent(/q=([^&]*)/.exec(u)[1]).slice(0, 4) + ']'), { status: 200 }) });
  const p = new GoogleTranslateTtsProvider(f);
  const text = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega. Second sentence is here and it is long enough to need another chunk to be fetched.';
  const r = await p.synthesize({ text, lang: 'en' });
  assert.equal(r.ok, true);
  assert.equal(r.calls, f.google());
  assert.ok(r.calls >= 2);
  const body = Buffer.from(r.dataUri.split('base64,')[1], 'base64').toString();
  assert.match(body, /^\[Alph\]\[/);
});

test('Google provider fails as a whole if any chunk fails (no half sentences)', async () => {
  let n = 0;
  const f = fakeFetch({ gemini: geminiOk, google: () => (++n === 2 ? new Response('no', { status: 500 }) : googleOk()) });
  const r = await new GoogleTranslateTtsProvider(f).synthesize({ text: 'a '.repeat(150), lang: 'en' });
  assert.equal(r.ok, false);
});

test('Gemini style prompt asks for breath, pauses and natural Pakistani Urdu', () => {
  const urdu = buildGeminiPrompt({ text: 'Kaise ho', lang: 'hi', style: emotionStyle('warm', 'hi') });
  assert.match(urdu, /breath/);
  assert.match(urdu, /pause/);
  assert.match(urdu, /Pakistani Urdu/);
  assert.match(urdu, /Roman/);
  assert.doesNotMatch(buildGeminiPrompt({ text: 'Hi', lang: 'en', style: emotionStyle('warm', 'en') }), /Pakistani/);
});

test('calls per reply: a six-sentence reply costs 2 Gemini calls instead of 6', async () => {
  const f = fakeFetch({ gemini: geminiOk, google: googleOk });
  const router = new TtsRouter({ getKey: () => 'k', getPreferred: () => 'gemini', fetchFn: f });
  const sentences = Array.from({ length: 6 }, (_, i) => ({ text: `Yeh jumla number ${i + 1} hai aur theek hai.`, emotion: 'warm' }));
  const groups = groupForSynthesis(sentences, 250);
  for (const g of groups) await router.synthesize({ text: g.text, lang: 'hi' });
  assert.equal(groups.length, 2);
  assert.equal(f.gemini(), 2);
});
