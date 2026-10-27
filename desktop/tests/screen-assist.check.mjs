import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUTTON_COOLDOWN_MS,
  WAKE_COOLDOWN_MS,
  buildImageUserMessage,
  buildVisionMessages,
  decideCapture,
  fileUriToPath,
  isBlankFrame,
  isNoVisionError,
  pickVisionTargets,
  redactForLog,
  targetSize,
  SCREEN_RULES,
} from '../src/shared/screen-assist.ts';
import { DEFAULT_SETTINGS, validSettings } from '../src/shared/validation.ts';
import { NO_VISION_MESSAGE, VisionError, describeVisionPayload, runVisionChat } from '../src/main/vision-chat.ts';
import { parseHelperOutput } from '../src/main/portal-screenshot.ts';

const IMAGE = 'data:image/jpeg;base64,' + 'A'.repeat(500);
const ok = { enabled: true, consented: true, source: 'wake', now: 100_000, lastCaptureAt: null, busy: false };

test('settings: screen assist is OFF by default and validated', () => {
  assert.equal(DEFAULT_SETTINGS.screenAssistEnabled, false);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, screenAssistEnabled: true }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, screenAssistEnabled: 'yes' }), false);
});

test('decideCapture: needs the setting, consent, and no capture in flight', () => {
  assert.deepEqual(decideCapture(ok), { capture: true });
  assert.deepEqual(decideCapture({ ...ok, enabled: false }), { capture: false, reason: 'disabled' });
  assert.deepEqual(decideCapture({ ...ok, consented: false }), { capture: false, reason: 'no-consent' });
  assert.deepEqual(decideCapture({ ...ok, busy: true }), { capture: false, reason: 'busy' });
  // Disabled wins over everything else: nothing is ever captured while the setting is off.
  assert.equal(decideCapture({ ...ok, enabled: false, consented: true, lastCaptureAt: null }).capture, false);
});

test('decideCapture: cooldown is 10 s for the wake word and 2 s for the button', () => {
  const last = 100_000;
  assert.equal(decideCapture({ ...ok, lastCaptureAt: last, now: last + WAKE_COOLDOWN_MS - 1 }).capture, false);
  assert.equal(decideCapture({ ...ok, lastCaptureAt: last, now: last + WAKE_COOLDOWN_MS }).capture, true);
  assert.equal(decideCapture({ ...ok, source: 'button', lastCaptureAt: last, now: last + BUTTON_COOLDOWN_MS - 1 }).capture, false);
  assert.equal(decideCapture({ ...ok, source: 'button', lastCaptureAt: last, now: last + BUTTON_COOLDOWN_MS }).capture, true);
  assert.deepEqual(decideCapture({ ...ok, lastCaptureAt: last, now: last + 5000 }), { capture: false, reason: 'cooldown' });
});

test('targetSize downsizes to 1280 wide, keeps aspect ratio and never upscales', () => {
  assert.deepEqual(targetSize(2560, 1440), { width: 1280, height: 720 });
  assert.deepEqual(targetSize(1366, 768), { width: 1280, height: 720 });
  assert.deepEqual(targetSize(800, 600), { width: 800, height: 600 });
  assert.deepEqual(targetSize(0, 0), { width: 0, height: 0 });
});

test('isBlankFrame: flat black or flat colour is blank, real content is not', () => {
  const flat = value => {
    const buf = new Uint8Array(200 * 100 * 4);
    buf.fill(value);
    return buf;
  };
  assert.equal(isBlankFrame(flat(0)), true);
  assert.equal(isBlankFrame(flat(128)), true);
  assert.equal(isBlankFrame(new Uint8Array(0)), true);
  const content = new Uint8Array(200 * 100 * 4);
  for (let i = 0; i < 200 * 100; i++) {
    const v = i % 200 < 100 ? 20 : 220; // two flat halves like a dark and a light window
    content.set([v, v, v, 255], i * 4);
  }
  assert.equal(isBlankFrame(content), false);
  // A dark desktop with slight variation (std ~ 31 like the real capture measured here) is not blank.
  const dark = new Uint8Array(200 * 100 * 4);
  for (let i = 0; i < 200 * 100; i++) dark.set(i % 7 === 0 ? [60, 80, 60, 255] : [10, 18, 10, 255], i * 4);
  assert.equal(isBlankFrame(dark), false);
});

test('image message: OpenAI-compatible image_url part, image only on the final user turn', () => {
  const message = buildImageUserMessage('ye kya hai?', IMAGE);
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content[0], { type: 'text', text: 'ye kya hai?' });
  assert.deepEqual(message.content[1], { type: 'image_url', image_url: { url: IMAGE } });

  const history = [
    { role: 'user', content: 'pehla sawal' },
    { role: 'assistant', content: 'pehla jawab' },
    { role: 'user', content: 'ye error kya hai' },
  ];
  const built = buildVisionMessages('SYS', history, 'fallback', IMAGE);
  assert.equal(built[0].role, 'system');
  assert.equal(built.length, 4);
  assert.equal(typeof built[1].content, 'string', 'earlier turns stay text-only');
  assert.equal(typeof built[2].content, 'string');
  assert.deepEqual(built[3].content[0], { type: 'text', text: 'ye error kya hai' });
  assert.equal(built.filter(m => Array.isArray(m.content)).length, 1);
  // No user message in history: the fallback text carries the turn.
  assert.deepEqual(buildVisionMessages('SYS', [], 'fallback', IMAGE)[1].content[0], { type: 'text', text: 'fallback' });
});

test('screen rules forbid inventing screen content', () => {
  assert.match(SCREEN_RULES, /Never invent/);
  assert.match(SCREEN_RULES, /passwords/);
});

test('redactForLog removes every image payload', () => {
  const payload = buildVisionMessages('SYS', [{ role: 'user', content: 'q' }], 'f', IMAGE);
  const redacted = JSON.stringify(redactForLog(payload));
  assert.equal(redacted.includes('AAAA'), false);
  assert.match(redacted, /\[image omitted\]/);
  assert.equal(JSON.stringify(describeVisionPayload({ system: 'S', history: [], fallbackText: 'f', imageDataUri: IMAGE })).includes('AAAA'), false);
});

test('pickVisionTargets: active provider first, then vision models of providers that have a key', () => {
  const groq = { endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'x', apiKey: 'k1' };
  const gemini = { endpoint: 'https://gen/v1/chat/completions', model: 'y', apiKey: 'k2' };
  const targets = pickVisionTargets({ provider: 'groq', ...groq, model: 'qwen/qwen3.8-27b' }, { groq, gemini });
  assert.deepEqual(targets.map(t => `${t.provider}/${t.model}`), ['groq/qwen/qwen3.8-27b', 'gemini/gemini-flash-lite-latest']);
  // Active chat model without vision: its provider's vision model is still tried.
  const text = pickVisionTargets({ provider: 'groq', ...groq, model: 'llama-3.1-8b-instant' }, { groq, gemini });
  assert.deepEqual(text.map(t => `${t.provider}/${t.model}`), ['groq/llama-3.1-8b-instant', 'groq/qwen/qwen3.8-27b', 'gemini/gemini-flash-lite-latest']);
  // No keys at all: nothing to try, so the caller can say so instead of pretending.
  assert.deepEqual(pickVisionTargets(null, {}), []);
  // Local mode (no active) still never invents a target without a key.
  assert.deepEqual(pickVisionTargets(null, { groq: { ...groq, apiKey: '' } }), []);
  // Custom active provider is used as-is.
  const custom = pickVisionTargets({ provider: 'custom', endpoint: 'https://my/v1/chat/completions', model: 'm', apiKey: 'k' }, {});
  assert.deepEqual(custom.map(t => t.provider), ['custom']);
});

test('isNoVisionError recognises image-unsupported responses only', () => {
  assert.equal(isNoVisionError(400, '{"error":{"message":"model does not support image input"}}'), true);
  assert.equal(isNoVisionError(422, 'content must be a string'), false);
  assert.equal(isNoVisionError(429, 'image rate limit'), false);
  assert.equal(isNoVisionError(500, 'image'), false);
});

test('fileUriToPath and portal helper output parsing', () => {
  assert.equal(fileUriToPath('file:///home/me/Pictures/Screenshot.png'), '/home/me/Pictures/Screenshot.png');
  assert.equal(fileUriToPath('file:///home/me/My%20Pics/a.png'), '/home/me/My Pics/a.png');
  assert.equal(fileUriToPath('https://x/y.png'), null);
  assert.deepEqual(parseHelperOutput('{"code": 0, "uri": "file:///tmp/a.png"}\n'), { ok: true, path: '/tmp/a.png' });
  assert.deepEqual(parseHelperOutput('{"code": 1, "uri": null}'), { ok: false, reason: 'portal-denied' });
  assert.deepEqual(parseHelperOutput('{"reason": "no-python-gi"}'), { ok: false, reason: 'no-python-gi' });
  assert.deepEqual(parseHelperOutput('garbage'), { ok: false, reason: 'portal-bad-output' });
});

function fakeFetch(handlers, calls) {
  let i = 0;
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = handlers[Math.min(i++, handlers.length - 1)];
    if (next instanceof Error) throw next;
    return new Response(next.body, { status: next.status, headers: { 'content-type': 'application/json' } });
  };
}

const targets = [
  { provider: 'groq', endpoint: 'https://groq.test/chat', model: 'm1', apiKey: 'KEY-GROQ-SECRET' },
  { provider: 'gemini', endpoint: 'https://gemini.test/chat', model: 'm2', apiKey: 'KEY-GEMINI-SECRET' },
];
const base = { targets, system: 'SYS', history: [{ role: 'user', content: 'ye kya error hai' }], fallbackText: 'f', imageDataUri: IMAGE };
const reply = text => JSON.stringify({ choices: [{ message: { content: text } }] });

test('runVisionChat sends the image to the first target and logs no image or key', async () => {
  const calls = [];
  const logs = [];
  const result = await runVisionChat({ ...base, fetchFn: fakeFetch([{ status: 200, body: reply('Ye ek error hai.') }], calls), log: l => logs.push(l) });
  assert.equal(result.text, 'Ye ek error hai.');
  assert.equal(result.provider, 'groq');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer KEY-GROQ-SECRET');
  assert.match(calls[0].init.headers['User-Agent'], /Sudo-chan/);
  const last = calls[0].body.messages.at(-1);
  assert.equal(last.content[1].type, 'image_url');
  assert.equal(last.content[1].image_url.url, IMAGE);
  assert.match(calls[0].body.messages[0].content, /SCREENSHOT ATTACHED/);
  assert.equal(calls[0].body.stream, false);
  const logged = logs.join('\n');
  assert.equal(logged.includes('AAAA'), false);
  assert.equal(logged.includes('SECRET'), false);
});

test('runVisionChat falls back to the next provider on 429, no-vision 400 and network errors', async () => {
  for (const first of [
    { status: 429, body: '{"error":{"message":"rate limit"}}' },
    { status: 400, body: '{"error":{"message":"this model does not support image inputs"}}' },
    new Error('offline'),
  ]) {
    const calls = [];
    const result = await runVisionChat({ ...base, fetchFn: fakeFetch([first, { status: 200, body: reply('Gemini ne dekha.') }], calls), log: () => {} });
    assert.equal(result.provider, 'gemini');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].init.headers.Authorization, 'Bearer KEY-GEMINI-SECRET');
  }
});

test('runVisionChat never pretends: no vision anywhere gives the honest message', async () => {
  const noVision = { status: 400, body: '{"error":{"message":"images are not supported by this model"}}' };
  await assert.rejects(runVisionChat({ ...base, fetchFn: fakeFetch([noVision, noVision], []), log: () => {} }), error => {
    assert.ok(error instanceof VisionError);
    assert.equal(error.message, NO_VISION_MESSAGE);
    return true;
  });
  await assert.rejects(runVisionChat({ ...base, targets: [], fetchFn: fakeFetch([], []) }), VisionError);
  // Transient failures give a retry message, not an invented answer.
  await assert.rejects(runVisionChat({ ...base, fetchFn: fakeFetch([{ status: 503, body: '{}' }], []), log: () => {} }), /dobara try/);
  // Empty replies are not accepted as answers.
  await assert.rejects(runVisionChat({ ...base, fetchFn: fakeFetch([{ status: 200, body: reply('   ') }], []), log: () => {} }), VisionError);
});

test('runVisionChat rethrows when the user cancels (abort)', async () => {
  const controller = new AbortController();
  controller.abort();
  const failing = async () => { throw new DOMException('aborted', 'AbortError'); };
  await assert.rejects(runVisionChat({ ...base, signal: controller.signal, fetchFn: failing, log: () => {} }), /abort/i);
});
