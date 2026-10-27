/**
 * Routes one spoken utterance (English, Roman Urdu / Hinglish, Urdu script) to 'screen', 'task' or 'chat'.
 *
 * Privacy first: 'screen' (a screenshot goes to a cloud vision model) is returned ONLY when the words clearly
 * point at the screen. Anything unsure is 'chat'. Task commands ("notes.txt bana do") are 'task' so they reach
 * the tool loop instead of a screenshot turn that has tools paused. Pure: no Electron, no disk, no network.
 */

import { aliasForMatching } from './transcript-normalize.ts';

export type Intent = 'screen' | 'task' | 'chat';

export interface ClassifyOptions {
  /**
   * Default true. When false only an explicit "screen" / "screenshot" / "اسکرین" request counts as 'screen';
   * pointing phrases such as "ye kya hai" fall back to 'chat'.
   */
  implicitScreen?: boolean;
}

/** Lower-case, NFKC, one Urdu spelling per letter, no diacritics, no punctuation, single spaces. */
export function normalizeIntentText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[​-‏ً-ٰٟ۔]/g, '')
    .replace(/ي/g, 'ی') // ي -> ی
    .replace(/ى/g, 'ی') // ى -> ی
    .replace(/ك/g, 'ک') // ك -> ک
    .replace(/ه/g, 'ہ') // ه -> ہ
    .replace(/ھ/g, 'ہ') // ھ -> ہ
    .replace(/ے/g, 'ے')
    .replace(/['’`]/g, '')
    .replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, '\u0001') // keep "notes.txt" together
    .replace(/[^\p{L}\p{N}\s\u0001]/gu, ' ')
    .replace(/\u0001/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The same Urdu letter folding the input gets, so patterns written with any spelling still match. */
function unify(source: string): string {
  return source
    .replace(/\u064a/g, '\u06cc').replace(/\u0649/g, '\u06cc').replace(/\u0643/g, '\u06a9')
    .replace(/\u0647/g, '\u06c1').replace(/\u06be/g, '\u06c1');
}

/** Whole-word (Unicode aware) regex for an alternation. Patterns may contain single spaces. */
function word(source: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${unify(source)})(?![\\p{L}\\p{N}])`, 'u');
}

// ---------------------------------------------------------------------------------------------- vocabulary

const SCREEN_WORD = word('screen|screens|screenshot|screenshots|skrin|skreen|scrin|اسکرین|سکرین|اسکرین شاٹ|سکرین شاٹ|اسکرینشاٹ');
/** "screen band karo", "screen ki brightness", "screen share": the screen as a device, not something to look at. */
const SCREEN_AS_DEVICE = word(
  '(?:screen|skrin|اسکرین|سکرین) (?:\\S+ )?(?:band|off|lock|brightness|saver|share|sharing|record|recording|timeout|resolution|size|rotate|dim|roshni|unlock|cast|بند|لاک|شیئر|ریکارڈ)|(?:turn|switch|share|record|lock|dim) (?:off |on )?(?:my |the )?(?:screen|اسکرین)',
);

const VIEW_VERB = word('dekh|dekho|dekhna|dekhiye|dekhiyega|dekhen|dekhein|dekhe|dekhlo|dekhte|dekhye|dikho|dekhta|dekhti|look|looking|see|watch|view|check|checks|peek|دیکھ|دیکھو|دیکھنا|دیکھیں|دیکھیے|دیکھئے|دیکھیئے|دیکھ لو|دیکھ لیں|دیکھ');
const SCREEN_CUE = word(
  'dekh\\w*|dikho|dikh\\w*|nazar|look|see|watch|view|check|read|padh\\w*|kya|kia|what|whats|describe|batao|bata|btao|batana|samjha\\w*|samjh\\w*|explain|tell|show|capture|lo|le|lena|take|analy[sz]e|summari[sz]e|dikhao|dikha|دیکھ\\p{L}*|دکھ\\p{L}*|کیا|پڑھ\\p{L}*|بتاؤ|بتا|بتائیں|سمجھا\\p{L}*|لو|لے',
);

/** Besides plain "look": verbs that mean "tell me what is on it". Only used when the same sentence also holds a task verb. */
const SCREEN_LOOK = word('read|padh\\w*|describe|analy[sz]e|summari[sz]e|samjha\\w*|explain|bata\\w*|پڑھ\\p{L}*|سمجھا\\p{L}*|بتا\\p{L}*');
const DEICTIC = word('ye|yeh|yah|yahi|isko|isse|isme|iske|iski|iska|isey|ismein|is ka|iss ka|is ko|is mein|is me|is mai|this|these|that|یہ|اس|اسے|اسکا|اسکی|اسکو|اسمیں|اس میں|اس کا|اس کی|اس کو|یہاں|ادھر|yahan|yaha|idhar|here');
const QUESTION = word('kya|kia|kyun|kyu|kaise|kese|matlab|mean|means|what|whats|why|how|explain|samjhao|samjha do|batao|bata|btao|کیا|کیوں|کیسے|مطلب|سمجھاؤ|بتاؤ');
/** Things that live on a screen. "file" is deliberately missing: files are the tool domain. */
const SCREEN_NOUN = word(
  'error|errors|bug|bugs|code|button|buttons|popup|pop up|dialog|warning|window|tab|page|website|site|image|picture|photo|text|likha|likhi|line|output|result|terminal|console|menu|link|video|chart|graph|table|form|ایرر|کوڈ|بٹن|ونڈو|ٹیب|پیج|تصویر|لکھا|لکھی|ٹیکسٹ|ویب سائٹ',
);
const FILE_REF = new RegExp(unify('(?<![\\p{L}\\p{N}])(?:files?|folders?|directory|documents?|docs?|notes?|pdf|txt|فائل|فائلز|فولڈر|نوٹس|نوٹ)(?![\\p{L}\\p{N}])|[\\p{L}\\p{N}_-]\\.(?:txt|md|pdf|docx?|xlsx?|csv|json|js|ts|tsx|py|html|css|log|sh|png|jpe?g)(?![\\p{L}\\p{N}])'), 'u');

/** Short "what is this" templates that need no noun: the user is pointing at something in front of them. */
const BARE_POINTING = [
  word('(?:ye|yeh|yah) (?:kya|kia) (?:hai|hy|he|hota hai|cheez hai|chiz hai|likha hai|aaya hai|dikh raha hai|ho raha hai|hua|bakwas hai)'),
  word('(?:iska|is ka) (?:kya matlab|matlab kya)(?: hai| hy| he)?'),
  word('what (?:is|s) (?:this|that)|what does (?:this|that) (?:say|mean|do)|whats (?:this|that)|what is this thing|what are these'),
  word('یہ کیا ہے|اس کا مطلب کیا ہے|اس کا کیا مطلب ہے|اسکا مطلب کیا ہے|یہ کیا لکھا ہے'),
];
/** "look at this" without the word screen. */
const LOOK_AT_THIS = [
  word('(?:ye|yeh|isko|isse|is ko|isey|yahan|yaha|idhar) (?:zara |jara |ek baar )?(?:dekho|dekh|dekhna|dekhiye|dekh lo|dekhlo|dekhen|dekhein)'),
  word('(?:dekho|dekh|dekhna|dekhiye|dekh lo|dekhlo|dekhen|dekhein) (?:zara |jara |ek baar )?(?:ye|yeh|isko|isse|is ko|yahan|yaha|idhar)'),
  word('(?:look|see|check|have a look|take a look|look over|look at) (?:at )?(?:this|here|that)(?: out)?'),
  word('یہ دیکھو|یہ دیکھیں|یہ دیکھیے|اسے دیکھو|اس کو دیکھو|دیکھو یہ|دیکھو یہاں|یہاں دیکھو'),
];
/** "dekho main kya kar raha hoon" / "look at what I'm doing". */
const WATCH_ME = [
  /(?<![\p{L}\p{N}])(?:dekh\w*|dikho|look|watch|see)(?![\p{L}\p{N}]).*(?<![\p{L}\p{N}])(?:main|mai|mein|me|meri|mera|mere|i|im|my)(?![\p{L}\p{N}]).*(?<![\p{L}\p{N}])(?:kya|kia|what)(?![\p{L}\p{N}]).*(?<![\p{L}\p{N}])(?:kar|likh|bana|chala|dekh|type|typ|work|karta|karti)\w*\s+(?:raha|rahi|rha|rhi|rahe|rahay)(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])(?:look|watch|see)(?![\p{L}\p{N}]).*(?<![\p{L}\p{N}])what (?:am i|i am|im|i m) (?:doing|working on|typing|writing|making)(?![\p{L}\p{N}])/u,
  new RegExp(unify('دیکھ\\S*.*(?:میں|مین).*کیا.*(?:کر|لکھ|بنا).*(?:رہا|رہی)'), 'u'),
];
/** "kya dikh raha hai", "what do you see". */
const WHAT_DO_YOU_SEE = [
  word('kya (?:kuch )?(?:dikh (?:raha|rahi|rha|rhi|hai|hy|gaya)|dikhta|dikhti|dikhai (?:de|dey|diya)|nazar (?:aa|a|aaya|ata|ati))'),
  word('(?:tumhe|tumko|aapko|apko|tujhe|tujhko) (?:kya )?(?:dikh (?:raha|rahi|rha|rhi|hai|hy)|dikhai (?:de|dey)|nazar (?:aa|a))'),
  word('what (?:do|can|did) (?:you|u) see'),
  word('کیا دکھ رہا ہے|کیا دکھائی دے رہا ہے|تمہیں کیا دکھ رہا ہے|آپ کو کیا دکھ رہا ہے|کیا نظر آ رہا ہے'),
];

// Task verbs. Roman / Urdu ones are unambiguous imperatives; English ones only count at the start of a request.
const TASK_ROMAN = word(
  'banao|bana do|bana dijiye|bana dein|bana den|bana de|bana dena|bana lo|banado|banaiye|banayein|banaen|' +
  'chalao|chala do|chala dijiye|chala dein|chalado|chalaiye|chalayein|chalana|' +
  'likho|likh do|likh dijiye|likh dein|likh den|likh de|likh dena|likhdo|likhiye|likhein|likhen|' +
  'padho|padh do|padh dijiye|padh dein|padh den|padh de|padh dena|padhdo|padhiye|padhein|padhen|padh kar sunao|padh ke sunao|' +
  'save karo|save kar do|save kar dijiye|save kar dein|save kar lo|save kardo|save kijiye|save kar de|' +
  'khol|kholo|khol do|khol dijiye|khol dein|khol den|khol de|khol dena|kholdo|kholiye|kholein|kholen|' +
  'delete karo|delete kar do|delete kar dijiye|delete kar dein|delete kar de|delete kardo|delete kijiye|' +
  'hatao|hata do|hata dijiye|hata dein|hata den|hata de|hatado|mitao|mita do|mita dijiye|mita dein|mita de|mitado|' +
  'rename karo|rename kar do|move karo|move kar do|copy karo|copy kar do|' +
  'yaad dilao|yaad dila do|yaad dila dena|yaad dilana|yad dilao|yad dila do|' +
  '(?:reminder|alarm|timer) (?:lagao|laga do|laga dena|laga de|set karo|set kar do|bana do|banao|rakh do|daal do|dalo|add karo)|' +
  'set karo|set kar do|add karo|add kar do|' +
  'note kar lo|note kar do|note karo|note likh|nikalo|nikal do|' +
  'dhoondo|dhundo|dhoondh do|dhundh do|dhoondh lo|dhund do|' +
  '(?:files?|folders?|notes?) (?:dikhao|dikha do|list karo|batao)|list karo|list kar do|' +
  'download karo|download kar do|install karo|install kar do|edit karo|edit kar do|edit kardo|' +
  'بنا دو|بناؤ|بنا دیں|بنا دیجیے|چلاؤ|چلا دو|چلا دیں|لکھو|لکھ دو|لکھ دیں|پڑھو|پڑھ دو|پڑھ دیں|سیو کرو|سیو کر دو|کھولو|کھول دو|کھول دیں|ڈیلیٹ کرو|ڈیلیٹ کر دو|حذف کر دو|ہٹا دو|ہٹاؤ|مٹا دو|مٹاؤ|یاد دلاؤ|یاد دلا دو|ریمائنڈر لگاؤ|ریمائنڈر لگا دو|ایڈٹ کر دو',
);
/** "kar do / karo / kijiye": imperative, but it carries no object by itself, so it only counts when there is no question. */
const TASK_GENERIC = word('kar do|kar dijiye|kar dijiyega|kar dein|kar den|kar de|kar dena|kar lo|kardo|karo|kijiye|kijiyega|کر دو|کرو|کر دیں|کر دیجیے|کیجیے');
const TASK_ENGLISH_VERBS = new Set([
  'create', 'make', 'write', 'open', 'run', 'list', 'delete', 'remove', 'save', 'read', 'rename', 'move', 'copy', 'edit', 'append',
  'launch', 'execute', 'start', 'install', 'download', 'find', 'search', 'remind', 'add', 'erase', 'show', 'mkdir',
]);
const ENGLISH_TASK_PHRASES = word('remind me|note down|jot down|set (?:a |an |the )?(?:reminder|alarm|timer)|ls');
/** "delete button", "run command": the verb is a noun adjunct, not an order. */
const ENGLISH_ADJUNCT = new Set(['button', 'key', 'icon', 'menu', 'shortcut', 'option', 'dialog', 'popup', 'error', 'warning', 'feature', 'mode', 'cell']);
const ENGLISH_QUESTION_START = new Set(['how', 'what', 'why', 'when', 'where', 'who', 'which', 'is', 'are', 'does', 'did', 'do', 'was', 'were', 'whats', 'kaise', 'kyun', 'kyu', 'kab', 'kahan']);
const FILLERS = new Set([
  'sudo', 'chan', 'sudochan', 'sid', 'please', 'plz', 'pls', 'ji', 'yaar', 'bhai', 'zara', 'jara', 'ek', 'a', 'an', 'the', 'mujhe', 'mere', 'meri', 'mera', 'liye', 'ab', 'abhi', 'now', 'can', 'could', 'would', 'will', 'you', 'u', 'kya', 'aap', 'tum', 'tu',
  'hey', 'hi', 'hello', 'ok', 'okay', 'so', 'and', 'then', 'aur', 'phir', 'just', 'bas', 'to', 'jo', 'ke', 'me', 'my', 'i', 'want', 'need', 'let', 'lets',
]);

// ------------------------------------------------------------------------------------------------- logic

function englishTask(tokens: string[]): boolean {
  const filtered = tokens.filter(t => !FILLERS.has(t));
  if (!filtered.length || tokens.some(t => /^(?:like|love|hate|enjoy|prefer|sense|laugh)$/.test(t))) return false;
  if (ENGLISH_QUESTION_START.has(tokens.find(t => !['sudo', 'chan', 'sudochan', 'sid', 'hey', 'hi', 'ok', 'okay', 'so', 'please', 'plz', 'pls'].includes(t)) ?? '')) return false;
  for (let i = 0; i < Math.min(filtered.length, 3); i++) {
    if (!TASK_ENGLISH_VERBS.has(filtered[i])) continue;
    if (ENGLISH_ADJUNCT.has(filtered[i + 1] ?? '')) continue;
    // "show" only as "show me the files / notes", never "show me my screen" (that is a screen request, handled earlier).
    if (filtered[i] === 'make' && !/^(?:files?|folders?|notes?|directory|reminders?|scripts?|lists?|dirs?)$/.test(filtered.slice(i + 1, i + 4).find(t => /^(?:files?|folders?|notes?|directory|reminders?|scripts?|lists?|dirs?)$/.test(t)) ?? '')) continue;
    if (filtered[i] === 'show' && !/(?:files?|folders?|notes?|directory|reminders?|list)/.test(filtered.slice(i + 1, i + 4).join(' '))) continue;
    return true;
  }
  return false;
}

function hasTaskCue(text: string, tokens: string[]): { strong: boolean; generic: boolean } {
  const strong = TASK_ROMAN.test(text) || ENGLISH_TASK_PHRASES.test(text) || englishTask(tokens);
  const generic = TASK_GENERIC.test(text) && !QUESTION.test(text);
  return { strong, generic };
}

/** Roman Urdu "is" (= this) in "is ka matlab", "is error", but not English "what is the error". */
function romanIsPointing(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'is' && tokens[i] !== 'iss') continue;
    const prev = tokens[i - 1] ?? '';
    if (/^(?:what|whats|how|why|where|who|which|when|it|that|this|there|here|he|she)$/.test(prev)) continue;
    const next = tokens[i + 1] ?? '';
    if (/^(?:ka|ko|ki|ke|mein|me|mai|se|par|pe)$/.test(next) || SCREEN_NOUN.test(next)) return true;
  }
  return false;
}

/**
 * How task-like an utterance is: 'strong' = a specific command verb ("bana do", "khol do", "delete notes.txt"),
 * 'generic' = only "kar do / karo" without an object, 'none' = no command at all.
 */
function taskStrengthAs(text: string): 'strong' | 'generic' | 'none' {
  const norm = normalizeIntentText(text ?? '');
  if (!norm) return 'none';
  const cue = hasTaskCue(norm, norm.split(' '));
  return cue.strong ? 'strong' : cue.generic ? 'generic' : 'none';
}

function classifyIntentAs(text: string, opts: ClassifyOptions): Intent {
  const norm = normalizeIntentText(text ?? '');
  if (!norm) return 'chat';
  const tokens = norm.split(' ');
  const wordCount = tokens.length;
  const implicit = opts.implicitScreen !== false;
  const task = hasTaskCue(norm, tokens);
  const anyTask = task.strong || task.generic;

  // 1. The user names the screen and does something screen-like with it ("meri screen dekho", "what's on my screen").
  if (SCREEN_WORD.test(norm) && !SCREEN_AS_DEVICE.test(norm)) {
    const cue = SCREEN_CUE.test(norm);
    const viewing = VIEW_VERB.test(norm) || SCREEN_LOOK.test(norm);
    // With a task verb in the same sentence the user must really ask to LOOK ("meri screen dekh ke ye kaam kar do").
    if (anyTask ? viewing || /(?<![\p{L}\p{N}])(?:kya|what|whats|کیا)(?![\p{L}\p{N}])/u.test(norm) : cue || wordCount <= 2) return 'screen';
  }

  // 2. Task commands go to the tool loop. A named file is a file task, never a pointing gesture.
  if (anyTask) return 'task';

  // 3. Pointing at something without saying "screen". Needs a clear shape, and is blocked by any file mention.
  if (implicit && !FILE_REF.test(norm)) {
    const core = tokens.filter(t => !FILLERS.has(t));
    if (wordCount <= 8 && (DEICTIC.test(norm) || romanIsPointing(tokens)) && QUESTION.test(norm) && SCREEN_NOUN.test(norm)) return 'screen';
    if (wordCount <= 8 && BARE_POINTING.some(p => p.test(norm))) return 'screen';
    if (core.length <= 4 && LOOK_AT_THIS.some(p => p.test(norm))) return 'screen';
    if (wordCount <= 12 && WATCH_ME.some(p => p.test(norm))) return 'screen';
    if (wordCount <= 8 && WHAT_DO_YOU_SEE.some(p => p.test(norm))) return 'screen';
  }
  return 'chat';
}

/** Text as spoken first; then the same words with Urdu / Hindi script and Roman spelling variants re-spelled. Only adds matches. */
export function taskStrength(text: string): 'strong' | 'generic' | 'none' {
  const first = taskStrengthAs(text);
  if (first === 'strong') return first;
  const aliased = aliasForMatching(text ?? '');
  if (aliased === text) return first;
  const second = taskStrengthAs(aliased);
  return second === 'strong' || first === 'none' ? second : first;
}

export function classifyIntent(text: string, opts: ClassifyOptions = {}): Intent {
  const first = classifyIntentAs(text, opts);
  if (first !== 'chat') return first;
  const aliased = aliasForMatching(text ?? '');
  return aliased === text ? first : classifyIntentAs(aliased, opts);
}

/**
 * What a spoken turn does after the wake word or inside the Live Talk window.
 * 'screen' = start the consent / countdown / guard screenshot flow; 'message' = plain chat turn (tools decide for themselves).
 * Never 'screen' while screen assist is off. A bare "Sudo" (empty rest) right after the wake word keeps its old behaviour.
 */
export function routeSpeech(rest: string, ctx: { screenAssist: boolean; afterWake: boolean }): 'screen' | 'message' {
  if (!ctx.screenAssist) return 'message';
  if (!rest.trim()) return ctx.afterWake ? 'screen' : 'message';
  return classifyIntent(rest) === 'screen' ? 'screen' : 'message';
}
