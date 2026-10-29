#!/usr/bin/env node
// TEST-ONLY: takes PNG screenshots of every first-run setup wizard screen, for people to look at (and for a reviewer to read).
//
//   flock <heavy.lock> node_modules/electron/dist/electron --ozone-platform=x11 scripts/onboarding-shots.mjs [outDir] [--app=<dir or app.asar>]
//
// `--app=release/linux-unpacked/resources/app.asar` (or an extracted app folder) runs the PACKAGED app code instead of ./dist: the
// installer-e2e check that the wizard also works from inside the asar with its packed node_modules. It is still the stock Electron binary.
//
// (needs the built app: npm run build). It runs the real built main process inside this Electron process, with
//   * an ISOLATED temp userData folder (never ~/.config/Sudo-chan, no single-instance clash with a running Sudo-chan),
//   * the global shortcut disabled and every fetch() refused (no network, no real provider call),
//   * a fake microphone (an oscillator) or a refusing one, injected into the pages for the mic screens,
// then steps through the wizard on its own and saves webContents.capturePage() PNGs. Nothing here ships in the app.
import { app, BrowserWindow, globalShortcut } from 'electron';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appArg = process.argv.slice(2).find(a => a.startsWith('--app='))?.slice(6);
const outDir = process.argv.slice(2).find(a => !a.startsWith('-') && !a.endsWith('.mjs')) ?? join(here, '../screenshots/wizard');
mkdirSync(outDir, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'sudo-chan-shots-'));
app.setPath('userData', join(tmp, 'userData'));
delete process.env.SUDO_CHAN_DEV_URL;
globalShortcut.register = () => false;
globalThis.fetch = () => Promise.reject(new Error('offline (screenshot script: no network)'));
app.on('window-all-closed', () => {});

const cleanup = () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(150);
  }
}
const kindOf = win => { try { return new URL(win.webContents.getURL()).hash.slice(1); } catch { return ''; } };
const windowOf = kind => BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && kindOf(w) === kind && !w.webContents.isLoading());

const page = (win, body) => win.webContents.executeJavaScript(`(async () => { ${body} })()`, true);
const shots = [];
const overflow = [];
async function shot(win, name) {
  await sleep(750); // let transitions and smooth scrolling settle
  const image = await win.webContents.capturePage();
  const file = join(outDir, `${name}.png`);
  writeFileSync(file, image.toPNG());
  const size = image.getSize();
  // No horizontal scrolling at any size: the page and the scrolling stage must fit the width.
  const hscroll = await page(win, `const d = document.documentElement; const s = document.querySelector('.wiz-scroll'); return d.scrollWidth > d.clientWidth || Boolean(s && s.scrollWidth > s.clientWidth);`);
  if (hscroll) overflow.push(name);
  shots.push(`${name}.png ${size.width}x${size.height}${hscroll ? ' HSCROLL' : ''}`);
  console.log(`[shots] ${name}.png ${size.width}x${size.height} hscroll=${hscroll}`);
}
// Click a button/radio by its visible text (exact, or "starts with" when the text ends with *).
const clickText = (win, text) => page(win, `
  const want = ${JSON.stringify(text)};
  const starts = want.endsWith('*');
  const key = starts ? want.slice(0, -1) : want;
  const els = [...document.querySelectorAll('button, [role=radio], summary')];
  const el = els.find(e => { const t = (e.textContent || '').replace(/\\s+/g, ' ').trim(); return starts ? t.startsWith(key) : t === key; });
  if (!el) return 'missing:' + want + ' among ' + els.map(e => (e.textContent || '').trim().slice(0, 24)).join('|');
  el.click();
  return 'ok';`);
const primary = win => page(win, `const b = document.querySelector('.wiz-primary'); if (!b) return 'no primary'; b.click(); return b.textContent;`);
const heading = win => page(win, `return document.querySelector('.wiz-stage h1')?.textContent || '';`);
const setInput = (win, selector, value) => page(win, `
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'missing';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';`);
// What the mic screens will find: a working microphone (a gentle tone) or a refusal with a given error name.
const fakeMic = (win, mode) => page(win, `
  window.__micMode = ${JSON.stringify(mode)};
  if (!window.__origGum) window.__origGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async () => {
    if (window.__micMode !== 'ok') { const e = new Error('fake'); e.name = window.__micMode; throw e; }
    const ctx = new AudioContext();
    const osc = ctx.createOscillator(); const gain = ctx.createGain(); const dest = ctx.createMediaStreamDestination();
    osc.frequency.value = 180; osc.connect(gain); gain.connect(dest); osc.start();
    let t = 0; setInterval(() => { t += 1; gain.gain.value = 0.08 + 0.07 * Math.sin(t / 3); }, 60);
    return dest.stream;
  };
  return 'ok';`);

async function drive() {
try {
  console.log('[shots] app ready; userData =', app.getPath('userData'));
  const win = await until(() => { const w = windowOf('settings'); return w && w.isVisible() ? w : null; }, 60000, 'the wizard window (first run)');
  win.webContents.on('console-message', () => {});
  await until(async () => (await heading(win)).length > 0, 20000, 'the first wizard screen');
  const [w, h] = win.getContentSize();
  console.log(`[shots] wizard window content ${w}x${h}`);

  // 1. welcome, both languages
  await shot(win, '01-welcome-en');
  await clickText(win, 'Roman Urdu');
  await shot(win, '01-welcome-ur');
  await clickText(win, 'English');

  // 2. microphone: idle, refused, no device, working
  await primary(win);
  await until(async () => (await heading(win)) === 'Can I hear you?', 8000, 'mic step');
  await shot(win, '02-mic-idle');
  await fakeMic(win, 'NotAllowedError');
  await primary(win);
  await sleep(400);
  await shot(win, '02-mic-denied');
  await fakeMic(win, 'NotFoundError');
  await primary(win);
  await sleep(400);
  await shot(win, '02-mic-no-device');
  await fakeMic(win, 'ok');
  await primary(win);
  await until(() => page(win, `return /I can hear you/.test(document.body.textContent) ? 'yes' : ''`), 12000, 'mic heard');
  await sleep(500);
  await shot(win, '02-mic-heard');
  // keep the real microphone of this computer closed during the run: the "keep listening" switch goes off before Next
  await page(win, `document.querySelector('.wiz-switch[aria-checked=true]')?.click(); return 'ok'`);

  // 3. her name
  await primary(win);
  await until(async () => (await heading(win)) === 'Her name', 8000, 'name step');
  await shot(win, '03-name');
  await clickText(win, 'Teach her now');
  await sleep(400);
  await shot(win, '03-name-teach');

  // 4. her brain (English), a typed fake key that is refused (no network here), and Ollama not found
  await primary(win);
  await until(async () => (await heading(win)) === 'Her brain', 8000, 'brain step');
  await shot(win, '04-brain-en');
  await setInput(win, '#wiz-key', 'gsk_this_is_not_a_real_key_0000000000');
  await sleep(200);
  await shot(win, '04-brain-key-typed');
  await clickText(win, 'Test and save');
  await until(() => page(win, `return /could not reach|not valid|did not work/i.test(document.body.textContent) ? 'yes' : ''`), 15000, 'key error');
  await shot(win, '04-brain-key-error');
  await setInput(win, '#wiz-key', '');
  await clickText(win, 'Offline, or later*');
  await sleep(300);
  await clickText(win, 'Check for Ollama');
  await until(() => page(win, `return /Ollama (was not found|found)/.test(document.body.textContent) ? 'yes' : ''`), 20000, 'ollama check');
  await shot(win, '04-brain-offline');

  // 5. privacy: all off, all on (only for the picture), the "never" list
  await primary(win);
  await until(async () => (await heading(win)) === 'Your choices', 8000, 'privacy step');
  await shot(win, '05-privacy-off');
  await page(win, `document.querySelectorAll('.wiz-switch').forEach(b => b.click()); return 'ok'`);
  await shot(win, '05-privacy-on');
  await page(win, `document.querySelectorAll('.wiz-switch').forEach(b => b.click()); return 'ok'`); // back to off before Next
  await clickText(win, 'What she never does');
  await sleep(300);
  await page(win, `document.querySelector('.wiz-never')?.scrollIntoView({ block: 'center' }); return 'ok'`);
  await shot(win, '05-privacy-never');

  // 6. try it: the demo button starts Live Talk on the desktop bot (fake mic in the bot's window too)
  await primary(win);
  await until(async () => (await heading(win)) === 'Say hello', 8000, 'try step');
  await shot(win, '06-try');
  const overlay = windowOf('overlay');
  if (overlay) await fakeMic(overlay, 'ok');
  await clickText(win, 'Start Live Talk');
  await sleep(700);
  await shot(win, '06-try-live');
  await clickText(win, 'Stop');

  // 7. done
  await primary(win);
  await until(async () => (await heading(win)) === 'You’re all set.', 8000, 'done step');
  await shot(win, '07-done-en');

  // Roman Urdu: restart from the first screen, pick the language, and photograph the same key screens
  await clickText(win, 'Back');
  for (let i = 0; i < 5; i++) await clickText(win, 'Back');
  await until(async () => /Hi, I.m Sudo-chan/.test(await heading(win)), 8000, 'welcome again');
  await clickText(win, 'Roman Urdu');
  for (let i = 0; i < 3; i++) { await primary(win); await sleep(350); }
  await until(async () => (await heading(win)) === 'Us ka dimagh', 8000, 'brain step (Roman Urdu)');
  await shot(win, '04-brain-ur');
  win.setSize(480, 560); // the smallest the wizard window can be
  await sleep(500);
  await shot(win, '04-brain-ur-min-size');
  await page(win, `document.querySelector('.wiz-stage')?.scrollIntoView(); return 'ok'`);
  win.setSize(600, 720);
  await sleep(500);
  await primary(win);
  await until(async () => (await heading(win)) === 'Aap ke faislay', 8000, 'privacy step (Roman Urdu)');
  await shot(win, '05-privacy-ur');
  await primary(win); await sleep(400); await primary(win); await sleep(400);
  await shot(win, '07-done-ur');

  // finish for real: the window must close and the app must go back to normal
  await primary(win);
  await sleep(2000);
  const state = await page(windowOf('overlay'), 'return await window.companion.getState();');
  console.log(`[shots] after finishing: setupActive=${state.setupActive} onboardingDone=${state.settings.onboardingDone} wakeWordEnabled=${state.settings.wakeWordEnabled} tools=${state.settings.toolsEnabled} screen=${state.settings.screenAssistEnabled} awareness=${state.settings.liveAwareness}`);
  console.log(`[shots] done: ${shots.length} screenshots in ${outDir}; horizontal overflow: ${overflow.length ? overflow.join(', ') : 'none'}`);
  writeFileSync(join(outDir, 'index.txt'), shots.join('\n') + '\n');
  cleanup();
  app.exit(0);
} catch (error) {
  console.error('[shots] FAILED:', error instanceof Error ? error.message : error);
  try {
    const win = windowOf('settings');
    if (win) writeFileSync(join(outDir, 'zz-failure.png'), (await win.webContents.capturePage()).toPNG());
  } catch { /* best effort */ }
  cleanup();
  app.exit(1);
}
}
// Electron emits 'ready' only after the entry module finished loading, so never `await app.whenReady()` here (it would wait forever).
if (appArg) console.log('[shots] app code from', resolve(appArg));
await import(appArg ? pathToFileURL(join(resolve(appArg), 'dist/main/index.js')).href : '../dist/main/index.js');
app.whenReady().then(drive);
