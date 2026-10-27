import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MAX_TASKS_FILE_BYTES, addTask, applyPanelAction, buildView, completeTask, emptyState, findTask, normalizeState, parseAddText, parsePanelAction, removeTask, startTask, updateTask,
  type NewTask, type TaskPatch, type TaskResult, type TaskState, type TasksView,
} from '../shared/tasks.ts';

export interface TaskStorage {
  read(): { state: TaskState; note?: string };
  write(state: TaskState): void;
}

/**
 * userData/tasks.json: tasks only, never keys, never inside config.json. Mode 0600, written atomically (temp file in the
 * same folder, fsync, rename), the previous good file is kept as tasks.json.bak. A file that cannot be read is moved to
 * tasks.corrupt.json (so nothing is silently destroyed) and the backup is tried before starting empty.
 */
export class TaskFile implements TaskStorage {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private parse(path: string): { state: TaskState; dropped: number } | undefined {
    try {
      if (statSync(path).size > MAX_TASKS_FILE_BYTES) return undefined;
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
      return normalizeState(raw);
    } catch {
      return undefined;
    }
  }

  read(): { state: TaskState; note?: string } {
    if (!existsSync(this.path)) return { state: emptyState() };
    const parsed = this.parse(this.path);
    if (parsed && parsed.dropped === 0) return { state: parsed.state };
    const corrupt = join(dirname(this.path), 'tasks.corrupt.json');
    try { copyFileSync(this.path, corrupt); chmodSync(corrupt, 0o600); } catch { /* keeping the evidence is best effort */ }
    if (parsed) return { state: parsed.state, note: `kept ${parsed.state.tasks.length} valid tasks, ${parsed.dropped} damaged entries were set aside in tasks.corrupt.json` };
    const backup = this.parse(`${this.path}.bak`);
    if (backup) return { state: backup.state, note: 'tasks.json was damaged; restored from tasks.json.bak' };
    return { state: emptyState(), note: 'tasks.json was damaged and no backup was usable; started empty (the old file is tasks.corrupt.json)' };
  }

  write(state: TaskState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (existsSync(this.path)) {
      try { copyFileSync(this.path, `${this.path}.bak`); chmodSync(`${this.path}.bak`, 0o600); } catch { /* the main write below matters more */ }
    }
    const temp = `${this.path}.tmp-${process.pid}`;
    const text = JSON.stringify({ version: 1, seq: state.seq, tasks: state.tasks });
    const fd = openSync(temp, 'w', 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, this.path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    chmodSync(this.path, 0o600);
  }
}

export interface TaskServiceDeps {
  storage: TaskStorage;
  now: () => number;
  /** Called after every saved change (main sends the new view to the chat window only). */
  onChange?: (view: TasksView) => void;
}

/**
 * The one place tasks are read and changed. The assistant's task tools and the chat window's panel both go through
 * it, so they always see the same list. Everything is synchronous: one change finishes (and is saved) before the next.
 */
export class TaskService {
  private deps: TaskServiceDeps;
  private current: TaskState | undefined;
  /** Why the file was repaired on load, if it was (shown in the log, never in the UI). */
  loadNote: string | undefined;

  constructor(deps: TaskServiceDeps) {
    this.deps = deps;
  }

  get state(): TaskState {
    if (!this.current) {
      try {
        const loaded = this.deps.storage.read();
        this.current = loaded.state;
        this.loadNote = loaded.note;
      } catch {
        this.current = emptyState();
        this.loadNote = 'tasks.json could not be read; started empty';
      }
    }
    return this.current;
  }

  now(): number {
    return this.deps.now();
  }

  view(): TasksView {
    return buildView(this.state, this.deps.now());
  }

  /** Runs a pure change; keeps it only if it was saved. A failed save leaves the list as it was. */
  apply(change: (state: TaskState, now: number) => TaskResult): TaskResult {
    const before = this.state;
    const result = change(before, this.deps.now());
    if (!result.ok) return result;
    try {
      this.deps.storage.write(result.state);
    } catch (error) {
      return { ok: false, error: `Could not save the task list (${(error as NodeJS.ErrnoException).code ?? 'disk error'}). Nothing was changed.` };
    }
    this.current = result.state;
    try { this.deps.onChange?.(buildView(result.state, this.deps.now())); } catch { /* a closed window must not undo a saved task */ }
    return result;
  }

  add(input: NewTask): TaskResult { return this.apply((state, now) => addTask(state, input, now)); }
  update(id: string, patch: TaskPatch): TaskResult { return this.apply((state, now) => updateTask(state, id, patch, now)); }
  complete(id: string): TaskResult { return this.apply((state, now) => completeTask(state, id, now)); }
  start(id: string): TaskResult { return this.apply((state, now) => startTask(state, id, now)); }
  remove(id: string): TaskResult { return this.apply(state => removeTask(state, id)); }
  find(ref: { id?: unknown; title?: unknown }, options?: { openOnly?: boolean }) { return findTask(this.state, ref, options); }

  /** Chat window: text from the add box ("kal client ko email bhejna"). */
  addFromText(text: unknown): { ok: boolean; error?: string; view: TasksView } {
    const parsed = parseAddText(text, this.deps.now());
    if (!parsed.ok) return { ok: false, error: parsed.error, view: this.view() };
    const result = this.add({ title: parsed.title, due: parsed.due, priority: parsed.priority, source: 'ui' });
    return result.ok ? { ok: true, view: this.view() } : { ok: false, error: result.error, view: this.view() };
  }

  /** Chat window: a click on a task row. Returns the removed/finished task so the caller can cancel its reminder. */
  panelAction(raw: unknown): { ok: boolean; error?: string; reminderId?: string | null; view: TasksView } {
    const input = parsePanelAction(raw);
    if (!input) return { ok: false, error: 'Invalid task action.', view: this.view() };
    const result = this.apply((state, now) => applyPanelAction(state, input, now));
    if (!result.ok) return { ok: false, error: result.error, view: this.view() };
    const closing = input.action === 'done' || input.action === 'remove';
    return { ok: true, reminderId: closing ? result.task.reminderId : null, view: this.view() };
  }
}
