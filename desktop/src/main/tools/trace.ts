/**
 * Compact "what the tools did" note kept in the chat history, so a follow-up ("ab isko run karo") still knows which
 * file was meant. It carries verbs and paths only: never file contents, command arguments, notes or search text.
 */

export const MAX_TRACE_CHARS = 300;
const MAX_PATH_CHARS = 90;

function cleanPath(value: unknown): string {
  if (typeof value !== 'string') return '?';
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!flat) return '?';
  return flat.length > MAX_PATH_CHARS ? `${flat.slice(0, MAX_PATH_CHARS - 1)}…` : flat;
}

function lineRange(args: Record<string, unknown>): string {
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : typeof v === 'string' && /^\d{1,7}$/.test(v) && Number(v) >= 1 ? Number(v) : undefined);
  const start = num(args.start_line);
  const end = num(args.end_line);
  if (start === undefined && end === undefined) return '';
  return ` (lines ${start ?? 1}-${end ?? 'end'})`;
}

function failureWord(result: string): string | null {
  if (/^Blocked:/.test(result)) return 'blocked';
  if (/^The user denied/.test(result)) return 'denied by user';
  if (/^The user did not respond/.test(result)) return 'timed out';
  if (/^All actions were stopped/.test(result) || /^Cancelled/.test(result)) return 'stopped';
  if (/^Error/.test(result)) return 'failed';
  return null;
}

/** One short phrase for one finished tool call, or null if it is not worth remembering. */
export function describeToolCall(name: string, rawArgs: unknown, result: string): string | null {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Record<string, unknown>;
  const fail = failureWord(result);
  const pathOf = () => cleanPath(args.path);
  switch (name) {
    case 'read_file':
      return fail ? `read ${pathOf()} ${fail}` : `read ${pathOf()}${lineRange(args)}`;
    case 'edit_file':
      return fail ? `edit of ${pathOf()} ${fail}` : `edited ${pathOf()}`;
    case 'write_file':
      return fail ? `write to ${pathOf()} ${fail}` : `wrote ${pathOf()}`;
    case 'append_file':
      return fail ? `append to ${pathOf()} ${fail}` : `appended to ${pathOf()}`;
    case 'list_dir':
      return fail ? null : `listed ${cleanPath(args.path ?? '~')}`;
    case 'search_files':
      return fail ? null : `searched files under ${cleanPath(args.path ?? '~')}`;
    case 'run_command': {
      const line = typeof args.command === 'string' ? args.command.trim().split(/\s+/)[0] : '';
      const program = cleanPath(typeof args.program === 'string' ? args.program : line).split('/').pop() || '?';
      if (fail) return `command ${program} ${fail}`;
      const exit = /^Exit code: (\d+)/.exec(result);
      return exit ? `ran ${program} (exit ${exit[1]})` : `ran ${program}`;
    }
    case 'open_url':
      return fail ? null : 'opened a link';
    case 'open_app': {
      const app = cleanPath(args.name).split('/').pop() || '?';
      return fail ? null : `opened app ${app}`;
    }
    default:
      return null;
  }
}

/** Joins phrases into "[tools: a; b]" within the character cap (oldest dropped first). Empty string when nothing happened. */
export function formatToolTrace(items: string[], maxChars = MAX_TRACE_CHARS): string {
  const compact: string[] = [];
  for (const item of items) if (item && compact[compact.length - 1] !== item) compact.push(item);
  while (compact.length) {
    const text = `[tools: ${compact.join('; ')}]`;
    if (text.length <= maxChars) return text;
    if (compact.length === 1) return `${text.slice(0, maxChars - 2)}…]`;
    compact.shift();
  }
  return '';
}
