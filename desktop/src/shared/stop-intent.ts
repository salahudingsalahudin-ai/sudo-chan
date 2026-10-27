/**
 * Decides whether a short spoken utterance is only a "stop talking" command
 * (English, Roman Urdu or Urdu script). Longer sentences and questions that merely
 * contain a stop word ("ruko mujhe ek sawal poochna hai") are NOT stop commands.
 */

import { aliasForMatching } from './transcript-normalize.ts';

const MAX_WORDS = 4;

// Spelling variants speech-to-text commonly produces, after collapsing repeated letters.
const STOP_WORD_PATTERNS: RegExp[] = [
  /^r[uo]k[oe]?$/,                 // ruko roko ruk ruke
  /^rukiy?e(ga)?$/,                // rukiye rukiyega
  /^(ruk|rok)(jao|jaao|jaye|jayen)$/, // rukjao
  /^s?top$/,                       // stop top
  /^bas$/,                         // bas
  /^chup$/, /^shup$/,              // chup
  /^kh?amo?sh$/, /^khamush$/,      // khamosh
  /^(the[hr]|thehe?r)(o|jao|jaao)$/, // thehro theher jao
  /^shut$/, /^enough$/, /^quiet$/, /^silence$/, /^wait$/, /^pause$/, /^hold$/, /^cancel$/,
  /^بس$/, /^رکو$/, /^روکو$/, /^رک$/, /^چپ$/, /^خاموش$/, /^ٹھہرو$/,
];

// Words that may appear next to a stop word without making it a real request.
const FILLERS = new Set([
  'please', 'plz', 'pls', 'ji', 'yaar', 'yar', 'yrr', 'yr', 'sid', 'sudo', 'chan', 'sudochan', 'jao', 'jaao', 'jaye', 'karo', 'kar', 'do', 'dijiye', 'dein',
  'ho', 'it', 'now', 'ab', 'abhi', 'bhi', 'ok', 'okay', 'na', 'zara', 'thora', 'thoda', 'mat', 'bolo', 'bolna', 'talking', 'speaking', 'up', 'on', 'shut', 'be', 'that', 'thats', 'is', 'stop', 'band', 'kardo',
  'جاؤ', 'کرو', 'کر', 'دو', 'جی', 'پلیز', 'ہو', 'اب', 'بھی', 'بولنا', 'مت',
]);

const QUESTION_WORDS = new Set(['kya', 'kyun', 'kyu', 'kaise', 'kaisay', 'kab', 'kahan', 'kaun', 'what', 'why', 'how', 'when', 'where', 'who', 'کیا', 'کیوں', 'کیسے']);

function normalize(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    // "rooko" -> "roko", "rukk" -> "ruk", "choop" -> "chop" ...
    .map(word => word.replace(/(.)\1+/g, '$1'));
}

function isStopWord(word: string): boolean {
  return STOP_WORD_PATTERNS.some(pattern => pattern.test(word));
}

function isStopCommandAs(text: string): boolean {
  if (!text || /\?|؟/.test(text)) return false;
  const words = normalize(text);
  if (!words.length || words.length > MAX_WORDS) return false;
  if (words.some(word => QUESTION_WORDS.has(word))) return false;
  // Two-word glue such as "ruk jao" / "shut up" / "hold on" / "band karo" is covered by filler words.
  let sawStop = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    // "band" alone is not a command ("band" the music group); "band karo / band kar do" is.
    if (word === 'band' || word === 'بند') {
      if (words[i + 1] && /^(karo|kar|kardo|do|ho|کرو|کر|دو|ہو)$/.test(words[i + 1])) sawStop = true;
      else if (word === 'بند' && words.length > 1) sawStop = true;
      else return false;
    } else if (isStopWord(word)) sawStop = true;
    else if (!FILLERS.has(word)) return false;
  }
  return sawStop;
}

/**
 * The text as spoken first, then with Urdu / Hindi script and Roman spelling variants re-spelled ("रुको" -> "ruko").
 * The second pass can only add matches.
 */
export function isStopCommand(text: string): boolean {
  if (isStopCommandAs(text)) return true;
  const aliased = aliasForMatching(text ?? '');
  return aliased !== text && isStopCommandAs(aliased);
}

/** An interruption this short is almost certainly a command word ("ruko") that the recogniser missed, not a real question. */
export const SHORT_INTERRUPTION_MS = 1000;

/**
 * What to do when an interruption could not be understood.
 * 'none' = nothing was interrupted; 'stay-stopped' = too short to be anything but a command; 'resume' = carry on.
 */
export function unclearAction(clipMs: number, hasInterruption: boolean): 'none' | 'stay-stopped' | 'resume' {
  if (!hasInterruption) return 'none';
  return clipMs < SHORT_INTERRUPTION_MS ? 'stay-stopped' : 'resume';
}
