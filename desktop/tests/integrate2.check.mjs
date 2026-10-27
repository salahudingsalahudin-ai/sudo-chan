import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSystemPrompt } from '../dist/main/local-ai.js';
import { panelPlan, wantedPanels, activePanelForState, escapeAction, PANEL_HEIGHT, PANEL_PRIORITY } from '../src/shared/overlay-panels.ts';
import { overlayShape } from '../src/shared/overlay-shape.ts';
import { ScreenFlow } from '../src/shared/screen-flow.ts';
import { ApprovalManager } from '../src/main/tools/approval.ts';
import { keyStoragePlan, encodeKey, decodeKey } from '../src/main/key-storage.ts';
import { DEFAULT_SETTINGS } from '../src/shared/validation.ts';
import { BOT_DIMENSIONS } from '../src/shared/validation.ts';

const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const none = { approvalPending: false, screenStatus: null, captionWanted: false, speechWanted: false };
const SCREEN = ['consent', 'countdown', 'notice', 'capturing', 'sent', 'cached', null];

// ---------- panel slot ----------

test('panel slot: priority is approval > consent > countdown > notice > capturing > awareness > caption > hint > speech', () => {
  assert.deepEqual([...PANEL_PRIORITY], ['approval', 'consent', 'countdown', 'notice', 'capturing', 'awareness', 'caption', 'hint', 'speech']);
  assert.equal(panelPlan(none).active, null);
  assert.equal(panelPlan({ ...none, speechWanted: true }).active, 'speech');
  assert.equal(panelPlan({ ...none, speechWanted: true, captionWanted: true }).active, 'caption');
  assert.equal(panelPlan({ ...none, captionWanted: true, screenStatus: 'capturing' }).active, 'capturing');
  assert.equal(panelPlan({ ...none, captionWanted: true, screenStatus: 'notice' }).active, 'notice');
  assert.equal(panelPlan({ ...none, captionWanted: true, screenStatus: 'countdown' }).active, 'countdown');
  assert.equal(panelPlan({ ...none, captionWanted: true, screenStatus: 'consent' }).active, 'consent');
  assert.equal(panelPlan({ ...none, captionWanted: true, screenStatus: 'consent', approvalPending: true }).active, 'approval');
});

test('panel slot: a caption can NEVER hide an approval or a consent prompt (every combination)', () => {
  for (const screenStatus of SCREEN) {
    for (const approvalPending of [false, true]) {
      for (const speechWanted of [false, true]) {
        const plan = panelPlan({ approvalPending, screenStatus, captionWanted: true, speechWanted });
        if (approvalPending) assert.equal(plan.active, 'approval');
        else if (screenStatus === 'consent') assert.equal(plan.active, 'consent');
        else if (screenStatus === 'countdown') assert.equal(plan.active, 'countdown');
        // exactly one panel is active and the rest are queued in priority order
        assert.ok(plan.active !== null);
        const all = wantedPanels({ approvalPending, screenStatus, captionWanted: true, speechWanted });
        assert.equal(all[0], plan.active);
        assert.equal(new Set(all).size, all.length);
      }
    }
  }
});

test('panel slot: lower panels are queued and appear when the one above is gone', () => {
  const both = { ...none, approvalPending: true, screenStatus: 'consent', captionWanted: true };
  const first = panelPlan(both);
  assert.equal(first.active, 'approval');
  assert.deepEqual(first.queued, ['consent', 'caption']);
  const afterApproval = panelPlan({ ...both, approvalPending: false });
  assert.equal(afterApproval.active, 'consent');
  assert.deepEqual(afterApproval.queued, ['caption']);
  const afterConsent = panelPlan({ ...both, approvalPending: false, screenStatus: null });
  assert.equal(afterConsent.active, 'caption');
  assert.deepEqual(afterConsent.queued, []);
});

test('panel slot: "screen sent / old screen" hints are folded into the caption instead of hiding her answer', () => {
  for (const hint of ['sent', 'cached']) {
    const plan = panelPlan({ ...none, screenStatus: hint, captionWanted: true });
    assert.equal(plan.active, 'caption');
    assert.equal(plan.chip, hint);
    assert.equal(plan.queued.includes('hint'), false);
    // with no caption the hint is the panel itself
    const alone = panelPlan({ ...none, screenStatus: hint });
    assert.equal(alone.active, 'hint');
    assert.equal(alone.chip, null);
  }
  // a prompt above the caption means no chip at all
  assert.equal(panelPlan({ ...none, screenStatus: 'sent', captionWanted: true, approvalPending: true }).chip, null);
});

test('panel slot: main derives the same active panel from the published state flags', () => {
  assert.equal(activePanelForState({}), null);
  assert.equal(activePanelForState({ captionVisible: true }), 'caption');
  assert.equal(activePanelForState({ toolStatus: 'working' }), 'caption');
  assert.equal(activePanelForState({ speech: 'Hi' }), 'speech');
  assert.equal(activePanelForState({ screenStatus: 'consent', captionVisible: true }), 'consent');
  assert.equal(activePanelForState({ approvalVisible: true, screenStatus: 'consent', captionVisible: true, toolStatus: 'working', speech: 'x' }), 'approval');
  assert.equal(activePanelForState({ screenStatus: 'sent', captionVisible: true }), 'caption');
});

test('Esc only refuses or cancels the visible prompt; it never confirms anything', () => {
  assert.equal(escapeAction('approval'), 'deny-approval');
  assert.equal(escapeAction('consent'), 'decline-consent');
  assert.equal(escapeAction('countdown'), 'cancel-screen');
  assert.equal(escapeAction('capturing'), 'cancel-screen');
  for (const panel of ['notice', 'caption', 'hint', 'speech', null]) assert.equal(escapeAction(panel), null);
});

// ---------- native window shape ----------

const contains = (rects, x, y) => rects.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);

test('shape: every panel region is inside the native window shape on every bot size, and the corners still pass through', () => {
  for (const [width, height] of Object.values(BOT_DIMENSIONS)) {
    for (const panel of PANEL_PRIORITY) {
      const shape = overlayShape(width, height, panel);
      // top-middle and the bottom edge of the panel (where Allow/Deny buttons live for the tall ones)
      assert.ok(contains(shape, width / 2, 3), `${panel} top ${width}x${height}`);
      assert.ok(contains(shape, width / 2, Math.floor(height * (PANEL_HEIGHT[panel] - 0.02))), `${panel} bottom ${width}x${height}`);
      assert.ok(contains(shape, width * 0.2, Math.floor(height * (PANEL_HEIGHT[panel] - 0.02))), `${panel} left button ${width}x${height}`);
      assert.ok(contains(shape, width * 0.8, Math.floor(height * (PANEL_HEIGHT[panel] - 0.02))), `${panel} right button ${width}x${height}`);
      for (const r of shape) assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= width && r.y + r.height <= height);
      assert.equal(contains(shape, 1, 1), width * 0.02 > 1 ? false : true);
    }
    // body, grip and dock are always there
    const idle = overlayShape(width, height, null);
    for (const [x, y] of [[.5, .5], [.5, .16], [.35, .91]]) assert.ok(contains(idle, width * x, height * y));
    assert.equal(contains(idle, width / 2, 3), false);
  }
});

test('shape: tall panels (approval, consent, notice) open more room than one-line panels, and legacy callers still work', () => {
  const [w, h] = BOT_DIMENSIONS.small;
  // a point left of the bot body and grip, so only the panel region can contain it
  const x = Math.floor(w * 0.04);
  const y = Math.floor(h * 0.4);
  assert.equal(contains(overlayShape(w, h, 'caption'), x, y), false);
  assert.ok(contains(overlayShape(w, h, 'approval'), x, y));
  assert.ok(contains(overlayShape(w, h, 'consent'), x, y));
  assert.ok(contains(overlayShape(w, h, true, true), x, y));
  assert.ok(contains(overlayShape(w, h, true), w / 2, 5));
  assert.equal(contains(overlayShape(w, h, false), w / 2, 5), false);
  assert.ok(PANEL_HEIGHT.approval > PANEL_HEIGHT.consent && PANEL_HEIGHT.consent > PANEL_HEIGHT.caption);
});

test('wiring: the renderer draws one panel from the plan and main shapes the window from the same plan', () => {
  const app = read('../src/renderer/App.tsx');
  const main = read('../src/main/index.ts');
  assert.match(app, /panelPlan\(/);
  assert.match(app, /plan\.active === 'approval'/);
  assert.match(app, /plan\.active === 'caption'/);
  assert.match(app, /plan\.active === 'speech'/);
  assert.match(app, /escapeAction\(plan\.active\)/);
  assert.match(main, /overlayShape\(width, height, activePanelForState\(state\)\)/);
  // the old per-feature shape expressions are gone
  assert.doesNotMatch(main, /state\.approvalVisible \? 'approval'/);
});

// ---------- (a) wake screenshot turn while tools are ON and an approval is pending ----------

function makeFlow() {
  const statuses = [];
  const consent = { resolve: null };
  const deps = {
    now: () => 1_000_000,
    sleep: () => Promise.resolve(),
    isEnabled: () => true,
    countdownEnabled: () => false,
    hasConsent: () => false,
    saveConsent: () => {},
    askConsent: () => new Promise(resolve => { consent.resolve = resolve; }),
    cancelConsent: () => { consent.resolve?.(false); },
    setStatus: status => statuses.push(status),
    capture: async () => ({ ok: true, shot: { dataUri: 'data:image/jpeg;base64,AAAA', thumbnail: 'data:image/jpeg;base64,BB' } }),
    checkWindows: async () => ({ status: 'unknown' }),
  };
  return { flow: new ScreenFlow(deps), statuses, consent };
}

test('(a) wake screenshot turn while a tool approval is pending: approval stays on top, consent waits behind it, nothing is auto-answered', async () => {
  const closed = [];
  const approvals = new ApprovalManager({ emit: () => true, onClose: (id, decision) => closed.push([id, decision]), timeoutMs: 60_000, setTimer: () => 1, clearTimer: () => {} });
  const decision = approvals.request({ tool: 'run_command', risk: 'exec', title: 'Run a command', detail: 'ls -la' });
  assert.equal(approvals.list().length, 1);
  const { flow, statuses, consent } = makeFlow();
  const turn = flow.request('wake');
  assert.equal(statuses.at(-1), 'consent');
  // both want the slot: the approval wins, consent is queued
  const plan = panelPlan({ approvalPending: approvals.list().length > 0, screenStatus: statuses.at(-1), captionWanted: true, speechWanted: false });
  assert.equal(plan.active, 'approval');
  assert.deepEqual(plan.queued, ['consent', 'caption']);
  // nothing resolved by itself: voice cannot answer either prompt
  let settled = false;
  decision.then(() => { settled = true; });
  turn.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  // deny the approval -> consent becomes the visible panel
  approvals.respond(approvals.list()[0].id, 'deny');
  assert.equal(await decision, 'deny');
  assert.equal(panelPlan({ approvalPending: approvals.list().length > 0, screenStatus: statuses.at(-1), captionWanted: true, speechWanted: false }).active, 'consent');
  // a click on Allow lets the screenshot turn continue
  consent.resolve(true);
  const result = await turn;
  assert.equal(result.kind, 'proceed');
});

// ---------- (b) stop cancels approvals AND the screenshot flow, (e) cache cleared ----------

test('(b) a stop cancels pending approvals, a pending consent/countdown/capture and forgets the screenshot', async () => {
  const approvals = new ApprovalManager({ emit: () => true, timeoutMs: 60_000, setTimer: () => 1, clearTimer: () => {} });
  const decision = approvals.request({ tool: 'write_file', risk: 'write', title: 'Write a file', detail: '/tmp/x' });
  const { flow, statuses } = makeFlow();
  const turn = flow.request('wake');
  assert.equal(statuses.at(-1), 'consent');
  // what main's stop handler does:
  flow.cancel();
  approvals.stopAll();
  assert.equal(await decision, 'stopped');
  assert.equal((await turn).kind, 'cancelled');
  assert.equal(statuses.at(-1), null);
  assert.equal(flow.busy, false);
  assert.equal(approvals.list().length, 0);
});

test('(b) main wires every stop path to cancel the screen flow, the reply and the tools together', () => {
  const main = read('../src/main/index.ts');
  const stop = main.match(/handle\(CHANNELS\.stop,[^\n]*\n/)?.[0] ?? '';
  assert.match(stop, /cancelScreenCapture\(/);
  assert.match(stop, /conversation\.stop\(\)/);
  assert.match(stop, /stopAllTools\(\)/);
  assert.match(stop, /\['chat', 'overlay'\]/);
  const stopAll = main.match(/handle\(CHANNELS\.toolsStopAll,[^\n]*\n/)?.[0] ?? '';
  assert.match(stopAll, /cancelScreenCapture\(\)/);
  assert.match(stopAll, /stopAllTools\(\)/);
});

test('(e) the cached screenshot is dropped on stop, cancel, setting off and after two minutes, and kept only for a barge-in', async () => {
  const shot = { dataUri: 'data:image/jpeg;base64,AAAA', thumbnail: 'data:image/jpeg;base64,BB' };
  const clock = { now: 1_000_000 };
  const make = () => {
    const { flow } = makeFlow();
    flow.cache.set(shot, clock.now);
    return flow;
  };
  let flow = make();
  assert.ok(flow.cache.has(clock.now));
  flow.cancel();
  assert.equal(flow.cache.has(clock.now), false, 'stop clears');
  flow = make();
  flow.cancel(true);
  assert.equal(flow.cache.has(clock.now), true, 'barge-in keeps');
  flow = make();
  flow.disable();
  assert.equal(flow.cache.has(clock.now), false, 'setting off clears');
  flow = make();
  assert.equal(flow.cache.has(clock.now + 2 * 60 * 1000 + 1), false, 'expires after 2 minutes');
});

// ---------- (c) prompt matrix, (d) defaults ----------

test('(c) prompt matrix tools x screenshot-turn x voice stays truthful', () => {
  for (const voice of [false, true]) {
    for (const tools of [false, true]) {
      for (const toolsPaused of [false, true]) {
        const prompt = buildSystemPrompt({ voice, tools, toolsPaused });
        if (voice) {
          assert.match(prompt, /you CAN hear/i);
        } else {
          assert.match(prompt, /microphone/i);
          if (tools) {
            assert.match(prompt, /ONLY on a turn where a screenshot is attached/);
            assert.match(prompt, /NOT such a turn/);
          } else {
            assert.match(prompt, /ONLY on a turn where a screenshot is attached/);
          }
          if (toolsPaused) assert.match(prompt, /NOT available on this screenshot turn/);
          else assert.doesNotMatch(prompt, /NOT available on this screenshot turn/);
        }
        // never claims it did something a tool did not do, never claims blanket screen access
        assert.doesNotMatch(prompt, /always (see|watch) (your|the) screen/i);
      }
    }
  }
});

test('(d) tools and screen assist are OFF by default; the screenshot countdown is ON', () => {
  assert.notEqual(DEFAULT_SETTINGS.toolsEnabled, true);
  assert.notEqual(DEFAULT_SETTINGS.screenAssistEnabled, true);
  assert.notEqual(DEFAULT_SETTINGS.screenAssistCountdown, false);
  assert.equal(DEFAULT_SETTINGS.sttSpeed === undefined || DEFAULT_SETTINGS.sttSpeed === 'fast' || DEFAULT_SETTINGS.sttSpeed === 'accurate', true);
});

// ---------- (f) safeStorage ----------

test('(f) startup never calls safeStorage and no code path outside key-storage.ts can block on it', () => {
  const main = read('../src/main/index.ts');
  const startFn = main.slice(main.indexOf('async function start()'));
  assert.doesNotMatch(startFn.replace(/\/\/.*$/gm, ''), /safeStorage/);
  // index.ts never calls a safeStorage method directly; it only hands the object to key-storage under a plan
  const code = main.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /safeStorage\.(isEncryptionAvailable|encryptString|decryptString)/);
  assert.match(code, /keyStoragePlan\(/);
});

test('(f) key storage: Linux never touches safeStorage (the call can hang), Windows/macOS do; saving never throws', () => {
  assert.equal(keyStoragePlan('linux', {}), 'base64');
  assert.equal(keyStoragePlan('linux', { SUDO_CHAN_USE_KEYRING: '0' }), 'base64');
  assert.equal(keyStoragePlan('linux', { SUDO_CHAN_USE_KEYRING: '1' }), 'safeStorage');
  assert.equal(keyStoragePlan('win32', {}), 'safeStorage');
  assert.equal(keyStoragePlan('darwin', {}), 'safeStorage');
  assert.equal(keyStoragePlan('darwin', {}, true), 'base64', 'smoke runs never use the keyring');

  let touched = 0;
  const trap = { isEncryptionAvailable() { touched++; return new Promise(() => {}); }, encryptString() { touched++; throw new Error('no'); }, decryptString() { touched++; throw new Error('no'); } };
  const stored = encodeKey('gsk_test_key_123', 'base64', trap);
  assert.equal(touched, 0, 'base64 plan must not call safeStorage');
  assert.equal(decodeKey(stored, 'base64', trap), 'gsk_test_key_123');
  // an old encrypted entry cannot be read on the base64 plan, and that must not hang or throw
  assert.equal(decodeKey({ encryptedKey: 'AAAA' }, 'base64', trap), '');
  assert.equal(touched, 0);
  assert.deepEqual(encodeKey('', 'base64', trap), {});
});

test('(f) key storage on the safeStorage plan encrypts, and falls back to base64 on any failure', () => {
  const ok = { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(`enc:${v}`), decryptString: b => Buffer.from(b).toString().replace(/^enc:/, '') };
  const stored = encodeKey('secret', 'safeStorage', ok);
  assert.ok(stored.encryptedKey && !stored.rawKey);
  assert.equal(decodeKey(stored, 'safeStorage', ok), 'secret');
  const broken = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('x'); }, decryptString: () => { throw new Error('x'); } };
  const fallback = encodeKey('secret', 'safeStorage', broken);
  assert.ok(fallback.rawKey && !fallback.encryptedKey);
  assert.equal(decodeKey(fallback, 'safeStorage', broken), 'secret');
  const throwing = { isEncryptionAvailable: () => { throw new Error('boom'); }, encryptString: () => { throw new Error('x'); }, decryptString: () => '' };
  assert.ok(encodeKey('secret', 'safeStorage', throwing).rawKey);
});

// ---------- (g) settings pages ----------

test('(g) Settings shows both toggles, and every field the Settings page edits is in the dirty check and the sync effect', () => {
  const app = read('../src/renderer/App.tsx');
  assert.match(app, /toolsEnabled/);
  assert.match(app, /screenAssistEnabled/);
  assert.match(app, /Let Sudo-chan use tools/i);
  assert.match(app, /look at my screen/i);
  const dirtyStart = app.indexOf('const dirty =');
  assert.ok(dirtyStart > 0);
  const dirtyBlock = app.slice(dirtyStart, app.indexOf('useEffect(() => setSettings(state.settings)', dirtyStart));
  const depsStart = app.indexOf('useEffect(() => setSettings(state.settings)', dirtyStart);
  const depsBlock = app.slice(depsStart, app.indexOf(']);', depsStart));
  const edited = new Set([...app.matchAll(/setSettings\(\{ \.\.\.settings, (\w+):/g)].map(m => m[1]));
  for (const field of ['toolsEnabled', 'screenAssistEnabled', 'screenAssistCountdown', 'sttSpeed', 'wakeWordEnabled', 'customWakeWord', 'wakeAliases', 'bargeInSensitivity']) {
    assert.ok(edited.has(field), `Settings should edit ${field}`);
  }
  const missing = [];
  for (const field of edited) {
    if (!new RegExp(`settings\\.${field}\\b`).test(dirtyBlock)) missing.push(`dirty:${field}`);
    if (!new RegExp(`state\\.settings\\.${field}\\b`).test(depsBlock)) missing.push(`deps:${field}`);
  }
  assert.deepEqual(missing, []);
});
