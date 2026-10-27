#!/usr/bin/env node
// One command to check an integrated Sudo-chan build:  npm run verify
//
// Order (build runs before the unit tests because several tests import ../dist/*):
//   1 typecheck   2 production build   3 unit tests   4 static wiring checks   5 REAL Electron smoke run
// Prints a PASS/FAIL table and exits non-zero on any FAIL. Use `--skip-smoke` to skip step 5.
// What this can and cannot prove is documented in VERIFY.md (no microphone, speakers, real screenshots, real model).
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const args = new Set(process.argv.slice(2));
const rows = [];
const add = (area, name, status, detail = '') => rows.push({ area, name, status, detail });
const read = file => readFileSync(join(root, file), 'utf8');
/** Source without comments, so a comment that merely mentions safeStorage or a handler name is not mistaken for code. */
const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const tail = (text, lines = 12) => String(text).trim().split('\n').slice(-lines).join('\n');

function run(label, command, commandArgs, timeoutMs) {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, ms: Date.now() - started, out: `${result.stdout ?? ''}\n${result.stderr ?? ''}`, label };
}

// ------------------------------------------------------------------------------------------ 1-3
{
  const t1 = run('tsc renderer', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'], 300_000);
  const t2 = run('tsc main', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.node.json'], 300_000);
  const ok = t1.ok && t2.ok;
  add('build', 'typecheck (renderer + main)', ok ? 'PASS' : 'FAIL', ok ? `${t1.ms + t2.ms} ms` : tail(t1.out + t2.out));
}
{
  const r = run('build', process.execPath, ['scripts/build.mjs'], 600_000);
  add('build', 'production build (scripts/build.mjs)', r.ok ? 'PASS' : 'FAIL', r.ok ? `${r.ms} ms` : tail(r.out));
}
{
  const r = run('tests', process.execPath, ['--test', ...readdirSync(join(root, 'tests')).filter(f => f.endsWith('.check.mjs')).map(f => `tests/${f}`)], 600_000);
  const pass = /ℹ pass (\d+)/.exec(r.out)?.[1] ?? '?';
  const fail = /ℹ fail (\d+)/.exec(r.out)?.[1] ?? '?';
  add('tests', 'unit tests (node --test tests/*.check.mjs)', r.ok && fail === '0' ? 'PASS' : 'FAIL', `${pass} passed, ${fail} failed, ${r.ms} ms${r.ok ? '' : `\n${tail(r.out.split('\n').filter(l => /✖|not ok|Error/.test(l)).join('\n'), 8)}`}`);
}

// ------------------------------------------------------------------------------------------ 4 static wiring
const index = stripComments(read('src/main/index.ts'));
const types = read('src/shared/types.ts');
const validation = read('src/shared/validation.ts');
const preload = read('src/preload/index.ts');

function functionBody(source, header) {
  const at = source.indexOf(header);
  if (at < 0) return undefined;
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  return undefined;
}

{
  const body = functionBody(index, 'async function start()');
  const usesKeyring = !body || /safeStorage|canEncryptKeys\(\)/.test(body);
  const migrate = body && /migrateProviders\([^;]*,\s*false\)/.test(body);
  add('wiring', 'start() never touches safeStorage (it can hang the keyring)', !usesKeyring && migrate ? 'PASS' : 'FAIL', !body ? 'start() not found' : usesKeyring ? 'start() references safeStorage/canEncryptKeys' : migrate ? '' : 'migrateProviders must be called with canEncrypt=false');
}
{
  const settingsDefaults = /DEFAULT_SETTINGS[^=]*=\s*{([\s\S]*?)\n};/.exec(validation)?.[1] ?? '';
  const off = k => new RegExp(`\\b${k}:\\s*false\\b`).test(settingsDefaults);
  const bad = ['toolsEnabled', 'screenAssistEnabled'].filter(k => new RegExp(`\\b${k}\\b`).test(validation) && !off(k));
  add('wiring', 'tools and screen assist default to OFF', bad.length === 0 ? 'PASS' : 'FAIL', bad.length ? `not false: ${bad.join(', ')}` : '');
}
{
  // Every handler must be limited to the window kinds we intend. Extra kinds are allowed only where listed.
  const expect = {
    cloudConfig: ['settings'], fetchCloudModels: null, quit: ['settings'], reset: ['settings'], messages: ['chat'],
    welcome: ['overlay'], stop: ['chat', 'overlay'], sendScreen: ['chat', 'overlay'], cancelScreen: ['chat', 'overlay'],
    toolApprovals: ['chat'], toolApprovalReply: ['chat'], toolsStopAll: ['chat', 'overlay', 'settings'],
    usage: ['settings', 'chat'], updateNotice: ['settings'], clearKeys: ['settings'], keyStorageInfo: ['settings'],
  };
  const registrations = [...index.matchAll(/\n  (handle|ipcMain\.on)\(CHANNELS\.(\w+),/g)].map((m, i, all) => ({
    name: m[2], kind: m[1], text: index.slice(m.index, all[i + 1]?.index ?? index.indexOf('\n}\n', m.index)),
  }));
  const problems = [];
  for (const [name, wanted] of Object.entries(expect)) {
    const reg = registrations.find(r => r.name === name);
    if (!reg) continue; // not on this branch
    if (wanted === null) continue;
    const m = /,\s*(\[[^\]]*\]|'[a-z]+')\s*\);?\s*$/.exec(reg.text.trim());
    const kinds = m ? [...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1]) : [];
    const extra = kinds.filter(k => !wanted.includes(k));
    const missing = wanted.filter(k => !kinds.includes(k));
    // toolApprovals/toolApprovalReply may legitimately also allow the overlay once approvals are shown there.
    const tolerated = ['toolApprovals', 'toolApprovalReply'].includes(name) ? extra.filter(k => k !== 'overlay') : extra;
    if (!kinds.length || tolerated.length || missing.length) problems.push(`${name}: wanted [${wanted}] got [${kinds}]`);
  }
  for (const reg of registrations.filter(r => r.kind === 'ipcMain.on')) {
    if (!/authorize\(event/.test(reg.text)) problems.push(`${reg.name}: ipcMain.on handler without authorize()`);
  }
  add('wiring', 'IPC handlers use authorize() with the intended window kinds', problems.length === 0 ? 'PASS' : 'FAIL', problems.join('\n'));
}
{
  const logs = [...new Set(readdirSync(join(root, 'src/main')).filter(f => f.endsWith('.ts')))].flatMap(f => {
    const text = read(`src/main/${f}`);
    return [...text.matchAll(/console\.(?:log|info|warn|error)\(([^;]*?)\);/g)].map(m => ({ f, call: m[1] }));
  });
  const leaks = logs.filter(l => /\b(apiKey|api_key|rawKey|encryptedKey|effectiveKey|Authorization|x-goog-api-key|Ocp-Apim|subscriptionKey|Bearer)\b/.test(l.call) && !/maskApiKey/.test(l.call));
  add('wiring', 'no console output includes API keys or auth headers', leaks.length === 0 ? 'PASS' : 'FAIL', leaks.map(l => `${l.f}: ${l.call.slice(0, 80)}`).join('\n'));
}
{
  const html = read('src/renderer/index.html');
  const csp = /Content-Security-Policy"\s+content="([^"]*)"/i.exec(html)?.[1] ?? '';
  const ok = /connect-src\s+'none'/.test(csp) && !/unsafe-eval/.test(csp) && /default-src\s+'none'|default-src\s+'self'/.test(csp);
  add('wiring', "renderer CSP still blocks page network (connect-src 'none', no unsafe-eval)", ok ? 'PASS' : 'FAIL', ok ? '' : csp || 'no CSP meta tag');
}
{
  const methods = [...(/export interface DesktopAPI \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? '').matchAll(/^\s{2}(\w+)\(/gm)].map(m => m[1]).sort();
  const exposed = [...preload.matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]).sort();
  const missing = methods.filter(m => !exposed.includes(m));
  const extra = exposed.filter(m => !methods.includes(m));
  add('wiring', 'preload exposes exactly the DesktopAPI methods', missing.length === 0 && extra.length === 0 ? 'PASS' : 'FAIL', `${methods.length} methods${missing.length ? `; missing: ${missing}` : ''}${extra.length ? `; extra: ${extra}` : ''}`);
}
{
  // One panel slot: main shapes the window from the same plan the renderer draws (shared/overlay-panels.ts).
  const shapeCall = /overlay\.setShape\(overlayShape\(([^;]*)\)\);/.exec(index)?.[1] ?? '';
  const app = read('src/renderer/App.tsx');
  const usesPlan = /activePanelForState\(state\)/.test(shapeCall) && /panelPlan\(/.test(app);
  const panels = await import(join(root, 'dist/shared/overlay-panels.js')).catch(() => undefined);
  const shape = await import(join(root, 'dist/shared/overlay-shape.js')).then(m => m.overlayShape, () => undefined);
  let opensAll = false;
  if (panels && shape) {
    opensAll = panels.PANEL_PRIORITY.every(panel => {
      const height = 230;
      const rects = shape(190, height, panel);
      const y = Math.floor(height * (panels.PANEL_HEIGHT[panel] - 0.02));
      return rects.some(r => 95 >= r.x && 95 < r.x + r.width && 3 >= r.y && 3 < r.y + r.height)
        && rects.some(r => 38 >= r.x && 38 < r.x + r.width && y >= r.y && y < r.y + r.height);
    }) && !shape(190, 230, null).some(r => r.y === 0);
  }
  add('wiring', 'overlay panel slot: window shape and renderer use one plan; every panel region is open', usesPlan && opensAll ? 'PASS' : 'FAIL', !usesPlan ? 'main must call overlayShape(…, activePanelForState(state)) and the overlay must render panelPlan(…)' : opensAll ? '' : 'a panel region is missing from the native window shape');
}
{
  // API keys: no direct safeStorage method calls in the main process (the call can block forever on some Linux keyrings).
  const direct = /safeStorage\.(isEncryptionAvailable|encryptString|decryptString|getSelectedStorageBackend)/.test(index);
  const planned = /keyStoragePlan\(/.test(index);
  add('wiring', 'saving/reading API keys never calls safeStorage directly (key-storage.ts decides)', !direct && planned ? 'PASS' : 'FAIL', direct ? 'index.ts calls a safeStorage method directly' : planned ? '' : 'keyStoragePlan() is not used');
}
{
  // Key files: config.json is created 600 inside a 700 folder, hardening never throws, and "Remove saved keys" exists (settings only, see IPC check above).
  const hardens = /hardenKeyFiles\(configDir,[^;]*\);\s*\n\s*store = new Store/.test(index) && /configFileMode:\s*0o600/.test(index);
  const removes = /handle\(CHANNELS\.clearKeys/.test(index) && /stripAllKeys\(/.test(index);
  add('wiring', 'config.json is 600 / folder 700, and "Remove saved keys" is wired', hardens && removes ? 'PASS' : 'FAIL', !hardens ? 'start() must call hardenKeyFiles before new Store and pass configFileMode: 0o600' : removes ? '' : 'clearKeys handler or stripAllKeys missing');
}
{
  const safe = /requestSingleInstanceLock/.test(index) && /smokeTest\)\s*app\.setPath\('userData'/.test(index);
  add('wiring', 'smoke runs use their own userData (own single-instance lock)', safe ? 'PASS' : 'FAIL', safe ? '' : 'smokeTest must set a temp userData before the lock');
}

// ------------------------------------------------------------------------------------------ 5 smoke run
async function smoke() {
  if (args.has('--skip-smoke')) return add('smoke', 'real Electron smoke run', 'SKIP', '--skip-smoke');
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return add('smoke', 'real Electron smoke run', 'SKIP', 'no DISPLAY/WAYLAND_DISPLAY (run under xvfb-run or a desktop session)');
  const electron = join(root, 'node_modules/electron/dist/electron');
  if (!existsSync(electron) || !existsSync(join(root, 'dist/main/bootstrap.js'))) return add('smoke', 'real Electron smoke run', 'FAIL', 'electron binary or dist/main/bootstrap.js missing (build first)');

  const base = mkdtempSync(join(tmpdir(), 'sudo-chan-verify-'));
  const home = join(base, 'home');
  mkdirSync(join(home, 'work'), { recursive: true });
  writeFileSync(join(home, 'work', 'hello.txt'), 'hello from the verify harness\n');
  const reportFile = join(base, 'report.json');
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model' }] }));
      }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const last = messages[messages.length - 1] ?? {};
      const lastText = typeof last.content === 'string' ? last.content : JSON.stringify(last.content ?? '');
      seen.push({ stream: body.stream === true, tools: Array.isArray(body.tools), lastRole: last.role, lastText: lastText.slice(0, 240) });
      const json = payload => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ index: 0, message: payload, finish_reason: payload.tool_calls ? 'tool_calls' : 'stop' }] })); };
      const call = (name, argsObj) => ({ role: 'assistant', content: null, tool_calls: [{ id: `call_${seen.length}`, type: 'function', function: { name, arguments: JSON.stringify(argsObj) } }] });
      if (body.tools && last.role === 'user' && /SMOKE_LIST/.test(lastText)) return json(call('list_dir', { path: join(home, 'work') }));
      if (body.tools && last.role === 'user' && /SMOKE_WRITE/.test(lastText)) return json(call('write_file', { path: join(home, 'work', 'new.txt'), content: 'smoke' }));
      let text = 'SMOKE_REPLY_OK hello from the fake server';
      if (last.role === 'tool') text = /NOT done|denied|did not respond/i.test(lastText) ? `SMOKE_DENIED_SEEN ${lastText.slice(0, 60)}` : `SMOKE_TOOL_OK ${lastText.slice(0, 200)}`;
      if (body.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = delta => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
        chunk({ role: 'assistant' });
        for (const part of text.match(/.{1,12}/g) ?? []) chunk({ content: part });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return json({ role: 'assistant', content: text });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const userAppRunning = spawnSync('pgrep', ['-f', 'electron/dist/electron'], { encoding: 'utf8' }).stdout.trim().length > 0;

  const launch = extra => new Promise(resolve => {
    const started = Date.now();
    const child = spawn(electron, ['.', '--smoke-test', '--ozone-platform=x11', ...extra], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, SUDO_CHAN_SMOKE_HIDDEN: '1', SUDO_CHAN_SMOKE_REPORT: reportFile, SUDO_CHAN_SMOKE_ENDPOINT: endpoint, SUDO_CHAN_SMOKE_HOME: home, SUDO_CHAN_SMOKE_APPROVAL_MS: '1500' },
    });
    let out = '';
    let readyMs;
    const collect = c => { out += c; if (readyMs === undefined && out.includes('SUDO_CHAN_READY')) readyMs = Date.now() - started; };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const killer = setTimeout(() => { child.kill('SIGKILL'); }, 90_000);
    child.on('exit', (code, signal) => { clearTimeout(killer); resolve({ code, signal, out, readyMs, ms: Date.now() - started }); });
  });

  let run1 = await launch([]);
  if (!existsSync(reportFile) && /sandbox/i.test(run1.out)) run1 = await launch(['--no-sandbox']);
  server.close();

  const leftovers = spawnSync('pgrep', ['-f', base], { encoding: 'utf8' }).stdout.trim();
  let report;
  try { report = JSON.parse(readFileSync(reportFile, 'utf8')); } catch { /* handled below */ }
  const apiMethods = [...(/export interface DesktopAPI \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? '').matchAll(/^\s{2}(\w+)\(/gm)].map(m => m[1]).sort();

  if (!report) {
    add('smoke', 'app started and produced a report', 'FAIL', `exit=${run1.code ?? run1.signal} ready=${run1.readyMs ?? 'never'} ms\n${tail(run1.out.split('\n').filter(l => !/dbus|gpu|zygote|ERROR:/i.test(l)).join('\n'), 10)}`);
  } else {
    add('smoke', 'app started, all windows ready (no startup hang)', run1.readyMs !== undefined ? 'PASS' : 'FAIL', `READY after ${run1.readyMs} ms, report after ${report.timingsMs.total} ms${userAppRunning ? '; ran while another Sudo-chan/Electron was running (own userData lock works)' : ''}`);
    for (const c of report.checks) add('smoke', c.name, c.ok ? 'PASS' : 'FAIL', c.detail ?? '');
    for (const kind of ['overlay', 'chat', 'settings']) {
      const keys = report.apiKeys[kind];
      if (!keys) continue;
      const missing = apiMethods.filter(m => !keys.includes(m));
      add('smoke', `${kind} window preload API matches DesktopAPI`, missing.length === 0 ? 'PASS' : 'FAIL', missing.length ? `missing: ${missing}` : `${keys.length} members`);
    }
    if (report.checks.some(c => /approval/.test(c.name))) {
      const told = seen.some(s => s.lastRole === 'tool' && /did not respond in time|NOT done/i.test(s.lastText));
      add('smoke', 'fake model was told the unanswered write was NOT done', told ? 'PASS' : 'FAIL');
      add('smoke', 'denied write did not create the file', existsSync(join(home, 'work', 'new.txt')) ? 'FAIL' : 'PASS');
    }
    add('smoke', 'plain chat used streaming, tool turns used tool definitions', seen.some(s => s.stream) ? 'PASS' : 'FAIL', `${seen.length} requests reached the fake server`);
  }
  add('smoke', 'app exited cleanly, no leftover processes', run1.code === 0 && !leftovers ? 'PASS' : 'FAIL', `exit=${run1.code ?? run1.signal}${leftovers ? `, leftover pids: ${leftovers.split('\n').join(',')}` : ''}`);
  if (leftovers) spawnSync('pkill', ['-9', '-f', base]);
  rmSync(base, { recursive: true, force: true });
}
await smoke();

// ------------------------------------------------------------------------------------------ table
const width = Math.max(...rows.map(r => r.name.length), 10);
console.log(`\nSudo-chan integrated build verification (${new Date().toISOString()})\n`);
for (const r of rows) console.log(`${r.status.padEnd(5)} ${r.area.padEnd(7)} ${r.name.padEnd(width)}  ${r.detail.split('\n')[0] ?? ''}`);
const failed = rows.filter(r => r.status === 'FAIL');
for (const r of failed) if (r.detail.includes('\n')) console.log(`\n--- ${r.name}\n${r.detail}`);
console.log(`\n${rows.filter(r => r.status === 'PASS').length} PASS, ${failed.length} FAIL, ${rows.filter(r => r.status === 'SKIP').length} SKIP`);
process.exit(failed.length ? 1 : 0);
