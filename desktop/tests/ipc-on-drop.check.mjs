import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8');

// One-way IPC (ipcMain.on) has no caller to reject to. A throw there is an uncaught main-process exception, which Electron
// shows as "A JavaScript error occurred in the main process". A closing window sends its speech "stop" while it is no longer
// a known window, so those handlers must drop untrusted or late messages quietly.
const handlers = [...index.matchAll(/\n  ipcMain\.on\(CHANNELS\.(\w+),/g)].map((m, i, all) => ({
  name: m[1],
  text: index.slice(m.index, all[i + 1]?.index ?? m.index + 600),
}));

test('there are one-way handlers to guard', () => {
  assert.ok(handlers.length >= 3, 'speechEvent, caption and interactive are expected');
});

test('every ipcMain.on handler uses authorizeOrDrop and never the throwing authorize', () => {
  for (const h of handlers) {
    const body = h.text.slice(0, 400);
    assert.match(body, /authorizeOrDrop\(event/, `${h.name} must use authorizeOrDrop`);
    assert.doesNotMatch(body, /[^a-zA-Z]authorize\(event/, `${h.name} must not call authorize() directly`);
  }
});

test('authorizeOrDrop swallows the throw and reports false', () => {
  const fn = /function authorizeOrDrop[\s\S]*?\n}\n/.exec(index)?.[0] ?? '';
  assert.match(fn, /try\s*{[\s\S]*authorize\(event, kind\);[\s\S]*return true;[\s\S]*}\s*catch\s*{[\s\S]*return false;/);
});

test('invoke handlers still reject loudly (handle() keeps authorize)', () => {
  assert.match(index, /function authorize\(event: IpcMainInvokeEvent/);
  assert.match(index, /throw new Error\('Untrusted IPC sender\.'\)/);
});
