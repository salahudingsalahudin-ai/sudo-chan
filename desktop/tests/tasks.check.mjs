// "Aaj ka kaam": pure task logic (src/shared/tasks.ts) and date/time phrases in English, Roman Urdu and Urdu script.
// All times are local and built with new Date(...), so the tests give the same result in any time zone.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DONE_KEPT, MAX_OPEN_TASKS, MAX_TITLE, MAX_NOTES, MAX_PLAN,
  addTask, applyPanelAction, asciiDigits, buildView, completeTask, dueLabel, dueToMs, emptyState, extractDue, filterTasks, findTask, formatTaskLine,
  isDueToday, isOverdue, isValidDue, nextTask, normalizeState, orderedOpen, overdueTasks, parseAddText, parseDue, parsePanelAction, removeTask,
  reorderTask, resolveDue, startTask, todayPlan, updateTask, localDay,
} from '../src/shared/tasks.ts';

// Tuesday 27 October 2026, 15:00 local.
const NOW = new Date(2026, 9, 27, 15, 0, 0).getTime();
const at = (day, h, m) => new Date(2026, 9, day, h, m, 0, 0).getTime();
const NOW_MORNING = new Date(2026, 9, 27, 8, 0, 0).getTime();
const NOW_NIGHT = new Date(2026, 9, 27, 23, 30, 0).getTime();

function stateWith(...inputs) {
  let state = emptyState();
  for (const input of inputs) {
    const r = addTask(state, typeof input === 'string' ? { title: input } : input, NOW);
    assert.equal(r.ok, true, r.error);
    state = r.state;
  }
  return state;
}

// ------------------------------------------------------------------ date parsing
const cases = [
  // English
  ['tomorrow', '2026-10-28'],
  ['today', '2026-10-27'],
  ['day after tomorrow', '2026-10-29'],
  ['tomorrow 5pm', '2026-10-28T17:00'],
  ['tomorrow at 9am', '2026-10-28T09:00'],
  ['5:30pm', '2026-10-27T17:30'],
  ['17:30', '2026-10-27T17:30'],
  ['at 17:30', '2026-10-27T17:30'],
  ['by 5pm', '2026-10-27T17:00'],
  ['9am', '2026-10-28T09:00'],
  ['Monday', '2026-11-02'],
  ['next Monday', '2026-11-02'],
  ['friday 9am', '2026-10-30T09:00'],
  ['Tuesday', '2026-11-03'],
  ['next week', '2026-11-02'],
  ['next month', '2026-11-01'],
  ['in 3 days', '2026-10-30'],
  ['in 2 hours', '2026-10-27T17:00'],
  ['in 45 minutes', '2026-10-27T15:45'],
  ['tonight', '2026-10-27T21:00'],
  ['this morning', '2026-10-27T09:00'],
  ['tomorrow morning', '2026-10-28T09:00'],
  ['tomorrow evening', '2026-10-28T18:00'],
  // Roman Urdu
  ['kal', '2026-10-28'],
  ['aaj', '2026-10-27'],
  ['parson', '2026-10-29'],
  ['kal subah', '2026-10-28T09:00'],
  ['kal shaam', '2026-10-28T18:00'],
  ['aaj raat', '2026-10-27T21:00'],
  ['aaj shaam 5 baje', '2026-10-27T17:00'],
  ['kal subah 10 baje', '2026-10-28T10:00'],
  ['kal 5 baje', '2026-10-28T17:00'],
  ['kal dopahar 2 baje', '2026-10-28T14:00'],
  ['parson raat 9 baje', '2026-10-29T21:00'],
  ['5 baje', '2026-10-27T17:00'],
  ['10 baje', '2026-10-27T22:00'],
  ['do baje', '2026-10-28T14:00'],
  ['paanch baje', '2026-10-27T17:00'],
  ['saade paanch baje', '2026-10-27T17:30'],
  ['sawa paanch baje', '2026-10-27T17:15'],
  ['paune paanch baje', '2026-10-27T16:45'],
  ['subah', '2026-10-28T09:00'],
  ['shaam', '2026-10-27T18:00'],
  ['agle hafte', '2026-11-02'],
  ['agla hafta', '2026-11-02'],
  ['agle mahine', '2026-11-01'],
  ['3 din baad', '2026-10-30'],
  ['2 din mein', '2026-10-29'],
  ['do din baad', '2026-10-29'],
  ['2 ghante baad', '2026-10-27T17:00'],
  ['jumerat ko', '2026-10-29'],
  ['juma', '2026-10-30'],
  ['peer', '2026-11-02'],
  ['itwar', '2026-11-01'],
  ['agle peer', '2026-11-02'],
  ['aaj raat 12 baje', '2026-10-28T00:00'],
  // Urdu script and Urdu digits
  ['کل', '2026-10-28'],
  ['آج', '2026-10-27'],
  ['پرسوں', '2026-10-29'],
  ['کل صبح', '2026-10-28T09:00'],
  ['شام ۵ بجے', '2026-10-27T17:00'],
  ['کل صبح ۹ بجے', '2026-10-28T09:00'],
  ['آج رات ۱۰ بجے', '2026-10-27T22:00'],
  ['اگلے ہفتے', '2026-11-02'],
  ['۳ دن بعد', '2026-10-30'],
  ['جمعرات', '2026-10-29'],
  ['اتوار', '2026-11-01'],
];
for (const [text, expected] of cases) {
  test(`parseDue(${JSON.stringify(text)}) -> ${expected}`, () => {
    assert.equal(parseDue(text, NOW), expected);
  });
}

test('words that are not dates never produce one', () => {
  for (const text of ['', 'client ko email bhejna', 'buy 2 apples', 'sun lo yaar', 'call mom', 'do kaam karne hain', 'meeting with sat nav', 'page 5', '5 files']) {
    assert.equal(parseDue(text, NOW), null, text);
  }
});

test('a bare hour is the next sensible one: later today, then tomorrow', () => {
  assert.equal(parseDue('5 baje', NOW_MORNING), '2026-10-27T17:00');
  assert.equal(parseDue('9 baje', NOW_MORNING), '2026-10-27T09:00');
  assert.equal(parseDue('9 baje', NOW), '2026-10-27T21:00', '9 am is over, 9 pm is still ahead');
  assert.equal(parseDue('5 baje', NOW_NIGHT), '2026-10-28T17:00');
  assert.equal(parseDue('subah', NOW_NIGHT), '2026-10-28T09:00');
  assert.equal(parseDue('shaam', NOW_NIGHT), '2026-10-28T18:00');
  assert.equal(parseDue('aaj shaam 5 baje', NOW_NIGHT), '2026-10-27T17:00', 'an explicit aaj stays today even if past');
});

test('a weekday never means today: the same weekday is a week away', () => {
  assert.equal(parseDue('Tuesday', NOW), '2026-11-03');
  assert.equal(parseDue('Wednesday', NOW), '2026-10-28');
  assert.equal(parseDue('mangal', NOW), '2026-11-03');
});

test('extractDue removes the date words and keeps the rest as the title', () => {
  const cases2 = [
    ['kal client ko email bhejna', 'client ko email bhejna', '2026-10-28'],
    ['client ko email bhejna kal', 'client ko email bhejna', '2026-10-28'],
    ['Monday ko meeting ki tayari', 'meeting ki tayari', '2026-11-02'],
    ['aaj shaam 5 baje gym jana', 'gym jana', '2026-10-27T17:00'],
    ['email Ali by 5pm', 'email Ali', '2026-10-27T17:00'],
    ['report likhni hai parson tak', 'report likhni hai', '2026-10-29'],
    ['buy milk', 'buy milk', null],
    ['کل ڈاکٹر کے پاس جانا', 'ڈاکٹر کے پاس جانا', '2026-10-28'],
  ];
  for (const [input, title, due] of cases2) {
    const out = extractDue(input, NOW);
    assert.equal(out.title, title, input);
    assert.equal(out.due, due, input);
  }
});

test('asciiDigits converts Urdu, Persian and Devanagari digits', () => {
  assert.equal(asciiDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
  assert.equal(asciiDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
  assert.equal(asciiDigits('०१२३४५६७८९'), '0123456789');
  assert.equal(asciiDigits('abc ۵ baje'), 'abc 5 baje');
});

test('resolveDue accepts ISO values and phrases and explains a failure', () => {
  assert.deepEqual(resolveDue('2026-11-03 17:00', NOW), { ok: true, due: '2026-11-03T17:00' });
  assert.deepEqual(resolveDue('2026-11-03', NOW), { ok: true, due: '2026-11-03' });
  assert.deepEqual(resolveDue('kal 5 baje', NOW), { ok: true, due: '2026-10-28T17:00' });
  assert.equal(resolveDue('whenever', NOW).ok, false);
  assert.equal(resolveDue('2026-02-30', NOW).ok, false);
});

test('isValidDue rejects impossible dates and times', () => {
  for (const ok of ['2026-10-27', '2026-10-27T09:05', '2028-02-29']) assert.equal(isValidDue(ok), true, ok);
  for (const bad of ['2026-13-01', '2026-02-30', '2027-02-29', '2026-10-27T24:00', '2026-10-27T09:60', '27-10-2026', 'tomorrow', '', null, 5, '1999-01-01']) assert.equal(isValidDue(bad), false, String(bad));
});

test('dueLabel and dueToMs', () => {
  assert.equal(dueLabel('2026-10-27T17:00', NOW), 'today 17:00');
  assert.equal(dueLabel('2026-10-28', NOW), 'tomorrow');
  assert.equal(dueLabel('2026-10-26', NOW), 'yesterday');
  assert.equal(dueLabel('2026-10-30', NOW), 'Fri');
  assert.equal(dueLabel('2026-11-20', NOW), '20 Nov');
  assert.equal(dueToMs('2026-10-28'), at(28, 9, 0), 'a day alone means 09:00');
  assert.equal(dueToMs('2026-10-28T17:30'), at(28, 17, 30));
});

// ------------------------------------------------------------------ add / update / complete
test('addTask creates t1, t2 with defaults and never reuses an id', () => {
  let state = stateWith('pehla', { title: 'doosra', due: '2026-10-28', priority: 'high', notes: 'detail', source: 'voice' });
  assert.deepEqual(state.tasks.map(t => t.id), ['t1', 't2']);
  assert.equal(state.tasks[0].status, 'todo');
  assert.equal(state.tasks[0].priority, 'normal');
  assert.equal(state.tasks[0].due, null);
  assert.equal(state.tasks[0].source, 'chat');
  assert.equal(state.tasks[1].source, 'voice');
  assert.equal(state.tasks[1].createdAt, NOW);
  state = removeTask(state, 't2').state;
  assert.equal(addTask(state, { title: 'teesra' }, NOW).task.id, 't3', 'seq keeps counting after a removal');
});

test('addTask validates title, notes, priority, due and the open cap', () => {
  const s = emptyState();
  assert.match(addTask(s, { title: '   ' }, NOW).error, /empty/);
  assert.match(addTask(s, { title: 'x'.repeat(MAX_TITLE + 1) }, NOW).error, /too long/);
  assert.match(addTask(s, { title: 'a', notes: 'n'.repeat(MAX_NOTES + 1) }, NOW).error, /notes are too long/);
  assert.match(addTask(s, { title: 'a', priority: 'urgent' }, NOW).error, /priority/);
  assert.match(addTask(s, { title: 'a', due: 'kal' }, NOW).error, /due must/);
  assert.equal(addTask(s, { title: '  spaced   out \n title ' }, NOW).task.title, 'spaced out title');
  let full = emptyState();
  for (let i = 0; i < MAX_OPEN_TASKS; i++) full = addTask(full, { title: `k${i}` }, NOW).state;
  assert.match(addTask(full, { title: 'one more' }, NOW).error, /Too many open tasks/);
  full = completeTask(full, 't1', NOW).state;
  assert.equal(addTask(full, { title: 'now it fits' }, NOW).ok, true);
});

test('titles and notes lose control characters', () => {
  const r = addTask(emptyState(), { title: 'a\u0000b\u0007c', notes: 'x\u0001y\r\nz' }, NOW);
  assert.equal(r.task.title, 'a b c');
  assert.equal(r.task.notes, 'x y\nz');
});

test('updateTask changes fields, clears due, validates, and tracks doneAt', () => {
  let state = stateWith({ title: 'a', due: '2026-10-28' });
  state = updateTask(state, 't1', { title: 'b', priority: 'low', notes: 'n' }, NOW).state;
  assert.deepEqual([state.tasks[0].title, state.tasks[0].priority, state.tasks[0].notes], ['b', 'low', 'n']);
  assert.equal(updateTask(state, 't1', { due: null }, NOW).task.due, null);
  assert.equal(updateTask(state, 't9', { title: 'x' }, NOW).ok, false);
  assert.equal(updateTask(state, 't1', { title: '' }, NOW).ok, false);
  assert.equal(updateTask(state, 't1', { due: 'soon' }, NOW).ok, false);
  assert.equal(updateTask(state, 't1', { status: 'finished' }, NOW).ok, false);
  const doing = updateTask(state, 't1', { status: 'doing' }, NOW).task;
  assert.equal(doing.status, 'doing');
  const done = updateTask(state, 't1', { status: 'done' }, NOW + 1000).task;
  assert.deepEqual([done.status, done.doneAt], ['done', NOW + 1000]);
  const again = updateTask({ seq: 1, tasks: [done] }, 't1', { status: 'done' }, NOW + 5000).task;
  assert.equal(again.doneAt, NOW + 1000, 'completing twice keeps the first time');
  const reopened = updateTask({ seq: 1, tasks: [done] }, 't1', { status: 'todo' }, NOW).task;
  assert.deepEqual([reopened.status, reopened.doneAt], ['todo', null]);
});

test('completeTask, startTask and removeTask', () => {
  const state = stateWith('a', 'b');
  const started = startTask(state, 't1', NOW);
  assert.equal(started.task.status, 'doing');
  const done = completeTask(started.state, 't1', NOW + 1);
  assert.equal(done.task.status, 'done');
  assert.equal(removeTask(done.state, 't1').state.tasks.length, 1);
  assert.equal(removeTask(done.state, 'nope').ok, false);
  assert.equal(completeTask(state, 'zz', NOW).ok, false);
});

test('only the newest finished tasks are kept', () => {
  let state = emptyState();
  for (let i = 0; i < MAX_DONE_KEPT + 10; i++) {
    state = addTask(state, { title: `t${i}` }, NOW).state;
    state = completeTask(state, `t${i + 1}`, NOW + i).state;
  }
  assert.equal(state.tasks.length, MAX_DONE_KEPT);
  assert.equal(state.tasks.some(t => t.title === 't0'), false, 'oldest dropped');
  assert.equal(state.tasks.some(t => t.title === `t${MAX_DONE_KEPT + 9}`), true);
});

test('reorderTask moves a task and clamps the position', () => {
  const state = stateWith('a', 'b', 'c');
  assert.deepEqual(reorderTask(state, 't3', 0).state.tasks.map(t => t.title), ['c', 'a', 'b']);
  assert.deepEqual(reorderTask(state, 't1', 99).state.tasks.map(t => t.title), ['b', 'c', 'a']);
  assert.deepEqual(reorderTask(state, 't2', -5).state.tasks.map(t => t.title), ['b', 'a', 'c']);
  assert.equal(reorderTask(state, 'x', 0).ok, false);
  assert.equal(reorderTask(state, 't1', 1.5).ok, false);
});

// ------------------------------------------------------------------ finding tasks by words
test('findTask: by id, bare number, exact title, unique part, ambiguity, done tasks', () => {
  let state = stateWith('Client ko email bhejna', 'Client ka invoice banana', 'gym jana');
  assert.equal(findTask(state, { id: 't2' }).task.id, 't2');
  assert.equal(findTask(state, { id: '3' }).task.id, 't3');
  assert.equal(findTask(state, { id: ' T1 ' }).task.id, 't1');
  assert.equal(findTask(state, { id: 't9' }).ok, false);
  assert.equal(findTask(state, { title: 'gym' }).task.id, 't3');
  assert.equal(findTask(state, { title: 'GYM JANA' }).task.id, 't3');
  const many = findTask(state, { title: 'client' });
  assert.equal(many.ok, false);
  assert.match(many.error, /Several tasks match/);
  assert.equal(findTask(state, { title: 'invoice' }).task.id, 't2');
  assert.equal(findTask(state, { title: 'nothing like it' }).ok, false);
  assert.equal(findTask(state, {}).ok, false);
  state = completeTask(state, 't3', NOW).state;
  assert.equal(findTask(state, { id: 't3' }, { openOnly: true }).ok, false);
  assert.equal(findTask(state, { id: 't3' }).ok, true);
  assert.equal(findTask(state, { title: 'gym' }).task.status, 'done', 'done tasks are found when nothing open matches');
});

// ------------------------------------------------------------------ plan, overdue, next
function planState() {
  return stateWith(
    { title: 'undated normal' },
    { title: 'undated high', priority: 'high' },
    { title: 'due today evening', due: '2026-10-27T19:00' },
    { title: 'due today day-only', due: '2026-10-27' },
    { title: 'overdue yesterday', due: '2026-10-26' },
    { title: 'overdue this morning', due: '2026-10-27T08:00' },
    { title: 'future', due: '2026-11-10' },
    { title: 'undated low', priority: 'low' },
  );
}

test('overdue and due-today follow the clock (a day alone is late only after the day)', () => {
  const state = planState();
  const by = title => state.tasks.find(t => t.title === title);
  assert.equal(isOverdue(by('overdue yesterday'), NOW), true);
  assert.equal(isOverdue(by('overdue this morning'), NOW), true);
  assert.equal(isOverdue(by('due today evening'), NOW), false);
  assert.equal(isOverdue(by('due today day-only'), NOW), false);
  assert.equal(isDueToday(by('due today day-only'), NOW), true);
  assert.equal(isDueToday(by('overdue this morning'), NOW), false, 'late wins over today');
  assert.equal(isOverdue(by('future'), NOW), false);
  assert.equal(isOverdue(completeTask(state, by('overdue yesterday').id, NOW).task, NOW), false, 'done is never late');
  assert.deepEqual(overdueTasks(state, NOW).map(t => t.title), ['overdue yesterday', 'overdue this morning']);
});

test('todayPlan: overdue first, then due today, then priority; at most five', () => {
  const plan = todayPlan(planState(), NOW);
  assert.equal(plan.length, MAX_PLAN);
  assert.deepEqual(plan.map(t => t.title), ['overdue yesterday', 'overdue this morning', 'due today evening', 'due today day-only', 'undated high']);
  assert.equal(todayPlan(planState(), NOW, 2).length, 2);
});

test('orderedOpen: in-progress tasks come before the rest, priority then due then manual order', () => {
  const state = planState();
  const started = startTask(state, 't1', NOW).state;
  const titles = orderedOpen(started, NOW).map(t => t.title);
  assert.deepEqual(titles.slice(0, 5), ['overdue yesterday', 'overdue this morning', 'due today evening', 'due today day-only', 'undated normal']);
  assert.equal(titles[5], 'undated high', 'not in progress: high priority first');
  assert.equal(titles.at(-1), 'undated low');
  assert.equal(orderedOpen(completeTask(state, 't5', NOW).state, NOW).some(t => t.title === 'overdue yesterday'), false, 'done tasks are not in the plan');
});

test('a manual reorder breaks ties between equal tasks', () => {
  let state = stateWith('a', 'b', 'c');
  assert.deepEqual(todayPlan(state, NOW).map(t => t.title), ['a', 'b', 'c']);
  state = reorderTask(state, 't3', 0).state;
  assert.deepEqual(todayPlan(state, NOW).map(t => t.title), ['c', 'a', 'b']);
});

test('nextTask skips what is already in progress; empty list gives null', () => {
  assert.equal(nextTask(emptyState(), NOW), null);
  const state = planState();
  assert.equal(nextTask(state, NOW).title, 'overdue yesterday');
  const only = startTask(stateWith('only'), 't1', NOW).state;
  assert.equal(nextTask(only, NOW).title, 'only', 'falls back to the one in progress');
  const two = startTask(stateWith('a', 'b'), 't1', NOW).state;
  assert.equal(nextTask(two, NOW).title, 'b');
});

test('filterTasks: today, overdue, all, done', () => {
  const state = completeTask(planState(), 't8', NOW + 5).state;
  assert.deepEqual(filterTasks(state, 'today', NOW).map(t => t.title), ['overdue yesterday', 'overdue this morning', 'due today evening', 'due today day-only']);
  assert.deepEqual(filterTasks(state, 'overdue', NOW).map(t => t.id), ['t5', 't6']);
  assert.equal(filterTasks(state, 'all', NOW).length, 7);
  assert.deepEqual(filterTasks(state, 'done', NOW).map(t => t.id), ['t8']);
});

test('formatTaskLine is plain text with status, lateness, due and priority', () => {
  const state = startTask(planState(), 't2', NOW).state;
  assert.equal(formatTaskLine(state.tasks[0], NOW), 't1: undated normal');
  assert.equal(formatTaskLine(state.tasks[1], NOW), 't2: undated high (in progress, high priority)');
  assert.equal(formatTaskLine(state.tasks[4], NOW), 't5: overdue yesterday (OVERDUE, due yesterday)');
  assert.equal(formatTaskLine(state.tasks[2], NOW), 't3: due today evening (due today 19:00)');
  assert.doesNotMatch(formatTaskLine(state.tasks[2], NOW), /[*#`]/);
});

// ------------------------------------------------------------------ panel view and actions
test('buildView gives the plan, counts and what was finished today', () => {
  let state = planState();
  state = completeTask(state, 't1', NOW).state;
  const view = buildView(state, NOW);
  assert.equal(view.plan.length, MAX_PLAN);
  assert.equal(view.openCount, 7);
  assert.equal(view.overdueCount, 2);
  assert.deepEqual(view.doneToday.map(t => t.id), ['t1']);
  assert.equal(view.plan[0].overdue, true);
  assert.equal(view.plan[0].dueLabel, 'yesterday');
  assert.deepEqual(Object.keys(view.plan[0]).sort(), ['due', 'dueLabel', 'id', 'overdue', 'priority', 'status', 'title']);
  const yesterday = completeTask(state, 't2', NOW - 26 * 3600_000).state;
  assert.equal(buildView(yesterday, NOW).doneToday.some(t => t.id === 't2'), false, 'only today counts');
});

test('parsePanelAction accepts only known actions and ids', () => {
  assert.deepEqual(parsePanelAction({ id: 't4', action: 'done' }), { id: 't4', action: 'done' });
  for (const bad of [null, 5, 'done', [], {}, { id: 't4' }, { action: 'done' }, { id: '4', action: 'done' }, { id: 't4', action: 'drop table' }, { id: '../x', action: 'remove' }, { id: 't4;', action: 'done' }]) {
    assert.equal(parsePanelAction(bad), null, JSON.stringify(bad));
  }
});

test('applyPanelAction: done, undo, start, stop, remove', () => {
  const state = stateWith('a');
  const doing = applyPanelAction(state, { id: 't1', action: 'start' }, NOW);
  assert.equal(doing.task.status, 'doing');
  assert.equal(applyPanelAction(doing.state, { id: 't1', action: 'stop' }, NOW).task.status, 'todo');
  const done = applyPanelAction(state, { id: 't1', action: 'done' }, NOW);
  assert.equal(done.task.status, 'done');
  assert.equal(applyPanelAction(done.state, { id: 't1', action: 'undo' }, NOW).task.status, 'todo');
  assert.equal(applyPanelAction(state, { id: 't1', action: 'remove' }, NOW).state.tasks.length, 0);
  assert.equal(applyPanelAction(state, { id: 't7', action: 'done' }, NOW).ok, false);
});

test('parseAddText splits the due date from the title and spots urgency', () => {
  assert.deepEqual(parseAddText('kal client ko email bhejna', NOW), { ok: true, title: 'client ko email bhejna', due: '2026-10-28', priority: 'normal' });
  assert.deepEqual(parseAddText('zaroori: aaj shaam 6 baje bill bharna', NOW), { ok: true, title: 'zaroori: bill bharna', due: '2026-10-27T18:00', priority: 'high' });
  assert.equal(parseAddText('aaj raat 12 baje', NOW).title, 'aaj raat 12 baje', 'never an empty title');
  assert.equal(parseAddText('   ', NOW).ok, false);
  assert.equal(parseAddText(42, NOW).ok, false);
  assert.equal(parseAddText('x'.repeat(500), NOW).ok, false);
  assert.equal(parseAddText('x'.repeat(300), NOW).title.length, MAX_TITLE);
});

// ------------------------------------------------------------------ stored data
test('normalizeState keeps valid tasks, drops damaged ones, fixes the counter and caps', () => {
  const good = { id: 't3', title: 'ok', notes: '', status: 'doing', priority: 'high', due: '2026-10-28', createdAt: 5, doneAt: null, source: 'voice', reminderId: null };
  const { state, dropped } = normalizeState({
    seq: 1,
    tasks: [good, { ...good }, { id: 'bad id', title: 'x' }, { id: 't4', title: '' }, null, 'text', { id: 't5', title: 'late', status: 'weird', priority: 'x', due: 'soon', source: 'robot' }],
  });
  assert.equal(dropped, 5);
  assert.deepEqual(state.tasks.map(t => t.id), ['t3', 't5']);
  assert.equal(state.seq, 5, 'counter never lower than the highest id');
  assert.deepEqual([state.tasks[1].status, state.tasks[1].priority, state.tasks[1].due, state.tasks[1].source], ['todo', 'normal', null, 'ui']);
  assert.deepEqual(normalizeState(null).state, emptyState());
  assert.deepEqual(normalizeState([1, 2]).state, emptyState());
  assert.deepEqual(normalizeState({ tasks: 'nope' }).state, emptyState());
  const huge = { tasks: Array.from({ length: 500 }, (_, i) => ({ id: `t${i + 1}`, title: `n${i}` })) };
  assert.equal(normalizeState(huge).state.tasks.length, 200);
  const long = normalizeState({ tasks: [{ id: 't1', title: 'y'.repeat(900), notes: 'z'.repeat(9000) }] }).state.tasks[0];
  assert.equal(long.title.length, MAX_TITLE);
  assert.equal(long.notes.length, MAX_NOTES);
});

test('localDay formats in local time', () => {
  assert.equal(localDay(at(27, 23, 59)), '2026-10-27');
  assert.equal(localDay(at(28, 0, 0)), '2026-10-28');
});
