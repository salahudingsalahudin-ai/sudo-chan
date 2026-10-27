import type { ToolSpec } from './registry.js';
import { describeDue, type Reminders } from './reminders.ts';
import type { NotesStore } from './notes.ts';
import type { TaskService } from '../tasks-store.ts';
import {
  MAX_PLAN, dueToMs, filterTasks, formatTaskLine, nextTask, resolveDue, todayPlan,
  type Task, type TaskFilter, type TaskPatch, type TaskPriority, type TaskSource,
} from '../../shared/tasks.ts';

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const allow = { verdict: 'allow' as const };

/**
 * Low-risk helper tools: a private notebook and reminders. They never touch the user's own files (the notebook is a
 * folder inside the app data directory) and never run programs, so they need no approval card. They still obey the
 * "Let Sudo-chan use tools" switch because every call goes through ToolRuntime.
 */
export function createNoteSpecs(notes: NotesStore): ToolSpec[] {
  const saveNote: ToolSpec = {
    name: 'save_note',
    description: 'Save a short note (max 20 KB) in your private notebook. No approval needed.',
    risk: 'write',
    parameters: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['title', 'text'] },
    async prepare(args) {
      const title = str(args.title)?.trim();
      const text = str(args.text);
      if (!title) return { error: 'title is required.' };
      if (text === undefined) return { error: 'text is required.' };
      return {
        verdict: allow, title: 'Save a note', detail: '', summary: 'save_note',
        async run() {
          try {
            const { file } = await notes.save(title, text);
            return `Saved as ${file}.`;
          } catch (error) {
            return `Error: ${(error as Error).message}`;
          }
        },
      };
    },
  };
  const listNotes: ToolSpec = {
    name: 'list_notes',
    description: 'List the notes in your private notebook (newest first).',
    risk: 'read',
    parameters: { type: 'object', properties: {} },
    async prepare() {
      return {
        verdict: allow, title: 'List notes', detail: '', summary: 'list_notes',
        async run() {
          const items = await notes.list();
          return items.length ? items.map(item => `${item.file} (${item.bytes} bytes, ${new Date(item.modified).toISOString().slice(0, 16).replace('T', ' ')})`).join('\n') : 'No notes yet.';
        },
      };
    },
  };
  const readNote: ToolSpec = {
    name: 'read_note',
    description: 'Read one note by name (as shown by list_notes).',
    risk: 'read',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    async prepare(args) {
      const name = str(args.name);
      if (!name) return { error: 'name is required.' };
      return {
        verdict: allow, title: 'Read a note', detail: '', summary: 'read_note',
        async run() {
          try {
            return await notes.read(name);
          } catch (error) {
            return `Error: ${(error as Error).message}`;
          }
        },
      };
    },
  };
  return [saveNote, listNotes, readNote];
}

export function createReminderSpecs(reminders: Reminders, now: () => number = Date.now, tasks?: TaskService): ToolSpec[] {
  const setReminder: ToolSpec = {
    name: 'set_reminder',
    description: 'Remind the user later with a notification and a spoken line. Give in_minutes (e.g. 5) OR at_time (local clock, e.g. "17:30"). Optional task_id (like t3) links the reminder to a task.',
    risk: 'write',
    parameters: { type: 'object', properties: { text: { type: 'string' }, in_minutes: { type: 'number' }, at_time: { type: 'string' }, task_id: { type: 'string' } }, required: ['text'] },
    async prepare(args) {
      const text = str(args.text);
      if (!text?.trim()) return { error: 'text is required.' };
      const inMinutes = typeof args.in_minutes === 'number' ? args.in_minutes : undefined;
      const atTime = str(args.at_time);
      if (inMinutes === undefined && !atTime) return { error: 'Give either in_minutes or at_time.' };
      const taskId = str(args.task_id)?.trim() || undefined;
      let linked: Task | undefined;
      if (taskId) {
        if (!tasks) return { error: 'Tasks are not available.' };
        const found = tasks.find({ id: taskId }, { openOnly: true });
        if (!found.ok) return { error: found.error };
        linked = found.task;
      }
      return {
        verdict: allow, title: 'Set a reminder', detail: '', summary: 'set_reminder',
        async run() {
          const result = reminders.add(text, inMinutes !== undefined ? { inMinutes } : { atTime }, linked?.id);
          if (!result.ok) return `Error: ${result.error}`;
          if (linked && tasks) tasks.update(linked.id, { reminderId: result.reminder.id });
          return `Reminder ${result.reminder.id} set for ${describeDue(result.reminder.dueAt, now())}: ${result.reminder.text}${linked ? ` (task ${linked.id})` : ''}`;
        },
      };
    },
  };
  const listReminders: ToolSpec = {
    name: 'list_reminders',
    description: 'List pending reminders.',
    risk: 'read',
    parameters: { type: 'object', properties: {} },
    async prepare() {
      return {
        verdict: allow, title: 'List reminders', detail: '', summary: 'list_reminders',
        async run() {
          const items = reminders.pending();
          return items.length ? items.map(item => `${item.id}: ${describeDue(item.dueAt, now())} - ${item.text}`).join('\n') : 'No pending reminders.';
        },
      };
    },
  };
  const cancelReminder: ToolSpec = {
    name: 'cancel_reminder',
    description: 'Cancel a pending reminder by id (from list_reminders).',
    risk: 'write',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async prepare(args) {
      const id = str(args.id);
      if (!id) return { error: 'id is required.' };
      return {
        verdict: allow, title: 'Cancel a reminder', detail: '', summary: 'cancel_reminder',
        async run() {
          return reminders.cancel(id) ? `Cancelled ${id}.` : `Error: no pending reminder with id ${id}.`;
        },
      };
    },
  };
  return [setReminder, listReminders, cancelReminder];
}

const PRIORITY_WORDS: Record<string, TaskPriority> = { low: 'low', normal: 'normal', medium: 'normal', high: 'high', urgent: 'high' };
const FILTERS: TaskFilter[] = ['today', 'overdue', 'all', 'done'];
const MAX_LIST_LINES = 20;

/**
 * The daily-planner tools. They only read and write the app's own tasks.json (like the notebook), so they need no
 * approval card; they still obey "Let Sudo-chan use tools" because every call goes through ToolRuntime, and every call
 * is audited. start_task only marks a task "doing" and returns its text: doing the work needs the other tools, with
 * their own approval cards.
 */
export function createTaskSpecs(tasks: TaskService, reminders: Reminders, getSource: () => TaskSource = () => 'chat'): ToolSpec[] {
  const nowMs = () => tasks.now();
  const taskRef = (value: unknown) => {
    const text = str(value)?.trim() ?? '';
    return /^t?\d{1,9}$/i.test(text) ? { id: text } : { title: text };
  };
  const priorityOf = (value: unknown): TaskPriority | undefined | { error: string } => {
    if (value === undefined || value === null || value === '') return undefined;
    const mapped = typeof value === 'string' ? PRIORITY_WORDS[value.trim().toLowerCase()] : undefined;
    return mapped ?? { error: 'priority must be low, normal or high.' };
  };
  const dueOf = (value: unknown): string | null | undefined | { error: string } => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string') return { error: 'due must be text such as "tomorrow 17:00".' };
    const text = value.trim();
    if (!text || /^(none|no|clear|remove|nahi|nahin)$/i.test(text)) return null;
    const parsed = resolveDue(text, nowMs());
    return parsed.ok ? parsed.due : { error: parsed.error };
  };
  /** A reminder at the task's due time (a due day without a time means 09:00). Replaces an older one of this task. */
  const remindFor = (task: Task): string => {
    if (!task.due) return ' No reminder: the task has no due date.';
    const at = dueToMs(task.due, 9);
    reminders.cancelForTask(task.id);
    const result = reminders.add(task.title, { atMs: at }, task.id);
    if (!result.ok) return ` No reminder: ${result.error}`;
    tasks.update(task.id, { reminderId: result.reminder.id });
    return ` Reminder ${result.reminder.id} set for ${describeDue(result.reminder.dueAt, nowMs())}.`;
  };
  const lines = (list: Task[]) => {
    const now = nowMs();
    const shown = list.slice(0, MAX_LIST_LINES).map(task => formatTaskLine(task, now));
    if (list.length > MAX_LIST_LINES) shown.push(`... and ${list.length - MAX_LIST_LINES} more`);
    return shown.join('\n');
  };
  const tool = (name: string, description: string, risk: ToolSpec['risk'], properties: Record<string, unknown>, required: string[], prepare: ToolSpec['prepare']): ToolSpec => ({
    name, description, risk, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) }, prepare,
  });

  const addTaskTool = tool('add_task',
    'Add a task to the user\'s to-do list (no approval needed). title is short; due is optional and may be words like "tomorrow", "kal 5 baje", "Monday" or 2026-11-03 17:00; set remind=true only if the user asked to be reminded.',
    'write',
    { title: { type: 'string' }, notes: { type: 'string' }, priority: { type: 'string', enum: ['low', 'normal', 'high'] }, due: { type: 'string' }, remind: { type: 'boolean' } },
    ['title'],
    async args => {
      const title = str(args.title)?.trim();
      if (!title) return { error: 'title is required.' };
      const priority = priorityOf(args.priority);
      if (priority && typeof priority === 'object') return priority;
      const due = dueOf(args.due);
      if (due && typeof due === 'object') return due;
      return {
        verdict: allow, title: 'Add a task', detail: '', summary: 'add_task',
        async run() {
          const result = tasks.add({ title, notes: str(args.notes), priority: priority as TaskPriority | undefined, due: due as string | null | undefined, source: getSource() });
          if (!result.ok) return `Error: ${result.error}`;
          const extra = args.remind === true ? remindFor(result.task) : '';
          return `Added ${formatTaskLine(result.task, nowMs())}.${extra}`;
        },
      };
    });

  const listTasksTool = tool('list_tasks',
    'List the user\'s tasks. filter: today (overdue + due today + in progress), overdue, all (every open task), done (recently finished). Default: today.',
    'read',
    { filter: { type: 'string', enum: FILTERS } },
    [],
    async args => {
      const raw = str(args.filter)?.trim().toLowerCase() || 'today';
      if (!FILTERS.includes(raw as TaskFilter)) return { error: 'filter must be today, overdue, all or done.' };
      return {
        verdict: allow, title: 'List tasks', detail: '', summary: 'list_tasks',
        async run() {
          const list = filterTasks(tasks.state, raw as TaskFilter, nowMs());
          return list.length ? lines(list) : raw === 'done' ? 'No finished tasks yet.' : raw === 'all' ? 'No open tasks.' : `No ${raw} tasks.`;
        },
      };
    });

  const updateTaskTool = tool('update_task',
    'Change a task. task = its id (like t3) or part of its title. Optional: title (new title), notes, priority, due ("none" clears it), status (todo, doing, done), remind=true to set a reminder at the due time.',
    'write',
    { task: { type: 'string' }, title: { type: 'string' }, notes: { type: 'string' }, priority: { type: 'string', enum: ['low', 'normal', 'high'] }, due: { type: 'string' }, status: { type: 'string', enum: ['todo', 'doing', 'done'] }, remind: { type: 'boolean' } },
    ['task'],
    async args => {
      if (!str(args.task)?.trim()) return { error: 'task is required (the id like t3, or part of the title).' };
      const priority = priorityOf(args.priority);
      if (priority && typeof priority === 'object') return priority;
      const due = dueOf(args.due);
      if (due && typeof due === 'object') return due;
      const status = str(args.status)?.trim().toLowerCase();
      if (status !== undefined && !['todo', 'doing', 'done'].includes(status)) return { error: 'status must be todo, doing or done.' };
      return {
        verdict: allow, title: 'Update a task', detail: '', summary: 'update_task',
        async run() {
          const found = tasks.find(taskRef(args.task));
          if (!found.ok) return `Error: ${found.error}`;
          const patch: TaskPatch = {};
          if (str(args.title) !== undefined) patch.title = str(args.title);
          if (str(args.notes) !== undefined) patch.notes = str(args.notes);
          if (priority) patch.priority = priority as TaskPriority;
          if (due !== undefined) patch.due = due as string | null;
          if (status) patch.status = status as TaskPatch['status'];
          if (!Object.keys(patch).length && args.remind !== true) return 'Error: nothing to change. Give title, notes, priority, due, status or remind.';
          const result = Object.keys(patch).length ? tasks.update(found.task.id, patch) : { ok: true as const, task: found.task };
          if (!result.ok) return `Error: ${result.error}`;
          if (result.task.status === 'done') reminders.cancelForTask(result.task.id);
          const extra = args.remind === true && result.task.status !== 'done' ? remindFor(result.task) : '';
          return `Updated ${formatTaskLine(result.task, nowMs())}.${extra}`;
        },
      };
    });

  const completeTaskTool = tool('complete_task',
    'Mark a task as done. task = its id (like t3) or part of its title. Any reminder for it is cancelled.',
    'write',
    { task: { type: 'string' } },
    ['task'],
    async args => {
      if (!str(args.task)?.trim()) return { error: 'task is required (the id like t3, or part of the title).' };
      return {
        verdict: allow, title: 'Complete a task', detail: '', summary: 'complete_task',
        async run() {
          const found = tasks.find(taskRef(args.task), { openOnly: true });
          if (!found.ok) return `Error: ${found.error}`;
          const result = tasks.complete(found.task.id);
          if (!result.ok) return `Error: ${result.error}`;
          const cancelled = reminders.cancelForTask(result.task.id);
          const left = tasks.state.tasks.filter(task => task.status !== 'done').length;
          return `Done: ${result.task.id} ${result.task.title}.${cancelled ? ' Its reminder was cancelled.' : ''} ${left} open task${left === 1 ? '' : 's'} left.`;
        },
      };
    });

  const planTodayTool = tool('plan_today',
    `The user's plan for today: at most ${MAX_PLAN} tasks in the order to do them (overdue first, then due today, then in progress, then by priority). Use for "aaj mera kya kaam hai".`,
    'read',
    {},
    [],
    async () => ({
      verdict: allow, title: 'Plan for today', detail: '', summary: 'plan_today',
      async run() {
        const state = tasks.state;
        const plan = todayPlan(state, nowMs());
        if (!plan.length) return 'No open tasks. Nothing is planned for today.';
        const open = state.tasks.filter(task => task.status !== 'done').length;
        const body = plan.map((task, index) => `${index + 1}. ${formatTaskLine(task, nowMs())}`).join('\n');
        return `Plan for today (${plan.length} of ${open} open task${open === 1 ? '' : 's'}):\n${body}`;
      },
    }));

  const nextTaskTool = tool('next_task',
    'The single task the user should do next (does not change anything).',
    'read',
    {},
    [],
    async () => ({
      verdict: allow, title: 'Next task', detail: '', summary: 'next_task',
      async run() {
        const task = nextTask(tasks.state, nowMs());
        return task ? `Next: ${formatTaskLine(task, nowMs())}${task.notes ? `\nNotes: ${task.notes}` : ''}` : 'No open tasks.';
      },
    }));

  const startTaskTool = tool('start_task',
    'Start working on a task ("mera kaam utha lo"): marks it in progress and returns its text. task = id (like t3) or part of the title; leave it out to take the next task. Starting does NOT do the work: afterwards use read_file / edit_file / open_url / run_command (they need the user\'s click) and only report what their results confirm.',
    'write',
    { task: { type: 'string' } },
    [],
    async args => ({
      verdict: allow, title: 'Start a task', detail: '', summary: 'start_task',
      async run() {
        const ref = str(args.task)?.trim();
        let task: Task | null | undefined;
        if (ref) {
          const found = tasks.find(taskRef(ref), { openOnly: true });
          if (!found.ok) return `Error: ${found.error}`;
          task = found.task;
        } else {
          task = nextTask(tasks.state, nowMs());
          if (!task) return 'Error: there are no open tasks to start.';
        }
        const others = tasks.state.tasks.filter(item => item.status === 'doing' && item.id !== task.id);
        const result = task.status === 'doing' ? { ok: true as const, task } : tasks.start(task.id);
        if (!result.ok) return `Error: ${result.error}`;
        const started = result.task;
        const parts = [`Started ${formatTaskLine(started, nowMs())}.`];
        if (started.notes) parts.push(`Notes: ${started.notes}`);
        if (others.length) parts.push(`Also in progress: ${others.slice(0, 3).map(item => `${item.id} ${item.title}`).join('; ')}.`);
        parts.push('Marking it started did not do any of the work. Do the work only with the other tools and say only what their results confirm.');
        return parts.join('\n');
      },
    }));

  return [addTaskTool, listTasksTool, updateTaskTool, completeTaskTool, planTodayTool, nextTaskTool, startTaskTool];
}
