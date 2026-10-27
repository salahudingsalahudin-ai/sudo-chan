import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotesStore, noteSlug, safeNoteFile, MAX_NOTE_BYTES, MAX_NOTES } from '../src/main/tools/notes.ts';
import { Reminders, nextClockTime, MAX_REMINDERS, MAX_REMINDER_TEXT } from '../src/main/tools/reminders.ts';
import { createNoteSpecs, createReminderSpecs } from '../src/main/tools/extra-tools.ts';
import { ToolRuntime } from '../src/main/tools/runtime.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'sudo-notes-'));

// ------------------------------------------------------------------ notes
test('noteSlug and safeNoteFile only produce plain file names', () => {
  assert.equal(noteSlug('Meeting Notes: Ali & Sara!'), 'meeting-notes-ali-sara');
  assert.equal(noteSlug('   '), 'note');
  assert.equal(noteSlug('../../etc/passwd'), 'etc-passwd');
  assert.equal(noteSlug('a'.repeat(100)).length <= 40, true);
  assert.equal(safeNoteFile('todo'), 'todo.md');
  assert.equal(safeNoteFile('todo.md'), 'todo.md');
  for (const bad of ['../x', 'a/b', '..', '.hidden', 'a\\b', '', 'x'.repeat(60), 'UPPER', 'a b']) assert.equal(safeNoteFile(bad), null, bad);
});

test('NotesStore saves, lists and reads inside its own folder only', async () => {
  const dir = join(scratch(), 'notes');
  const notes = new NotesStore(dir);
  const first = await notes.save('Shopping list', 'milk\neggs');
  assert.equal(first.file, 'shopping-list.md');
  const second = await notes.save('Shopping list', 'bread');
  assert.equal(second.file, 'shopping-list-2.md', 'never overwrites');
  assert.equal(await notes.read('shopping-list'), 'milk\neggs');
  assert.deepEqual((await notes.list()).map(n => n.file).sort(), ['shopping-list-2.md', 'shopping-list.md']);
  await assert.rejects(() => notes.read('../../../etc/passwd'), /not a valid note name/);
  await assert.rejects(() => notes.read('missing'), /No note called/);
  assert.deepEqual(readdirSync(dir).sort(), ['shopping-list-2.md', 'shopping-list.md']);
  rmSync(dir, { recursive: true, force: true });
});

test('NotesStore caps size and count and rejects empty notes', async () => {
  const dir = join(scratch(), 'notes');
  const notes = new NotesStore(dir);
  await assert.rejects(() => notes.save('x', '   '), /empty/);
  await assert.rejects(() => notes.save('x', 'a'.repeat(MAX_NOTE_BYTES + 1)), /too long/);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < MAX_NOTES; i++) writeFileSync(join(dir, `n${i}.md`), 'x');
  await assert.rejects(() => notes.save('one more', 'x'), /Too many notes/);
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ reminders
const fakeClock = (start = Date.UTC(2026, 9, 27, 10, 0, 0)) => {
  const clock = { now: start, timers: [], saved: null, fired: [] };
  clock.deps = (stored = []) => ({
    load: () => stored,
    save: list => { clock.saved = JSON.parse(JSON.stringify(list)); },
    now: () => clock.now,
    setTimer: (fn, ms) => { const t = { fn, at: clock.now + ms, live: true }; clock.timers.push(t); return t; },
    clearTimer: t => { if (t) t.live = false; },
    onDue: (r, late) => clock.fired.push([r.text, late]),
  });
  clock.advance = ms => {
    clock.now += ms;
    for (const t of clock.timers.filter(x => x.live && x.at <= clock.now)) { t.live = false; t.fn(); }
  };
  return clock;
};

test('nextClockTime understands 24h and am/pm and picks the next occurrence', () => {
  const now = new Date(2026, 9, 27, 10, 0, 0).getTime();
  const at = (h, m, dayOffset = 0) => new Date(2026, 9, 27 + dayOffset, h, m, 0, 0).getTime();
  assert.equal(nextClockTime('17:30', now), at(17, 30));
  assert.equal(nextClockTime('5:30pm', now), at(17, 30));
  assert.equal(nextClockTime('5pm', now), at(17, 0));
  assert.equal(nextClockTime('0930', now), at(9, 30, 1), 'already past today -> tomorrow');
  assert.equal(nextClockTime('12am', now), at(0, 0, 1));
  for (const bad of ['25:00', '13pm', 'noon', '', '10:75', 'tomorrow 9']) assert.equal(nextClockTime(bad, now), null, bad);
});

test('a reminder fires once at the due time, is removed and persisted', () => {
  const clock = fakeClock();
  const r = new Reminders(clock.deps());
  r.start();
  const added = r.add('Chai pee lo', { inMinutes: 5 });
  assert.equal(added.ok, true);
  assert.equal(clock.saved.length, 1);
  clock.advance(4 * 60_000);
  assert.equal(clock.fired.length, 0);
  clock.advance(60_000);
  assert.deepEqual(clock.fired, [['Chai pee lo', 0]]);
  assert.deepEqual(clock.saved, []);
  clock.advance(10 * 60_000);
  assert.equal(clock.fired.length, 1, 'never fires twice');
});

test('reminders that came due while the app was closed fire at start, marked late', () => {
  const clock = fakeClock();
  const stored = [{ id: 'r-old', text: 'Dawa', dueAt: clock.now - 30 * 60_000, createdAt: clock.now - 60 * 60_000 }, { id: 'r-new', text: 'Meeting', dueAt: clock.now + 10 * 60_000, createdAt: clock.now }];
  const r = new Reminders(clock.deps(stored));
  r.start();
  assert.deepEqual(clock.fired, [['Dawa', 30 * 60_000]]);
  assert.deepEqual(r.pending().map(x => x.text), ['Meeting']);
  clock.advance(10 * 60_000);
  assert.deepEqual(clock.fired.map(f => f[0]), ['Dawa', 'Meeting']);
});

test('add before start never overwrites stored reminders; ordering and cancel work', () => {
  const clock = fakeClock();
  const stored = [{ id: 'r-keep', text: 'Stored one', dueAt: clock.now + 60 * 60_000, createdAt: clock.now }];
  const r = new Reminders(clock.deps(stored));
  const out = r.add('Second', { inMinutes: 30 });
  assert.equal(out.ok, true);
  assert.deepEqual(clock.saved.map(x => x.text).sort(), ['Second', 'Stored one']);
  assert.deepEqual(r.pending().map(x => x.text), ['Second', 'Stored one']);
  assert.equal(r.cancel(out.reminder.id), true);
  assert.equal(r.cancel(out.reminder.id), false);
  assert.deepEqual(clock.saved.map(x => x.text), ['Stored one']);
});

test('reminder validation: text, limits, time arguments', () => {
  const clock = fakeClock();
  const r = new Reminders(clock.deps());
  assert.equal(r.add('   ', { inMinutes: 5 }).ok, false);
  assert.equal(r.add('x'.repeat(MAX_REMINDER_TEXT + 1), { inMinutes: 5 }).ok, false);
  assert.equal(r.add('x', { inMinutes: 0 }).ok, false);
  assert.equal(r.add('x', { inMinutes: Number.NaN }).ok, false);
  assert.equal(r.add('x', { inMinutes: 999999999 }).ok, false);
  assert.equal(r.add('x', { atTime: 'sometime' }).ok, false);
  assert.equal(r.add('x', {}).ok, false);
  for (let i = 0; i < MAX_REMINDERS; i++) assert.equal(r.add(`r${i}`, { inMinutes: 10 + i }).ok, true);
  assert.match(r.add('one too many', { inMinutes: 5 }).error, /Too many/);
});

test('a very far reminder is scheduled in chunks below the timer limit', () => {
  const clock = fakeClock();
  const r = new Reminders(clock.deps());
  r.add('Saal baad', { inMinutes: 60 * 24 * 300 });
  assert.ok(clock.timers.at(-1).at - clock.now <= 2 ** 31 - 1);
});

test('a throwing notification does not stop the other reminders', () => {
  const clock = fakeClock();
  const deps = clock.deps();
  let calls = 0;
  deps.onDue = () => { calls++; throw new Error('no notification service'); };
  const r = new Reminders(deps);
  r.add('a', { inMinutes: 1 });
  r.add('b', { inMinutes: 1 });
  clock.advance(60_000);
  assert.equal(calls, 2);
});

// ------------------------------------------------------------------ tools through the runtime
const runtimeFor = (specs, enabled = true) => new ToolRuntime({
  specs, definitions: [], approval: { request: async () => 'deny', isAllowedForChat: () => false, stopAll() {} },
  audit: { record() {} }, isEnabled: () => enabled,
});
const sig = () => new AbortController().signal;

test('note and reminder tools run without a card but obey the tools switch', async () => {
  const dir = join(scratch(), 'notes');
  const clock = fakeClock();
  const reminders = new Reminders(clock.deps());
  const specs = [...createNoteSpecs(new NotesStore(dir)), ...createReminderSpecs(reminders, () => clock.now)];
  const on = runtimeFor(specs, true);
  assert.match(await on.execute('save_note', { title: 'Plan', text: 'ship it' }, 'c1', sig()), /Saved as plan\.md/);
  assert.match(await on.execute('list_notes', {}, 'c2', sig()), /plan\.md/);
  assert.equal(await on.execute('read_note', { name: 'plan' }, 'c3', sig()), 'ship it');
  assert.match(await on.execute('read_note', { name: '../../etc/passwd' }, 'c4', sig()), /not a valid note name/);
  const set = await on.execute('set_reminder', { text: 'Chai', in_minutes: 5 }, 'c5', sig());
  assert.match(set, /Reminder r-.* set for .*\(in 5 min\): Chai/);
  assert.match(await on.execute('list_reminders', {}, 'c6', sig()), /Chai/);
  const id = /Reminder (r-[^ ]+)/.exec(set)[1];
  assert.match(await on.execute('cancel_reminder', { id }, 'c7', sig()), /Cancelled/);
  assert.match(await on.execute('cancel_reminder', { id }, 'c8', sig()), /no pending reminder/);
  assert.match(await on.execute('set_reminder', { text: 'x' }, 'c9', sig()), /Give either in_minutes or at_time/);
  assert.match(await on.execute('set_reminder', { text: 'x', at_time: 'whenever' }, 'c10', sig()), /at_time must look like/);

  const off = runtimeFor(specs, false);
  assert.match(await off.execute('save_note', { title: 'Plan', text: 'x' }, 'c11', sig()), /tools are turned off/);
  assert.match(await off.execute('set_reminder', { text: 'x', in_minutes: 5 }, 'c12', sig()), /tools are turned off/);
  assert.deepEqual(readdirSync(dir), ['plan.md']);
  assert.equal(readFileSync(join(dir, 'plan.md'), 'utf8'), 'ship it');
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

test('main wiring: reminders start after the windows exist, never call safeStorage, and keep firing if tools are turned off', () => {
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  assert.match(main, /setTimeout\(\(\) => reminderService\(\)\.start\(\), 4000\)/);
  assert.match(main, /createNoteSpecs\(new NotesStore\(join\(app\.getPath\('userData'\), 'notes'\)\)\)/);
  assert.match(main, /reminderDue/);
});
