import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

export const MAX_NOTE_BYTES = 20 * 1024;
export const MAX_NOTES = 200;
const MAX_LIST = 100;

/** Lowercase file-safe name from a title: letters, digits and dashes only, never empty. */
export function noteSlug(title: string): string {
  const slug = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'note';
}

/** Accepts "shopping", "shopping.md" and nothing that could point outside the notes folder. */
export function safeNoteFile(name: string): string | null {
  const base = name.trim().replace(/\.md$/i, '');
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(base)) return null;
  return `${base}.md`;
}

export interface NoteInfo {
  file: string;
  bytes: number;
  modified: number;
}

/**
 * A tiny notebook that lives in ONE folder inside the app data directory. It is reachable only through the three
 * note tools: the generic file tools refuse that folder (the whole app data directory is a hard block).
 */
export class NotesStore {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async save(title: string, text: string): Promise<{ file: string }> {
    if (!text.trim()) throw new Error('The note is empty.');
    if (Buffer.byteLength(text, 'utf8') > MAX_NOTE_BYTES) throw new Error(`The note is too long (max ${MAX_NOTE_BYTES / 1024} KB).`);
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const existing = (await fsp.readdir(this.dir)).filter(name => name.endsWith('.md'));
    if (existing.length >= MAX_NOTES) throw new Error(`Too many notes (max ${MAX_NOTES}). Ask the user to delete some first.`);
    const taken = new Set(existing);
    const slug = noteSlug(title);
    let file = `${slug}.md`;
    for (let i = 2; taken.has(file); i++) {
      if (i > 99) throw new Error('Could not find a free note name.');
      file = `${slug}-${i}.md`;
    }
    await fsp.writeFile(join(this.dir, file), text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { file };
  }

  async list(): Promise<NoteInfo[]> {
    let names: string[];
    try {
      names = (await fsp.readdir(this.dir)).filter(name => name.endsWith('.md'));
    } catch {
      return [];
    }
    const infos: NoteInfo[] = [];
    for (const file of names.slice(0, MAX_NOTES)) {
      const stat = await fsp.stat(join(this.dir, file)).catch(() => null);
      if (stat?.isFile()) infos.push({ file, bytes: stat.size, modified: stat.mtimeMs });
    }
    return infos.sort((a, b) => b.modified - a.modified).slice(0, MAX_LIST);
  }

  async read(name: string): Promise<string> {
    const file = safeNoteFile(name);
    if (!file) throw new Error('That is not a valid note name. Use list_notes to see the names.');
    try {
      const text = await fsp.readFile(join(this.dir, file), 'utf8');
      return text.length > MAX_NOTE_BYTES ? `${text.slice(0, MAX_NOTE_BYTES)}\n[cut]` : text;
    } catch {
      throw new Error(`No note called "${file}". Use list_notes to see the names.`);
    }
  }
}
