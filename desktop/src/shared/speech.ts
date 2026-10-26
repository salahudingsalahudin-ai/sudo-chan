export const EMOTIONS = ['neutral', 'warm', 'excited', 'calm', 'curious', 'soft', 'happy'] as const;
export type Emotion = typeof EMOTIONS[number];

const TAG_ALIASES: Record<string, Emotion> = {
  neutral: 'neutral', warm: 'warm', friendly: 'warm', excited: 'excited', calm: 'calm', curious: 'curious',
  soft: 'soft', apologetic: 'soft', sorry: 'soft', sad: 'soft', happy: 'happy', cheerful: 'happy', greeting: 'happy',
};
const TAG_PATTERN = /\[\s*(neutral|warm|friendly|excited|calm|curious|soft|apologetic|sorry|sad|happy|cheerful|greeting)\s*\]/gi;

/** Removes [warm]-style emotion tags, including a half-typed tag at the end of a streaming reply. */
export function stripEmotionTags(text: string): string {
  if (!text) return '';
  return text.replace(TAG_PATTERN, '').replace(/\[[a-z]{0,10}$/i, '').replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+/gm, '');
}

export interface EmotionSegment { text: string; emotion: Emotion }

/** Splits raw LLM text on emotion tags. A tag applies to the text that follows it; untagged text is neutral. */
export function parseEmotionTags(text: string): EmotionSegment[] {
  if (!text) return [];
  const segments: EmotionSegment[] = [];
  let emotion: Emotion = 'neutral';
  let last = 0;
  const push = (chunk: string) => {
    const t = chunk.trim();
    if (t) segments.push({ text: t, emotion });
  };
  for (const match of text.matchAll(TAG_PATTERN)) {
    push(text.slice(last, match.index));
    emotion = TAG_ALIASES[match[1].toLowerCase()] ?? 'neutral';
    last = (match.index ?? 0) + match[0].length;
  }
  push(text.slice(last));
  return segments;
}

const HUMAN_DELIVERY = ' Sound like a real person talking, not reading: vary the pitch naturally, take a soft breath between phrases, leave a short pause at commas and a slightly longer one at the end of a sentence, and never rush.';

/** Natural-language style instruction handed to the TTS model together with the sentence. */
export function emotionStyle(emotion: Emotion, lang: 'ur' | 'en' | 'hi' = 'en'): string {
  const base: Record<Emotion, string> = {
    neutral: 'in a natural, conversational tone with small pauses',
    warm: 'warmly and kindly, at a natural conversational pace, with small pauses',
    excited: 'with bright, excited energy, slightly faster, with a smile in the voice',
    calm: 'calmly and gently, a little slower, with soft pauses',
    curious: 'with curious, rising intonation as if genuinely interested',
    soft: 'softly and apologetically, gentle and low in volume',
    happy: 'cheerfully, like a happy greeting to a friend',
  };
  const accent = lang === 'en'
    ? ''
    : ' The text is Urdu, possibly written in Roman (Latin) letters: read it as natural spoken Pakistani Urdu, pronounce it as a native Pakistani Urdu speaker would, and never as English.';
  return `Say the following ${base[emotion]}.${HUMAN_DELIVERY}${accent}`;
}

/** Fewer than 3 words is not worth a quota-limited Gemini call. */
export function worthGemini(text: string): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length >= 3;
}

const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\be\.g\.,?/gi, 'for example,'],
  [/\bi\.e\.,?/gi, 'that is,'],
  [/\betc\.?/gi, 'et cetera'],
  [/\bvs\.?(?=\s)/gi, 'versus'],
  [/\bapprox\.?(?=\s)/gi, 'approximately'],
  [/\bDr\./g, 'Doctor'],
  [/\bMr\./g, 'Mister'],
  [/\bMrs\./g, 'Missus'],
  [/\bRAM\b/g, 'ram'],
  [/&/g, ' and '],
];

/** Makes text easier for a TTS engine: symbols, abbreviations, runs of punctuation, brackets. */
export function normalizeForSpeech(text: string): string {
  let t = text;
  for (const [pattern, replacement] of ABBREVIATIONS) t = t.replace(pattern, replacement);
  t = t.replace(/(\d)\s*%/g, '$1 percent');
  t = t.replace(/\.{2,}|…/g, ', ');            // ellipsis becomes a short pause
  t = t.replace(/([!?])\1+/g, '$1');          // "!!!" -> "!"
  t = t.replace(/[()\[\]{}]/g, ', ');          // brackets read as a pause
  t = t.replace(/\s*[—–]\s*|\s-\s/g, ', ');   // dashes read as a pause
  t = t.replace(/[*_#~^|<>\\]/g, ' ');
  t = t.replace(/\s*,(\s*,)+/g, ',').replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1');
  return t.trim();
}

/** Splits at the most natural boundary at or before maxLen: sentence end, then comma/semicolon, then a space. */
export function chunkForGoogle(text: string, maxLen = 180): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen + 1);
    let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf('۔ '));
    if (cut < maxLen * 0.4) cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf('، '));
    if (cut < maxLen * 0.4) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = maxLen - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * Groups sentences for synthesis: the first group is a single sentence (fast start); the rest merge
 * consecutive sentences with the same emotion up to maxLen characters, so one quota-limited request
 * covers several sentences.
 */
export function groupForSynthesis(sentences: SpokenSentence[], maxLen = 250): SpokenSentence[] {
  const groups: SpokenSentence[] = [];
  sentences.forEach((sentence, index) => {
    const last = groups[groups.length - 1];
    if (index > 1 && last && last.emotion === sentence.emotion && (last.text + ' ' + sentence.text).length <= maxLen) {
      last.text += ' ' + sentence.text;
    } else {
      groups.push({ text: sentence.text, emotion: sentence.emotion });
    }
  });
  return groups;
}

export interface SpokenSentence { text: string; emotion: Emotion }

/** Tag-aware sentence queue for TTS: emotion per sentence, markdown/emoji/URL/code already removed. */
export function splitIntoSpokenSentences(raw: string, maxLen = 180): SpokenSentence[] {
  const out: SpokenSentence[] = [];
  for (const segment of parseEmotionTags(raw)) {
    for (const sentence of splitIntoSentences(segment.text, maxLen)) out.push({ text: sentence, emotion: segment.emotion });
  }
  return out;
}

export function cleanTextForSpeech(text: string): string {
  if (!text || typeof text !== 'string') return '';

  let cleaned = stripEmotionTags(text);

  // 1. Remove fenced code blocks (``` ... ```)
  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' ');

  // 2. Remove inline code (`...`)
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');

  // 3. Remove markdown links ([text](url)) -> text
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 4. Remove bare URLs
  cleaned = cleaned.replace(/https?:\/\/\S+/g, ' ');

  // 5. Remove markdown headings (#, ##, etc.) at start of line
  cleaned = cleaned.replace(/^\s{0,3}#{1,6}\s+/gm, ' ');

  // 6. Remove blockquote markers (> )
  cleaned = cleaned.replace(/^\s{0,3}>\s+/gm, ' ');

  // 7. Remove list bullets (-, *, +, 1., 2.)
  cleaned = cleaned.replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, ' ');

  // 8. Remove bold / italics (**text**, *text*, __text__, _text_)
  cleaned = cleaned.replace(/(\*\*|__)(.*?)\1/g, '$2');
  cleaned = cleaned.replace(/(\*|_)(.*?)\1/g, '$2');

  // 9. Remove strikethrough (~~text~~)
  cleaned = cleaned.replace(/~~(.*?)~~/g, '$1');

  // 10. Strip emojis and special decorative symbols (e.g. 🍵, ✨, ⚠️, ✦, ✧, etc.)
  // Keep standard alphanumeric, Latin accents, Urdu/Arabic script if any, and natural punctuation (. , ? ! ' " : -)
  cleaned = cleaned.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}✦✧⚠️•]/gu, ' ');

  // 11. Normalize multiple spaces, tabs, and newlines into single spaces with proper punctuation spacing
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

export function splitIntoSentences(text: string, maxLen = 180): string[] {
  const clean = cleanTextForSpeech(text);
  if (!clean) return [];

  // Split on sentence boundaries: periods, Urdu full stops (۔), question marks, exclamation marks, and newlines
  const regex = /([^.!?۔\n]+[.!?۔\n]+|[^.!?۔\n]+$)/gu;
  const rawParts = clean.match(regex) || [clean];

  const sentences: string[] = [];
  for (const part of rawParts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (trimmed.length <= maxLen) {
      sentences.push(trimmed);
    } else {
      const subParts = trimmed.split(/([,;،—–-]\s+)/);
      let current = '';
      for (const sub of subParts) {
        if ((current + sub).length <= maxLen) {
          current += sub;
        } else {
          if (current.trim()) sentences.push(current.trim());
          current = sub;
        }
      }
      if (current.trim()) sentences.push(current.trim());
    }
  }

  return sentences.filter(s => s.length > 0);
}

export function detectSentenceLanguage(sentence: string): 'ur' | 'en' | 'hi' {
  // Urdu Arabic script (e.g. ۔ ، ا ب ت)
  if (/[\u0600-\u06FF]/.test(sentence)) return 'ur';
  // Pakistani Roman Urdu keywords (tl=hi provides natural phonetic Urdu vowels for Roman Urdu)
  if (/\b(hai|hain|hoon|kya|kaise|kaisi|karo|karein|baat|acha|theek|batao|shukriya|madad|tum|aap|mera|meri|hum|bohot|zaroor|nahi|nhi|suno|ji)\b/i.test(sentence)) {
    return 'hi';
  }
  return 'en';
}
