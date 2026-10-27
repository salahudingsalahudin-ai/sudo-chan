import { detectSentenceLanguage, groupForSynthesis, splitIntoSpokenSentences } from '../shared/speech.ts';
import type { Emotion } from '../shared/speech.ts';
import { beginPlayback, currentGeneration, decodeDataUri, finishPlayback, markSpeechStart, onStopSpeaking, playBuffer, stopSpeaking } from './tts-player.ts';

const STORAGE_KEY = 'sudo_chan_tts_muted';

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

export function getMutedPreference(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setMutedPreference(muted: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, muted ? 'true' : 'false');
  } catch {
    // Ignore localStorage failures
  }
}

let cachedVoices: SpeechSynthesisVoice[] = [];

function loadVoices(): SpeechSynthesisVoice[] {
  if (!isSpeechSupported()) return [];
  if (cachedVoices.length) return cachedVoices;
  cachedVoices = window.speechSynthesis.getVoices();
  return cachedVoices;
}

if (isSpeechSupported()) {
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoices = window.speechSynthesis.getVoices();
  };
}

export function findBestVoice(): SpeechSynthesisVoice | undefined {
  const voices = loadVoices();
  if (!voices || !voices.length) return undefined;

  // Female voice keywords
  const femaleKeywords = ['female', 'zira', 'samantha', 'victoria', 'karen', 'aria', 'jenny', 'priya', 'veena', 'natural'];

  // 1. Try to find a voice that matches both English/Urdu/Hindi and female keyword
  const femaleEnglish = voices.find(v => {
    const name = v.name.toLowerCase();
    const lang = v.lang.toLowerCase();
    const isLangMatch = lang.startsWith('en') || lang.startsWith('ur') || lang.startsWith('hi');
    const isFemale = femaleKeywords.some(kw => name.includes(kw));
    return isLangMatch && isFemale;
  });
  if (femaleEnglish) return femaleEnglish;

  // 2. Try any female voice
  const anyFemale = voices.find(v => {
    const name = v.name.toLowerCase();
    return femaleKeywords.some(kw => name.includes(kw));
  });
  if (anyFemale) return anyFemale;

  // 3. Try English default or en-US/en-GB
  const defaultEnglish = voices.find(v => v.lang.toLowerCase().startsWith('en') && v.default) ||
    voices.find(v => v.lang.toLowerCase().startsWith('en'));
  if (defaultEnglish) return defaultEnglish;

  return voices[0];
}

/** Stops any spoken reply right now (Stop button, mute, barge-in callers use stopSpeaking directly). */
export function stopSpeech(): void {
  stopSpeaking('stop-button');
}

/** Synthesis happens in the main process (API keys / network); playback happens only in tts-player. */
async function synthesize(sentence: string, emotion: Emotion): Promise<AudioBuffer | null> {
  const lang = detectSentenceLanguage(sentence);
  try {
    const result = await window.companion?.playSpeech({ text: sentence, lang, emotion });
    if (result?.ok && result.dataUri) return await decodeDataUri(result.dataUri);
  } catch (error) {
    console.warn('[TTS] synthesis request failed:', (error as Error).message);
  }
  return null;
}

function speakWithBrowserVoice(sentence: string, generation: number): Promise<boolean> {
  if (!isSpeechSupported()) return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    try {
      if (generation !== currentGeneration()) return resolve(false);
      const utterance = new SpeechSynthesisUtterance(sentence);
      const voice = findBestVoice();
      if (voice) utterance.voice = voice;
      utterance.pitch = 1.08;
      utterance.rate = 1.0;
      utterance.onend = () => resolve(true);
      utterance.onerror = () => resolve(false);
      markSpeechStart();
      window.speechSynthesis.speak(utterance);
    } catch {
      resolve(false);
    }
  });
}

// ---------------------------------------------------------------------------
// Interrupted-reply memory: a barge-in remembers where she was so that, if the
// interruption turns out to be unintelligible, she can carry on from there.
// ---------------------------------------------------------------------------
interface ReplyItem { text: string; emotion: Emotion }
interface Interrupted {
  items: ReplyItem[];
  index: number;
  savedAt: number;
  resumes: number;
  /** The clip that was playing and how far it had got (exact mid-sentence resume). */
  partial: { buffer: AudioBuffer; offsetSec: number } | null;
}

export const RESUME_WINDOW_MS = 20_000;
export const MAX_RESUMES = 2;
/** Rewind a little so she restarts a word or two before the cut instead of mid-syllable. */
const RESUME_REWIND_SEC = 0.4;

let currentReply: { items: ReplyItem[]; index: number; resumes: number; generation: number } | null = null;
let interrupted: Interrupted | null = null;
let clock: () => number = () => Date.now();

/** Test hook: replace the clock used for the 20 s resume window. */
export function setSpeechClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

onStopSpeaking(info => {
  if (info.reason === 'barge-in') {
    if (currentReply) {
      interrupted = {
        items: currentReply.items,
        index: currentReply.index,
        savedAt: clock(),
        resumes: currentReply.resumes,
        partial: info.played,
      };
      currentReply = null;
    }
    return;
  }
  if (info.reason === 'finish') return;
  // Stop button, mute, window closed, a new reply, an error: whatever was interrupted is forgotten.
  interrupted = null;
  currentReply = null;
});

export function clearInterruptedSpeech(): void {
  interrupted = null;
}

/** True if a barge-in cut a reply less than 20 s ago and it can still be resumed. */
export function hasInterruptedSpeech(): boolean {
  return interrupted !== null && clock() - interrupted.savedAt <= RESUME_WINDOW_MS && interrupted.resumes < MAX_RESUMES;
}

/**
 * Continues the reply that a barge-in cut, from the sentence (and, when known, the exact
 * moment) where it was interrupted. Returns false and stays silent if there is nothing to resume.
 */
export function resumeInterruptedSpeech(): boolean {
  const saved = interrupted;
  interrupted = null;
  if (!saved || getMutedPreference()) return false;
  if (clock() - saved.savedAt > RESUME_WINDOW_MS || saved.resumes >= MAX_RESUMES) return false;
  const generation = beginPlayback();
  currentReply = { items: saved.items, index: saved.index, resumes: saved.resumes + 1, generation };
  void playItems(saved.items, saved.index, generation, saved.partial, undefined);
  return true;
}

async function playItems(
  items: ReplyItem[],
  start: number,
  generation: number,
  partial: Interrupted['partial'],
  callbacks?: { onEnd?: () => void; onError?: () => void }
): Promise<void> {
  let hadSuccess = false;
  // Synthesize sentence N+1 while sentence N plays so there are no audible gaps.
  let pending: Promise<AudioBuffer | null> = partial ? Promise.resolve(partial.buffer) : synthesize(items[start].text, items[start].emotion);
  for (let i = start; i < items.length; i++) {
    if (currentReply && currentReply.generation === generation) currentReply.index = i;
    const buffer = await pending;
    if (generation !== currentGeneration()) return;
    if (i + 1 < items.length) pending = synthesize(items[i + 1].text, items[i + 1].emotion);
    const offset = i === start && partial ? Math.max(0, partial.offsetSec - RESUME_REWIND_SEC) : 0;
    const ok = buffer
      ? await playBuffer(buffer, generation, offset)
      : await speakWithBrowserVoice(items[i].text, generation);
    if (generation !== currentGeneration()) return;
    if (ok) hadSuccess = true;
  }

  finishPlayback(generation);
  if (currentReply && currentReply.generation === generation) currentReply = null;
  if (hadSuccess) callbacks?.onEnd?.();
  else {
    stopSpeaking('error');
    callbacks?.onError?.();
  }
}

export async function speak(
  rawText: string,
  callbacks?: { onEnd?: () => void; onError?: () => void }
): Promise<void> {
  if (getMutedPreference()) {
    console.info('[voice] speak skipped: voice is muted');
    return;
  }

  // First sentence alone (fast start), later same-emotion sentences are batched into one request to save Gemini quota.
  const sentences = groupForSynthesis(splitIntoSpokenSentences(rawText, 180), 450);
  if (!sentences.length) {
    console.info(`[voice] speak skipped: nothing speakable in ${rawText.length} chars`);
    return;
  }
  console.info(`[voice] speak: ${sentences.length} chunk(s)`);

  const generation = beginPlayback(); // also forgets any older interrupted reply ('new-reply')
  currentReply = { items: sentences, index: 0, resumes: 0, generation };
  await playItems(sentences, 0, generation, null, callbacks);
}

/** Plays one finished clip (for example the Azure test button) through the central player. */
export async function playDataUriOnce(dataUri: string): Promise<boolean> {
  const generation = beginPlayback();
  const buffer = await decodeDataUri(dataUri);
  if (!buffer || generation !== currentGeneration()) return false;
  const ok = await playBuffer(buffer, generation);
  finishPlayback(generation);
  return ok;
}
