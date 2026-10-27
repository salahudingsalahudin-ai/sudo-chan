export const MAX_REMINDERS = 50;
export const MAX_REMINDER_TEXT = 200;
const MAX_MINUTES = 60 * 24 * 365;
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface Reminder {
  id: string;
  text: string;
  dueAt: number;
  createdAt: number;
  /** The task this reminder belongs to (optional). */
  taskId?: string;
}

export interface ReminderDeps {
  load: () => Reminder[];
  save: (list: Reminder[]) => void;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Fires the notification and the spoken line. `lateMs` > 0 means the app was not running at the due time. */
  onDue: (reminder: Reminder, lateMs: number) => void;
}

export type AddResult = { ok: true; reminder: Reminder } | { ok: false; error: string };

/** "17:30", "5:30pm", "5pm", "0930" -> the next local time at that clock time (today if still ahead, else tomorrow). */
export function nextClockTime(input: string, now: number): number | null {
  const match = /^\s*(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?\s*$/i.exec(input);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
  }
  if (hours > 23 || minutes > 59) return null;
  const due = new Date(now);
  due.setHours(hours, minutes, 0, 0);
  if (due.getTime() <= now) due.setDate(due.getDate() + 1);
  return due.getTime();
}

export function describeDue(dueAt: number, now: number): string {
  const time = new Date(dueAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const minutes = Math.round((dueAt - now) / 60_000);
  if (minutes < 60) return `${time} (in ${Math.max(0, minutes)} min)`;
  if (minutes < 60 * 24) return `${time} (in ${Math.floor(minutes / 60)} h ${minutes % 60} min)`;
  return `${new Date(dueAt).toLocaleDateString('en-GB')} ${time}`;
}

/** Persisted reminders with one timer for the next due one. Survives restarts; late ones fire at startup. */
export class Reminders {
  private deps: ReminderDeps;
  private list: Reminder[] = [];
  private timer: unknown = null;
  private counter = 0;
  private loaded = false;

  constructor(deps: ReminderDeps) {
    this.deps = deps;
  }

  /** Load from storage, fire anything overdue, schedule the rest. */
  start() {
    this.ensureLoaded();
    this.tick();
  }

  /** Storage is read once, lazily, so an add/list before start() can never overwrite stored reminders. */
  private ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    let stored: Reminder[] = [];
    try { stored = this.deps.load(); } catch { stored = []; }
    const known = new Set(this.list.map(item => item.id));
    const valid = stored.filter(item => item && typeof item.id === 'string' && typeof item.text === 'string' && Number.isFinite(item.dueAt) && !known.has(item.id));
    this.list = [...valid, ...this.list];
  }

  pending(): Reminder[] {
    this.ensureLoaded();
    return [...this.list].sort((a, b) => a.dueAt - b.dueAt);
  }

  add(text: string, when: { inMinutes?: number; atTime?: string; atMs?: number }, taskId?: string): AddResult {
    this.ensureLoaded();
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return { ok: false, error: 'The reminder text is empty.' };
    if (clean.length > MAX_REMINDER_TEXT) return { ok: false, error: `The reminder text is too long (max ${MAX_REMINDER_TEXT} characters).` };
    if (this.list.length >= MAX_REMINDERS) return { ok: false, error: `Too many reminders (max ${MAX_REMINDERS}). Cancel some first.` };
    const now = this.deps.now();
    let dueAt: number | null = null;
    if (typeof when.inMinutes === 'number') {
      if (!Number.isFinite(when.inMinutes) || when.inMinutes < 1 || when.inMinutes > MAX_MINUTES) return { ok: false, error: 'in_minutes must be between 1 and 525600.' };
      dueAt = now + Math.round(when.inMinutes) * 60_000;
    } else if (typeof when.atMs === 'number') {
      if (!Number.isFinite(when.atMs) || when.atMs <= now) return { ok: false, error: 'That time has already passed.' };
      if (when.atMs - now > MAX_MINUTES * 60_000) return { ok: false, error: 'That is more than a year away.' };
      dueAt = Math.round(when.atMs / 60_000) * 60_000;
    } else if (typeof when.atTime === 'string') {
      dueAt = nextClockTime(when.atTime, now);
      if (dueAt === null) return { ok: false, error: 'at_time must look like 17:30 or 5:30pm.' };
    } else {
      return { ok: false, error: 'Give either in_minutes or at_time.' };
    }
    const reminder: Reminder = { id: `r-${now.toString(36)}-${++this.counter}`, text: clean, dueAt, createdAt: now };
    if (taskId) reminder.taskId = taskId;
    this.list.push(reminder);
    this.persist();
    this.schedule();
    return { ok: true, reminder };
  }

  cancel(id: string): boolean {
    this.ensureLoaded();
    const before = this.list.length;
    this.list = this.list.filter(item => item.id !== id);
    if (this.list.length === before) return false;
    this.persist();
    this.schedule();
    return true;
  }

  /** Cancels every pending reminder that belongs to this task; returns how many. */
  cancelForTask(taskId: string): number {
    this.ensureLoaded();
    const before = this.list.length;
    this.list = this.list.filter(item => item.taskId !== taskId);
    const removed = before - this.list.length;
    if (removed) {
      this.persist();
      this.schedule();
    }
    return removed;
  }

  /** Stops the timer (app quit). Reminders stay stored. */
  stop() {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private persist() {
    try { this.deps.save(this.list); } catch { /* a storage hiccup must not lose the in-memory reminder */ }
  }

  private tick() {
    const now = this.deps.now();
    const due = this.list.filter(item => item.dueAt <= now);
    if (due.length) {
      this.list = this.list.filter(item => item.dueAt > now);
      this.persist();
      for (const reminder of due.sort((a, b) => a.dueAt - b.dueAt)) {
        try { this.deps.onDue(reminder, Math.max(0, now - reminder.dueAt)); } catch { /* notification problems must not stop the others */ }
      }
    }
    this.schedule();
  }

  private schedule() {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    if (!this.list.length) return;
    const next = Math.min(...this.list.map(item => item.dueAt));
    const delay = Math.max(0, Math.min(next - this.deps.now(), MAX_TIMER_MS));
    this.timer = this.deps.setTimer(() => this.tick(), delay);
  }
}
