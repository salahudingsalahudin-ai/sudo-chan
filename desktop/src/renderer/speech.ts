import { detectSentenceLanguage, groupForSynthesis, splitIntoSpokenSentences } from '../shared/speech';
import type { Emotion } from '../shared/speech';
import { beginPlayback, currentGeneration, decodeDataUri, finishPlayback, markSpeechStart, playBuffer, stopSpeaking } from './tts-player';

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

export async function speak(
  rawText: string,
  callbacks?: { onEnd?: () => void; onError?: () => void }
): Promise<void> {
  if (getMutedPreference()) return;

  // First sentence alone (fast start), later same-emotion sentences are batched into one request to save Gemini quota.
  const sentences = groupForSynthesis(splitIntoSpokenSentences(rawText, 180), 450);
  if (!sentences.length) return;

  const generation = beginPlayback();
  let hadSuccess = false;

  // Synthesize sentence N+1 while sentence N plays so there are no audible gaps.
  let pending = synthesize(sentences[0].text, sentences[0].emotion);
  for (let i = 0; i < sentences.length; i++) {
    const buffer = await pending;
    if (generation !== currentGeneration()) return;
    if (i + 1 < sentences.length) pending = synthesize(sentences[i + 1].text, sentences[i + 1].emotion);
    const ok = buffer
      ? await playBuffer(buffer, generation)
      : await speakWithBrowserVoice(sentences[i].text, generation);
    if (generation !== currentGeneration()) return;
    if (ok) hadSuccess = true;
  }

  finishPlayback(generation);
  if (hadSuccess) callbacks?.onEnd?.();
  else {
    stopSpeaking('error');
    callbacks?.onError?.();
  }
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
