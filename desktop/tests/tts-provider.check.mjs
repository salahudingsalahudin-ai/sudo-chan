import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiTtsProvider, TtsRouter, buildGeminiPrompt, pcmToWav } from '../src/main/tts-provider.ts';
import {
  cleanTextForSpeech, emotionStyle, parseEmotionTags, splitIntoSpokenSentences, stripEmotionTags,
} from '../src/shared/speech.ts';
import { DEFAULT_SETTINGS, validSettings } from '../src/shared/validation.ts';

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
    return (u.includes('generativelanguage') ? handlers.gemini : handlers.google)();
  };
  fn.calls = calls;
  return fn;
}

test('emotion tags are parsed per sentence and stripped from display text', () => {
  const raw = '[happy] Assalam o Alaikum Sid! [curious] Aaj kya karna hai? Theek hai.';
  assert.deepEqual(parseEmotionTags(raw), [
    { text: 'Assalam o Alaikum Sid!', emotion: 'happy' },
    { text: 'Aaj kya karna hai? Theek hai.', emotion: 'curious' },
  ]);
  assert.equal(stripEmotionTags(raw), 'Assalam o Alaikum Sid! Aaj kya karna hai? Theek hai.');
  assert.equal(stripEmotionTags('[warm] Hello [ca'), 'Hello ');
  assert.deepEqual(parseEmotionTags('No tags here.'), [{ text: 'No tags here.', emotion: 'neutral' }]);
  assert.equal(parseEmotionTags('[apologetic] Sorry.')[0].emotion, 'soft', 'aliases map to the canonical set');
});

test('splitIntoSpokenSentences keeps emotion per sentence and drops tags from the spoken text', () => {
  const out = splitIntoSpokenSentences('[excited] Great news! Ye kaam ho gaya. [soft] Sorry for the wait.');
  assert.deepEqual(out.map(s => s.emotion), ['excited', 'excited', 'soft']);
  assert.ok(out.every(s => !s.text.includes('[')));
});

test('style instructions map from emotion and add Pakistani pronunciation for Urdu', () => {
  assert.match(emotionStyle('warm'), /warmly/);
  assert.match(emotionStyle('soft'), /apologetically/);
  assert.match(emotionStyle('curious'), /rising intonation/);
  assert.match(emotionStyle('happy'), /greeting/);
  assert.doesNotMatch(emotionStyle('warm', 'en'), /Pakistani/);
  assert.match(emotionStyle('warm', 'hi'), /Pakistani/);
  const prompt = buildGeminiPrompt({ text: 'Salam', lang: 'hi', style: emotionStyle('calm', 'hi'), speed: 0.8 });
  assert.match(prompt, /^Say the following calmly/);
  assert.match(prompt, /slower/);
  assert.ok(prompt.endsWith('Salam'));
});

test('cleanTextForSpeech strips markdown, emoji, URLs, code blocks and emotion tags', () => {
  const dirty = '[warm] **Hello** 🎉 see https://example.com and `code` ```js\nconst a = 1;\n``` [link](https://x.y) done ✨';
  const clean = cleanTextForSpeech(dirty);
  assert.equal(clean, 'Hello see and code link done');
});

test('pcmToWav writes a valid 24 kHz mono 16-bit RIFF header', () => {
  const wav = pcmToWav(pcm);
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(28), 48000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), pcm.length);
});

test('Gemini provider sends voice + style, keeps the key out of the URL, returns a WAV data URI', async () => {
  const f = fakeFetch({ gemini: geminiOk });
  const p = new GeminiTtsProvider({ getKey: () => 'secret-key', fetchFn: f });
  const r = await p.synthesize({ text: 'Hello', lang: 'en', style: 'Say the following warmly.', voice: 'Puck' });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'gemini');
  assert.match(r.dataUri, /^data:audio\/wav;base64,/);
  const call = f.calls[0];
  assert.ok(!call.url.includes('secret-key'));
  assert.equal(call.init.headers['x-goog-api-key'], 'secret-key');
  const body = JSON.parse(call.init.body);
  assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
  assert.deepEqual(body.generationConfig.responseModalities, ['AUDIO']);
  assert.match(body.contents[0].parts[0].text, /^Say the following warmly\./);
});

test('router falls back to Google when Gemini fails, then backs off instead of retrying every sentence', async () => {
  let t = 1000;
  const f = fakeFetch({ gemini: () => new Response('quota', { status: 429 }), google: googleOk });
  const router = new TtsRouter({ getKey: () => 'k', getPreferred: () => 'gemini', fetchFn: f, now: () => t });
  const first = await router.synthesize({ text: 'One of these sentences', lang: 'en' });
  assert.equal(first.ok, true);
  assert.equal(first.provider, 'google');
  const second = await router.synthesize({ text: 'Two of these sentences', lang: 'en' });
  assert.equal(second.provider, 'google');
  assert.equal(f.calls.filter(c => c.url.includes('generativelanguage')).length, 1, 'no second Gemini attempt inside the backoff window');
  t += 61_000;
  await router.synthesize({ text: 'Three of these sentences', lang: 'en' });
  assert.equal(f.calls.filter(c => c.url.includes('generativelanguage')).length, 2, 'Gemini is retried after the backoff');
});

test('router uses Google when there is no Gemini key or Google is the chosen engine', async () => {
  const f = fakeFetch({ gemini: geminiOk, google: googleOk });
  const noKey = new TtsRouter({ getKey: () => '', getPreferred: () => undefined, fetchFn: f });
  assert.equal((await noKey.synthesize({ text: 'Hi there my friend', lang: 'en' })).provider, 'google');
  const chosen = new TtsRouter({ getKey: () => 'k', getPreferred: () => 'google', fetchFn: f });
  assert.equal((await chosen.synthesize({ text: 'Hi there my friend', lang: 'en' })).provider, 'google');
  assert.equal(f.calls.filter(c => c.url.includes('generativelanguage')).length, 0);
  const preferred = new TtsRouter({ getKey: () => 'k', getPreferred: () => undefined, fetchFn: f });
  assert.equal((await preferred.synthesize({ text: 'Hi there my friend', lang: 'en' })).provider, 'gemini', 'Gemini is the default engine');
});

test('settings validation covers the Gemini voice and speed', () => {
  assert.equal(DEFAULT_SETTINGS.ttsGeminiVoice, 'Kore');
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, ttsGeminiVoice: 'Puck', ttsSpeed: 1.2 }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, ttsGeminiVoice: 'Bad Voice!' }), false);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, ttsGeminiVoice: 7 }), false);
});
