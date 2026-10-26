import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validSettings, validPosition, clampPosition, DEFAULT_SETTINGS } from '../dist/shared/validation.js';
import { LocalAI } from '../dist/main/local-ai.js';
import { ChatSession } from '../dist/main/chat-session.js';

test('settings accept supported choices and modifier shortcuts', () => {
  assert.equal(validSettings(DEFAULT_SETTINGS), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, shortcut: 'Control+Shift+Space', botSize: 'large' }), true);
});
test('reject untrusted settings and unmodified keys', () => {
  for (const value of [null, {}, { ...DEFAULT_SETTINGS, shortcut: 'A' }, { ...DEFAULT_SETTINGS, botSize: 'huge' }, { ...DEFAULT_SETTINGS, launchAtLogin: 'yes' }, { ...DEFAULT_SETTINGS, shortcut: 'Control+<script>' }]) assert.equal(validSettings(value), false);
});
test('saved positions must be finite coordinates', () => {
  assert.equal(validPosition({ x: -1920, y: 0 }), true);
  for (const value of [null, { x: Infinity, y: 3 }, { x: NaN, y: 0 }, { x: '4', y: 1 }]) assert.equal(validPosition(value), false);
});
test('disconnected display positions return to a visible work area', () => {
  assert.deepEqual(clampPosition({ x: 5000, y: -600 }, { x: 0, y: 24, width: 1920, height: 1056 }, 220, 260), { x: 1700, y: 24 });
});
test('negative-coordinate monitors preserve visible positions', () => {
  assert.deepEqual(clampPosition({ x: -4000, y: 3000 }, { x: -1920, y: 0, width: 1920, height: 1080 }, 220, 260), { x: -1920, y: 820 });
});
test('oversized windows never generate positions outside the work area origin', () => {
  assert.deepEqual(clampPosition({ x: 200, y: 200 }, { x: 0, y: 0, width: 160, height: 180 }, 220, 260), { x: 0, y: 0 });
});
test('local AI lists only downloaded local models and blocks cloud models', async () => {
  const ai = new LocalAI(async url => {
    assert.equal(url, 'http://127.0.0.1:11434/api/tags');
    return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:0.5b' }, { name: 'llama3:cloud' }, { name: 'qwen2.5:0.5b' }] }));
  });
  assert.deepEqual(await ai.models(), ['qwen2.5:0.5b']);
});
test('chat session streams local replies and supports stopping an active reply', async () => {
  let step = 0;
  const ai = new LocalAI(async (url, init) => {
    if (String(url).endsWith('/api/show')) {
      return new Response(JSON.stringify({ model_info: { 'general.architecture': 'qwen2' } }));
    }
    step++;
    const current = step;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { content: 'Hello ' }, done: false })}\n`));
        if (current === 1) {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { content: 'friend.' }, done: true })}\n`));
          controller.close();
        } else {
          init?.signal?.addEventListener('abort', () => { try { controller.error(new Error('aborted')); } catch {} });
        }
      },
    });
    return new Response(stream);
  });
  const session = new ChatSession(ai, () => {});
  assert.deepEqual(session.send('First message', 'qwen2.5:0.5b'), { ok: true });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(session.snapshot().busy, false);
  assert.equal(session.snapshot().messages[1].text, 'Hello friend.');
  assert.equal(session.snapshot().messages[1].status, 'complete');

  assert.deepEqual(session.send('Second message', 'qwen2.5:0.5b'), { ok: true });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(session.snapshot().busy, true);
  assert.equal(session.snapshot().messages[3].text, 'Hello ');
  session.stop();
  assert.equal(session.snapshot().busy, false);
  assert.equal(session.snapshot().messages[3].status, 'stopped');
});
