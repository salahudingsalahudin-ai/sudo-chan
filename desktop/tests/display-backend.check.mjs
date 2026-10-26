import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayBackend } from '../dist/shared/display-backend.js';

test('Linux startup relaunches once with a backend selected before Electron initializes', () => {
  const first = displayBackend('linux', ['/path with spaces/app']);
  assert.deepEqual(first, { backend: 'x11', relaunch: true });
  assert.deepEqual(displayBackend('linux', [`--ozone-platform=${first.backend}`]), { backend: 'x11', relaunch: false });
});
test('native Wayland opt-in and explicit backend overrides survive relaunch', () => {
  assert.deepEqual(displayBackend('linux', ['--native-wayland']), { backend: 'wayland', relaunch: true });
  assert.deepEqual(displayBackend('linux', ['--native-wayland', '--ozone-platform=wayland']), { backend: 'wayland', relaunch: false });
  assert.deepEqual(displayBackend('linux', ['--ozone-platform', 'x11']), { backend: 'x11', relaunch: false });
  assert.deepEqual(displayBackend('linux', ['--native-wayland', '--ozone-platform=x11']), { backend: 'x11', relaunch: false });
});
test('other operating systems do not relaunch', () => {
  for (const platform of ['darwin', 'win32']) assert.deepEqual(displayBackend(platform, []), { backend: platform, relaunch: false });
});
