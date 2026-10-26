import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderKey, shouldActivate, withProviderEntry, migrateProviders } from '../src/main/provider-keys.ts';
import { SttRouter, buildGeminiPrompt, isValidTranscription, normalizeSttLang, cleanTranscript, hasArabicScript } from '../src/main/stt.ts';

// Fake codec: "enc:" prefix = encrypted, "raw:" = base64-ish plain.
const codec = {
  encrypt: key => ({ encryptedKey: 'enc:' + key }),
  decrypt: stored => (stored?.encryptedKey ? stored.encryptedKey.slice(4) : stored?.rawKey ? stored.rawKey.slice(4) : ''),
};

test('resolveProviderKey prefers the provider entry and falls back to the active one', () => {
  const active = { provider: 'groq', rawKey: 'raw:GROQ' };
  const providers = { gemini: { provider: 'gemini', encryptedKey: 'enc:GEM' } };
  assert.equal(resolveProviderKey('gemini', active, providers, codec), 'GEM');
  assert.equal(resolveProviderKey('groq', active, providers, codec), 'GROQ');
  assert.equal(resolveProviderKey('openai', active, providers, codec), '');
  assert.equal(resolveProviderKey('gemini', undefined, undefined, codec), '');
});

test('saving a Gemini key while Groq is active does not switch chat; everything else activates', () => {
  assert.equal(shouldActivate('groq', 'gemini', undefined), false);
  assert.equal(shouldActivate('groq', 'gemini', true), true);
  assert.equal(shouldActivate('gemini', 'gemini', undefined), true);
  assert.equal(shouldActivate(undefined, 'gemini', undefined), true);
  assert.equal(shouldActivate('gemini', 'groq', undefined), true);
});

test('withProviderEntry keeps the other providers keys', () => {
  const next = withProviderEntry({ groq: { provider: 'groq', rawKey: 'raw:G' } }, 'gemini', { provider: 'gemini', encryptedKey: 'enc:X' });
  assert.equal(next.groq.rawKey, 'raw:G');
  assert.equal(next.gemini.encryptedKey, 'enc:X');
});

test('migrateProviders mirrors the active entry and re-encrypts raw keys only when possible', () => {
  const active = { provider: 'groq', model: 'm', rawKey: 'raw:GROQ' };
  const m1 = migrateProviders(active, {}, codec, false);
  assert.equal(m1.groq.rawKey, 'raw:GROQ');
  const m2 = migrateProviders(active, { gemini: { provider: 'gemini', rawKey: 'raw:GEM' } }, codec, true);
  assert.equal(m2.gemini.encryptedKey, 'enc:GEM');
  assert.equal(m2.gemini.rawKey, undefined);
  assert.equal(m2.groq.encryptedKey, 'enc:GROQ');
  const done = { groq: { provider: 'groq', encryptedKey: 'enc:G' } };
  assert.equal(migrateProviders({ provider: 'groq', encryptedKey: 'enc:G' }, done, codec, true), null);
});

// ---- STT ----
const ok = body => ({ ok: true, status: 200, json: async () => body });
const fail = status => ({ ok: false, status, json: async () => ({}) });
const geminiBody = text => ({ candidates: [{ content: { parts: [{ text }] } }] });
function router(handler, keys = { gemini: 'G', groq: 'W', openai: '' }) {
  const calls = [];
  let t = 1000;
  const r = new SttRouter({
    fetch: async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); },
    getKey: id => keys[id] ?? '',
    now: () => t,
  });
  return { r, calls, advance: ms => { t += ms; } };
}
const req = { base64: Buffer.from('x').toString('base64'), mimeType: 'audio/wav', language: 'auto', hint: 'Name: Sudo.' };

test('prompt asks for Roman Urdu in Latin script and keeps the hint; auto language is not forced to English', () => {
  const p = buildGeminiPrompt(normalizeSttLang('auto'), 'Name: Sudo.');
  assert.match(p, /Roman Urdu/);
  assert.match(p, /never in Urdu or Arabic script/);
  assert.match(p, /Name: Sudo\./);
  assert.doesNotMatch(p, /uses English\./);
  assert.equal(normalizeSttLang('auto'), undefined);
  assert.equal(normalizeSttLang('ur-PK'), 'ur');
  assert.equal(normalizeSttLang('en'), 'en');
});

test('Gemini is tried first, key goes in a header, not the URL', async () => {
  const { r, calls } = router(() => ok(geminiBody('tum mere sath baat kyun nahi kar rahe')));
  const out = await r.transcribe(req);
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'gemini');
  assert.equal(out.text, 'tum mere sath baat kyun nahi kar rahe');
  assert.equal(out.scriptWarning, undefined);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].url.includes('G'.repeat(1) + '=') && !calls[0].url.includes('key='));
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'G');
});

test('Gemini 429 on flash falls to flash-lite, then to Whisper, silently, and backs off', async () => {
  let n = 0;
  const { r, calls, advance } = router((url) => {
    n++;
    if (url.includes('gemini-flash-lite-latest:')) return fail(429);
    if (url.includes('gemini-flash-latest:')) return fail(429);
    return ok({ text: 'mujhe batao kya haal hai' });
  });
  const out = await r.transcribe(req);
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'whisper');
  assert.equal(calls.length, 3);
  // Second clip within the back-off window skips both Gemini models without calling them.
  const calls2 = calls.length;
  await r.transcribe(req);
  assert.equal(calls.length, calls2 + 1);
  advance(61_000);
  await r.transcribe(req);
  assert.ok(calls.length >= calls2 + 3);
});

test('all providers rate limited reports rateLimited for the wake gate', async () => {
  const { r } = router(() => fail(429));
  const out = await r.transcribe(req);
  assert.equal(out.ok, false);
  assert.equal(out.rateLimited, true);
});

test('an auth/404 error backs a route off but is not reported as rate limiting', async () => {
  const { r } = router(() => fail(404), { gemini: 'G' });
  await r.transcribe(req);
  const out = await r.transcribe(req); // both gemini routes are in their 15 s error back-off
  assert.equal(out.ok, false);
  assert.equal(out.rateLimited, false);
});

test('no keys at all fails cleanly without calling the network', async () => {
  const { r, calls } = router(() => ok({}), {});
  const out = await r.transcribe(req);
  assert.equal(out.ok, false);
  assert.equal(calls.length, 0);
});

test('Groq-only setup uses Whisper with a Roman Urdu prompt, language only when explicit', async () => {
  const seen = [];
  const { r } = router((url, init) => {
    const form = init.body;
    seen.push({ lang: form.get('language'), prompt: form.get('prompt') });
    return ok({ text: 'tum kaise ho aaj' });
  }, { groq: 'W' });
  await r.transcribe(req);
  await r.transcribe({ ...req, language: 'ur' });
  assert.equal(seen[0].lang, null);
  assert.match(seen[0].prompt, /Roman Urdu/);
  assert.equal(seen[1].lang, 'ur');
});

test('Urdu-script result is flagged when Latin was expected, not when Urdu was chosen', async () => {
  const { r } = router(() => ok({ text: 'تم بول کھینڈے میرے ساتھ کیا' }), { groq: 'W' });
  const a = await r.transcribe(req);
  assert.equal(a.ok, true);
  assert.equal(a.scriptWarning, true);
  const b = await r.transcribe({ ...req, language: 'ur' });
  assert.equal(b.scriptWarning, undefined);
  assert.equal(hasArabicScript('abc'), false);
});

test('Gemini [none] means silence and does not spend more quota on other providers', async () => {
  const { r, calls } = router(() => ok(geminiBody('[none]')));
  const out = await r.transcribe(req);
  assert.equal(out.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(cleanTranscript('"hello there"'), 'hello there');
});

test('garbage transcriptions are rejected', () => {
  assert.equal(isValidTranscription(''), false);
  assert.equal(isValidTranscription('...'), false);
  assert.equal(isValidTranscription('Thank you.'), false);
  assert.equal(isValidTranscription('hmm'), false);
  assert.equal(isValidTranscription('ha ha ha ha ha ha'), false);
  assert.equal(isValidTranscription('sid'), true);
  assert.equal(isValidTranscription('mujhe batao kya haal hai'), true);
});
