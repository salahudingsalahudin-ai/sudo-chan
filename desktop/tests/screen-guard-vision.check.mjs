import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findSensitive, parseWindowList, evaluateWindowList, SENSITIVE_KEYWORDS } from '../src/shared/screen-guard.ts';
import { parseRetryAfterMs, screenRules, SCREEN_RULES, buildVisionMessages } from '../src/shared/screen-assist.ts';
import { runVisionChat, describeVisionPayload } from '../src/main/vision-chat.ts';
import { overlayShape } from '../src/shared/overlay-shape.ts';
import { DEFAULT_SETTINGS, validSettings } from '../src/shared/validation.ts';

const win = (app, title, showing = true) => ({ app, title, showing });

test('guard flags password managers, banks, logins and private windows that are on screen', () => {
  assert.deepEqual(findSensitive([win('bitwarden', 'My vault')]), { status: 'sensitive', matched: 'bitwarden' });
  assert.equal(findSensitive([win('firefox', 'Login - Bank Alfalah — Mozilla Firefox')]).status, 'sensitive');
  assert.equal(findSensitive([win('firefox', 'Sign in to your account — Mozilla Firefox')]).status, 'sensitive');
  assert.equal(findSensitive([win('firefox', 'Private Browsing — Mozilla Firefox')]).status, 'sensitive');
  assert.equal(findSensitive([win('chrome', 'New Incognito Tab - Google Chrome')]).status, 'sensitive');
  assert.equal(findSensitive([win('org.keepassxc.KeePassXC', 'Database')]).status, 'sensitive');
  assert.equal(findSensitive([win('firefox', 'Enter your OTP - JazzCash')]).status, 'sensitive');
  assert.equal(findSensitive([win('firefox', 'MetaMask wallet')]).status, 'sensitive');
  assert.ok(SENSITIVE_KEYWORDS.includes('seed phrase'));
  assert.equal(findSensitive([win('x', 'Write down your seed phrase')]).status, 'sensitive');
});

test('guard ignores ordinary windows, hidden windows, word fragments and Sudo-chan itself', () => {
  assert.equal(findSensitive([win('gnome-terminal-server', '◑ Agent ka context'), win('eog', 'Screenshot from 2026-10-27.png')]).status, 'clear');
  assert.equal(findSensitive([win('firefox', 'Bankruptcy law overview')]).status, 'clear', 'whole words only');
  assert.equal(findSensitive([win('bitwarden', 'Vault', false)]).status, 'clear', 'a window that is not showing is not in the screenshot');
  assert.equal(findSensitive([win('electron', 'Sudo-chan')]).status, 'clear');
  assert.equal(findSensitive([]).status, 'clear');
});

test('helper output parsing: garbage or empty is "unknown", never "clear"', () => {
  assert.equal(evaluateWindowList('').status, 'unknown');
  assert.equal(evaluateWindowList('not json').status, 'unknown');
  assert.equal(evaluateWindowList('[]').status, 'unknown');
  assert.equal(evaluateWindowList('{"a":1}').status, 'unknown');
  assert.equal(evaluateWindowList(JSON.stringify([{ app: 'eog', title: 'photo.png', showing: true }])).status, 'clear');
  assert.equal(evaluateWindowList(JSON.stringify([{ app: 'firefox', title: 'Log in', showing: true }])).status, 'sensitive');
  assert.equal(parseWindowList('x\n[{"app":"a","title":"t","showing":true}]').length, 1);
});

test('retry-after parsing (header, Groq sentence, ms, minutes)', () => {
  assert.equal(parseRetryAfterMs('', '3'), 3000);
  assert.equal(parseRetryAfterMs('Rate limit ... Please try again in 4.02s.'), 4020);
  assert.equal(parseRetryAfterMs('Please try again in 850ms'), 850);
  assert.equal(parseRetryAfterMs('Please try again in 1m2.5s'), 62500);
  assert.equal(parseRetryAfterMs('nothing useful'), null);
});

test('screen rules: only a fresh turn is plain; a cached screenshot says how old it is; voice turns stay short', () => {
  assert.match(screenRules(), /SCREENSHOT ATTACHED/);
  assert.doesNotMatch(screenRules({ ageSeconds: 0 }), /seconds ago/);
  assert.match(screenRules({ ageSeconds: 45 }), /SAME screenshot taken 45 seconds ago/);
  assert.match(screenRules({ voice: true }), /at most 3 short sentences/);
  assert.doesNotMatch(screenRules({ voice: false }), /spoken aloud/);
  assert.match(screenRules(), /Never invent/);
  assert.match(SCREEN_RULES, /unreadable/);
});

const target = { provider: 'groq', endpoint: 'https://example.test/v1/chat/completions', model: 'qwen/qwen3.8-27b', apiKey: 'k' };
const fakeResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: name => headers[name.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const base = { system: 'You are Sudo-chan.', history: [{ role: 'user', content: 'ye error kya hai?' }], fallbackText: 'ye error kya hai?', imageDataUri: 'data:image/jpeg;base64,AAAA' };

test('vision: the image is attached only to the final user message and the rules say so', async () => {
  let sent;
  const result = await runVisionChat({ ...base, targets: [target], voice: true, ageSeconds: 30, fetchFn: async (_url, init) => { sent = JSON.parse(init.body); return fakeResponse(200, { choices: [{ message: { content: 'Requests install nahi hai.' } }] }); } });
  assert.equal(result.text, 'Requests install nahi hai.');
  const last = sent.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.ok(last.content.some(part => part.type === 'image_url'));
  assert.equal(sent.messages.filter(m => Array.isArray(m.content)).length, 1);
  assert.match(sent.messages[0].content, /SAME screenshot taken 30 seconds ago/);
  assert.match(sent.messages[0].content, /at most 3 short sentences/);
});

test('vision payload description never contains the image', () => {
  const described = JSON.stringify(describeVisionPayload({ ...base, voice: true }));
  assert.doesNotMatch(described, /AAAA/);
  assert.match(described, /image omitted/);
});

test('truthfulness: without a screenshot the screen rules are never part of the prompt', () => {
  const plain = buildVisionMessages('SYSTEM', [], 'hi', 'data:image/jpeg;base64,AAAA');
  assert.equal(plain[0].content, 'SYSTEM');
  assert.doesNotMatch(plain[0].content, /SCREENSHOT ATTACHED/);
});

test('vision: a short rate limit is waited out once and then succeeds; a long one falls through to the next provider', async () => {
  const waits = [];
  let calls = 0;
  const ok = await runVisionChat({
    ...base, targets: [target], sleep: async ms => { waits.push(ms); },
    fetchFn: async () => (++calls === 1
      ? fakeResponse(429, { error: { message: 'Rate limit. Please try again in 1.30s.' } })
      : fakeResponse(200, { choices: [{ message: { content: 'ok' } }] })),
  });
  assert.equal(ok.text, 'ok');
  assert.equal(calls, 2);
  assert.ok(waits[0] >= 1300 && waits[0] < 2000);

  const order = [];
  const second = { ...target, provider: 'gemini', model: 'gemini-flash-lite-latest' };
  const fallback = await runVisionChat({
    ...base, targets: [target, second], sleep: async () => { throw new Error('must not wait that long'); },
    fetchFn: async (_url, init) => {
      const model = JSON.parse(init.body).model;
      order.push(model);
      return model === target.model
        ? fakeResponse(429, { error: { message: 'Please try again in 40s' } })
        : fakeResponse(200, { choices: [{ message: { content: 'from gemini' } }] });
    },
  });
  assert.equal(fallback.text, 'from gemini');
  assert.deepEqual(order, [target.model, second.model]);
});

test('vision: when nothing works she says so instead of guessing', async () => {
  await assert.rejects(
    runVisionChat({ ...base, targets: [target], sleep: async () => {}, fetchFn: async () => fakeResponse(500, 'boom') }),
    /Screen dekh kar jawab nahi mil saka/,
  );
  await assert.rejects(runVisionChat({ ...base, targets: [] }), /vision/i);
});

test('overlay shape: consent panel (tall) opens more of the window than a banner; both stay inside the window', () => {
  const contains = (rects, x, y) => rects.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
  const [w, h] = [190, 230];
  assert.equal(contains(overlayShape(w, h, false), w / 2, 5), false);
  assert.equal(contains(overlayShape(w, h, true), w / 2, 5), true);
  assert.equal(contains(overlayShape(w, h, true), w / 2, h * 0.4), true, 'bot area already covers the middle');
  const tall = overlayShape(w, h, true, true);
  assert.equal(contains(tall, w * 0.1, h * 0.45), true);
  for (const r of tall) assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= w && r.y + r.height <= h);
});

test('main wiring (source guard): consent is click-only from the overlay, wake uses the panel, guard + follow-up + shape are connected', () => {
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  assert.match(main, /handle\(CHANNELS\.screenConsent, \(_e, granted\) => answerScreenConsent\(granted === true\), 'overlay'\)/);
  assert.match(main, /askConsent: source => \(source === 'wake' \? askConsentOnOverlay\(\) : consentDialog\(\)\)/);
  assert.match(main, /checkWindows: checkVisibleWindows/);
  assert.match(main, /followUpVision\(text, visionTargets\(\)\)/);
  assert.match(main, /overlayShape\(width, height, Boolean\(state\.speech \|\| state\.screenStatus\), state\.screenStatus === 'consent'\)/);
  assert.match(main, /if \(!candidate\.screenAssistEnabled && state\.settings\.screenAssistEnabled\) screenFlow\.disable\(\)/);
  // No speech path may reach consent: the renderer only calls screenConsent from the two panel buttons.
  const panel = readFileSync(new URL('../src/renderer/ScreenPanel.tsx', import.meta.url), 'utf8');
  assert.equal((panel.match(/screenConsent\(/g) ?? []).length, 2);
  const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /screenConsent\(/);
  assert.match(app, /stopReply\(\{ keepScreen: true \}\)/);
});

test('settings: countdown defaults ON and is validated', () => {
  assert.equal(DEFAULT_SETTINGS.screenAssistCountdown, true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, screenAssistCountdown: false }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, screenAssistCountdown: 'yes' }), false);
});
