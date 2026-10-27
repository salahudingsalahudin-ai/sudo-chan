/**
 * Speech-to-text hallucination filter (pure, no DOM, no Electron).
 *
 * Whisper, on quiet or noisy clips, sometimes writes back the words of its own `prompt` ("Sudo-chan, Sid, suno, ji, ...")
 * or stock subtitle junk ("Thanks for watching"). Those transcripts contain no speech at all, but a transcript that is just
 * the assistant's name matches the wake word, so the bot woke itself up and answered nobody.
 *
 * Rules (a single name is real speech and is never dropped):
 *  - empty / punctuation only            -> drop
 *  - known Whisper junk as the WHOLE text -> drop
 *  - only names, 2 or more times          -> drop  ("Sudo-chan, Sido-chan,", "Sid sudo")
 *  - only names and prompt words, with 2+ names, or a copied chunk of the prompt -> drop
 *  - anything else (including "Sid, kaise ho?", Urdu script) -> keep
 */
import { DEFAULT_WAKE_ALIASES, allowedDistance, editDistance, normalizeWord } from './wake-word.ts';
import { aliasForMatching } from './transcript-normalize.ts';

export type PhantomReason = 'empty' | 'junk' | 'name-list' | 'prompt-copy';

export interface PhantomVerdict {
  drop: boolean;
  reason?: PhantomReason;
}

export interface PhantomOptions {
  /** Extra names the user can call the assistant (custom wake word, aliases). Default aliases are always included. */
  names?: string[];
}

/** Spelling variants Whisper produces for the default names. */
const EXTRA_NAME_VARIANTS = ['sido', 'sidochan', 'sudochan', 'sudu', 'sidu', 'shudo', 'pseudo', 'sidd', 'suddo'];
/** "Sudo-chan" often arrives as two words. */
const SUFFIX_TOKENS = new Set(['chan', 'chaan', 'chann']);

/** Words of the old and new Whisper prompts plus the structured wake hint. A transcript made only of these and names is a prompt echo. */
const PROMPT_WORDS = new Set([
  'suno', 'ji', 'kya', 'haal', 'hai', 'kaise', 'ho', 'theek', 'mujhe', 'batao', 'kaam', 'baat', 'computer',
  'pakistani', 'conversation', 'in', 'roman', 'urdu', 'and', 'english', 'aur', 'short', 'voice', 'command',
  'the', 'speaker', 'may', 'call', 'assistant', 'by', 'name', 'ka', 'se', 'karni', 'mein',
]);

/** Boilerplate phrases from our own prompts; Whisper copies them verbatim when it hears nothing. */
const PROMPT_BOILERPLATE = [
  /pakistani conversation in roman urdu and english/g,
  /conversation in english urdu and roman urdu/g,
  /roman urdu and english/g,
  /short voice command/g,
  /the speaker may call the assistant by name/g,
  /mujhe .{0,20} se baat karni hai/g,
];

/** Token sequences of earlier/current prompts. A long contiguous copy of one of them is a prompt echo. */
const PROMPT_SEQUENCES = [
  'pakistani conversation in roman urdu and english sudo chan sid suno ji kya haal hai kaise ho theek hai mujhe batao kaam baat computer',
  'conversation in english urdu and roman urdu sudo chan sid suno ji kya haal hai kaise ho theek ho computer kaam baat',
  'roman urdu and english kaise ho theek hai mujhe computer ka kaam batao mujhe sudo chan se baat karni hai',
].map(seq => seq.split(' '));

const MIN_COPY_RUN = 6;

/** Stock Whisper hallucinations; only dropped when they are the entire transcript. */
const JUNK_WHOLE = new RegExp(`^(?:${[
  'thank you', 'thank you very much', 'thank you so much', 'thank you for watching', 'thanks for watching',
  'thanks', 'thanks for listening', 'thank you for listening', 'bye', 'bye bye', 'goodbye', 'you', 'the end',
  'please subscribe', 'like and subscribe', 'subscribe', 'see you next time', 'see you in the next video',
  'i will see you in the next video', 'see you soon', 'music', 'applause', 'silence', 'laughter', 'hmm', 'mm', 'uh', 'um',
  'subtitles by .*', 'subtitles by the amara org community', 'amara org', 'transcribed by .*', 'translated by .*',
  'www .*', 'pakistani conversation', 'pakistani conversation in roman urdu', 'roman urdu', 'roman urdu and english',
  'conversation in roman urdu and english',
].join('|')})$`, 'iu');

function plainText(text: string): string {
  return text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function nameKeys(extra: string[] | undefined): string[] {
  const keys = new Set<string>();
  for (const raw of [...DEFAULT_WAKE_ALIASES, ...EXTRA_NAME_VARIANTS, ...(extra ?? [])]) {
    const key = normalizeWord(raw);
    if (key) keys.add(key);
  }
  return [...keys];
}

/** Does this single (normalised) word look like one of the assistant's names? */
function isNameWord(word: string, keys: string[]): boolean {
  if (!word) return false;
  if (keys.includes(word)) return true;
  // "suno" is one letter from "sudo" but is an ordinary word of the prompt/greetings, never a name.
  if (PROMPT_WORDS.has(word)) return false;
  for (const key of keys) {
    // Fuzzy only for words long enough that a typo is plausible ("sudo" ~ "sido" ~ "suddo").
    if (word.length >= 4 && key.length >= 4 && editDistance(word, key) <= allowedDistance(key)) return true;
  }
  return false;
}

interface Tokens {
  /** Words in order; a name followed by "chan" counts as ONE name. */
  words: Array<{ text: string; isName: boolean }>;
  names: number;
  others: string[];
}

function tokenize(text: string, keys: string[]): Tokens {
  const raw = plainText(text).split(' ').filter(Boolean);
  const words: Tokens['words'] = [];
  for (const word of raw) {
    const previous = words[words.length - 1];
    if (SUFFIX_TOKENS.has(word) && previous?.isName) continue;
    words.push({ text: word, isName: isNameWord(word, keys) || (SUFFIX_TOKENS.has(word)) });
  }
  const names = words.filter(w => w.isName).length;
  return { words, names, others: words.filter(w => !w.isName).map(w => w.text) };
}

function longestPromptRun(words: string[]): number {
  let best = 0;
  for (const sequence of PROMPT_SEQUENCES) {
    for (let i = 0; i < words.length; i++) {
      for (let j = 0; j < sequence.length; j++) {
        let k = 0;
        while (i + k < words.length && j + k < sequence.length && words[i + k] === sequence[j + k]) k++;
        if (k > best) best = k;
      }
    }
  }
  return best;
}

function classifyAs(text: string, options: PhantomOptions): PhantomVerdict {
  const trimmed = (text ?? '').trim();
  if (!trimmed || !/[\p{L}\p{N}]/u.test(trimmed)) return { drop: true, reason: 'empty' };
  const plain = plainText(trimmed);
  // "[Music]", "(applause)", "♪ ... ♪": whole-text bracket tags.
  if (/^[\[(*♪].*[\])*♪]$/u.test(trimmed) && plain.split(' ').length <= 3) return { drop: true, reason: 'junk' };
  if (JUNK_WHOLE.test(plain)) return { drop: true, reason: 'junk' };

  const keys = nameKeys(options.names);
  const tokens = tokenize(trimmed, keys);
  if (!tokens.words.length) return { drop: true, reason: 'empty' };

  // Only names, said 2+ times: "Sudo-chan, Sido-chan,", "Sid sudo", "Sid Sid Sid".
  if (tokens.names >= 2 && tokens.others.length === 0) return { drop: true, reason: 'name-list' };

  // Names plus words that only exist in our own prompt: "Sudo-chan, Sid, suno, ji".
  const onlyPromptWords = tokens.others.every(w => PROMPT_WORDS.has(w));
  if (tokens.names >= 2 && onlyPromptWords) return { drop: true, reason: 'prompt-copy' };

  // Our prompt boilerplate ("Pakistani conversation in Roman Urdu and English") with nothing real left over.
  let stripped = plain;
  let hadBoilerplate = false;
  for (const pattern of PROMPT_BOILERPLATE) {
    const next = stripped.replace(pattern, ' ');
    if (next !== stripped) hadBoilerplate = true;
    stripped = next;
  }
  if (hadBoilerplate) {
    const rest = tokenize(stripped, keys);
    if (rest.others.every(w => PROMPT_WORDS.has(w))) return { drop: true, reason: 'prompt-copy' };
  }

  // A long verbatim chunk of the prompt's word list ("kya haal hai kaise ho theek hai mujhe batao ...") covering the whole text.
  const plainWords = plain.split(' ');
  if (plainWords.length >= MIN_COPY_RUN) {
    const run = longestPromptRun(plainWords);
    if (run >= MIN_COPY_RUN && run / plainWords.length >= 0.85) return { drop: true, reason: 'prompt-copy' };
  }
  return { drop: false };
}

/**
 * As spoken first; then with Urdu / Hindi script names re-spelled ("सुडो चान, सिडो चान" is the same name list as "Sudo-chan, Sido-chan").
 * The second pass can only add drops.
 */
export function classifyTranscript(text: string, options: PhantomOptions = {}): PhantomVerdict {
  const first = classifyAs(text, options);
  if (first.drop) return first;
  const aliased = aliasForMatching(text ?? '');
  return aliased === text ? first : classifyAs(aliased, options);
}

export function isPhantomTranscript(text: string, options: PhantomOptions = {}): boolean {
  return classifyTranscript(text, options).drop;
}

/** How long after the bot's own speech a name-only echo of it is still treated as the bot hearing itself. */
export const SELF_ECHO_WINDOW_MS = 3000;

/**
 * Safety net for the overlay: right after the bot spoke, a transcript that is only its own name (plus words the bot just
 * said) is the bot hearing itself through the speakers, not the user calling it.
 * `msSinceBotSpoke` is 0 while it is still talking.
 */
export function isSelfEchoTranscript(text: string, lastSpoken: string | undefined, msSinceBotSpoke: number, options: PhantomOptions = {}): boolean {
  if (echoAs(text, lastSpoken, msSinceBotSpoke, options)) return true;
  const aliased = aliasForMatching(text ?? '');
  return aliased !== text && echoAs(aliased, aliasForMatching(lastSpoken ?? ''), msSinceBotSpoke, options);
}

function echoAs(text: string, lastSpoken: string | undefined, msSinceBotSpoke: number, options: PhantomOptions): boolean {
  if (!lastSpoken || !lastSpoken.trim()) return false;
  if (!(msSinceBotSpoke >= 0) || msSinceBotSpoke > SELF_ECHO_WINDOW_MS) return false;
  const keys = nameKeys(options.names);
  const said = tokenize(text, keys);
  if (said.names < 1) return false;
  const spoken = tokenize(lastSpoken, keys);
  if (spoken.names < 1) return false; // the bot did not say a name, so hearing one is not an echo
  const spokenWords = new Set(plainText(lastSpoken).split(' '));
  return said.others.every(word => spokenWords.has(word));
}

export interface WhisperSegment {
  no_speech_prob?: number;
  avg_logprob?: number;
  compression_ratio?: number;
}

/**
 * Uses Whisper's own confidence (verbose_json) to reject results that are probably silence.
 * Same rule Whisper uses internally: no_speech_prob above 0.6 AND avg_logprob below -1.0, on EVERY segment.
 * Missing or malformed segments mean "no information", so the text is kept.
 */
export function segmentsLookLikeSilence(segments: unknown): boolean {
  if (!Array.isArray(segments) || segments.length === 0) return false;
  for (const raw of segments) {
    const seg = raw as WhisperSegment | null;
    const noSpeech = seg?.no_speech_prob;
    const logprob = seg?.avg_logprob;
    if (typeof noSpeech !== 'number' || typeof logprob !== 'number') return false;
    if (!(noSpeech > 0.6 && logprob < -1.0)) return false;
  }
  return true;
}

/** Whisper rejects a segment as silence above this no_speech_prob; between 0.6 and this value the text can still be quiet real speech. */
export const BORDERLINE_NO_SPEECH = 0.85;
/** Quiet Roman Urdu is low-confidence for Whisper (Urdu is rarely written in Latin letters); avg_logprob above this is not "garbage". */
export const BORDERLINE_LOGPROB = -1.6;
/** A borderline result needs at least this many words that are not the assistant's names. */
export const BORDERLINE_MIN_WORDS = 3;

/**
 * Final silence verdict for one Whisper result (segments plus its text). `segmentsLookLikeSilence` is the strict rule
 * (every segment no_speech_prob > 0.6 AND avg_logprob < -1). This keeps it, except for the borderline band: no segment above
 * 0.85 no-speech, every avg_logprob above -1.6 AND a sentence of 3+ non-name words that is not a phantom. That is what a quiet,
 * low-confidence Roman Urdu sentence looks like; a prompt echo ("Sudo-chan, Sido-chan,") is 1-2 words of names and stays rejected.
 * The band is reasoned, not measured: it needs a real-audio check (see URDU-STT.md).
 */
export function whisperTextIsSilence(segments: unknown, text: string, options: PhantomOptions = {}): boolean {
  if (!segmentsLookLikeSilence(segments)) return false;
  const segs = segments as WhisperSegment[];
  const maxNoSpeech = Math.max(...segs.map(seg => seg.no_speech_prob ?? 1));
  const minLogprob = Math.min(...segs.map(seg => seg.avg_logprob ?? -9));
  if (maxNoSpeech > BORDERLINE_NO_SPEECH || minLogprob < BORDERLINE_LOGPROB) return true;
  if (classifyTranscript(text, options).drop) return true;
  const aliased = aliasForMatching(text ?? '');
  return tokenize(aliased, nameKeys(options.names)).others.length < BORDERLINE_MIN_WORDS;
}
