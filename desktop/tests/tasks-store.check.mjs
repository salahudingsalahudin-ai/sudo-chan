// "Aaj ka kaam": the tasks.json store, the task tools (policy, audit, validation, reminders link), the chat-window IPC wiring
// and the prompt. Nothing here touches the real app data folder: every file lives in a throw-away temp directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskFile, TaskService } from '../src/main/tasks-store.ts';
import { createReminderSpecs, createTaskSpecs } from '../src/main/tools/extra-tools.ts';
import { Reminders } from '../src/main/tools/reminders.ts';
import { ToolRuntime } from '../src/main/tools/runtime.ts';
import { describeToolCall } from '../src/main/tools/trace.ts';
import { MAX_TASKS_FILE_BYTES, emptyState, addTask } from '../src/shared/tasks.ts';
import { CHANNELS } from '../src/shared/types.ts';
import { TOOLS_PROMPT } from '../dist/main/local-ai.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = file => readFileSync(join(here, file), 'utf8');
const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const scratch = () => mkdtempSync(join(tmpdir(), 'sudo-tasks-'));
// Tuesday 27 October 2026, 15:00 local.
const NOW = new Date(2026, 9, 27, 15, 0, 0).getTime();

// ------------------------------------------------------------------ the file
test('TaskFile writes tasks.json atomically with mode 0600 and reads it back', () => {
  const dir = scratch();
  const file = new TaskFile(join(dir, 'tasks.json'));
  assert.deepEqual(file.read().state, emptyState(), 'missing file = empty list, no note');
  const state = addTask(addTask(emptyState(), { title: 'ek' }, NOW).state, { title: 'do', due: '2026-10-28T17:00', priority: 'high' }, NOW).state;
  file.write(state);
  assert.equal(statSync(file.path).mode & 0o777, 0o600);
  assert.deepEqual(file.read().state, state);
  assert.deepEqual(readdirSync(dir).sort(), ['tasks.json'], 'no temp file is left behind');
  file.write({ ...state, seq: state.seq });
  assert.equal(statSync(`${file.path}.bak`).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).sort(), ['tasks.json', 'tasks.json.bak']);
  const raw = JSON.parse(readFileSync(file.path, 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['seq', 'tasks', 'version']);
  rmSync(dir, { recursive: true, force: true });
});

test('a failed write leaves the old file untouched (temp + rename)', () => {
  const dir = scratch();
  const file = new TaskFile(join(dir, 'tasks.json'));
  const one = addTask(emptyState(), { title: 'safe' }, NOW).state;
  file.write(one);
  chmodSync(dir, 0o500);
  let threw = false;
  try { file.write(addTask(one, { title: 'lost' }, NOW).state); } catch { threw = true; }
  chmodSync(dir, 0o700);
  if (process.getuid?.() !== 0) assert.equal(threw, true, 'a read-only folder makes the write fail loudly');
  assert.deepEqual(file.read().state, one);
  rmSync(dir, { recursive: true, force: true });
});

test('corrupted file: backup is restored, the damaged file is kept aside', () => {
  const dir = scratch();
  const file = new TaskFile(join(dir, 'tasks.json'));
  const first = addTask(emptyState(), { title: 'pehla' }, NOW).state;
  file.write(first);
  file.write(first);
  writeFileSync(file.path, '{"tasks": [ {"id": "t1", ', 'utf8');
  const out = file.read();
  assert.deepEqual(out.state.tasks.map(t => t.title), ['pehla']);
  assert.match(out.note, /restored from tasks\.json\.bak/);
  assert.equal(readFileSync(join(dir, 'tasks.corrupt.json'), 'utf8'), '{"tasks": [ {"id": "t1", ');
  assert.equal(statSync(join(dir, 'tasks.corrupt.json')).mode & 0o777, 0o600);
  rmSync(dir, { recursive: true, force: true });
});

test('corrupted file without a backup starts empty and never throws', () => {
  const dir = scratch();
  const file = new TaskFile(join(dir, 'tasks.json'));
  for (const junk of ['not json at all', '', '[1,2,3]', 'null', '"text"', '\u0000\u0001']) {
    writeFileSync(file.path, junk, 'utf8');
    const out = file.read();
    assert.deepEqual(out.state, emptyState(), JSON.stringify(junk));
    assert.match(out.note, /started empty/);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('a half-valid file keeps the valid tasks and sets the damaged ones aside', () => {
  const dir = scratch();
  const file = new TaskFile(join(dir, 'tasks.json'));
  writeFileSync(file.path, JSON.stringify({ seq: 2, tasks: [{ id: 't1', title: 'good' }, { id: 'zzz', title: 'bad id' }, { id: 't2' }] }));
  const out = file.read();
  assert.deepEqual(out.state.tasks.map(t => t.id), ['t1']);
  assert.match(out.note, /kept 1 valid tasks, 2 damaged/);
  assert.equal(existsSync(join(dir, 'tasks.corrupt.json')), true);
  rmSync(dir, { recursive: true, force: true });
});

test('an oversized tasks file is not loaded', () => {
  const dir = scratch();
  const file = new TaskFile(join(dir, 'tasks.json'));
  writeFileSync(file.path, JSON.stringify({ seq: 1, tasks: [{ id: 't1', title: 'x'.repeat(MAX_TASKS_FILE_BYTES) }] }));
  const out = file.read();
  assert.deepEqual(out.state, emptyState());
  assert.match(out.note, /started empty/);
  rmSync(dir, { recursive: true, force: true });
});

test('the store keeps tasks only: it never touches config.json or key storage', () => {
  const source = stripComments(read('../src/main/tasks-store.ts')) + stripComments(read('../src/shared/tasks.ts'));
  assert.doesNotMatch(source, /config\.json|safeStorage|apiKey|api_key|Authorization|process\.env|fetch\(/);
  const main = read('../src/main/index.ts');
  assert.match(main, /join\(app\.getPath\('userData'\), 'tasks\.json'\)/);
  assert.doesNotMatch(main, /store\.(get|set)\('tasks'/, 'tasks are not stored in the config store');
});

// ------------------------------------------------------------------ the service
function memoryStorage(initial = emptyState()) {
  const box = { state: initial, writes: 0, fail: false };
  return {
    box,
    read: () => ({ state: box.state }),
    write: state => { if (box.fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); box.state = state; box.writes++; },
  };
}
const makeService = (storage = memoryStorage()) => {
  const views = [];
  const service = new TaskService({ storage, now: () => NOW, onChange: view => views.push(view) });
  return { service, storage, views };
};

test('the service saves every change once and tells the listener', () => {
  const { service, storage, views } = makeService();
  assert.equal(service.add({ title: 'a' }).ok, true);
  assert.equal(storage.box.writes, 1);
  assert.equal(views.length, 1);
  assert.equal(views[0].openCount, 1);
  assert.equal(service.find({ title: 'a' }).task.id, 't1');
  assert.equal(service.add({ title: '' }).ok, false);
  assert.equal(storage.box.writes, 1, 'a rejected change writes nothing');
});

test('a failed save is reported and the list stays as it was', () => {
  const { service, storage } = makeService();
  service.add({ title: 'keep' });
  storage.box.fail = true;
  const out = service.add({ title: 'lost' });
  assert.equal(out.ok, false);
  assert.match(out.error, /Could not save the task list \(ENOSPC\)/);
  assert.deepEqual(service.state.tasks.map(t => t.title), ['keep']);
  assert.equal(service.complete('t1').ok, false);
  assert.equal(service.state.tasks[0].status, 'todo');
});

test('a throwing listener or unreadable storage does not break the service', () => {
  const service = new TaskService({ storage: { read() { throw new Error('boom'); }, write() {} }, now: () => NOW, onChange() { throw new Error('window closed'); } });
  assert.deepEqual(service.state.tasks, []);
  assert.match(service.loadNote, /started empty/);
  assert.equal(service.add({ title: 'still works' }).ok, true);
});

test('chat-window actions: add text, check off, undo, remove, bad input', () => {
  const { service } = makeService();
  const added = service.addFromText('kal client ko email bhejna');
  assert.equal(added.ok, true);
  assert.equal(service.state.tasks[0].title, 'client ko email bhejna');
  assert.equal(service.state.tasks[0].due, '2026-10-28');
  assert.equal(service.state.tasks[0].source, 'ui');
  assert.equal(added.view.plan[0].dueLabel, 'tomorrow');
  assert.equal(service.addFromText('   ').ok, false);
  assert.equal(service.addFromText({ evil: true }).ok, false);
  assert.equal(service.panelAction({ id: 't1', action: 'done' }).view.doneToday.length, 1);
  assert.equal(service.panelAction({ id: 't1', action: 'undo' }).view.doneToday.length, 0);
  assert.equal(service.panelAction({ id: 't1', action: 'explode' }).ok, false);
  assert.equal(service.panelAction({ id: 't1', action: 'remove' }).ok, true);
  assert.equal(service.state.tasks.length, 0);
  assert.equal(service.panelAction(null).ok, false);
});

// ------------------------------------------------------------------ the tools
function fakeReminderClock() {
  const clock = { now: NOW, timers: [], saved: [], fired: [] };
  clock.deps = () => ({
    load: () => clock.saved,
    save: list => { clock.saved = JSON.parse(JSON.stringify(list)); },
    now: () => clock.now,
    setTimer: (fn, ms) => { const t = { fn, at: clock.now + ms, live: true }; clock.timers.push(t); return t; },
    clearTimer: t => { if (t) t.live = false; },
    onDue: r => clock.fired.push(r.text),
  });
  return clock;
}

function setup({ enabled = true } = {}) {
  const { service, storage } = makeService();
  const clock = fakeReminderClock();
  const reminders = new Reminders(clock.deps());
  const specs = [...createTaskSpecs(service, reminders, () => 'voice'), ...createReminderSpecs(reminders, () => clock.now, service)];
  const audit = [];
  const approvals = [];
  const runtime = new ToolRuntime({
    specs, definitions: [],
    approval: { request: async input => { approvals.push(input); return 'deny'; }, isAllowedForChat: () => false, stopAll() {} },
    audit: { record: entry => audit.push(entry) },
    isEnabled: () => enabled,
  });
  const run = (name, args = {}) => runtime.execute(name, args, `c${audit.length}`, new AbortController().signal);
  return { service, storage, reminders, clock, specs, audit, approvals, runtime, run };
}

test('the seven task tools exist with clean schemas', () => {
  const { specs } = setup();
  const names = specs.map(s => s.name);
  for (const name of ['add_task', 'list_tasks', 'update_task', 'complete_task', 'plan_today', 'next_task', 'start_task']) assert.ok(names.includes(name), name);
  const wanted = { add_task: ['title'], update_task: ['task'], complete_task: ['task'] };
  for (const spec of specs.filter(s => /task|plan_today/.test(s.name))) {
    assert.equal(spec.parameters.type, 'object', spec.name);
    assert.deepEqual(spec.parameters.required ?? [], wanted[spec.name] ?? [], spec.name);
    assert.ok(spec.description.length > 20 && spec.description.length < 420, `${spec.name} description is short`);
    for (const [key, value] of Object.entries(spec.parameters.properties)) assert.ok(value.type, `${spec.name}.${key} has a type`);
    assert.ok(['read', 'write'].includes(spec.risk), `${spec.name} is never command/open`);
  }
  assert.equal(new Set(names).size, names.length, 'no duplicate tool names');
  const size = JSON.stringify(specs.filter(s => /task|plan_today/.test(s.name)).map(s => ({ n: s.name, d: s.description, p: s.parameters }))).length;
  assert.ok(size < 4200, `task tool definitions stay small for the free token limits (${size} chars)`);
});

test('task tools run without a card and every call is audited', async () => {
  const { run, audit, approvals } = setup();
  await run('add_task', { title: 'client ko email bhejna', due: 'kal 5 baje' });
  await run('plan_today');
  await run('next_task');
  await run('list_tasks', { filter: 'all' });
  await run('start_task', {});
  await run('update_task', { task: 't1', priority: 'high' });
  await run('complete_task', { task: 't1' });
  assert.equal(approvals.length, 0, 'no approval card for the planner');
  assert.deepEqual(audit.map(a => a.tool), ['add_task', 'plan_today', 'next_task', 'list_tasks', 'start_task', 'update_task', 'complete_task']);
  assert.ok(audit.every(a => a.decision === 'auto' && a.status === 'ok'), JSON.stringify(audit));
  assert.ok(audit.every(a => !/client|email/.test(a.summary)), 'task text never goes into the audit summary');
});

test('with "Let Sudo-chan use tools" OFF the task tools refuse and change nothing', async () => {
  const { run, service } = setup({ enabled: false });
  assert.match(await run('add_task', { title: 'x' }), /tools are turned off/);
  assert.match(await run('plan_today'), /tools are turned off/);
  assert.equal(service.state.tasks.length, 0);
});

test('add_task: natural due dates, priority words, source, validation', async () => {
  const { run, service } = setup();
  assert.match(await run('add_task', { title: 'Client ko email bhejna', due: 'kal 5 baje', priority: 'urgent' }), /^Added t1: Client ko email bhejna \(due tomorrow 17:00, high priority\)\.$/);
  assert.equal(service.state.tasks[0].source, 'voice');
  assert.match(await run('add_task', { title: 'rent', due: '2026-11-01' }), /Added t2: rent \(due Sun\)/);
  assert.match(await run('add_task', { title: '' }), /Blocked: title is required/);
  assert.match(await run('add_task', { title: 'a', priority: 'whenever' }), /Blocked: priority must be/);
  assert.match(await run('add_task', { title: 'a', due: 'kisi din' }), /Blocked: I could not understand that due date/);
  assert.match(await run('add_task', { title: 'a'.repeat(300) }), /Error: The task title is too long/);
  assert.match(await run('add_task', 'oops'), /arguments must be a JSON object/);
  assert.equal(service.state.tasks.length, 2);
});

test('plan_today, next_task and list_tasks answer in plain text', async () => {
  const { run } = setup();
  assert.equal(await run('plan_today'), 'No open tasks. Nothing is planned for today.');
  assert.equal(await run('next_task'), 'No open tasks.');
  assert.equal(await run('list_tasks'), 'No today tasks.');
  await run('add_task', { title: 'purana kaam', due: '2026-10-25' });
  await run('add_task', { title: 'aaj ka kaam', due: 'aaj shaam 6 baje' });
  await run('add_task', { title: 'kabhi ka kaam', priority: 'low' });
  const plan = await run('plan_today');
  assert.equal(plan, 'Plan for today (3 of 3 open tasks):\n1. t1: purana kaam (OVERDUE, due 25 Oct)\n2. t2: aaj ka kaam (due today 18:00)\n3. t3: kabhi ka kaam (low priority)');
  assert.match(await run('next_task'), /^Next: t1: purana kaam/);
  assert.equal((await run('list_tasks', { filter: 'overdue' })).split('\n').length, 1);
  assert.match(await run('list_tasks', { filter: 'today' }), /t1.*\nt2/);
  assert.match(await run('list_tasks', { filter: 'weekly' }), /Blocked: filter must be/);
});

test('complete_task by id or by words, and the list shrinks', async () => {
  const { run, service } = setup();
  await run('add_task', { title: 'Client ko email bhejna' });
  await run('add_task', { title: 'gym jana' });
  assert.equal(await run('complete_task', { task: 'email' }), 'Done: t1 Client ko email bhejna. 1 open task left.');
  assert.match(await run('complete_task', { task: 't1' }), /Error: No open task with id t1/);
  assert.match(await run('complete_task', { task: 'nonexistent' }), /Error: No task matches/);
  assert.match(await run('complete_task', {}), /Blocked: task is required/);
  assert.equal(await run('complete_task', { task: '2' }), 'Done: t2 gym jana. 0 open tasks left.');
  assert.match(await run('list_tasks', { filter: 'done' }), /t2.*\nt1|t1.*\nt2/);
  assert.equal(service.state.tasks.every(t => t.status === 'done'), true);
});

test('update_task changes fields, clears the due date and rejects empty updates', async () => {
  const { run, service } = setup();
  await run('add_task', { title: 'report', due: 'kal' });
  assert.match(await run('update_task', { task: 'report', title: 'report final', priority: 'high', notes: 'Ali ko bhejna' }), /^Updated t1: report final \(due tomorrow, high priority\)\./);
  assert.equal(service.state.tasks[0].notes, 'Ali ko bhejna');
  assert.match(await run('update_task', { task: 't1', due: 'none' }), /Updated t1: report final \(high priority\)/);
  assert.match(await run('update_task', { task: 't1', due: 'parson subah' }), /due Thu|due 29 Oct|due Thu 09:00/);
  assert.match(await run('update_task', { task: 't1', status: 'doing' }), /in progress/);
  assert.match(await run('update_task', { task: 't1' }), /Error: nothing to change/);
  assert.match(await run('update_task', { task: 'zzz', priority: 'low' }), /Error: No task matches/);
  assert.match(await run('update_task', { task: 't1', status: 'finished' }), /Blocked: status must be/);
  assert.match(await run('update_task', { priority: 'low' }), /Blocked: task is required/);
  assert.match(await run('update_task', { task: 't1', status: 'done' }), /\(done/);
});

test('start_task marks doing, returns the text and never claims the work is done', async () => {
  const { run, service } = setup();
  await run('add_task', { title: 'README mein typo theek karo', notes: '~/proj/README.md line 12' });
  await run('add_task', { title: 'doosra kaam', due: 'aaj shaam' });
  const out = await run('start_task', {});
  assert.match(out, /^Started t2: doosra kaam/, 'no argument = the next task in plan order');
  const named = await run('start_task', { task: 'typo' });
  assert.match(named, /^Started t1: README mein typo theek karo \(in progress\)\./);
  assert.match(named, /Notes: ~\/proj\/README\.md line 12/);
  assert.match(named, /Also in progress: t2 doosra kaam/);
  assert.match(named, /did not do any of the work/);
  assert.deepEqual(service.state.tasks.map(t => t.status), ['doing', 'doing']);
  assert.match(await run('start_task', { task: 'nothing' }), /Error: No task matches/);
  await run('complete_task', { task: 't1' });
  await run('complete_task', { task: 't2' });
  assert.match(await run('start_task', {}), /Error: there are no open tasks/);
  assert.equal(describeToolCall('start_task', {}, named), 'started task t1');
  assert.equal(describeToolCall('start_task', {}, 'Error: nope'), null);
});

test('start_task adds no power: it only edits the task file', () => {
  const { specs } = setup();
  const start = specs.find(s => s.name === 'start_task');
  assert.match(start.description, /does NOT do the work/);
  const source = read('../src/main/tools/extra-tools.ts');
  const planner = source.slice(source.indexOf('export function createTaskSpecs'));
  assert.doesNotMatch(planner, /child_process|execFile|spawn|runProgram|openDetached|writeFile|readFile|fetch\(/, 'the planner has no file, process or network access');
});

test('reminder link: remind=true makes a reminder at the due time, completing cancels it', async () => {
  const { run, reminders, clock, service } = setup();
  const added = await run('add_task', { title: 'dawa lena', due: 'aaj shaam 6 baje', remind: true });
  assert.match(added, /Added t1: dawa lena \(due today 18:00\)\. Reminder r-.* set for/);
  const pending = reminders.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].taskId, 't1');
  assert.equal(pending[0].text, 'dawa lena');
  assert.equal(pending[0].dueAt, new Date(2026, 9, 27, 18, 0).getTime());
  assert.equal(service.state.tasks[0].reminderId, pending[0].id);
  assert.match(await run('complete_task', { task: 't1' }), /Its reminder was cancelled/);
  assert.equal(reminders.pending().length, 0);
  clock.now += 4 * 3600_000;
  for (const t of clock.timers.filter(x => x.live)) t.fn();
  assert.deepEqual(clock.fired, [], 'a finished task never reminds');
});

test('reminder link: no due date, a past due time and a day-only due date', async () => {
  const { run, reminders } = setup();
  assert.match(await run('add_task', { title: 'a', remind: true }), /No reminder: the task has no due date\./);
  assert.match(await run('add_task', { title: 'b', due: '2026-10-27T09:00', remind: true }), /No reminder: That time has already passed\./);
  assert.match(await run('add_task', { title: 'c', due: '2026-10-29', remind: true }), /Reminder r-.* set for/);
  assert.equal(reminders.pending()[0].dueAt, new Date(2026, 9, 29, 9, 0).getTime(), 'a day alone reminds at 09:00');
  assert.match(await run('update_task', { task: 't3', due: '2026-10-30T10:30', remind: true }), /Reminder r-.* set for/);
  assert.equal(reminders.pending().length, 1, 'changing the due time replaces the old reminder');
  assert.equal(reminders.pending()[0].dueAt, new Date(2026, 9, 30, 10, 30).getTime());
});

test('set_reminder can attach a task id; a wrong id is refused', async () => {
  const { run, reminders, service } = setup();
  await run('add_task', { title: 'call Ali' });
  const set = await run('set_reminder', { text: 'Ali ko call', in_minutes: 30, task_id: 't1' });
  assert.match(set, /\(task t1\)/);
  assert.equal(reminders.pending()[0].taskId, 't1');
  assert.equal(service.state.tasks[0].reminderId, reminders.pending()[0].id);
  assert.match(await run('set_reminder', { text: 'x', in_minutes: 5, task_id: 't9' }), /Blocked: No open task with id t9/);
  assert.match(await run('set_reminder', { text: 'plain', in_minutes: 5 }), /^Reminder r-.* set for/);
  assert.equal(reminders.pending().length, 2);
  assert.match(await run('complete_task', { task: 't1' }), /Its reminder was cancelled/);
  assert.deepEqual(reminders.pending().map(r => r.text), ['plain']);
});

test('Reminders: atMs must be in the future and within a year; taskId survives', () => {
  const clock = fakeReminderClock();
  const r = new Reminders(clock.deps());
  assert.equal(r.add('x', { atMs: NOW - 1 }).ok, false);
  assert.equal(r.add('x', { atMs: NOW + 400 * 24 * 3600_000 }).ok, false);
  assert.equal(r.add('x', { atMs: Number.NaN }).ok, false);
  const ok = r.add('x', { atMs: NOW + 3600_000 }, 't4');
  assert.equal(ok.ok, true);
  assert.equal(ok.reminder.taskId, 't4');
  assert.equal(r.cancelForTask('t4'), 1);
  assert.equal(r.cancelForTask('t4'), 0);
});

// ------------------------------------------------------------------ wiring (source level, same style as verify)
test('IPC: the task channels exist, are chat-window only, and the preload exposes them', () => {
  for (const name of ['tasksList', 'tasksAdd', 'tasksAct', 'tasksState']) assert.match(CHANNELS[name], /^companion:tasks-/);
  assert.equal(new Set(Object.values(CHANNELS)).size, Object.values(CHANNELS).length, 'channel names are unique');
  const main = stripComments(read('../src/main/index.ts'));
  for (const name of ['tasksList', 'tasksAdd', 'tasksAct']) {
    const at = main.indexOf(`handle(CHANNELS.${name},`);
    assert.ok(at > 0, `${name} is handled`);
    const end = main.indexOf('\n  handle(', at + 10);
    const block = main.slice(at, end > 0 ? end : at + 600).trim();
    assert.match(block, /,\s*'chat'\);$/, `${name} is restricted to the chat window via authorize()`);
    assert.doesNotMatch(block, /overlay|settings/, `${name} is not open to overlay or settings`);
  }
  assert.match(main, /const handle = \(channel: string, callback: [^;]*authorize\(event, kind\)/);
  const send = main.slice(main.indexOf('onChange: view =>'), main.indexOf('onChange: view =>') + 200);
  assert.match(send, /chat\.webContents\.send\(CHANNELS\.tasksState/);
  assert.doesNotMatch(send, /overlay/, 'task titles are never pushed to the overlay');
  const preload = read('../src/preload/index.ts');
  for (const method of ['getTasks', 'onTasks', 'addTaskText', 'taskAction']) assert.match(preload, new RegExp(`\\b${method}:`));
  const types = read('../src/shared/types.ts');
  for (const method of ['getTasks', 'onTasks', 'addTaskText', 'taskAction']) assert.match(types, new RegExp(`\\b${method}\\(`));
});

test('voice, speech and overlay code have no way to reach the tasks', () => {
  for (const file of ['voice-engine.ts', 'speech.ts', 'tts-player.ts', 'Bot.tsx', 'SonicOrb.tsx']) {
    assert.doesNotMatch(read(`../src/renderer/${file}`), /getTasks|taskAction|addTaskText|onTasks|TasksPanel|tasks\.json/, file);
  }
  const app = read('../src/renderer/App.tsx');
  assert.equal((app.match(/<TasksPanel\/>/g) ?? []).length, 1, 'the panel is used once');
  const chatStart = app.indexOf('function Chat(');
  const chatEnd = app.indexOf('\nfunction ', chatStart + 10);
  const at = app.indexOf('<TasksPanel/>');
  assert.ok(at > chatStart && (chatEnd < 0 || at < chatEnd), 'the panel is inside the Chat window component only');
  const panel = read('../src/renderer/TasksPanel.tsx');
  assert.doesNotMatch(panel, /node:|require\(|ipcRenderer|tasks\.json/);
  const voiceFiles = ['wake-word.ts', 'intent.ts', 'stop-intent.ts', 'chat-voice-turn.ts'].map(f => read(`../src/shared/${f}`)).join('\n');
  assert.doesNotMatch(voiceFiles, /respondToolApproval|taskAction|tasksAct/);
});

test('the task service is shared by the tools and the panel and works with tools OFF', () => {
  const main = stripComments(read('../src/main/index.ts'));
  assert.match(main, /createTaskSpecs\(tasksService\(\), reminderService\(\)/);
  assert.match(main, /createReminderSpecs\(reminderService\(\), \(\) => Date\.now\(\), tasksService\(\)\)/);
  const panelHandlers = main.slice(main.indexOf('handle(CHANNELS.tasksList'), main.indexOf('handle(CHANNELS.clear,'));
  assert.doesNotMatch(panelHandlers, /toolsEnabled/, 'the manual panel does not need the tools switch');
  assert.match(panelHandlers, /cancelForTask/, 'checking a task off cancels its reminder');
});

// ------------------------------------------------------------------ the prompt
test('the tools prompt names the planner tools, the language rule and the honesty rule', () => {
  for (const tool of ['add_task', 'plan_today', 'next_task', 'list_tasks', 'update_task', 'complete_task', 'start_task']) assert.match(TOOLS_PROMPT, new RegExp(tool), tool);
  assert.match(TOOLS_PROMPT, /task_id/);
  assert.match(TOOLS_PROMPT, /aaj mera kya kaam hai/);
  assert.match(TOOLS_PROMPT, /mera agla kaam utha lo/);
  assert.match(TOOLS_PROMPT, /Starting a task is NOT doing it/);
  assert.match(TOOLS_PROMPT, /user's language in 1-3 short spoken sentences, no markdown/);
  assert.match(TOOLS_PROMPT, /cannot delete tasks/);
  assert.match(TOOLS_PROMPT, /remind=true ONLY if they asked/);
  assert.ok(TOOLS_PROMPT.length < 4200, `the prompt stays short (${TOOLS_PROMPT.length} chars)`);
});
