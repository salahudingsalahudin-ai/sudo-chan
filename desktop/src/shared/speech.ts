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
  const accent = lang === 'en' ? '' : ' Pronounce it as a native Pakistani Urdu speaker would.';
  return `Say the following ${base[emotion]}.${accent}`;
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
