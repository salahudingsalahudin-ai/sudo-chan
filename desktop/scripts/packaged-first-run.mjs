#!/usr/bin/env node
// TEST-ONLY: first-launch journey of a PACKAGED Sudo-chan (the deb's /opt payload, an extracted AppImage, release/linux-unpacked).
//
//   flock <heavy.lock> node scripts/packaged-first-run.mjs <path-to-packaged-binary> [shots-dir]
//
// Unlike `npm run verify -- --packaged=...` (a --smoke-test run, which by design never shows the wizard and uses its own userData),
// this starts the app the way a user does (NO --smoke-test) with
//   * a brand new --user-data-dir and a temp HOME / XDG_CONFIG_HOME (never ~/.config/Sudo-chan, no single-instance clash),
//   * --remote-debugging-port on 127.0.0.1 so this script can read the windows (Chrome DevTools Protocol),
// and checks run 1 (fresh userData => the setup wizard is open, everything risky is off, file modes) and run 2 (same folder
// after setup is marked done => no wizard). It quits the app through the app's own quit button and checks the exit code and leftovers.
// The windows ARE shown on the screen for a few seconds (the wizard is a real window). The app's update check starts 20 s after launch,
// and this script quits before that, so nothing touches the network. No provider key exists, so no provider call is possible.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const binary = resolve(process.argv[2] ?? '');
const shotsDir = process.argv[3] ? resolve(process.argv[3]) : undefined;
if (!process.argv[2] || !existsSync(binary)) { console.error('usage: packaged-first-run.mjs <packaged binary> [shots dir]'); process.exit(2); }
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const rows = [];
const add = (name, ok, detail = '') => { rows.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mode = path => (statSync(path).mode & 0o777).toString(8);

const base = mkdtempSync(join(tmpdir(), 'sudo-chan-firstrun-'));
const home = join(base, 'home');
const userData = join(base, 'userData');
mkdirSync(join(home, '.config'), { recursive: true });

const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

async function launch(extra = []) {
  const port = await freePort();
  const started = Date.now();
  const child = spawn(binary, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--ozone-platform=x11', ...extra], {
    cwd: dirname(binary),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share') },
  });
  let out = '';
  child.stdout.on('data', c => (out += c));
  child.stderr.on('data', c => (out += c));
  const exit = new Promise(res => child.on('exit', (code, signal) => res({ code, signal })));
  return { child, port, started, exit, log: () => out };
}

async function targets(port) {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return []; }
}
const kindOf = t => { try { return new URL(t.url).hash.slice(1); } catch { return ''; } };

async function cdp(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('ws error')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(res => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  return {
    eval: async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; },
    shot: async file => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(file, Buffer.from(r.result.data, 'base64')); },
    close: () => ws.close(),
  };
}

/** Wait until pages of all wanted kinds exist and have finished loading. */
async function waitForPages(run, kinds, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const list = (await targets(run.port)).filter(t => t.type === 'page');
    const found = Object.fromEntries(kinds.map(k => [k, list.find(t => kindOf(t) === k)]));
    if (kinds.every(k => found[k])) {
      const ready = [];
      for (const k of kinds) { const c = await cdp(found[k]); ready.push((await c.eval('document.readyState')) === 'complete'); c.close(); }
      if (ready.every(Boolean)) return { found, ms: Date.now() - run.started };
    }
    if (Date.now() > end) return { found, ms: undefined, list };
    await sleep(200);
  }
}

function x11Classes(pid) {
  const tree = spawnSync('xwininfo', ['-root', '-tree'], { encoding: 'utf8' }).stdout ?? '';
  const ids = [...tree.matchAll(/^\s+(0x[0-9a-f]+) /gm)].map(m => m[1]);
  const out = [];
  for (const id of ids) {
    const p = spawnSync('xprop', ['-id', id, '_NET_WM_PID', 'WM_CLASS'], { encoding: 'utf8' }).stdout ?? '';
    if (new RegExp(`_NET_WM_PID\\(CARDINAL\\) = ${pid}\\b`).test(p)) { const m = /WM_CLASS\(STRING\) = (.*)/.exec(p); if (m) out.push(`${m[1]}  (${(new RegExp(`${id} (\"[^\"]*\"|\\(has no name\\))`).exec(tree)?.[1] ?? '').slice(0, 40)})`); }
  }
  return [...new Set(out)];
}

function recordingApps() {
  const r = spawnSync('pactl', ['list', 'source-outputs'], { encoding: 'utf8' });
  if (r.status !== 0) return undefined;
  return (r.stdout.match(/application\.name = "([^"]*)"/g) ?? []).map(s => s.slice(19, -1));
}

async function quit(run, kind) {
  let t = (await targets(run.port)).find(x => x.type === 'page' && kindOf(x) === kind);
  if (!t) { // quit() is allowed from the Settings window only: open it first
    const o = (await targets(run.port)).find(x => x.type === 'page' && kindOf(x) === 'overlay');
    if (o) { const c = await cdp(o); await c.eval('window.companion.openSettings()'); c.close(); }
    for (let i = 0; i < 40 && !t; i++) { await sleep(250); t = (await targets(run.port)).find(x => x.type === 'page' && kindOf(x) === kind); }
  }
  if (t) { const c = await cdp(t); c.eval('window.companion.quit()').catch(() => {}); await sleep(300); c.close(); }
  const result = await Promise.race([run.exit, sleep(15000).then(() => 'timeout')]);
  if (result === 'timeout') { run.child.kill('SIGKILL'); return { code: 'timeout' }; }
  return result;
}

let run1 = await launch();
let pages = await waitForPages(run1, ['overlay', 'settings'], 45000);
if (!pages.ms && /sandbox/i.test(run1.log())) {
  // Same fallback `verify` has: an unpacked build without the SUID sandbox helper and without user namespaces.
  console.log('note: started without --no-sandbox failed, retrying with --no-sandbox');
  run1.child.kill('SIGKILL'); await run1.exit;
  rmSync(userData, { recursive: true, force: true });
  run1 = await launch(['--no-sandbox']);
  pages = await waitForPages(run1, ['overlay', 'settings'], 45000);
}
add('run 1: overlay + settings (wizard) windows created and loaded', Boolean(pages.ms), pages.ms ? `${pages.ms} ms after launch` : `not found; ${(pages.list ?? []).map(t => t.url).join(' | ')}\n${run1.log().slice(-600)}`);
let exit1;
if (pages.ms) {
  const overlay = await cdp(pages.found.overlay);
  const settings = await cdp(pages.found.settings);
  const state = JSON.parse(await overlay.eval('window.companion.getState().then(s => JSON.stringify({ setupActive: s.setupActive, voice: s.voiceCallActive, paused: s.paused, platform: s.platform, s: s.settings }))'));
  add('FIRST RUN: fresh userData => setupActive is true', state.setupActive === true);
  add('FIRST RUN: onboarding not yet done, started at the welcome step', state.s.onboardingDone !== true && state.s.onboardingStep === 'welcome', `step=${state.s.onboardingStep}`);
  add('FIRST RUN: microphone off (wake word off, no live call)', state.s.wakeWordEnabled === false && state.voice === false, `wakeWordEnabled=${state.s.wakeWordEnabled} voiceCallActive=${state.voice}`);
  add('FIRST RUN: tools, screen help and live awareness default OFF', state.s.toolsEnabled === false && state.s.screenAssistEnabled === false && (!state.s.liveAwareness || state.s.liveAwareness === 'off'), `tools=${state.s.toolsEnabled} screen=${state.s.screenAssistEnabled} awareness=${state.s.liveAwareness}`);
  const heading = await settings.eval(`document.querySelector('.wiz-stage h1')?.textContent || ''`);
  add('wizard shows its welcome screen', /Sudo-chan/.test(heading), heading);
  await sleep(700);
  const apps = recordingApps();
  add('no program is recording from a microphone (pactl source-outputs)', apps === undefined ? true : !apps.some(a => /chromium|electron|sudo/i.test(a)), apps === undefined ? 'pactl not available: not checked' : `recording apps: ${apps.join(', ') || 'none'}`);
  const classes = x11Classes(run1.child.pid);
  // Window class must equal the .desktop file's StartupWMClass (package.json build.linux.desktop.entry) and desktopName, or the app menu and the dock do not link the window to its icon.
  const wantClass = process.env.EXPECT_WM_CLASS ?? 'sudo-chan';
  add(`X11 window class is "${wantClass}" (= StartupWMClass), not the npm package name`, classes.some(c => c.startsWith(`"${wantClass}", "${wantClass}"`)) && !classes.some(c => /sudo-chan-desktop/.test(c)), classes.join(' ; ') || 'no X11 window found (Wayland-native?)');
  if (shotsDir) { await settings.shot(join(shotsDir, 'packaged-first-run-welcome.png')); }
  const dirBefore = existsSync(userData) ? mode(userData) : 'missing';
  // mark the wizard done the way the last screen does: through the Settings window's saveSettings
  const saved = await settings.eval(`window.companion.saveSettings({ onboardingDone: true }, 'settings').then(r => JSON.stringify(r))`);
  await sleep(500);
  const cfg = join(userData, 'config.json');
  add('after the first save: config.json is 600 and the folder is 700', existsSync(cfg) && mode(cfg) === '600' && mode(userData) === '700', `config.json=${existsSync(cfg) ? mode(cfg) : 'missing'} folder=${mode(userData)} (folder before save: ${dirBefore}); save result ${saved}`);
  const after = JSON.parse(await overlay.eval('window.companion.getState().then(s => JSON.stringify({ setupActive: s.setupActive, done: s.settings.onboardingDone }))'));
  add('onboardingDone saved', after.done === true, `setupActive=${after.setupActive}`);
  settings.close(); overlay.close();
  const quitElapsed = Date.now() - run1.started;
  exit1 = await quit(run1, 'settings');
  add('run 1: quit from the app, exit code 0, quit before the 20 s update check', exit1.code === 0 && quitElapsed < 20000, `exit=${exit1.code ?? exit1.signal} after ${quitElapsed} ms`);
} else {
  run1.child.kill('SIGKILL');
}
await sleep(500);
add('run 1: no leftover processes', (spawnSync('pgrep', ['-f', userData], { encoding: 'utf8' }).stdout.trim() === ''));

// ---- run 2: same folder, setup done => no wizard
const run2 = await launch();
const pages2 = await waitForPages(run2, ['overlay'], 45000);
if (pages2.ms) {
  await sleep(3500); // the wizard (if wrongly open) is opened 500 ms after the overlay is ready
  const overlay = await cdp(pages2.found.overlay);
  const s = JSON.parse(await overlay.eval('window.companion.getState().then(s => JSON.stringify({ setupActive: s.setupActive, wake: s.settings.wakeWordEnabled }))'));
  const settingsOpen = (await targets(run2.port)).some(t => t.type === 'page' && kindOf(t) === 'settings');
  add('SECOND LAUNCH (same folder, setup done): wizard does not show', s.setupActive !== true && !settingsOpen, `setupActive=${s.setupActive} settingsWindowOpen=${settingsOpen}`);
  overlay.close();
  const exit2 = await quit(run2, 'settings');
  add('run 2: quit from the app, exit code 0', exit2.code === 0, `exit=${exit2.code ?? exit2.signal}`);
} else {
  add('run 2: overlay window created', false, run2.log().slice(-500));
  run2.child.kill('SIGKILL');
}
await sleep(500);
add('run 2: no leftover processes', (spawnSync('pgrep', ['-f', userData], { encoding: 'utf8' }).stdout.trim() === ''));

rmSync(base, { recursive: true, force: true });
const failed = rows.filter(r => !r.ok).length;
console.log(`\n${rows.length - failed} PASS, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
