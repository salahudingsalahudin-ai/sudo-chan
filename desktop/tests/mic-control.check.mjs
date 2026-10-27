import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MIC_CONFIRM_MS, MIC_SOURCES, changedSettings, isMicSource, mergeSettings, micChangeLine, micDotArmed, micDotPress, micDotView,
  parseSaveRequest, resolveMicSource,
} from '../src/shared/mic-control.ts';
import { DEFAULT_SETTINGS, validSettings } from '../src/shared/validation.ts';

const base = { wakeEnabled: true, liveActive: false, armedAt: null, now: 10_000 };

// ---------- the dot gesture ----------
test('turning the mic ON is a single click', () => {
  assert.deepEqual(micDotPress({ ...base, wakeEnabled: false }), { action: 'enable', armedAt: null });
});
test('a single click on a listening mic only arms it, it does not turn it off', () => {
  assert.deepEqual(micDotPress(base), { action: 'arm', armedAt: 10_000 });
});
test('a second click within 3 s confirms and turns the mic off', () => {
  assert.deepEqual(micDotPress({ ...base, armedAt: 10_000, now: 10_000 + MIC_CONFIRM_MS }), { action: 'disable', armedAt: null });
  assert.deepEqual(micDotPress({ ...base, armedAt: 10_000, now: 11_200 }), { action: 'disable', armedAt: null });
});
test('a second click after 3 s starts over (arms again), never disables', () => {
  assert.deepEqual(micDotPress({ ...base, armedAt: 10_000, now: 10_000 + MIC_CONFIRM_MS + 1 }), { action: 'arm', armedAt: 13_001 });
});
test('a clock that goes backwards never counts as a confirmation', () => {
  assert.equal(micDotArmed(10_000, 9_000), false);
  assert.equal(micDotPress({ ...base, armedAt: 10_000, now: 9_000 }).action, 'arm');
});
test('during Live Talk the dot ends Live Talk and never touches the wake-word setting', () => {
  assert.deepEqual(micDotPress({ ...base, liveActive: true, armedAt: 9_000 }), { action: 'end-live', armedAt: null });
  assert.deepEqual(micDotPress({ ...base, liveActive: true, wakeEnabled: false }), { action: 'end-live', armedAt: null });
});
test('five clicks spread out over time never turn the mic off', () => {
  let armedAt = null, now = 0, disabled = 0;
  for (let i = 0; i < 5; i += 1) {
    now += 3500;
    const r = micDotPress({ wakeEnabled: true, liveActive: false, armedAt, now });
    armedAt = r.armedAt; if (r.action === 'disable') disabled += 1;
  }
  assert.equal(disabled, 0);
});

test('dot view: every state has a different mode and a plain-English tooltip', () => {
  const views = {
    listening: micDotView({ wakeEnabled: true, liveActive: false, paused: false, armed: false }),
    armed: micDotView({ wakeEnabled: true, liveActive: false, paused: false, armed: true }),
    live: micDotView({ wakeEnabled: true, liveActive: true, paused: false, armed: false }),
    paused: micDotView({ wakeEnabled: true, liveActive: false, paused: true, armed: false }),
    off: micDotView({ wakeEnabled: false, liveActive: false, paused: false, armed: false }),
  };
  for (const [mode, view] of Object.entries(views)) { assert.equal(view.mode, mode); assert.ok(view.title.length > 10 && view.title.length < 80); }
  assert.match(views.listening.title, /click twice/i);
  assert.match(views.off.title, /OFF/);
  assert.match(views.off.title, /turn it on/i);
  assert.match(views.armed.title, /again/i);
  assert.equal(new Set(Object.values(views).map(v => v.title)).size, 5);
  // The mic being OFF wins over "paused" so the slash is never hidden.
  assert.equal(micDotView({ wakeEnabled: false, liveActive: false, paused: true, armed: false }).mode, 'off');
});

// ---------- settings merge ----------
test('a patch that does not mention wakeWordEnabled keeps the current value (either way)', () => {
  for (const wake of [true, false]) {
    const current = { ...DEFAULT_SETTINGS, wakeWordEnabled: wake };
    const merged = mergeSettings(current, { botSize: 'large', ttsSpeed: 1.2 });
    assert.equal(merged.wakeWordEnabled, wake);
    assert.equal(merged.botSize, 'large');
    assert.equal(validSettings(merged), true);
  }
});
test('a stale full settings object from the Settings window is reduced to what it really changed', () => {
  const current = { ...DEFAULT_SETTINGS, wakeWordEnabled: false };            // the dot/tray turned it off meanwhile
  const staleBaseline = { ...DEFAULT_SETTINGS, wakeWordEnabled: true };        // what the form was opened with
  const edited = { ...staleBaseline, botSize: 'small' };                       // the user only changed the size
  const patch = changedSettings(staleBaseline, edited);
  assert.deepEqual(patch, { botSize: 'small' });
  const merged = mergeSettings(current, patch);
  assert.equal(merged.wakeWordEnabled, false);
  assert.equal(merged.botSize, 'small');
});
test('when the user really flips the switch in Settings, the patch carries it', () => {
  const patch = changedSettings(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, wakeWordEnabled: false });
  assert.deepEqual(patch, { wakeWordEnabled: false });
  assert.equal(mergeSettings(DEFAULT_SETTINGS, patch).wakeWordEnabled, false);
});
test('undefined in a patch means "unchanged"; arrays are compared by value', () => {
  assert.equal(mergeSettings({ ...DEFAULT_SETTINGS, wakeWordEnabled: false }, { wakeWordEnabled: undefined }).wakeWordEnabled, false);
  const a = { ...DEFAULT_SETTINGS, wakeAliases: ['Sid'] };
  assert.deepEqual(changedSettings(a, { ...a, wakeAliases: ['Sid'] }), {});
  assert.deepEqual(changedSettings(a, { ...a, wakeAliases: ['Sid', 'Sudo'] }), { wakeAliases: ['Sid', 'Sudo'] });
});
test('merged settings are still validated: a bad patch value is rejected, not stored', () => {
  assert.equal(validSettings(mergeSettings(DEFAULT_SETTINGS, { wakeWordEnabled: 'yes' })), false);
  assert.equal(validSettings(mergeSettings(DEFAULT_SETTINGS, { shortcut: 'rm -rf' })), false);
  assert.equal(validSettings(mergeSettings(DEFAULT_SETTINGS, { botSize: 'huge' })), false);
});

// ---------- IPC payload ----------
test('parseSaveRequest accepts {patch, source} and bare settings, and rejects junk', () => {
  assert.deepEqual(parseSaveRequest({ patch: { botSize: 'small' }, source: 'dot' }), { patch: { botSize: 'small' }, source: 'dot' });
  assert.deepEqual(parseSaveRequest({ botSize: 'small' }), { patch: { botSize: 'small' }, source: undefined });
  for (const bad of [null, undefined, 5, 'x', [], { patch: null }, { patch: 'x' }, { patch: [] }]) assert.equal(parseSaveRequest(bad), null, String(bad));
});

// ---------- source allow-list ----------
test('source allow-list is exactly dot, tray, settings, chat', () => {
  assert.deepEqual([...MIC_SOURCES], ['dot', 'tray', 'settings', 'chat']);
  for (const s of MIC_SOURCES) assert.equal(isMicSource(s), true);
  for (const s of ['', 'DOT', 'overlay', 'dot ', null, undefined, 1, {}, '__proto__', 'tray\n[mic] fake']) assert.equal(isMicSource(s), false);
});
test('a window can only claim its own source; the tray source cannot come over IPC', () => {
  assert.equal(resolveMicSource('dot', 'overlay'), 'dot');
  assert.equal(resolveMicSource('settings', 'settings'), 'settings');
  assert.equal(resolveMicSource('chat', 'chat'), 'chat');
  assert.equal(resolveMicSource('tray', 'overlay'), 'dot');
  assert.equal(resolveMicSource('settings', 'overlay'), 'dot');
  assert.equal(resolveMicSource('dot', 'settings'), 'settings');
  assert.equal(resolveMicSource('whatever', 'chat'), 'chat');
  assert.equal(resolveMicSource('dot', undefined), 'unknown');
  assert.equal(resolveMicSource(undefined, 'weird'), 'unknown');
});

// ---------- diagnostic log line ----------
test('[mic] line is produced only when wakeWordEnabled changes, in the exact format', () => {
  assert.equal(micChangeLine(true, false, 'dot'), '[mic] wakeWordEnabled true->false source=dot');
  assert.equal(micChangeLine(false, true, 'tray'), '[mic] wakeWordEnabled false->true source=tray');
  assert.equal(micChangeLine(true, false, 'settings'), '[mic] wakeWordEnabled true->false source=settings');
  assert.equal(micChangeLine(true, false, 'chat'), '[mic] wakeWordEnabled true->false source=chat');
  assert.equal(micChangeLine(true, true, 'dot'), null);
  assert.equal(micChangeLine(undefined, true, 'dot'), null);            // missing means on
  assert.equal(micChangeLine(undefined, false, 'dot'), '[mic] wakeWordEnabled true->false source=dot');
  assert.equal(micChangeLine(true, false, 'evil\nsource=dot'), '[mic] wakeWordEnabled true->false source=unknown');
});

// ---------- wiring (reads the source) ----------
const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const app = strip(readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8'));
const main = strip(readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'));

test('the mic switch is a sibling of the chat pill, never inside it', () => {
  const dock = app.slice(app.indexOf('className="overlay-dock"'), app.indexOf('</main>;', app.indexOf('className="overlay-dock"')));
  const pill = dock.slice(dock.indexOf('<button className="companion-pill"'), dock.indexOf('</button>', dock.indexOf('<button className="companion-pill"')));
  assert.ok(dock.includes('className="mic-switch"'));
  assert.ok(dock.indexOf('className="mic-switch"') < dock.indexOf('className="companion-pill"'));
  assert.equal(/mic-switch|mic-dot|wakeWordEnabled|saveSettings/.test(pill), false);
  assert.equal(/<button[^>]*mic-switch[^>]*onClick=\{pressMicDot\}/.test(dock), true);
  assert.equal(/mic-toggle/.test(app), false);
});
test('nothing in the renderer sends a whole settings object any more', () => {
  assert.equal(/saveSettings\(\{\s*\.\.\.state\.settings/.test(app), false);
  assert.equal(/saveSettings\(settings\b/.test(app), false);
  assert.ok(app.includes("changedSettings(state.settings, settings), 'settings'"));
});
test('main merges onto its current settings, logs mic changes, and keeps the authorised window kinds', () => {
  assert.ok(/mergeSettings\(state\.settings,/.test(main));
  assert.ok(/micChangeLine\(previous\.wakeWordEnabled, candidate\.wakeWordEnabled, source\)/.test(main));
  assert.ok(/saveSettings\(\{ wakeWordEnabled: item\.checked \}, 'tray'\)/.test(main));
  assert.ok(/\}, \['settings', 'chat', 'overlay'\]\);/.test(main.slice(main.indexOf('handle(CHANNELS.save'))));
  assert.equal(/\bapiKey\b/.test(main.slice(main.indexOf('micChangeLine('), main.indexOf('micChangeLine(') + 200)), false);
});
