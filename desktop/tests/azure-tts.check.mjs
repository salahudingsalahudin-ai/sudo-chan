import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AZURE_VOICES, addPauses, azureBackoffMs, azureEndpoint, buildAzureSsml, escapeXml, expressStyle,
  isAzureVoice, pickAzureVoice, prosodyFor, validAzureKey, validAzureRegion,
} from '../src/shared/azure-tts.ts';
import { AzureTtsProvider } from '../src/main/azure-provider.ts';
import { TtsRouter } from '../src/main/tts-provider.ts';
import { migrateProviders, resolveProviderKey, withProviderEntry } from '../src/main/provider-keys.ts';
import { DEFAULT_SETTINGS, validSettings } from '../src/shared/validation.ts';

const KEY = 'AZKEY0123456789abcdefABCDEF012345';
const audio = () => new Response(Buffer.alloc(600, 7), { status: 200 });

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes('.tts.speech.microsoft.com')) return handlers.azure(calls.filter(c => c.url.includes('.tts.speech')).length);
    if (u.includes('generativelanguage')) return handlers.gemini();
    return handlers.google();
  };
  fn.calls = calls;
  return fn;
}
const azureCalls = f => f.calls.filter(c => c.url.includes('.tts.speech.microsoft.com'));
const geminiOk = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.alloc(4800, 1).toString('base64') } }] } }] }), { status: 200 });
const gemini429 = () => new Response('{"error":{"message":"quota per day"}}', { status: 429 });
const googleOk = () => new Response(Buffer.from('ID3google'), { status: 200 });

function provider(f, over = {}) {
  return new AzureTtsProvider({
    getKey: () => over.key ?? KEY,
    getRegion: () => over.region ?? 'eastus',
    getVoice: () => over.voice ?? 'auto',
    getRomanRoute: () => over.route ?? 'hi',
    fetchFn: f,
  });
}

test('voice catalog, region and key validation', () => {
  assert.equal(AZURE_VOICES.length, 8);
  assert.ok(isAzureVoice('ur-PK-UzmaNeural'));
  assert.ok(!isAzureVoice('ur-PK-Evil"><x/>'));
  assert.ok(validAzureRegion('eastus') && validAzureRegion('uaenorth') && validAzureRegion('westus2'));
  assert.ok(!validAzureRegion('') && !validAzureRegion('East US') && !validAzureRegion('a/b') && !validAzureRegion('x'.repeat(40)));
  assert.ok(validAzureKey(KEY));
  assert.ok(!validAzureKey('short') && !validAzureKey('has space in it 0123456789') && !validAzureKey(12345));
  assert.equal(azureEndpoint('uaenorth'), 'https://uaenorth.tts.speech.microsoft.com/cognitiveservices/v1');
});

test('auto voice routing by language and Roman Urdu route', () => {
  assert.equal(pickAzureVoice('en', 'auto'), 'en-US-AriaNeural');
  assert.equal(pickAzureVoice('ur', 'auto'), 'ur-PK-UzmaNeural');
  assert.equal(pickAzureVoice('hi', 'auto'), 'hi-IN-SwaraNeural');
  assert.equal(pickAzureVoice('hi', 'auto', 'ur'), 'ur-PK-UzmaNeural');
  assert.equal(pickAzureVoice('hi', undefined), 'hi-IN-SwaraNeural');
});

test('an explicit voice is used only for text it can speak', () => {
  assert.equal(pickAzureVoice('ur', 'ur-PK-AsadNeural'), 'ur-PK-AsadNeural');
  assert.equal(pickAzureVoice('hi', 'hi-IN-MadhurNeural'), 'hi-IN-MadhurNeural');
  assert.equal(pickAzureVoice('hi', 'ur-PK-AsadNeural'), 'ur-PK-AsadNeural', 'Urdu voice for Roman Urdu text when chosen');
  assert.equal(pickAzureVoice('en', 'en-US-AndrewNeural'), 'en-US-AndrewNeural');
  assert.equal(pickAzureVoice('en', 'ur-PK-AsadNeural'), 'en-US-AriaNeural', 'Urdu voice must not read English');
  assert.equal(pickAzureVoice('ur', 'en-US-AndrewNeural'), 'ur-PK-UzmaNeural', 'English voice must not read Urdu');
  assert.equal(pickAzureVoice('en', 'not-a-voice'), 'en-US-AriaNeural');
});

test('SSML escaping stops markup injection', () => {
  assert.equal(escapeXml(`a & b < c > "d" 'e'`), 'a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
  const ssml = buildAzureSsml({ text: 'x</voice><voice name="evil">y & z', voice: 'en-US-AriaNeural' });
  assert.ok(!ssml.includes('<voice name="evil">'));
  assert.ok(ssml.includes('&lt;/voice&gt;'));
  assert.ok(ssml.includes('&amp;'));
  assert.throws(() => buildAzureSsml({ text: 'hi', voice: `en-US-AriaNeural'><x` }), /unsupported Azure voice/);
});

test('SSML structure: language, namespaces, prosody per emotion, pauses', () => {
  const ssml = buildAzureSsml({ text: 'Hello there, friend. How are you?', voice: 'en-US-JennyNeural', emotion: 'excited' });
  assert.match(ssml, /^<speak version='1\.0' xml:lang='en-US' xmlns='http:\/\/www\.w3\.org\/2001\/10\/synthesis' xmlns:mstts='https:\/\/www\.w3\.org\/2001\/mstts'>/);
  assert.match(ssml, /<voice name='en-US-JennyNeural'>/);
  assert.match(ssml, /<mstts:express-as style="excited">/);
  assert.match(ssml, /<prosody rate="\+8%" pitch="\+5%" volume="medium">/);
  assert.match(ssml, /there,<break time="120ms"\/> friend\.<break time="320ms"\/> How are you\?/);
  assert.ok(ssml.endsWith('</voice></speak>'));
});

test('express-as only for voices that document styles; neutral urdu voice gets plain prosody', () => {
  assert.equal(expressStyle('en-US-AriaNeural', 'warm'), 'friendly');
  assert.equal(expressStyle('en-US-AriaNeural', 'soft'), 'empathetic');
  assert.equal(expressStyle('ur-PK-UzmaNeural', 'warm'), undefined);
  assert.equal(expressStyle('en-US-AvaNeural', 'happy'), undefined);
  const urdu = buildAzureSsml({ text: 'Aap kaise hain?', voice: 'ur-PK-UzmaNeural', emotion: 'warm' });
  assert.ok(!urdu.includes('express-as'));
  assert.match(urdu, /xml:lang='ur-PK'/);
  const noStyle = buildAzureSsml({ text: 'Hi', voice: 'en-US-AriaNeural', emotion: 'warm', useStyle: false });
  assert.ok(!noStyle.includes('express-as'));
  const plain = buildAzureSsml({ text: 'Hi', voice: 'en-US-AvaNeural' });
  assert.ok(!plain.includes('<prosody'), 'neutral at normal speed needs no prosody tag');
});

test('speed changes the rate and everything stays in range', () => {
  assert.deepEqual(prosodyFor('neutral', 1.2), { rate: '+20%', pitch: '+0%', volume: 'default' });
  assert.equal(prosodyFor('calm', 0.8).rate, '-30%');
  assert.equal(prosodyFor('excited', 5).rate, '+60%');
  assert.equal(prosodyFor('calm', 0.1).rate, '-40%');
  assert.equal(prosodyFor('warm', undefined).rate, '-3%');
  assert.equal(addPauses('a, b'), 'a,<break time="120ms"/> b');
  assert.equal(addPauses('Khatam۔ Phir'), 'Khatam۔<break time="320ms"/> Phir');
});

test('back-off by status', () => {
  assert.equal(azureBackoffMs(401), 600_000);
  assert.equal(azureBackoffMs(403), 600_000);
  assert.equal(azureBackoffMs(429, '12'), 12_000);
  assert.equal(azureBackoffMs(429), 30_000);
  assert.equal(azureBackoffMs(429, '999999'), 3_600_000);
  assert.equal(azureBackoffMs(503), 30_000);
  assert.equal(azureBackoffMs(400), 60_000);
  assert.equal(azureBackoffMs(undefined), 20_000);
});

test('request shape: region URL, key only in a header, SSML body, mp3 data URI', async () => {
  const f = fakeFetch({ azure: audio });
  const p = provider(f, { region: 'uaenorth' });
  const r = await p.synthesize({ text: 'Hello & welcome', lang: 'en', emotion: 'warm' });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'azure');
  assert.equal(r.voice, 'en-US-AriaNeural');
  assert.match(r.dataUri, /^data:audio\/mp3;base64,/);
  const [call] = azureCalls(f);
  assert.equal(call.url, 'https://uaenorth.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Ocp-Apim-Subscription-Key'], KEY);
  assert.equal(call.init.headers['Content-Type'], 'application/ssml+xml');
  assert.equal(call.init.headers['X-Microsoft-OutputFormat'], 'audio-24khz-48kbitrate-mono-mp3');
  assert.ok(call.init.headers['User-Agent']);
  assert.ok(!call.url.includes(KEY), 'key must not be in the URL');
  assert.ok(!String(call.init.body).includes(KEY), 'key must not be in the body');
  assert.match(String(call.init.body), /Hello and welcome/, "normalizeForSpeech turns & into and before SSML");
});

test('Roman Urdu follows the route setting and char counter counts successes only', async () => {
  const f = fakeFetch({ azure: audio });
  await provider(f, { route: 'hi' }).synthesize({ text: 'Aap kaise hain', lang: 'hi' });
  await provider(f, { route: 'ur' }).synthesize({ text: 'Aap kaise hain', lang: 'hi' });
  assert.match(String(azureCalls(f)[0].init.body), /name='hi-IN-SwaraNeural'/);
  assert.match(String(azureCalls(f)[1].init.body), /name='ur-PK-UzmaNeural'/);
  const f2 = fakeFetch({ azure: n => (n === 1 ? new Response('', { status: 500 }) : audio()) });
  const p = provider(f2);
  await p.synthesize({ text: 'twelve chars', lang: 'en' });
  assert.equal(p.charsUsed, 0, 'a failed request is not counted');
  await p.synthesize({ text: 'twelve chars', lang: 'en' });
  assert.equal(p.charsUsed, 12);
});

test('HTTP 400 retries once without express-as', async () => {
  const f = fakeFetch({ azure: n => (n === 1 ? new Response('bad style', { status: 400 }) : audio()) });
  const r = await provider(f).synthesize({ text: 'Hello friend', lang: 'en', emotion: 'warm' });
  assert.equal(r.ok, true);
  const bodies = azureCalls(f).map(c => String(c.init.body));
  assert.equal(bodies.length, 2);
  assert.match(bodies[0], /express-as/);
  assert.doesNotMatch(bodies[1], /express-as/);
});

test('401, 429, 5xx, timeout, tiny audio and missing key', async () => {
  const bad = await provider(fakeFetch({ azure: () => new Response('denied', { status: 401 }) })).synthesize({ text: 'Hello', lang: 'en' });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
  assert.equal(bad.retryAfterMs, 600_000);
  assert.ok(!JSON.stringify(bad).includes(KEY));

  const limited = await provider(fakeFetch({ azure: () => new Response('', { status: 429, headers: { 'retry-after': '7' } }) })).synthesize({ text: 'Hello', lang: 'en' });
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfterMs, 7000);

  const down = await provider(fakeFetch({ azure: () => new Response('', { status: 503 }) })).synthesize({ text: 'Hello', lang: 'en' });
  assert.equal(down.retryAfterMs, 30_000);

  const slow = provider(async () => { const e = new Error('The operation was aborted'); e.name = 'TimeoutError'; throw e; });
  const timedOut = await slow.synthesize({ text: 'Hello', lang: 'en' });
  assert.equal(timedOut.ok, false);
  assert.equal(slow.lastError, 'Azure timed out.');

  const tiny = await provider(fakeFetch({ azure: () => new Response(Buffer.alloc(10), { status: 200 }) })).synthesize({ text: 'Hello', lang: 'en' });
  assert.equal(tiny.ok, false);

  let called = 0;
  const none = provider(async () => { called++; return audio(); }, { key: '' });
  assert.equal((await none.synthesize({ text: 'Hello', lang: 'en' })).error, 'no-key');
  assert.equal(none.hasKey(), false);
  const noRegion = provider(async () => { called++; return audio(); }, { region: '' });
  assert.equal(noRegion.hasKey(), false);
  assert.equal((await noRegion.synthesize({ text: 'Hello', lang: 'en' })).error, 'no-key');
  assert.equal(called, 0, 'no network call without key and region');
});

test('auto chain: Gemini, then Azure, then Google', async () => {
  const f = fakeFetch({ gemini: gemini429, azure: audio, google: googleOk });
  const router = new TtsRouter({ getKey: () => 'gk', getPreferred: () => 'auto', fetchFn: f, azure: provider(f) });
  const first = await router.synthesize({ text: 'Assalam o alaikum kaise ho', lang: 'hi', emotion: 'warm' });
  assert.equal(first.provider, 'azure', 'Gemini 429 falls to Azure');
  assert.equal(f.calls[0].url.includes('generativelanguage'), true);
  assert.equal(router.stats.geminiCalls, 1);
  assert.equal(router.stats.azureCalls, 1);

  const g = fakeFetch({ gemini: geminiOk, azure: audio, google: googleOk });
  const okRouter = new TtsRouter({ getKey: () => 'gk', getPreferred: () => undefined, fetchFn: g, azure: provider(g) });
  const gem = await okRouter.synthesize({ text: 'This works with Gemini today', lang: 'en' });
  assert.equal(gem.provider, 'gemini');
  assert.equal(azureCalls(g).length, 0);
});

test('forced engines and missing keys', async () => {
  const f = fakeFetch({ gemini: geminiOk, azure: audio, google: googleOk });
  const azureOnly = new TtsRouter({ getKey: () => 'gk', getPreferred: () => 'azure', fetchFn: f, azure: provider(f) });
  assert.equal((await azureOnly.synthesize({ text: 'Only Azure speaks now', lang: 'en' })).provider, 'azure');
  assert.equal(f.calls.some(c => c.url.includes('generativelanguage')), false);

  const g = fakeFetch({ gemini: gemini429, azure: audio, google: googleOk });
  const geminiOnly = new TtsRouter({ getKey: () => 'gk', getPreferred: () => 'gemini', fetchFn: g, azure: provider(g) });
  const viaGoogle = await geminiOnly.synthesize({ text: 'Gemini forced but out of quota', lang: 'en' });
  assert.equal(viaGoogle.provider, 'google');
  assert.equal(azureCalls(g).length, 0, 'forced Gemini never uses Azure');

  const h = fakeFetch({ gemini: gemini429, azure: audio, google: googleOk });
  const noAzureKey = new TtsRouter({ getKey: () => '', getPreferred: () => 'auto', fetchFn: h, azure: provider(h, { key: '' }) });
  assert.equal((await noAzureKey.synthesize({ text: 'No keys anywhere here', lang: 'en' })).provider, 'google');
  assert.equal(h.calls.length, 1);

  const googleOnly = new TtsRouter({ getKey: () => 'gk', getPreferred: () => 'google', fetchFn: h, azure: provider(h) });
  assert.equal((await googleOnly.synthesize({ text: 'Google only please', lang: 'en' })).provider, 'google');
});

test('Azure failure backs off to Google, cache serves repeats, reset clears the back-off', async () => {
  let t = 1_000_000;
  let azureBroken = true;
  const f = fakeFetch({ gemini: gemini429, azure: () => (azureBroken ? new Response('', { status: 401 }) : audio()), google: googleOk });
  const router = new TtsRouter({ getKey: () => '', getPreferred: () => 'azure', fetchFn: f, azure: provider(f), now: () => t });
  const a = await router.synthesize({ text: 'Back off test sentence', lang: 'en' });
  assert.equal(a.provider, 'google');
  assert.ok(router.azureBackoffRemainingMs() > 0);
  const callsAfterFirst = azureCalls(f).length;
  await router.synthesize({ text: 'Another sentence during back off', lang: 'en' });
  assert.equal(azureCalls(f).length, callsAfterFirst, 'no Azure request while backed off');

  azureBroken = false;
  router.resetBackoff();
  assert.equal(router.azureBackoffRemainingMs(), 0);
  const b = await router.synthesize({ text: 'Azure works again now', lang: 'en' });
  assert.equal(b.provider, 'azure');
  const before = azureCalls(f).length;
  const again = await router.synthesize({ text: 'Azure works again now', lang: 'en' });
  assert.equal(again.cached, true);
  assert.equal(azureCalls(f).length, before, 'repeat served from cache');

  azureBroken = true;
  t += 3_000_000;
  await router.synthesize({ text: 'Something new to break', lang: 'en' });
  const cachedWhileDown = await router.synthesize({ text: 'Azure works again now', lang: 'en' });
  assert.equal(cachedWhileDown.provider, 'azure');
  assert.equal(cachedWhileDown.cached, true, 'cached Azure clip is free even during back-off');
});

test('cache key includes the Azure voice setting', async () => {
  let voice = 'auto';
  const f = fakeFetch({ azure: audio });
  const p = new AzureTtsProvider({ getKey: () => KEY, getRegion: () => 'eastus', getVoice: () => voice, getRomanRoute: () => 'hi', fetchFn: f });
  const router = new TtsRouter({ getKey: () => '', getPreferred: () => 'azure', fetchFn: f, azure: p });
  await router.synthesize({ text: 'Same words again', lang: 'ur' });
  voice = 'ur-PK-AsadNeural';
  await router.synthesize({ text: 'Same words again', lang: 'ur' });
  assert.equal(azureCalls(f).length, 2, 'a different voice must not reuse the old clip');
  assert.match(String(azureCalls(f)[1].init.body), /ur-PK-AsadNeural/);
});

test('settings validation for Azure fields and the auto engine', () => {
  assert.equal(DEFAULT_SETTINGS.ttsProvider, 'auto');
  assert.equal(DEFAULT_SETTINGS.ttsAzureVoice, 'auto');
  assert.equal(DEFAULT_SETTINGS.ttsAzureRomanUrdu, 'hi');
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, ttsProvider: 'azure' }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, ttsProvider: 'auto' }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, ttsAzureVoice: 'ur-PK-AsadNeural' }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, ttsAzureVoice: 'made-up' }), false);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, ttsAzureVoice: 5 }), false);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, ttsAzureRomanUrdu: 'ur' }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, ttsAzureRomanUrdu: 'en' }), false);
});

test('provider keys keep the Azure region and never fall back to the chat provider key', () => {
  const codec = { encrypt: k => ({ rawKey: Buffer.from(k).toString('base64') }), decrypt: s => (s?.rawKey ? Buffer.from(s.rawKey, 'base64').toString() : '') };
  const groq = { provider: 'groq', rawKey: Buffer.from('groq-secret').toString('base64') };
  let providers = withProviderEntry({ groq }, 'azure', { provider: 'azure', region: 'eastus', rawKey: Buffer.from(KEY).toString('base64') });
  assert.equal(providers.azure.region, 'eastus');
  assert.equal(resolveProviderKey('azure', groq, providers, codec), KEY);
  assert.equal(resolveProviderKey('azure', groq, { groq }, codec), '', 'the active Groq key is not an Azure key');
  providers = migrateProviders(groq, { azure: { provider: 'azure', region: 'uaenorth', rawKey: Buffer.from(KEY).toString('base64') } }, { encrypt: () => ({ encryptedKey: 'ENC' }), decrypt: codec.decrypt }, true);
  assert.equal(providers.azure.region, 'uaenorth', 're-encryption keeps the region');
  assert.equal(providers.azure.encryptedKey, 'ENC');
});
