// Installer config checks: the things that decide whether the Linux .deb / AppImage integrate with the desktop.
// Pure file checks (no Electron, no network). Found by the installer end-to-end run (desktop/INSTALLER-E2E.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const linux = pkg.build.linux;

test('window class: desktopName, the generated .desktop file name and StartupWMClass all agree (else the app menu icon does not match the window)', () => {
  // Without desktopName Electron names its window class after the npm package ("sudo-chan-desktop"), which no .desktop file matches.
  assert.equal(pkg.desktopName, `${linux.executableName}.desktop`);
  assert.equal(linux.desktop.entry.StartupWMClass, linux.executableName);
  assert.equal(linux.desktop.entry.Name, 'Sudo-chan');
});

test('icons: the Linux icon is a folder of several sizes (a single 1024 px file made the menu entry blurry or missing on some desktops)', () => {
  assert.equal(linux.icon, 'assets/linux-icons');
  const dir = join(root, linux.icon);
  const sizes = readdirSync(dir).map(f => /^(\d+)x\1\.png$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  for (const need of [16, 32, 48, 64, 128, 256, 512]) assert.ok(sizes.includes(need), `missing ${need}x${need}.png`);
  for (const f of readdirSync(dir)) assert.ok(readFileSync(join(dir, f)).subarray(1, 4).toString() === 'PNG', `${f} is not a PNG`);
  assert.ok(existsSync(join(root, 'assets/icon.png')), 'the runtime window/tray icon is still shipped');
  assert.ok(pkg.build.files.includes('assets/icon.png'));
});

test('packaging: artifact names, linux targets and the placeholder maintainer are what the website guide and release workflow expect', () => {
  assert.equal(pkg.build.artifactName, 'Sudo-chan-${version}-${os}-${arch}.${ext}');
  assert.deepEqual([...linux.target].sort(), ['AppImage', 'deb']);
  assert.match(linux.maintainer, /<noreply@sudo-chan\.vercel\.app>$/);
  assert.equal(pkg.build.publish, null);
});

test('packaging: every runtime dependency is a real "dependency" (devDependencies are never packed) and the file list drops sources, tests, maps and config.json', () => {
  assert.ok(Object.keys(pkg.dependencies).includes('electron-store'));
  for (const bad of ['electron', 'electron-builder', 'typescript', 'vite', 'esbuild']) assert.equal(bad in pkg.dependencies, false, `${bad} must stay a devDependency`);
  for (const f of ['!**/*.map', '!**/config.json', '!**/.env*', '!**/*.test.*']) assert.ok(pkg.build.files.includes(f), f);
  assert.equal(pkg.build.files.some(f => /^(src|tests|scripts)\b/.test(f)), false);
});

test('deb: depends lists the libraries Electron needs on Debian/Ubuntu', () => {
  for (const lib of ['libgtk-3-0', 'libnss3', 'libgbm1', 'libxss1', 'libxtst6', 'xdg-utils']) assert.ok(pkg.build.deb.depends.includes(lib), lib);
  // Electron links libasound.so.2 (speech and microphone); on Ubuntu 24.04 the package is called libasound2t64.
  assert.ok(pkg.build.deb.depends.includes('libasound2 | libasound2t64'));
  assert.equal(pkg.build.deb.packageCategory, 'utils');
});
