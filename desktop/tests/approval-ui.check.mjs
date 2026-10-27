import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reduceApprovals, mergeApprovals, approvalSpokenLine, approvalHeadline, approvalSecondsLeft, routeApprovalRequest, routeApprovalClose } from '../src/shared/approval-ui.ts';
import { ApprovalManager } from '../src/main/tools/approval.ts';
import { overlayShape } from '../src/shared/overlay-shape.ts';

const req = (id, extra = {}) => ({ id, tool: 'run_command', risk: 'exec', title: 'Run a command', detail: 'ls -la', expiresInMs: 60000, ...extra });
const port = (over = {}) => {
  const events = [];
  return { events, visible: () => true, ready: () => true, send: e => events.push(e), ...over };
};

test('reduceApprovals adds once and removes on close', () => {
  let list = reduceApprovals([], { type: 'request', request: req('a') });
  list = reduceApprovals(list, { type: 'request', request: req('a') });
  list = reduceApprovals(list, { type: 'request', request: req('b') });
  assert.deepEqual(list.map(r => r.id), ['a', 'b']);
  list = reduceApprovals(list, { type: 'close', id: 'a' });
  assert.deepEqual(list.map(r => r.id), ['b']);
  assert.deepEqual(reduceApprovals(list, { type: 'close', id: 'zzz' }).map(r => r.id), ['b']);
});

test('mergeApprovals keeps pulled cards first and does not duplicate', () => {
  assert.deepEqual(mergeApprovals([req('a')], [req('a'), req('b')]).map(r => r.id), ['a', 'b']);
});

test('spoken line is a one-liner that asks for a click, never claims approval', () => {
  for (const tool of ['run_command', 'write_file', 'append_file', 'open_url', 'open_app', 'read_file']) {
    const line = approvalSpokenLine({ tool });
    assert.match(line, /Allow ya Deny dabayen|ijazat/);
    assert.ok(line.length < 120);
    assert.equal(/approved|kar diya/i.test(line), false);
  }
  assert.match(approvalSpokenLine({ tool: 'run_command', elevated: true }), /zaroori/);
  assert.equal(approvalHeadline({ title: 'Run a command', elevated: true }), '⚠ Run a command');
});

test('approvalSecondsLeft counts down and never goes negative', () => {
  assert.equal(approvalSecondsLeft({ expiresInMs: 60000 }, 1000, 1000), 60);
  assert.equal(approvalSecondsLeft({ expiresInMs: 60000 }, 1000, 31000), 30);
  assert.equal(approvalSecondsLeft({ expiresInMs: 60000 }, 0, 99999), 0);
});

test('routing: overlay first, chat too if visible, chat opened only when nothing is visible', () => {
  const overlay = port();
  const chat = port();
  let opened = 0;
  const both = routeApprovalRequest(req('a'), { overlay, chat, openChat: () => { opened++; return null; } });
  assert.deepEqual(both, { shown: true, overlay: true, chat: true });
  assert.equal(opened, 0);
  assert.equal(overlay.events.length, 1);
  assert.equal(chat.events.length, 1);

  const onlyOverlay = routeApprovalRequest(req('b'), { overlay, chat: port({ visible: () => false }), openChat: () => { opened++; return null; } });
  assert.deepEqual(onlyOverlay, { shown: true, overlay: true, chat: false });

  const fresh = port();
  const none = routeApprovalRequest(req('c'), { overlay: port({ visible: () => false }), chat: null, openChat: () => { opened++; return fresh; } });
  assert.equal(opened, 1);
  assert.deepEqual(none, { shown: true, overlay: false, chat: true });
  assert.equal(fresh.events.length, 1);

  const nothing = routeApprovalRequest(req('d'), { overlay: null, chat: null, openChat: () => null });
  assert.equal(nothing.shown, false);
});

test('a window that has not loaded yet is not sent the card (it pulls the list itself)', () => {
  const loading = port({ ready: () => false });
  const out = routeApprovalRequest(req('a'), { overlay: loading, chat: null, openChat: () => null });
  assert.equal(out.shown, true);
  assert.equal(loading.events.length, 0);
});

test('both windows: an answer in one place closes the card in both, exactly once', async () => {
  const overlay = port();
  const chat = port();
  const timers = [];
  let manager;
  manager = new ApprovalManager({
    emit: request => routeApprovalRequest(request, { overlay, chat, openChat: () => null }).shown,
    onClose: id => routeApprovalClose(id, { overlay, chat }),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: () => {},
    newId: () => 'card-1',
  });
  const decision = manager.request({ tool: 'run_command', risk: 'exec', title: 'Run a command', detail: 'ls' });
  assert.equal(manager.pendingCount, 1);
  assert.equal(manager.respond('card-1', 'allow'), true);
  assert.equal(await decision, 'allow');
  assert.equal(manager.respond('card-1', 'deny'), false, 'second answer from the other window is rejected');
  assert.deepEqual(overlay.events.map(e => e.type), ['request', 'close']);
  assert.deepEqual(chat.events.map(e => e.type), ['request', 'close']);
  assert.equal(manager.pendingCount, 0);
});

test('timeout denies and closes the card in both windows', async () => {
  const overlay = port();
  const chat = port();
  const timers = [];
  const manager = new ApprovalManager({
    emit: request => routeApprovalRequest(request, { overlay, chat, openChat: () => null }).shown,
    onClose: id => routeApprovalClose(id, { overlay, chat }),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: () => {},
    newId: () => 'card-2',
  });
  const decision = manager.request({ tool: 'write_file', risk: 'write', title: 'Create a file', detail: 'x' });
  assert.equal(timers[0].ms, 60000);
  timers[0].fn();
  assert.equal(await decision, 'timeout');
  assert.deepEqual(overlay.events.at(-1), { type: 'close', id: 'card-2' });
  assert.deepEqual(chat.events.at(-1), { type: 'close', id: 'card-2' });
});

test('nothing could show the card: it is denied immediately', async () => {
  const manager = new ApprovalManager({ emit: () => false, newId: () => 'card-3', setTimer: () => 0, clearTimer: () => {} });
  assert.equal(await manager.request({ tool: 'open_app', risk: 'exec', title: 'Open', detail: 'x' }), 'deny');
});

test('the overlay window shape includes the approval panel (60% of the height) and the caption area', () => {
  const contains = (rects, x, y) => rects.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
  const w = 190;
  const h = 230;
  assert.equal(contains(overlayShape(w, h, false), 95, 5), false);
  assert.equal(contains(overlayShape(w, h, true), 95, 5), true);
  assert.equal(contains(overlayShape(w, h, 'approval'), 95, 5), true);
  assert.equal(contains(overlayShape(w, h, 'approval'), 95, h * 0.55), true);
  assert.equal(contains(overlayShape(w, h, true), 95, 5), true);
  for (const r of overlayShape(w, h, 'approval')) assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= w && r.y + r.height <= h);
});

test('voice can never approve: no speech/STT/voice module can reach the approval reply API', () => {
  const root = new URL('../src/', import.meta.url);
  for (const file of ['renderer/voice-engine.ts', 'renderer/speech.ts', 'renderer/tts-player.ts', 'renderer/lipsync.ts', 'main/stt.ts', 'shared/stop-intent.ts', 'shared/wake-word.ts', 'shared/approval-ui.ts']) {
    const text = readFileSync(new URL(file, root), 'utf8');
    assert.equal(/respondToolApproval|toolApprovalReply|\.respond\(/.test(text), false, `${file} must not answer approvals`);
  }
  const app = readFileSync(new URL('renderer/App.tsx', root), 'utf8');
  const uses = [...app.matchAll(/respondToolApproval/g)].length;
  assert.equal(uses, 3, 'only the chat card button, the overlay panel buttons and its Esc-to-deny');
  // The only keyboard path is Escape = deny (one central handler, driven by the panel slot).
  assert.match(app, /action === 'deny-approval' && approval\) void api\?\.respondToolApproval\(approval\.id, 'deny'\)/);
});

test('tool status: the runtime reports activity counts while a tool runs', async () => {
  const { ToolRuntime } = await import('../src/main/tools/runtime.ts');
  const counts = [];
  const spec = { name: 'get_system_info', risk: 'read', description: '', parameters: {}, async prepare() { return { verdict: { verdict: 'allow' }, summary: 's', title: 't', detail: 'd', run: async () => 'ok' }; } };
  const runtime = new ToolRuntime({
    specs: [spec], definitions: [], approval: { request: async () => 'deny', isAllowedForChat: () => false, stopAll() {} },
    audit: { record() {} }, isEnabled: () => true, onActivity: n => counts.push(n),
  });
  assert.equal(await runtime.execute('get_system_info', {}, 'c1', new AbortController().signal), 'ok');
  assert.deepEqual(counts, [1, 0]);
});
