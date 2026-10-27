import { execFile, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { arch, cpus, freemem, platform, release, totalmem, uptime } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type * as PolicyModule from './policy.js';
import type { ToolDefinition, ToolRisk, Verdict } from './types.js';

export type PolicyApi = Pick<
  typeof PolicyModule,
  'checkPath' | 'checkCommand' | 'checkUrl' | 'checkAppName' | 'tokenizeCommand' | 'truncate' | 'sanitizedEnv' | 'isSecretPath'
> & { CommandParseError: typeof PolicyModule.CommandParseError; MAX_RESULT_BYTES: number; MAX_READ_BYTES: number };

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface RegistryDeps {
  home: string;
  runProgram: (program: string, args: string[], options: { cwd: string; timeoutMs: number; signal: AbortSignal; env: NodeJS.ProcessEnv }) => Promise<RunResult>;
  openDetached: (program: string, args: string[]) => Promise<{ ok: boolean; error?: string }>;
}

/** A tool call that has been validated and is ready either to run or to be shown on an approval card. */
export interface Prepared {
  verdict: Verdict;
  title: string;
  detail: string;
  /** One line for the audit log (never file contents). */
  summary: string;
  allowForChat?: boolean;
  run: (signal: AbortSignal) => Promise<string>;
}

export interface ToolSpec {
  name: string;
  description: string;
  risk: ToolRisk;
  parameters: Record<string, unknown>;
  prepare: (args: Record<string, unknown>) => Promise<Prepared | { error: string }>;
}

const MAX_WRITE_BYTES = 200 * 1024;
/** One read_file answer is at most this big (it is re-sent on every following step, so it must stay small). */
export const READ_PAGE_BYTES = 6 * 1024;
/** read_file never looks at more than this much of a file (ranges are counted inside this window). */
const READ_SCAN_BYTES = 1024 * 1024;
const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_LINES = 8;
const MAX_DIR_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 50;
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.next', 'dist', 'build', '__pycache__', '.venv', 'venv', '.npm', '.pub-cache']);

export const nodeRunProgram: RegistryDeps['runProgram'] = (program, args, options) =>
  new Promise<RunResult>(resolve => {
    const child = execFile(program, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024,
      signal: options.signal,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      const aborted = Boolean(err && (err.name === 'AbortError' || options.signal.aborted));
      const timedOut = Boolean(err && err.killed && !aborted);
      let code: number | null = 0;
      if (err) code = typeof err.code === 'number' ? err.code : null;
      const spawnFailed = err && typeof err.code === 'string' ? `Could not run "${program}": ${err.code === 'ENOENT' ? 'program not found' : err.code}` : '';
      resolve({ code, stdout: String(stdout ?? ''), stderr: spawnFailed || String(stderr ?? ''), timedOut, aborted });
    });
    child.on('error', () => { /* reported through the callback */ });
  });

export const nodeOpenDetached: RegistryDeps['openDetached'] = (program, args) =>
  new Promise(resolve => {
    try {
      const child = spawn(program, args, { detached: true, stdio: 'ignore' });
      child.once('error', error => resolve({ ok: false, error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? `"${program}" was not found.` : error.message }));
      child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
    } catch (error) {
      resolve({ ok: false, error: (error as Error).message });
    }
  });

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function lineDiff(oldText: string, newText: string): { added: number; removed: number } {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const oldSet = new Map<string, number>();
  for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
  let same = 0;
  for (const line of newLines) {
    const count = oldSet.get(line) ?? 0;
    if (count > 0) { same++; oldSet.set(line, count - 1); }
  }
  return { added: newLines.length - same, removed: oldLines.length - same };
}

function preview(text: string, lines = 12): string {
  const parts = text.split('\n');
  const shown = parts.slice(0, lines).map(line => (line.length > 160 ? line.slice(0, 160) + '…' : line)).join('\n');
  return parts.length > lines ? `${shown}\n… (${parts.length - lines} more lines)` : shown;
}

/** Exactly-matching positions of `needle` in `text` (non-overlapping). */
function matchOffsets(text: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) found.push(at);
  return found;
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/** Compact before/after of an edit: only the changed lines ("- old" / "+ new"), long blocks shortened. Never the rest of the file. */
export function editDiffText(oldText: string, newText: string, startLine: number): { text: string; added: number; removed: number; firstLine: number } {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
  let tail = 0;
  while (tail < oldLines.length - head && tail < newLines.length - head && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++;
  const removedLines = oldLines.slice(head, oldLines.length - tail);
  const addedLines = newLines.slice(head, newLines.length - tail);
  const render = (lines: string[], mark: string) => {
    const shown = lines.slice(0, MAX_DIFF_LINES).map(line => `${mark} ${line.length > 110 ? line.slice(0, 110) + '…' : line}`);
    if (lines.length > MAX_DIFF_LINES) shown.push(`${mark} … (${lines.length - MAX_DIFF_LINES} more lines)`);
    return shown;
  };
  const body = [...render(removedLines, '-'), ...render(addedLines, '+')];
  return { text: body.join('\n') || '(no visible line change)', added: addedLines.length, removed: removedLines.length, firstLine: startLine + head };
}

export function createRegistry(policy: PolicyApi, deps: RegistryDeps): ToolSpec[] {
  const pathProblem = (check: { verdict: string; reason?: string }) => (check.verdict === 'deny' ? { error: check.reason ?? 'Path not allowed.' } : null);

  const readFile: ToolSpec = {
    name: 'read_file',
    description: `Read a text file from the user's computer (home folder). Returns at most ~${READ_PAGE_BYTES / 1024} KB per call; for bigger files pass start_line / end_line (1-based, inclusive) and follow the "call again with start_line=N" footer.`,
    risk: 'read',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, e.g. ~/notes.txt' },
        start_line: { type: 'integer', description: 'First line to return (1-based). Optional.' },
        end_line: { type: 'integer', description: 'Last line to return (inclusive). Optional.' },
      },
      required: ['path'],
    },
    async prepare(args) {
      const path = str(args.path);
      if (!path) return { error: 'path is required.' };
      const lineArg = (value: unknown, name: string): number | undefined | { error: string } => {
        if (value === undefined || value === null) return undefined;
        const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return { error: `${name} must be a whole number of 1 or more.` };
        return n;
      };
      const startArg = lineArg(args.start_line, 'start_line');
      if (typeof startArg === 'object') return startArg;
      const endArg = lineArg(args.end_line, 'end_line');
      if (typeof endArg === 'object') return endArg;
      if (startArg !== undefined && endArg !== undefined && endArg < startArg) return { error: 'end_line must not be smaller than start_line.' };
      const check = policy.checkPath(path, { home: deps.home });
      const bad = pathProblem(check);
      if (bad) return bad;
      const ranged = startArg !== undefined || endArg !== undefined;
      return {
        verdict: check,
        title: 'Read a file',
        detail: check.path,
        summary: `read ${check.path}${ranged ? ` lines ${startArg ?? 1}-${endArg ?? 'end'}` : ''}`,
        async run() {
          const stat = await fsp.stat(check.path);
          if (stat.isDirectory()) return 'Error: that is a folder. Use list_dir.';
          const handle = await fsp.open(check.path, 'r');
          let text: string;
          try {
            const buffer = Buffer.alloc(Math.min(stat.size, READ_SCAN_BYTES + 4));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const data = buffer.subarray(0, bytesRead);
            if (data.subarray(0, 1024).includes(0)) return 'Error: this looks like a binary file; not shown.';
            text = data.toString('utf8');
          } finally {
            await handle.close();
          }
          const scanned = stat.size > READ_SCAN_BYTES;
          // Small file, no range: exactly the old behaviour (the whole text, no footer).
          if (!ranged && !scanned && Buffer.byteLength(text) <= READ_PAGE_BYTES) return text;
          const lines = text.split('\n');
          if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
          const total = lines.length;
          const first = startArg ?? 1;
          if (first > total) return `Error: the file has only ${total} line(s)${scanned ? ' in its first 1 MB' : ''}; start_line=${first} is past the end.`;
          const last = Math.min(endArg ?? total, total);
          const out: string[] = [];
          let used = 0;
          let n = first;
          for (; n <= last; n++) {
            const line = lines[n - 1];
            const cost = Buffer.byteLength(line) + 1;
            if (out.length > 0 && used + cost > READ_PAGE_BYTES) break;
            // A single huge line is cut so one call can never exceed the page size.
            out.push(cost > READ_PAGE_BYTES ? policy.truncate(line, READ_PAGE_BYTES) : line);
            used += Math.min(cost, READ_PAGE_BYTES);
          }
          const shownLast = n - 1;
          const body = out.join('\n');
          if (shownLast < last) {
            return `${body}\n[truncated: showed lines ${first}-${shownLast} of ${total}${scanned ? '+' : ''}. Call read_file again with start_line=${shownLast + 1} to continue.]`;
          }
          if (shownLast < total || scanned) {
            const more = shownLast < total ? ` Call read_file again with start_line=${shownLast + 1} for more.` : ' The rest of this large file is not shown.';
            return `${body}\n[showed lines ${first}-${shownLast} of ${total}${scanned ? '+' : ''}.${more}]`;
          }
          return first > 1 ? `${body}\n[showed lines ${first}-${shownLast} of ${total}; end of file.]` : body;
        },
      };
    },
  };

  const listDir: ToolSpec = {
    name: 'list_dir',
    description: 'List the files and folders in a directory (defaults to the home folder).',
    risk: 'read',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    async prepare(args) {
      const check = policy.checkPath(str(args.path) ?? '~', { home: deps.home });
      const bad = pathProblem(check);
      if (bad) return bad;
      return {
        verdict: check,
        title: 'List a folder',
        detail: check.path,
        summary: `list ${check.path}`,
        async run() {
          const entries = await fsp.readdir(check.path, { withFileTypes: true });
          const lines: string[] = [];
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const full = join(check.path, entry.name);
            if (policy.isSecretPath(full, deps.home)) continue;
            if (lines.length >= MAX_DIR_ENTRIES) { lines.push(`... more than ${MAX_DIR_ENTRIES} entries`); break; }
            lines.push(`${entry.isDirectory() ? 'dir ' : entry.isSymbolicLink() ? 'link' : 'file'}  ${entry.name}`);
          }
          return policy.truncate(lines.join('\n') || '(empty folder)');
        },
      };
    },
  };

  const searchFiles: ToolSpec = {
    name: 'search_files',
    description: 'Search under a folder for files whose NAME contains the query, or (content=true) whose text contains it. Skips node_modules, .git and secret locations.',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, path: { type: 'string' }, content: { type: 'boolean' } },
      required: ['query'],
    },
    async prepare(args) {
      const query = str(args.query);
      if (!query || query.length > 200) return { error: 'query is required (max 200 characters).' };
      const check = policy.checkPath(str(args.path) ?? '~', { home: deps.home });
      const bad = pathProblem(check);
      if (bad) return bad;
      const inContent = args.content === true;
      return {
        verdict: check,
        title: 'Search files',
        detail: `${inContent ? 'text' : 'name'} contains "${query}" under ${check.path}`,
        summary: `search "${query.slice(0, 40)}" in ${check.path}`,
        async run(signal) {
          const needle = query.toLowerCase();
          const hits: string[] = [];
          const walk = async (folder: string, depth: number): Promise<void> => {
            if (hits.length >= MAX_SEARCH_RESULTS || depth > 6 || signal.aborted) return;
            let entries;
            try { entries = await fsp.readdir(folder, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
              if (hits.length >= MAX_SEARCH_RESULTS || signal.aborted) return;
              const full = join(folder, entry.name);
              if (policy.isSecretPath(full, deps.home)) continue;
              if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
              } else if (entry.isFile()) {
                if (!inContent) {
                  if (entry.name.toLowerCase().includes(needle)) hits.push(full);
                } else {
                  try {
                    const stat = await fsp.stat(full);
                    if (stat.size > 512 * 1024) continue;
                    const data = await fsp.readFile(full);
                    if (data.subarray(0, 1024).includes(0)) continue;
                    const text = data.toString('utf8');
                    const index = text.toLowerCase().indexOf(needle);
                    if (index >= 0) {
                      const line = text.slice(0, index).split('\n').length;
                      hits.push(`${full}:${line}`);
                    }
                  } catch { /* unreadable file */ }
                }
              }
            }
          };
          await walk(check.path, 0);
          return policy.truncate(hits.join('\n') || 'No matches.');
        },
      };
    },
  };

  const writeLike = (name: 'write_file' | 'append_file'): ToolSpec => ({
    name,
    description: name === 'write_file'
      ? 'Create a NEW text file (or fully replace one) in the home folder; for a small change to an existing file use edit_file instead. Keep content under ~2500 characters per call (use append_file for the rest). The user must approve each write.'
      : 'Append text to a file in the home folder (created if missing). The user must approve each append.',
    risk: 'write',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' }, create_dirs: { type: 'boolean' } },
      required: ['path', 'content'],
    },
    async prepare(args) {
      const path = str(args.path);
      const content = str(args.content);
      if (!path || content === undefined) return { error: 'path and content are required.' };
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES) return { error: `content is too large (max ${MAX_WRITE_BYTES / 1024} KB).` };
      const check = policy.checkPath(path, { home: deps.home, write: true });
      const bad = pathProblem(check);
      if (bad) return bad;
      let existing: string | null = null;
      try {
        const stat = await fsp.stat(check.path);
        if (stat.isDirectory()) return { error: 'That path is a folder.' };
        if (stat.size <= MAX_WRITE_BYTES) existing = await fsp.readFile(check.path, 'utf8');
        else existing = '';
      } catch { existing = null; }
      const bytes = Buffer.byteLength(content);
      let detail: string;
      if (name === 'append_file') {
        detail = `${check.path}\n${existing === null ? 'New file' : 'Appending to existing file'} · +${bytes} bytes\n\n${preview(content)}`;
      } else if (existing === null) {
        detail = `${check.path}\nNew file · ${bytes} bytes\n\n${preview(content)}`;
      } else {
        const diff = lineDiff(existing, content);
        detail = `${check.path}\nOVERWRITES an existing file · ${existing.length} → ${content.length} chars · +${diff.added} / -${diff.removed} lines\n\n${preview(content)}`;
      }
      const createDirs = args.create_dirs === true;
      return {
        verdict: { verdict: 'confirm' },
        title: name === 'write_file' ? (existing === null ? 'Create a file' : 'Overwrite a file') : 'Append to a file',
        detail,
        summary: `${name} ${check.path} (${bytes} bytes)`,
        async run() {
          if (createDirs) await fsp.mkdir(dirname(check.path), { recursive: true });
          if (name === 'write_file') await fsp.writeFile(check.path, content, 'utf8');
          else await fsp.appendFile(check.path, content, 'utf8');
          return `OK: ${name === 'write_file' ? 'wrote' : 'appended'} ${bytes} bytes to ${check.path}`;
        },
      };
    },
  });

  const editFile: ToolSpec = {
    name: 'edit_file',
    description: 'Change an existing text file: replace old_text with new_text. old_text must appear EXACTLY ONCE in the file (copy it exactly, include enough neighbouring lines to be unique). Preferred for any small change. The user must approve each edit and sees the before/after lines.',
    risk: 'write',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string', description: 'Exact text to replace; must match exactly one place.' },
        new_text: { type: 'string', description: 'Replacement text (may be empty to delete old_text).' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
    async prepare(args) {
      const path = str(args.path);
      const oldText = str(args.old_text);
      const newText = str(args.new_text);
      if (!path || oldText === undefined || newText === undefined) return { error: 'path, old_text and new_text are required.' };
      if (!oldText) return { error: 'old_text must not be empty. To create a file use write_file; to add at the end use append_file.' };
      if (oldText === newText) return { error: 'old_text and new_text are identical; nothing to change.' };
      if (Buffer.byteLength(oldText) > MAX_WRITE_BYTES || Buffer.byteLength(newText) > MAX_WRITE_BYTES) return { error: `old_text/new_text are too large (max ${MAX_WRITE_BYTES / 1024} KB).` };
      const check = policy.checkPath(path, { home: deps.home, write: true });
      const bad = pathProblem(check);
      if (bad) return bad;

      /** Finds the single match; returns the problem text for the model otherwise. */
      const locate = (content: string): { error: string } | { at: number; from: string; to: string } => {
        let from = oldText;
        let to = newText;
        let hits = matchOffsets(content, from);
        // A CRLF file edited with LF-only text: match with CRLF line endings instead.
        if (!hits.length && content.includes('\r\n') && !from.includes('\r\n') && from.includes('\n')) {
          from = from.replace(/\n/g, '\r\n');
          to = to.replace(/\r?\n/g, '\r\n');
          hits = matchOffsets(content, from);
        }
        if (hits.length === 0) {
          return { error: 'old_text was not found in the file, so nothing was changed. Call read_file (with start_line/end_line) to see the exact current text, then retry with old_text copied exactly, including spaces and indentation.' };
        }
        if (hits.length > 1) {
          const where = hits.slice(0, 5).map(at => lineNumberAt(content, at)).join(', ');
          return { error: `old_text matches ${hits.length} places (lines ${where}${hits.length > 5 ? ', ...' : ''}), so nothing was changed. Call edit_file again with old_text extended by neighbouring lines so it matches exactly one place.` };
        }
        return { at: hits[0], from, to };
      };

      let content: string;
      try {
        const stat = await fsp.stat(check.path);
        if (stat.isDirectory()) return { error: 'That path is a folder.' };
        if (stat.size > MAX_EDIT_FILE_BYTES) return { error: `The file is too large to edit (${Math.round(stat.size / 1024)} KB, max ${MAX_EDIT_FILE_BYTES / 1024} KB).` };
        const buffer = await fsp.readFile(check.path);
        if (buffer.subarray(0, 1024).includes(0)) return { error: 'This looks like a binary file; it cannot be edited.' };
        content = buffer.toString('utf8');
      } catch {
        return { error: 'The file does not exist or cannot be read. To create a new file use write_file.' };
      }
      const found = locate(content);
      if ('error' in found) return found;
      const startLine = lineNumberAt(content, found.at);
      const diff = editDiffText(found.from, found.to, startLine);
      return {
        verdict: { verdict: 'confirm' },
        title: 'Edit a file',
        detail: `${check.path}\nline ${diff.firstLine} · -${diff.removed} / +${diff.added} lines\n${diff.text}`,
        summary: `edit_file ${check.path} (line ${diff.firstLine}, -${diff.removed}/+${diff.added} lines)`,
        async run() {
          // The file may have changed while the card was open: check again before touching it.
          const target = await fsp.realpath(check.path);
          const stat = await fsp.stat(target);
          const now = (await fsp.readFile(target)).toString('utf8');
          const again = locate(now);
          if ('error' in again) return `Error: the file changed while waiting for approval. ${again.error}`;
          const updated = now.slice(0, again.at) + again.to + now.slice(again.at + again.from.length);
          const temp = join(dirname(target), `.${basename(target)}.sudo-tmp-${process.pid}-${Date.now().toString(36)}`);
          try {
            await fsp.writeFile(temp, updated, { encoding: 'utf8', mode: stat.mode & 0o7777, flag: 'wx' });
            await fsp.chmod(temp, stat.mode & 0o7777);
            await fsp.rename(temp, target);
          } catch (error) {
            await fsp.rm(temp, { force: true }).catch(() => undefined);
            throw error;
          }
          return `OK: edited ${check.path} (line ${diff.firstLine}, -${diff.removed} / +${diff.added} lines)`;
        },
      };
    },
  };

  const runCommand: ToolSpec = {
    name: 'run_command',
    description: 'Run ONE program with arguments (no shell: no pipes, redirects, && or ;). 30 s timeout. The user must approve every command.',
    risk: 'command',
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string', description: 'Program name or path, e.g. ls' },
        args: { type: 'array', items: { type: 'string' } },
        command: { type: 'string', description: 'Alternative to program+args: a plain command line without shell features.' },
        cwd: { type: 'string' },
        timeout_seconds: { type: 'number' },
      },
    },
    async prepare(args) {
      let program = str(args.program);
      let argv: string[] = Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === 'string') : [];
      const commandLine = str(args.command);
      if (!program && commandLine) {
        try {
          const parts = policy.tokenizeCommand(commandLine);
          program = parts[0];
          argv = parts.slice(1);
        } catch (error) {
          if (error instanceof policy.CommandParseError) return { error: error.message };
          throw error;
        }
      }
      if (!program) return { error: 'program (or command) is required.' };
      if (argv.length > 100) return { error: 'Too many arguments.' };
      const cwdCheck = policy.checkPath(str(args.cwd) ?? '~', { home: deps.home });
      const bad = pathProblem(cwdCheck);
      if (bad) return bad;
      const check = policy.checkCommand(program, argv, cwdCheck.path, { home: deps.home });
      if (check.verdict === 'deny') return { error: check.reason ?? 'Command blocked.' };
      const timeoutSeconds = typeof args.timeout_seconds === 'number' && Number.isFinite(args.timeout_seconds)
        ? Math.max(1, Math.min(120, args.timeout_seconds))
        : 30;
      const shown = [program, ...argv].map(part => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
      const elevated = Boolean(check.elevated || cwdCheck.elevated);
      return {
        verdict: { verdict: 'confirm', elevated, reason: check.reason ?? cwdCheck.reason },
        title: elevated ? 'Run a command (elevated)' : 'Run a command',
        detail: `${shown}\nin ${cwdCheck.path} · timeout ${timeoutSeconds}s${check.reason ? `\n⚠ ${check.reason}` : ''}`,
        summary: `run ${shown}`.slice(0, 200),
        async run(signal) {
          const result = await deps.runProgram(program as string, argv, {
            cwd: cwdCheck.path,
            timeoutMs: timeoutSeconds * 1000,
            signal,
            env: policy.sanitizedEnv(process.env),
          });
          if (result.aborted) return 'Stopped: the command was cancelled.';
          const body = [
            result.timedOut ? `Timed out after ${timeoutSeconds}s.` : `Exit code: ${result.code ?? 'unknown'}`,
            result.stdout ? `--- stdout ---\n${result.stdout}` : '',
            result.stderr ? `--- stderr ---\n${result.stderr}` : '',
          ].filter(Boolean).join('\n');
          return policy.truncate(body);
        },
      };
    },
  };

  const openUrl: ToolSpec = {
    name: 'open_url',
    description: 'Open an http(s) link in the user\'s default browser. The user must approve.',
    risk: 'open',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    async prepare(args) {
      const check = policy.checkUrl(str(args.url) ?? '');
      if (!check.ok || !check.url) return { error: check.reason ?? 'Invalid URL.' };
      const url = check.url;
      return {
        verdict: { verdict: 'confirm' },
        title: 'Open a link',
        detail: url,
        summary: `open_url ${url}`.slice(0, 200),
        allowForChat: true,
        async run() {
          const result = await deps.openDetached('xdg-open', [url]);
          return result.ok ? `OK: opened ${url}` : `Error: ${result.error ?? 'could not open the link'}`;
        },
      };
    },
  };

  const openApp: ToolSpec = {
    name: 'open_app',
    description: 'Start an installed desktop application by its command name (for example firefox, gnome-calculator). No arguments. The user must approve.',
    risk: 'open',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    async prepare(args) {
      const name = str(args.name) ?? '';
      const check = policy.checkAppName(name);
      if (!check.ok) return { error: check.reason ?? 'Invalid application name.' };
      return {
        verdict: { verdict: 'confirm' },
        title: 'Open an application',
        detail: name,
        summary: `open_app ${name}`,
        async run() {
          const result = await deps.openDetached(basename(name), []);
          return result.ok ? `OK: started ${name}` : `Error: ${result.error ?? 'could not start the application'}`;
        },
      };
    },
  };

  const systemInfo: ToolSpec = {
    name: 'get_system_info',
    description: 'Basic facts about this computer: OS, CPU count, memory, uptime.',
    risk: 'read',
    parameters: { type: 'object', properties: {} },
    async prepare() {
      return {
        verdict: { verdict: 'allow' },
        title: 'System info',
        detail: '',
        summary: 'get_system_info',
        async run() {
          const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
          return [
            `OS: ${platform()} ${release()} (${arch()})`,
            `CPU cores: ${cpus().length}`,
            `Memory: ${gb(freemem())} GB free of ${gb(totalmem())} GB`,
            `Uptime: ${(uptime() / 3600).toFixed(1)} hours`,
            `Local time: ${new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })}`,
          ].join('\n');
        },
      };
    },
  };

  return [readFile, listDir, searchFiles, writeLike('write_file'), writeLike('append_file'), editFile, runCommand, openUrl, openApp, systemInfo];
}

export function toDefinitions(specs: ToolSpec[]): ToolDefinition[] {
  return specs.map(spec => ({ type: 'function' as const, function: { name: spec.name, description: spec.description, parameters: spec.parameters } }));
}
