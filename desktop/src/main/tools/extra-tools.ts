import type { ToolSpec } from './registry.js';
import { describeDue, type Reminders } from './reminders.ts';
import type { NotesStore } from './notes.ts';

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

export function createReminderSpecs(reminders: Reminders, now: () => number = Date.now): ToolSpec[] {
  const setReminder: ToolSpec = {
    name: 'set_reminder',
    description: 'Remind the user later with a notification and a spoken line. Give in_minutes (e.g. 5) OR at_time (local clock, e.g. "17:30").',
    risk: 'write',
    parameters: { type: 'object', properties: { text: { type: 'string' }, in_minutes: { type: 'number' }, at_time: { type: 'string' } }, required: ['text'] },
    async prepare(args) {
      const text = str(args.text);
      if (!text?.trim()) return { error: 'text is required.' };
      const inMinutes = typeof args.in_minutes === 'number' ? args.in_minutes : undefined;
      const atTime = str(args.at_time);
      if (inMinutes === undefined && !atTime) return { error: 'Give either in_minutes or at_time.' };
      return {
        verdict: allow, title: 'Set a reminder', detail: '', summary: 'set_reminder',
        async run() {
          const result = reminders.add(text, inMinutes !== undefined ? { inMinutes } : { atTime });
          if (!result.ok) return `Error: ${result.error}`;
          return `Reminder ${result.reminder.id} set for ${describeDue(result.reminder.dueAt, now())}: ${result.reminder.text}`;
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
