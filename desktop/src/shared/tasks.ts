// "Aaj ka kaam": pure task logic (no fs, no Electron, no clock: `now` is always passed in as milliseconds).
// Dates are LOCAL: a due value is 'YYYY-MM-DD' (a day) or 'YYYY-MM-DDTHH:mm' (a day and a clock time).
// Written so node can run it directly (no parameter properties, no enums).

export type TaskStatus = 'todo' | 'doing' | 'done';
export type TaskPriority = 'low' | 'normal' | 'high';
export type TaskSource = 'voice' | 'chat' | 'ui';

export interface Task {
  id: string;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Local 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm', or null. */
  due: string | null;
  createdAt: number;
  doneAt: number | null;
  source: TaskSource;
  /** Id of the reminder created for this task (so completing the task can cancel it). */
  reminderId: string | null;
}

export interface TaskState {
  /** Last number used in an id (t1, t2, ...). Kept so an id is never reused. */
  seq: number;
  tasks: Task[];
}

export const MAX_TASKS = 200;
export const MAX_OPEN_TASKS = 150;
export const MAX_DONE_KEPT = 50;
export const MAX_TITLE = 160;
export const MAX_NOTES = 1000;
export const MAX_PLAN = 5;
/** The tasks file is never read when bigger than this. */
export const MAX_TASKS_FILE_BYTES = 512 * 1024;

const STATUSES: TaskStatus[] = ['todo', 'doing', 'done'];
const PRIORITIES: TaskPriority[] = ['low', 'normal', 'high'];
const SOURCES: TaskSource[] = ['voice', 'chat', 'ui'];

export type TaskResult = { ok: true; state: TaskState; task: Task } | { ok: false; error: string };

export function emptyState(): TaskState {
  return { seq: 0, tasks: [] };
}

// ------------------------------------------------------------------------------------------ text cleaning
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export function cleanTitle(value: unknown): string {
  return typeof value === 'string' ? value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim() : '';
}

export function cleanNotes(value: unknown): string {
  return typeof value === 'string' ? value.replace(CONTROL, ' ').replace(/\r\n?/g, '\n').trim() : '';
}

// ------------------------------------------------------------------------------------------ local date helpers
const pad = (n: number) => String(n).padStart(2, '0');

export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isValidDue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return false;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59)) return false;
  return y >= 2000 && y <= 2100;
}

export function dueHasTime(due: string): boolean {
  return due.includes('T');
}

export function dueDay(due: string): string {
  return due.slice(0, 10);
}

/** The moment a due value means. A day without a time means `defaultHour`:00 on that day. */
export function dueToMs(due: string, defaultHour = 9): number {
  const [y, mo, d] = due.slice(0, 10).split('-').map(Number);
  const [h, mi] = dueHasTime(due) ? due.slice(11, 16).split(':').map(Number) : [defaultHour, 0];
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

function dayStart(ms: number): Date {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
}

function addDays(ms: number, days: number): Date {
  const base = dayStart(ms);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, 12, 0, 0, 0);
}

function dueString(date: Date, hour?: number, minute?: number): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return hour === undefined ? day : `${day}T${pad(hour)}:${pad(minute ?? 0)}`;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short English label for the model: "today 17:00", "tomorrow", "Mon", "3 Nov", "yesterday". */
export function dueLabel(due: string, now: number): string {
  const day = dueDay(due);
  const today = localDay(now);
  const time = dueHasTime(due) ? ` ${due.slice(11, 16)}` : '';
  if (day === today) return `today${time}`;
  if (day === localDay(addDays(now, 1).getTime())) return `tomorrow${time}`;
  if (day === localDay(addDays(now, -1).getTime())) return `yesterday${time}`;
  const date = new Date(`${day}T12:00:00`);
  for (let i = 2; i <= 6; i++) if (day === localDay(addDays(now, i).getTime())) return `${WEEKDAY_NAMES[date.getDay()]}${time}`;
  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}${time}`;
}

// ------------------------------------------------------------------------------------------ date parsing
// English and Roman Urdu (and the Urdu script versions of the same words). Returns a LOCAL due string.

const DIGIT_MAPS = ['٠١٢٣٤٥٦٧٨٩', '۰۱۲۳۴۵۶۷۸۹', '०१२३४५६७८९'];

/** Arabic-Indic, Persian (Urdu) and Devanagari digits -> 0-9. */
export function asciiDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    let mapped: string = ch;
    for (const map of DIGIT_MAPS) {
      const at = map.indexOf(ch);
      if (at >= 0) { mapped = String(at); break; }
    }
    out += mapped;
  }
  return out;
}

const URDU_WORDS: Record<string, string> = {
  آج: 'aaj', کل: 'kal', پرسوں: 'parson', پرسو: 'parson', صبح: 'subah', سویرے: 'subah', دوپہر: 'dopahar', شام: 'shaam', رات: 'raat',
  بجے: 'baje', بجکر: 'baje', اگلے: 'agle', اگلا: 'agle', ہفتے: 'hafte', ہفتہ: 'saturday', دن: 'din', بعد: 'baad', میں: 'mein', کو: 'ko', تک: 'tak',
  سوا: 'sawa', ساڑھے: 'saade', پونے: 'paune', گھنٹے: 'ghante', گھنٹہ: 'ghante', منٹ: 'minute', مہینے: 'mahine', اس: 'is',
  پیر: 'peer', سوموار: 'peer', منگل: 'mangal', بدھ: 'budh', جمعرات: 'jumerat', جمعہ: 'juma', اتوار: 'itwar',
  ایک: 'ek', دو: 'do', تین: 'teen', چار: 'char', پانچ: 'paanch', چھ: 'chhe', سات: 'saat', آٹھ: 'aath', نو: 'nau', دس: 'das', گیارہ: 'gyarah', بارہ: 'barah',
};

const NUMBER_WORDS: Record<string, number> = {
  ek: 1, one: 1, do: 2, two: 2, teen: 3, three: 3, char: 4, chaar: 4, four: 4, panch: 5, paanch: 5, five: 5,
  chhe: 6, chhay: 6, cheh: 6, che: 6, six: 6, saat: 7, seven: 7, aath: 8, eight: 8, nau: 9, nine: 9, das: 10, ten: 10,
  gyarah: 11, gyara: 11, eleven: 11, barah: 12, baarah: 12, twelve: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, itwar: 0, itwaar: 0, etwar: 0, ittwar: 0, itvar: 0,
  monday: 1, peer: 1, pir: 1, somwar: 1, sumwar: 1, soomwar: 1,
  tuesday: 2, tues: 2, mangal: 2, mangle: 2,
  wednesday: 3, budh: 3, budhwar: 3,
  thursday: 4, thurs: 4, thur: 4, jumerat: 4, jumeraat: 4, jumayrat: 4, jumerrat: 4, veerwar: 4,
  friday: 5, juma: 5, jumma: 5, jumah: 5, jummah: 5,
  saturday: 6, sanichar: 6, sanichr: 6,
};

type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';
const DAYPART_WORDS: Record<string, DayPart> = {
  subah: 'morning', subha: 'morning', savere: 'morning', morning: 'morning',
  dopahar: 'afternoon', dopehar: 'afternoon', afternoon: 'afternoon',
  shaam: 'evening', sham: 'evening', evening: 'evening',
  raat: 'night', night: 'night', tonight: 'night',
};
const DAYPART_DEFAULT_HOUR: Record<DayPart, number> = { morning: 9, afternoon: 13, evening: 18, night: 21 };

const LEADING_FILLER = new Set(['at', 'by', 'on', 'before', 'until', 'till', 'this', 'is', 'for']);
const TRAILING_FILLER = new Set(['ko', 'tak', 'tk', 'se', 'later']);

interface Word { raw: string; n: string }

function toWords(text: string): Word[] {
  const prepared = asciiDigits(text).replace(/[،؟۔]/g, ' ').replace(/[ً-ٰٟ]/g, '');
  return prepared.split(/\s+/).filter(Boolean).map(raw => {
    const trimmed = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    const lower = trimmed.toLowerCase();
    return { raw, n: URDU_WORDS[trimmed] ?? lower };
  });
}

function numberOf(word: string | undefined): number | undefined {
  if (word === undefined) return undefined;
  if (/^\d{1,3}$/.test(word)) return Number(word);
  return NUMBER_WORDS[word];
}

interface ClockPick { h: number; m: number; mer?: 'am' | 'pm'; is24: boolean }
interface DueAcc {
  offset?: number;
  weekday?: number;
  weekNext?: boolean;
  monthNext?: boolean;
  daypart?: DayPart;
  clock?: ClockPick;
  relMinutes?: number;
}

interface Hit { len: number; apply: (acc: DueAcc) => void }

function clockHit(words: Word[], i: number): Hit | undefined {
  const w = words[i].n;
  // sawa 5 baje, saade 5 baje, paune 5 baje
  const fraction = w === 'sawa' ? 15 : ['saade', 'sade', 'sarhe', 'saarhe', 'saadhe'].includes(w) ? 30 : w === 'paune' ? 45 : undefined;
  if (fraction !== undefined) {
    const h = numberOf(words[i + 1]?.n);
    if (h !== undefined && h >= 1 && h <= 12) {
      const len = words[i + 2]?.n === 'baje' ? 3 : 2;
      const pick: ClockPick = fraction === 45 ? { h: h === 1 ? 12 : h - 1, m: 45, is24: false } : { h, m: fraction, is24: false };
      return { len, apply: acc => { acc.clock ??= pick; } };
    }
  }
  const clock = /^(\d{1,2})(?::(\d{2}))?(am|pm|a\.m\.|p\.m\.)?$/.exec(w);
  if (clock) {
    const h = Number(clock[1]);
    const m = clock[2] === undefined ? 0 : Number(clock[2]);
    let len = 1;
    let mer: 'am' | 'pm' | undefined = clock[3] ? (clock[3].startsWith('a') ? 'am' : 'pm') : undefined;
    let valid = false;
    if (mer) valid = h >= 1 && h <= 12 && m <= 59;
    else if (words[i + 1]?.n === 'baje') { valid = h <= 23 && m <= 59; len = 2; }
    else if (clock[2] !== undefined) valid = h <= 23 && m <= 59;
    else if (i > 0 && ['at', 'by', 'before', 'until', 'till'].includes(words[i - 1].n)) valid = h >= 1 && h <= 12;
    if (!mer && (words[i + 1]?.n === 'am' || words[i + 1]?.n === 'pm') && h >= 1 && h <= 12 && m <= 59) {
      mer = words[i + 1].n as 'am' | 'pm';
      valid = true;
      len = 2;
    }
    if (valid) {
      const is24 = !mer && (h > 12 || h === 0);
      return { len, apply: acc => { acc.clock ??= { h, m, mer, is24 }; } };
    }
  }
  // paanch baje, five baje
  const spoken = numberOf(w);
  if (spoken !== undefined && words[i + 1]?.n === 'baje' && spoken >= 1 && spoken <= 12) {
    return { len: 2, apply: acc => { acc.clock ??= { h: spoken, m: 0, is24: false }; } };
  }
  return undefined;
}

function matchAt(words: Word[], i: number): Hit | undefined {
  const w = words[i].n;
  const next = words[i + 1]?.n;
  if (w === 'day' && next === 'after' && words[i + 2]?.n === 'tomorrow') return { len: 3, apply: acc => { acc.offset = 2; } };
  if (['parson', 'parso', 'parsoon', 'parsun'].includes(w)) return { len: 1, apply: acc => { acc.offset = 2; } };
  if (['tomorrow', 'tmrw', 'tomorow', 'kal'].includes(w)) return { len: 1, apply: acc => { acc.offset = 1; } };
  if (['aaj', 'aj', 'today'].includes(w)) return { len: 1, apply: acc => { acc.offset = 0; } };
  if (w === 'tonight') return { len: 1, apply: acc => { acc.offset = 0; acc.daypart = 'night'; } };
  // agle hafte / agla hafta / next week / next month
  if (['agle', 'agla', 'next'].includes(w) && ['hafte', 'hafta', 'haftay', 'week'].includes(next ?? '')) return { len: 2, apply: acc => { acc.weekNext = true; } };
  if (['agle', 'agla', 'next'].includes(w) && ['mahine', 'mahina', 'month'].includes(next ?? '')) return { len: 2, apply: acc => { acc.monthNext = true; } };
  // optional "next"/"agle"/"this" + weekday (+ ko handled as trailing filler)
  if (['agle', 'agla', 'next', 'this', 'is'].includes(w) && next !== undefined && WEEKDAYS[next] !== undefined) {
    return { len: 2, apply: acc => { acc.weekday = WEEKDAYS[next]; } };
  }
  if (WEEKDAYS[w] !== undefined) return { len: 1, apply: acc => { acc.weekday = WEEKDAYS[w]; } };
  // this morning / is subah
  if (['this', 'is'].includes(w) && next !== undefined && DAYPART_WORDS[next] !== undefined) {
    return { len: 2, apply: acc => { acc.offset ??= 0; acc.daypart = DAYPART_WORDS[next]; } };
  }
  if (DAYPART_WORDS[w] !== undefined) return { len: 1, apply: acc => { acc.daypart = DAYPART_WORDS[w]; } };
  // relative: in 3 days / 3 din baad / 2 hafte / in 20 minutes / 2 ghante baad
  const start = w === 'in' ? i + 1 : i;
  const amount = numberOf(words[start]?.n);
  const unit = words[start + 1]?.n;
  if (amount !== undefined && unit !== undefined) {
    const kind = ['day', 'days', 'din'].includes(unit) ? 'day'
      : ['week', 'weeks', 'hafte', 'hafton'].includes(unit) ? 'week'
        : ['hour', 'hours', 'hr', 'hrs', 'ghante', 'ghanta', 'ghantay'].includes(unit) ? 'hour'
          : ['minute', 'minutes', 'min', 'mins', 'minat', 'mint'].includes(unit) ? 'minute' : undefined;
    if (kind && amount >= 1) {
      let len = start - i + 2;
      const tail = words[start + 2]?.n;
      if (tail === 'ke' && words[start + 3]?.n === 'baad') len += 2;
      else if (['baad', 'mein', 'me', 'later'].includes(tail ?? '')) len += 1;
      const apply = (acc: DueAcc) => {
        if (kind === 'day') acc.offset = amount;
        else if (kind === 'week') acc.offset = amount * 7;
        else acc.relMinutes = kind === 'hour' ? amount * 60 : amount;
      };
      if (w === 'in' || kind === 'day' || kind === 'week' || ['baad', 'mein', 'me', 'later'].includes(tail ?? '')) return { len, apply };
    }
  }
  return clockHit(words, i);
}

function resolveClock(clock: ClockPick, part: DayPart | undefined): { options: Array<{ h: number; plusDay: number }> } {
  const { h, mer } = clock;
  if (clock.is24) return { options: [{ h, plusDay: 0 }] };
  if (mer) return { options: [{ h: mer === 'pm' ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h), plusDay: 0 }] };
  if (part === 'morning') return { options: [{ h: h === 12 ? 0 : h, plusDay: 0 }] };
  if (part === 'afternoon') return { options: [{ h: h === 12 ? 12 : h <= 6 ? h + 12 : h, plusDay: 0 }] };
  if (part === 'evening') return { options: [{ h: h === 12 ? 12 : h < 12 ? h + 12 : h, plusDay: 0 }] };
  if (part === 'night') {
    if (h === 12) return { options: [{ h: 0, plusDay: 1 }] };
    if (h >= 6) return { options: [{ h: h + 12, plusDay: 0 }] };
    return { options: [{ h, plusDay: 1 }] };
  }
  // No hint: 1-6 are afternoon hours, 7-11 morning hours, 12 is noon; the other half of the day is the fallback.
  if (h === 12) return { options: [{ h: 12, plusDay: 0 }, { h: 0, plusDay: 1 }] };
  if (h >= 1 && h <= 6) return { options: [{ h: h + 12, plusDay: 0 }, { h, plusDay: 0 }] };
  if (h >= 7 && h <= 11) return { options: [{ h, plusDay: 0 }, { h: h + 12, plusDay: 0 }] };
  return { options: [{ h, plusDay: 0 }] };
}

function computeDue(acc: DueAcc, now: number): string | null {
  if (acc.relMinutes !== undefined) {
    const when = new Date(Math.ceil((now + acc.relMinutes * 60_000) / 60_000) * 60_000);
    return dueString(when, when.getHours(), when.getMinutes());
  }
  const hasDay = acc.offset !== undefined || acc.weekday !== undefined || acc.weekNext || acc.monthNext;
  if (!hasDay && !acc.clock && !acc.daypart) return null;
  let base: Date | undefined;
  if (acc.monthNext) {
    const d = new Date(now);
    base = new Date(d.getFullYear(), d.getMonth() + 1, 1, 12, 0, 0, 0);
  } else if (acc.weekNext) {
    const dow = new Date(now).getDay();
    base = addDays(now, ((1 - dow + 7) % 7) || 7);
  } else if (acc.weekday !== undefined) {
    const dow = new Date(now).getDay();
    base = addDays(now, ((acc.weekday - dow + 7) % 7) || 7);
  } else if (acc.offset !== undefined) {
    base = addDays(now, acc.offset);
  }
  if (!acc.clock && !acc.daypart) return dueString(base as Date);
  const sameDay = base === undefined || (acc.offset === 0 && acc.weekday === undefined && !acc.weekNext);
  const dayBase = base ?? addDays(now, 0);
  let hour: number;
  let minute = 0;
  let plusDay = 0;
  if (acc.clock) {
    minute = acc.clock.m;
    const { options } = resolveClock(acc.clock, acc.daypart);
    let chosen = options[0];
    if (base === undefined || sameDay) {
      const todayBase = addDays(now, 0);
      const future = options.find(opt => new Date(todayBase.getFullYear(), todayBase.getMonth(), todayBase.getDate() + opt.plusDay, opt.h, minute).getTime() > now);
      if (future) chosen = future;
      else if (base === undefined) { chosen = options[0]; plusDay = 1; }
    }
    hour = chosen.h;
    plusDay += chosen.plusDay;
  } else {
    hour = DAYPART_DEFAULT_HOUR[acc.daypart as DayPart];
    if (base === undefined) {
      const today = addDays(now, 0);
      if (new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, 0).getTime() <= now) plusDay = 1;
    }
  }
  const day = new Date(dayBase.getFullYear(), dayBase.getMonth(), dayBase.getDate() + plusDay, 12, 0, 0, 0);
  return dueString(day, hour, minute);
}

export interface ExtractedDue {
  /** The text with the date/time words removed (still the user's own words). */
  title: string;
  due: string | null;
  /** The words that were taken as the date, for display. */
  matched: string;
}

/** Finds a date/time phrase anywhere in `text`: "kal subah client ko email bhejna" -> due tomorrow 09:00, title "client ko email bhejna". */
export function extractDue(text: string, now: number): ExtractedDue {
  const words = toWords(text);
  const acc: DueAcc = {};
  const remove = new Set<number>();
  for (let i = 0; i < words.length;) {
    const hit = matchAt(words, i);
    if (!hit) { i++; continue; }
    hit.apply(acc);
    for (let k = 0; k < hit.len; k++) remove.add(i + k);
    // Swallow "at"/"by" before and "ko"/"tak" after a matched phrase.
    for (let b = i - 1; b >= 0 && LEADING_FILLER.has(words[b].n) && !remove.has(b); b--) remove.add(b);
    const after = i + hit.len;
    if (after < words.length && TRAILING_FILLER.has(words[after].n)) remove.add(after);
    i += hit.len;
  }
  const due = computeDue(acc, now);
  if (due === null) return { title: cleanTitle(text), due: null, matched: '' };
  const title = cleanTitle(words.filter((_, idx) => !remove.has(idx)).map(w => w.raw).join(' '));
  const matched = words.filter((_, idx) => remove.has(idx)).map(w => w.raw).join(' ');
  return { title, due, matched };
}

/** The due value for a phrase such as "kal 5 baje" or "next Monday", or null if no date was understood. */
export function parseDue(text: string, now: number): string | null {
  return extractDue(text, now).due;
}

/** Accepts an ISO due value as is, otherwise a natural phrase. */
export function resolveDue(value: string, now: number): { ok: true; due: string } | { ok: false; error: string } {
  const text = value.trim();
  if (isValidDue(text)) return { ok: true, due: text };
  const spaced = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(text);
  if (spaced && isValidDue(`${spaced[1]}T${spaced[2]}`)) return { ok: true, due: `${spaced[1]}T${spaced[2]}` };
  const due = parseDue(text, now);
  if (due && isValidDue(due)) return { ok: true, due };
  return { ok: false, error: 'I could not understand that due date. Use a day like "tomorrow", "kal 5 baje", "Monday" or 2026-11-03 17:00.' };
}

// ------------------------------------------------------------------------------------------ validation of stored data
function validTask(raw: unknown): Task | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^t\d{1,9}$/.test(r.id)) return null;
  const title = cleanTitle(r.title).slice(0, MAX_TITLE);
  if (!title) return null;
  const status = STATUSES.includes(r.status as TaskStatus) ? (r.status as TaskStatus) : 'todo';
  const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0;
  const doneAt = typeof r.doneAt === 'number' && Number.isFinite(r.doneAt) ? r.doneAt : null;
  return {
    id: r.id,
    title,
    notes: cleanNotes(r.notes).slice(0, MAX_NOTES),
    status,
    priority: PRIORITIES.includes(r.priority as TaskPriority) ? (r.priority as TaskPriority) : 'normal',
    due: isValidDue(r.due) ? r.due : null,
    createdAt,
    doneAt: status === 'done' ? (doneAt ?? createdAt) : null,
    source: SOURCES.includes(r.source as TaskSource) ? (r.source as TaskSource) : 'ui',
    reminderId: typeof r.reminderId === 'string' && r.reminderId.length <= 60 ? r.reminderId : null,
  };
}

/** Turns anything read from disk into a safe state: bad entries are dropped, duplicates removed, caps enforced. */
export function normalizeState(raw: unknown): { state: TaskState; dropped: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: emptyState(), dropped: 0 };
  const source = raw as Record<string, unknown>;
  const list = Array.isArray(source.tasks) ? source.tasks : [];
  const seen = new Set<string>();
  const tasks: Task[] = [];
  let dropped = 0;
  for (const item of list) {
    const task = validTask(item);
    if (!task || seen.has(task.id)) { dropped++; continue; }
    if (tasks.length >= MAX_TASKS) { dropped++; continue; }
    seen.add(task.id);
    tasks.push(task);
  }
  const highest = tasks.reduce((max, task) => Math.max(max, Number(task.id.slice(1))), 0);
  const seq = typeof source.seq === 'number' && Number.isInteger(source.seq) && source.seq >= 0 && source.seq < 1e9 ? source.seq : 0;
  return { state: { seq: Math.max(seq, highest), tasks: pruneDone(tasks) }, dropped };
}

/** Keeps only the newest MAX_DONE_KEPT finished tasks. */
export function pruneDone(tasks: Task[]): Task[] {
  const done = tasks.filter(task => task.status === 'done').sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  if (done.length <= MAX_DONE_KEPT) return tasks;
  const drop = new Set(done.slice(MAX_DONE_KEPT).map(task => task.id));
  return tasks.filter(task => !drop.has(task.id));
}

// ------------------------------------------------------------------------------------------ changes
export interface NewTask {
  title: string;
  notes?: string;
  priority?: TaskPriority;
  due?: string | null;
  source?: TaskSource;
}

export function addTask(state: TaskState, input: NewTask, now: number): TaskResult {
  const title = cleanTitle(input.title);
  if (!title) return { ok: false, error: 'The task title is empty.' };
  if (title.length > MAX_TITLE) return { ok: false, error: `The task title is too long (max ${MAX_TITLE} characters).` };
  const notes = cleanNotes(input.notes);
  if (notes.length > MAX_NOTES) return { ok: false, error: `The task notes are too long (max ${MAX_NOTES} characters).` };
  if (input.priority !== undefined && !PRIORITIES.includes(input.priority)) return { ok: false, error: 'priority must be low, normal or high.' };
  if (input.due !== undefined && input.due !== null && !isValidDue(input.due)) return { ok: false, error: 'due must look like 2026-11-03 or 2026-11-03T17:00.' };
  if (state.tasks.filter(task => task.status !== 'done').length >= MAX_OPEN_TASKS) return { ok: false, error: `Too many open tasks (max ${MAX_OPEN_TASKS}). Finish or remove some first.` };
  const seq = state.seq + 1;
  const task: Task = {
    id: `t${seq}`,
    title,
    notes,
    status: 'todo',
    priority: input.priority ?? 'normal',
    due: input.due ?? null,
    createdAt: now,
    doneAt: null,
    source: input.source && SOURCES.includes(input.source) ? input.source : 'chat',
    reminderId: null,
  };
  return { ok: true, state: { seq, tasks: [...state.tasks, task] }, task };
}

export interface TaskPatch {
  title?: string;
  notes?: string;
  priority?: TaskPriority;
  /** null clears the due date. */
  due?: string | null;
  status?: TaskStatus;
  reminderId?: string | null;
}

export function updateTask(state: TaskState, id: string, patch: TaskPatch, now: number): TaskResult {
  const index = state.tasks.findIndex(task => task.id === id);
  if (index < 0) return { ok: false, error: `No task with id ${id}.` };
  const current = state.tasks[index];
  const next: Task = { ...current };
  if (patch.title !== undefined) {
    const title = cleanTitle(patch.title);
    if (!title) return { ok: false, error: 'The task title is empty.' };
    if (title.length > MAX_TITLE) return { ok: false, error: `The task title is too long (max ${MAX_TITLE} characters).` };
    next.title = title;
  }
  if (patch.notes !== undefined) {
    const notes = cleanNotes(patch.notes);
    if (notes.length > MAX_NOTES) return { ok: false, error: `The task notes are too long (max ${MAX_NOTES} characters).` };
    next.notes = notes;
  }
  if (patch.priority !== undefined) {
    if (!PRIORITIES.includes(patch.priority)) return { ok: false, error: 'priority must be low, normal or high.' };
    next.priority = patch.priority;
  }
  if (patch.due !== undefined) {
    if (patch.due !== null && !isValidDue(patch.due)) return { ok: false, error: 'due must look like 2026-11-03 or 2026-11-03T17:00.' };
    next.due = patch.due;
  }
  if (patch.reminderId !== undefined) next.reminderId = patch.reminderId;
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) return { ok: false, error: 'status must be todo, doing or done.' };
    if (patch.status === 'done' && current.status !== 'done') { next.status = 'done'; next.doneAt = now; }
    else if (patch.status !== 'done') { next.status = patch.status; next.doneAt = null; }
  }
  const tasks = state.tasks.slice();
  tasks[index] = next;
  return { ok: true, state: { seq: state.seq, tasks: next.status === 'done' ? pruneDone(tasks) : tasks }, task: next };
}

export function completeTask(state: TaskState, id: string, now: number): TaskResult {
  return updateTask(state, id, { status: 'done' }, now);
}

export function startTask(state: TaskState, id: string, now: number): TaskResult {
  return updateTask(state, id, { status: 'doing' }, now);
}

export function removeTask(state: TaskState, id: string): TaskResult {
  const task = state.tasks.find(item => item.id === id);
  if (!task) return { ok: false, error: `No task with id ${id}.` };
  return { ok: true, state: { seq: state.seq, tasks: state.tasks.filter(item => item.id !== id) }, task };
}

/** Moves a task to `toIndex` in the manual order (0 = first). The manual order only breaks ties in the plan. */
export function reorderTask(state: TaskState, id: string, toIndex: number): TaskResult {
  const from = state.tasks.findIndex(task => task.id === id);
  if (from < 0) return { ok: false, error: `No task with id ${id}.` };
  if (!Number.isInteger(toIndex)) return { ok: false, error: 'The position must be a whole number.' };
  const to = Math.max(0, Math.min(state.tasks.length - 1, toIndex));
  const tasks = state.tasks.slice();
  const [task] = tasks.splice(from, 1);
  tasks.splice(to, 0, task);
  return { ok: true, state: { seq: state.seq, tasks }, task };
}

// ------------------------------------------------------------------------------------------ finding a task by words
export type FindResult = { ok: true; task: Task } | { ok: false; error: string };

const fold = (text: string) => asciiDigits(text).toLowerCase().replace(/\s+/g, ' ').trim();

/** `id` ("t3" or "3") wins; otherwise `title` must match one task (exact, then "contains"). Open tasks are preferred. */
export function findTask(state: TaskState, ref: { id?: unknown; title?: unknown }, options?: { openOnly?: boolean }): FindResult {
  const pool = options?.openOnly ? state.tasks.filter(task => task.status !== 'done') : state.tasks;
  if (typeof ref.id === 'string' && ref.id.trim()) {
    const raw = fold(ref.id);
    const id = /^\d+$/.test(raw) ? `t${raw}` : raw;
    const task = pool.find(item => item.id === id);
    return task ? { ok: true, task } : { ok: false, error: `No ${options?.openOnly ? 'open ' : ''}task with id ${ref.id.slice(0, 20)}. Use list_tasks to see the ids.` };
  }
  if (typeof ref.title === 'string' && ref.title.trim()) {
    const wanted = fold(ref.title);
    const open = pool.filter(task => task.status !== 'done');
    for (const group of [open, pool]) {
      const exact = group.filter(task => fold(task.title) === wanted);
      if (exact.length === 1) return { ok: true, task: exact[0] };
      if (exact.length > 1) return { ok: false, error: `Several tasks have that title: ${exact.slice(0, 3).map(t => t.id).join(', ')}. Use the id.` };
      const part = group.filter(task => fold(task.title).includes(wanted));
      if (part.length === 1) return { ok: true, task: part[0] };
      if (part.length > 1) return { ok: false, error: `Several tasks match "${ref.title.slice(0, 40)}": ${part.slice(0, 3).map(t => `${t.id} ${t.title}`).join(' | ')}. Use the id.` };
    }
    return { ok: false, error: `No task matches "${ref.title.slice(0, 40)}". Use list_tasks to see the ids.` };
  }
  return { ok: false, error: 'Give the task id (or its title).' };
}

// ------------------------------------------------------------------------------------------ plans
export function isOverdue(task: Task, now: number): boolean {
  if (task.status === 'done' || !task.due) return false;
  return dueHasTime(task.due) ? dueToMs(task.due) < now : dueDay(task.due) < localDay(now);
}

export function isDueToday(task: Task, now: number): boolean {
  return task.status !== 'done' && task.due !== null && dueDay(task.due) === localDay(now) && !isOverdue(task, now);
}

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

function planRank(task: Task, now: number): number {
  if (isOverdue(task, now)) return 0;
  if (isDueToday(task, now)) return 1;
  if (task.status === 'doing') return 2;
  return 3;
}

/** Open tasks in the order they should be done: overdue, due today, in progress, then the rest; each group by time, priority, manual order. */
export function orderedOpen(state: TaskState, now: number): Task[] {
  const open = state.tasks.map((task, order) => ({ task, order })).filter(item => item.task.status !== 'done');
  return open
    .sort((a, b) => {
      const rank = planRank(a.task, now) - planRank(b.task, now);
      if (rank) return rank;
      const dueA = a.task.due ? dueToMs(a.task.due, 23) : Infinity;
      const dueB = b.task.due ? dueToMs(b.task.due, 23) : Infinity;
      if (planRank(a.task, now) <= 1 && dueA !== dueB) return dueA - dueB;
      const pr = PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority];
      if (pr) return pr;
      if (dueA !== dueB) return dueA - dueB;
      return a.order - b.order;
    })
    .map(item => item.task);
}

/** Today's short plan: at most `max` tasks. */
export function todayPlan(state: TaskState, now: number, max = MAX_PLAN): Task[] {
  return orderedOpen(state, now).slice(0, Math.max(1, max));
}

export function overdueTasks(state: TaskState, now: number): Task[] {
  return orderedOpen(state, now).filter(task => isOverdue(task, now));
}

/** The task to take next: the first one in plan order that is not already in progress (an in-progress one only if nothing else is open). */
export function nextTask(state: TaskState, now: number): Task | null {
  const ordered = orderedOpen(state, now);
  return ordered.find(task => task.status === 'todo') ?? ordered[0] ?? null;
}

export type TaskFilter = 'today' | 'overdue' | 'all' | 'done';

export function filterTasks(state: TaskState, filter: TaskFilter, now: number): Task[] {
  if (filter === 'done') return state.tasks.filter(task => task.status === 'done').sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  const ordered = orderedOpen(state, now);
  if (filter === 'overdue') return ordered.filter(task => isOverdue(task, now));
  if (filter === 'today') return ordered.filter(task => isOverdue(task, now) || isDueToday(task, now) || task.status === 'doing');
  return ordered;
}

/** One line for the model. Titles are read aloud by the assistant, so this stays plain text. */
export function formatTaskLine(task: Task, now: number): string {
  const bits: string[] = [];
  if (task.status === 'doing') bits.push('in progress');
  if (task.status === 'done') bits.push('done');
  if (isOverdue(task, now)) bits.push('OVERDUE');
  if (task.due) bits.push(`due ${dueLabel(task.due, now)}`);
  if (task.priority !== 'normal') bits.push(`${task.priority} priority`);
  return `${task.id}: ${task.title}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

// ------------------------------------------------------------------------------------------ what the panel shows
export interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  due: string | null;
  dueLabel: string;
  overdue: boolean;
}

export interface TasksView {
  plan: TaskView[];
  openCount: number;
  overdueCount: number;
  doneToday: TaskView[];
}

export function taskView(task: Task, now: number): TaskView {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    due: task.due,
    dueLabel: task.due ? dueLabel(task.due, now) : '',
    overdue: isOverdue(task, now),
  };
}

export function buildView(state: TaskState, now: number): TasksView {
  const today = localDay(now);
  const open = state.tasks.filter(task => task.status !== 'done');
  return {
    plan: todayPlan(state, now).map(task => taskView(task, now)),
    openCount: open.length,
    overdueCount: open.filter(task => isOverdue(task, now)).length,
    doneToday: state.tasks
      .filter(task => task.status === 'done' && task.doneAt !== null && localDay(task.doneAt) === today)
      .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
      .slice(0, 3)
      .map(task => taskView(task, now)),
  };
}

// ------------------------------------------------------------------------------------------ chat-window actions
export type PanelAction = 'done' | 'undo' | 'start' | 'stop' | 'remove';
const PANEL_ACTIONS: PanelAction[] = ['done', 'undo', 'start', 'stop', 'remove'];

/** Validates what the chat window sends for a click on a task row. */
export function parsePanelAction(raw: unknown): { id: string; action: PanelAction } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^t\d{1,9}$/.test(r.id)) return null;
  if (!PANEL_ACTIONS.includes(r.action as PanelAction)) return null;
  return { id: r.id, action: r.action as PanelAction };
}

export function applyPanelAction(state: TaskState, input: { id: string; action: PanelAction }, now: number): TaskResult {
  switch (input.action) {
    case 'done': return completeTask(state, input.id, now);
    case 'undo': return updateTask(state, input.id, { status: 'todo' }, now);
    case 'start': return startTask(state, input.id, now);
    case 'stop': return updateTask(state, input.id, { status: 'todo' }, now);
    case 'remove': return removeTask(state, input.id);
  }
}

const HIGH_WORDS = /\b(urgent|zaroori|zaruri|important|jaldi|asap)\b/i;

/** Text typed into the panel's add box: "kal client ko email bhejna" -> title + due (+ high priority for "urgent"/"zaroori"). */
export function parseAddText(text: unknown, now: number): { ok: true; title: string; due: string | null; priority: TaskPriority } | { ok: false; error: string } {
  if (typeof text !== 'string') return { ok: false, error: 'Write what you need to do.' };
  const raw = cleanTitle(text);
  if (!raw) return { ok: false, error: 'Write what you need to do.' };
  if (raw.length > 400) return { ok: false, error: `That is too long for a task title (max ${MAX_TITLE} characters).` };
  const found = extractDue(raw, now);
  const title = (found.title || raw).slice(0, MAX_TITLE);
  return { ok: true, title, due: found.due, priority: HIGH_WORDS.test(raw) ? 'high' : 'normal' };
}
