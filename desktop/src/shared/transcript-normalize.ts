/**
 * Transcript normaliser for matching (pure: no DOM, no Electron, no network).
 *
 * Speech-to-text returns the same Pakistani command in many shapes: Roman Urdu ("ruko"), Urdu script ("رکو"), Hindi /
 * Devanagari ("रुको", Whisper often detects Urdu speech as Hindi) and creative Roman spellings ("sudu", "krdo", "parho").
 * The downstream matchers (wake word, stop words, intent routing) were written for the Roman forms, so a good transcript
 * in another script simply did not match.
 *
 * `aliasForMatching(text)` maps KNOWN tokens only (wake names, stop words, yes/no, screen/task verbs and a few nouns) to one
 * canonical Roman spelling and leaves every other token, the spacing and the punctuation exactly as they were. The output is
 * for MATCHING ONLY; display and chat always keep the original text. It keeps the token count (1:1), so callers can map a match
 * back to the original words. Matchers always try the original text first and the aliased text second, so this can only add
 * matches, never remove an existing one.
 *
 * Not mapped on purpose (too common as ordinary words): "sad", "side", "sudden", "seed", "said", "suno" (= "listen"), "bus",
 * "bass", "can", and the Urdu name word "سید" (Syed).
 */

export type ScriptKind = 'latin' | 'urdu' | 'devanagari' | 'mixed' | 'none';

/** canonical Roman form -> spellings in every script. Spellings are folded (see `foldKey`) when the table is built. */
export const ALIAS_GROUPS: Record<string, string[]> = {
  // ---- wake names
  sudo: ['sudo', 'sudu', 'soodo', 'soodu', 'sudho', 'sudoh', 'sudhu', 'suddu', 'سوڈو', 'سڈو', 'سودو', 'سوڈُو', 'سُڈو', 'सुडो', 'सुदो', 'सूडो', 'सुडू', 'सुडु', 'सूदो', 'सुडोह'],
  sid: ['sid', 'sidd', 'sidh', 'siid', 'syd', 'سڈ', 'سیڈ', 'سڈّ', 'सिड', 'सिद', 'सिड्ड', 'सीड'],
  sido: ['sido', 'सिडो', 'सिदो', 'سیڈو'],
  // ---- stop words
  ruko: ['ruko', 'rukoo', 'rukho', 'رکو', 'رُکو', 'रुको', 'रूको'],
  roko: ['roko', 'rooko', 'روکو', 'रोको'],
  ruk: ['ruk', 'رک', 'रुक'],
  rukiye: ['rukiye', 'rukiyay', 'رکیے', 'رکئے', 'رکیئے', 'रुकिए', 'रुकिये', 'रुकिय'],
  bas: ['bas', 'بس', 'बस'],
  chup: ['chup', 'chupp', 'choop', 'چپ', 'चुप', 'चूप'],
  khamosh: ['khamosh', 'khamush', 'خاموش', 'खामोश'],
  thehro: ['thehro', 'theherro', 'ٹھہرو', 'ٹھیرو', 'ٹھہر', 'ठहरो', 'ठैरो', 'ठहर'],
  stop: ['stop', 'اسٹاپ', 'سٹاپ', 'स्टॉप', 'स्टाप', 'स्टोप'],
  band: ['band', 'بند', 'बंद', 'बन्द'],
  // ---- light words that surround commands
  jao: ['jao', 'jaao', 'جاؤ', 'جاو', 'जाओ', 'जाउ'],
  karo: ['karo', 'kro', 'کرو', 'करो'],
  kar: ['kar', 'kr', 'کر', 'कर'],
  do: ['دو', 'दो'],
  kardo: ['kardo', 'krdo', 'کردو', 'करदो'],
  kijiye: ['kijiye', 'kijiyay', 'کیجیے', 'کیجئے', 'कीजिए', 'कीजिये'],
  dijiye: ['dijiye', 'دیجیے', 'دیجئے', 'दीजिए', 'दीजिये'],
  dein: ['دیں', 'दें', 'दे'],
  lo: ['لو', 'लो'],
  // ---- yes / no / politeness
  haan: ['haan', 'haanji', 'ہاں', 'ہان', 'हाँ', 'हां', 'हान'],
  nahi: ['nahi', 'nahin', 'nhi', 'nai', 'nahee', 'نہیں', 'نہی', 'नहीं', 'नही', 'नहि'],
  ji: ['ji', 'jee', 'جی', 'जी'],
  theek: ['theek', 'thik', 'ٹھیک', 'ठीक'],
  hai: ['hai', 'hy', 'ہے', 'है'],
  hain: ['hain', 'ہیں', 'हैं'],
  ok: ['ok', 'okay', 'اوکے', 'ओके', 'ओकै'],
  // ---- screen / look / task verbs (intent.ts)
  dekho: ['dekho', 'dkho', 'دیکھو', 'देखो'],
  dekh: ['dekh', 'دیکھ', 'देख'],
  dekhiye: ['dekhiye', 'dekhiyay', 'دیکھیے', 'دیکھئے', 'دیکھیئے', 'देखिए', 'देखिये'],
  dekhein: ['dekhein', 'dekhen', 'دیکھیں', 'देखें', 'देखे'],
  dekhna: ['dekhna', 'دیکھنا', 'देखना'],
  dikhao: ['dikhao', 'دکھاؤ', 'دکھاو', 'दिखाओ'],
  dikha: ['dikha', 'دکھا', 'दिखा'],
  banao: ['banao', 'bnao', 'بناؤ', 'بناو', 'बनाओ'],
  bana: ['bana', 'bna', 'بنا', 'बना'],
  banado: ['banado', 'bnado', 'बनादो', 'بنادو'],
  likho: ['likho', 'لکھو', 'लिखो'],
  likh: ['likh', 'لکھ', 'लिख'],
  padho: ['padho', 'parho', 'پڑھو', 'पढ़ो', 'पढो'],
  padh: ['padh', 'parh', 'پڑھ', 'पढ़', 'पढ'],
  padhna: ['padhna', 'parhna', 'پڑھنا', 'पढ़ना', 'पढना'],
  kholo: ['kholo', 'کھولو', 'खोलो'],
  khol: ['khol', 'کھول', 'खोल'],
  chalao: ['chalao', 'chlao', 'چلاؤ', 'چلاو', 'चलाओ'],
  chala: ['chala', 'چلا', 'चला'],
  hatao: ['hatao', 'ہٹاؤ', 'ہٹاو', 'हटाओ'],
  hata: ['hata', 'ہٹا', 'हटा'],
  mitao: ['mitao', 'مٹاؤ', 'مٹاو', 'मिटाओ'],
  mita: ['mita', 'مٹا', 'मिटा'],
  batao: ['batao', 'btao', 'بتاؤ', 'بتاو', 'बताओ'],
  bata: ['bata', 'bta', 'بتا', 'बता'],
  samjhao: ['samjhao', 'samjao', 'سمجھاؤ', 'سمجھاو', 'समझाओ'],
  // ---- nouns used by the intent patterns
  screen: ['screen', 'skrin', 'اسکرین', 'سکرین', 'سکرین', 'स्क्रीन', 'स्क्रिन', 'सक्रीन', 'सकरीन', 'स्क्रीन'],
  screenshot: ['screenshot', 'اسکرینشاٹ', 'स्क्रीनशॉट', 'स्क्रीनशाट'],
  shot: ['شاٹ', 'शॉट', 'शाट'],
  file: ['file', 'فائل', 'फाइल'],
  folder: ['folder', 'فولڈر', 'फोल्डर'],
  notes: ['notes', 'نوٹس', 'नोट्स'],
  note: ['note', 'نوٹ', 'नोट'],
  error: ['error', 'ایرر', 'एरर'],
  code: ['code', 'کوڈ', 'कोड'],
  button: ['button', 'بٹن', 'बटन'],
  window: ['window', 'ونڈو', 'विंडो'],
  save: ['save', 'سیو', 'सेव'],
  delete: ['delete', 'ڈیلیٹ', 'डिलीट'],
  download: ['download', 'ڈاؤنلوڈ', 'डाउनलोड'],
  install: ['install', 'انسٹال', 'इंस्टॉल'],
  reminder: ['reminder', 'ریمائنڈر', 'रिमाइंडर'],
  // ---- pointing and question words
  ye: ['ye', 'yeh', 'یہ', 'ये', 'यह'],
  kya: ['kya', 'kia', 'کیا', 'क्या'],
  isko: ['isko', 'اسکو', 'اسے', 'इसको', 'इसे'],
  yahan: ['yahan', 'yaha', 'یہاں', 'यहाँ', 'यहां', 'यहा'],
  zara: ['zara', 'jara', 'ذرا', 'ज़रा', 'जरा'],
  meri: ['meri', 'میری', 'मेरी'],
  mera: ['mera', 'میرا', 'मेरा'],
  main: ['main', 'میں', 'मैं', 'मै'],
  mujhe: ['mujhe', 'مجھے', 'मुझे'],
  raha: ['raha', 'rha', 'رہا', 'रहा'],
  rahi: ['rahi', 'rhi', 'رہی', 'रही'],
  hoon: ['hoon', 'ہوں', 'हूँ', 'हूं'],
  matlab: ['matlab', 'مطلب', 'मतलब'],
  kyun: ['kyun', 'kyu', 'کیوں', 'क्यों', 'क्यूँ'],
  kaise: ['kaise', 'kese', 'کیسے', 'कैसे'],
  aap: ['aap', 'آپ', 'आप'],
  tum: ['tum', 'تم', 'तुम'],
};

/** "chan" after a wake name ("Sudo-chan"); only mapped in that position because "چین" is also China and "can" is English. */
const CHAN_SPELLINGS = ['chan', 'chaan', 'chann', 'chen', 'چان', 'چن', 'چین', 'چیں', 'चान', 'चैन', 'चेन', 'चन', 'चांन'];
const WAKE_CANONICALS = new Set(['sudo', 'sid', 'sido']);

/**
 * Folds one token to a comparison key: NFKC, lower case, no zero-width / bidi marks, no Arabic diacritics, one Urdu letter per
 * sound (ي ى -> ی, ك -> ک, ه ھ ۃ -> ہ, ؤ -> و, ئ ے -> ی, ں -> ن, ڑ -> ر), Devanagari without nukta, candrabindu = anusvara,
 * long vowel signs folded to short (ी -> ि, ू -> ु).
 */
export function foldKey(token: string): string {
  return token
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[​-‏‪-‮⁠﻿]/g, '')
    .replace(/[ً-ٰٟۖ-ۭـ]/g, '')
    .replace(/[يى]/g, 'ی')
    .replace(/[ئے]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[هھەۃ]/g, 'ہ')
    .replace(/ؤ/g, 'و')
    .replace(/ں/g, 'ن')
    .replace(/ڑ/g, 'ر')
    .replace(/[़]/g, '')
    .replace(/ँ/g, 'ं')
    .replace(/ी/g, 'ि')
    .replace(/ू/g, 'ु');
}

/** Collapse runs of the same letter ("rukooo" -> "ruko"); used only as a Latin fallback for words of 4+ letters. */
function collapseRuns(key: string): string {
  return key.replace(/(.)\1+/gu, '$1');
}

const TABLE = new Map<string, string>();
const COLLAPSED = new Map<string, string>();
const CHAN_KEYS = new Set(CHAN_SPELLINGS.map(foldKey));
for (const [canonical, spellings] of Object.entries(ALIAS_GROUPS)) {
  for (const spelling of spellings) {
    const key = foldKey(spelling);
    if (!TABLE.has(key)) TABLE.set(key, canonical);
    const collapsed = collapseRuns(key);
    if (/^[a-z]+$/.test(collapsed) && collapsed.length >= 4 && !COLLAPSED.has(collapsed)) COLLAPSED.set(collapsed, canonical);
  }
}

const EDGE = /^([^\p{L}\p{M}\p{N}]*)([\s\S]*?)([^\p{L}\p{M}\p{N}]*)$/u;
const JOINERS = /([-‐‑–_])/;

function lookup(core: string, afterWake: boolean): string | undefined {
  const key = foldKey(core);
  if (!key) return undefined;
  if (afterWake && CHAN_KEYS.has(key)) return 'chan';
  const direct = TABLE.get(key);
  if (direct) return direct;
  if (/^[a-z]+$/.test(key)) {
    const collapsed = collapseRuns(key);
    if (collapsed.length >= 4) {
      const hit = COLLAPSED.get(collapsed);
      if (hit) return hit;
    }
  }
  // "सुडोचान" / "sudochan" / "سوڈوچان": a wake name glued to "chan".
  for (const wake of WAKE_CANONICALS) {
    for (const [spelling, canonical] of TABLE) {
      if (canonical !== wake || spelling.length < 2 || !key.startsWith(spelling) || key.length === spelling.length) continue;
      if (CHAN_KEYS.has(key.slice(spelling.length))) return `${wake}chan`;
    }
  }
  return undefined;
}

function sameIgnoringCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** One whitespace-free token (may hold hyphens). Returns the replacement and whether it ended on a wake name. */
function mapToken(token: string, afterWake: boolean): { text: string; wake: boolean } {
  const m = EDGE.exec(token);
  if (!m || !m[2]) return { text: token, wake: false };
  const [, head, core, tail] = m;
  const pieces = core.split(JOINERS);
  let wake = afterWake;
  const mapped = pieces.map(piece => {
    if (!piece || JOINERS.test(piece)) return piece;
    const hit = lookup(piece, wake);
    if (hit === undefined) {
      wake = false;
      return piece;
    }
    wake = WAKE_CANONICALS.has(hit);
    // Keep the original spelling (and its capital letters) when it already is the canonical word.
    return sameIgnoringCase(piece, hit) ? piece : hit;
  });
  return { text: `${head}${mapped.join('')}${tail}`, wake };
}

/**
 * The text with every known command token spelled canonically. Unknown words, spacing and punctuation are untouched, and the
 * number of whitespace-separated tokens never changes. Use ONLY for matching, never for display.
 */
export function aliasForMatching(text: string): string {
  if (!text) return '';
  const parts = text.split(/(\s+)/);
  let afterWake = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || /^\s+$/.test(part)) continue;
    const { text: mapped, wake } = mapToken(part, afterWake);
    parts[i] = mapped;
    afterWake = wake;
  }
  return parts.join('');
}

export function detectScript(text: string): ScriptKind {
  const urdu = /[؀-ۿݐ-ݿ]/.test(text);
  const hindi = /[ऀ-ॿ]/.test(text);
  const latin = /[A-Za-z]/.test(text);
  const count = Number(urdu) + Number(hindi) + Number(latin);
  if (count === 0) return 'none';
  if (count > 1) return 'mixed';
  return urdu ? 'urdu' : hindi ? 'devanagari' : 'latin';
}

export interface NormalizedTranscript {
  /** Exactly what the speech engine returned: show this to the user and send it to the chat. */
  display: string;
  /** Aliased copy for wake / stop / intent matching. */
  match: string;
  script: ScriptKind;
  /** True when at least one token was re-spelled. */
  changed: boolean;
}

export function normalizeTranscript(text: string): NormalizedTranscript {
  const display = text ?? '';
  const match = aliasForMatching(display);
  return { display, match, script: detectScript(display), changed: match !== display };
}

/** Single words that are real commands or answers on their own, in canonical (aliased) spelling. */
export const SHORT_COMMAND_WORDS: ReadonlySet<string> = new Set([
  'sid', 'sudo', 'sido', 'ji', 'haan', 'nahi', 'suno', 'kaho', 'bye', 'hello', 'hi', 'yes', 'no', 'theek', 'kya', 'ok', 'okay',
  'dekho', 'dekh', 'dekhiye', 'batao', 'bolo', 'chalo', 'shukriya', 'screen', 'screenshot', 'ruko', 'roko', 'ruk', 'rukiye', 'bas', 'chup',
  'khamosh', 'thehro', 'stop', 'sudochan', 'sidchan', 'padho', 'likho', 'kholo', 'banao',
]);

/** True when `text` is one word (punctuation ignored) that is a known short command or answer in any script. */
export function isShortCommandWord(text: string): boolean {
  const words = aliasForMatching(text ?? '').split(/\s+/).map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase()).filter(Boolean);
  return words.length === 1 && SHORT_COMMAND_WORDS.has(words[0]);
}
