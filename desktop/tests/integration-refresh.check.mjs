import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSystemPrompt } from '../dist/main/local-ai.js';
import { matchWakeWord } from '../src/shared/wake-word.ts';
import { isStopCommand } from '../src/shared/stop-intent.ts';
import { DEFAULT_SETTINGS, validSettings } from '../src/shared/validation.ts';

const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');

test('voice prompt: she can hear through the mic, in every tools/screenshot combination', () => {
  for (const options of [{ voice: true }, { voice: true, tools: true }, { voice: true, toolsPaused: true }]) {
    const prompt = buildSystemPrompt(options);
    assert.match(prompt, /you CAN hear/i);
    assert.doesNotMatch(prompt, /Cannot view desktop screen pixels/);
  }
  assert.match(buildSystemPrompt({ voice: true, tools: true }), /approve on screen/i);
  assert.match(buildSystemPrompt({ voice: true, toolsPaused: true }), /not available on this screenshot turn/i);
  assert.doesNotMatch(buildSystemPrompt({ voice: true }), /approve on screen/i);
});

test('text prompt keeps the hearing fact next to the tools/screen truthfulness lines', () => {
  const plain = buildSystemPrompt({});
  const withTools = buildSystemPrompt({ tools: true });
  const paused = buildSystemPrompt({ toolsPaused: true });
  for (const prompt of [plain, withTools, paused]) assert.match(prompt, /Do not claim you cannot hear voice/);
  assert.match(plain, /screenshot is attached/i);
  assert.match(withTools, /NOT such a turn/);
  assert.match(paused, /NOT available on this screenshot turn/);
});

test('"Sudo, ruko" is a stop command after the name, so it must not trigger a screenshot', () => {
  const match = matchWakeWord('Sudo ruko', 'Sudo', undefined);
  assert.equal(match.matched, true);
  assert.equal(isStopCommand(match.rest), true);
  const real = matchWakeWord('Sudo ye error kya hai', 'Sudo', undefined);
  assert.equal(isStopCommand(real.rest), false);
  const app = read('../src/renderer/App.tsx');
  assert.match(app, /if \(match\.rest && handleStopCommand\(match\.rest\)\) return;/);
});

test('main wiring: stop cancels screen capture and tools and is allowed from the overlay; wake screenshots are voice', () => {
  const main = read('../src/main/index.ts');
  // A real stop drops the cached screenshot; a barge-in passes keepScreen so a follow-up can still use it.
  assert.match(main, /handle\(CHANNELS\.stop, \(_e, value\) => \{ cancelScreenCapture\(\(value as \{ keepScreen\?: unknown \} \| undefined\)\?\.keepScreen === true\); conversation\.stop\(\); stopAllTools\(\); \}, \['chat', 'overlay'\]\)/);
  assert.match(main, /v\.source === 'wake' \|\| Boolean\(state\.voiceCallActive\)/);
});

test('main wiring: approvals only reach the chat window, the overlay gets chat text without screenshots, startup avoids safeStorage', () => {
  const main = read('../src/main/index.ts');
  assert.doesNotMatch(main, /overlay\.webContents\.send\(CHANNELS\.toolApproval/);
  assert.match(main, /overlay\.webContents\.send\(CHANNELS\.chatState, withoutAttachments\(next\)\)/);
  assert.match(main, /handle\(CHANNELS\.toolApprovalReply[\s\S]*?'chat'\);/);
  assert.match(main, /migrateProviders\(store\.get\('cloud'\)[^;]*keyCodec, false\)/);
});

test('settings defaults across branches: wake ON, fast STT allowed, tools and screen assist OFF', () => {
  assert.equal(DEFAULT_SETTINGS.wakeWordEnabled, true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, sttSpeed: 'fast' }), true);
  assert.notEqual(DEFAULT_SETTINGS.toolsEnabled, true);
  assert.notEqual(DEFAULT_SETTINGS.screenAssistEnabled, true);
});
