import { cleanTextForSpeech, detectSentenceLanguage, splitIntoSentences } from '../shared/speech';

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

let currentAudio: HTMLAudioElement | null = null;
let currentUtterance: SpeechSynthesisUtterance | null = null;
let currentPlaybackId = 0;
let abortPlayback = false;

export function stopAudioPlayback(): void {
  abortPlayback = true;
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
    } catch {}
  }
  if (isSpeechSupported()) {
    try {
      window.speechSynthesis.cancel();
      currentUtterance = null;
    } catch {}
  }
}

export function stopSpeech(): void {
  abortPlayback = true;
  try {
    if (typeof window !== 'undefined' && window.companion?.setIsSpeaking) {
      void window.companion.setIsSpeaking(false);
    }
  } catch {}
  stopAudioPlayback();
}

export async function checkVoiceStudio(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:3900/health', {
      method: 'GET',
      signal: AbortSignal.timeout(1200),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function speakVoiceStudio(text: string): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:3900/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: 'default',
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    return await new Promise<boolean>(resolve => {
      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (currentAudio === audio) currentAudio = null;
        resolve(true);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        if (currentAudio === audio) currentAudio = null;
        resolve(false);
      };
      audio.play().catch(() => resolve(false));
    });
  } catch {
    return false;
  }
}

export async function speakOnlineStream(text: string, lang = 'ur'): Promise<boolean> {
  try {
    if (abortPlayback) return false;
    const clean = text.trim();
    if (!clean) return false;
    // High-quality natural voice audio stream without truncation
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(clean)}&tl=${lang}&client=tw-ob`;
    const audio = new Audio(url);
    currentAudio = audio;
    return await new Promise<boolean>(resolve => {
      audio.onended = () => {
        if (currentAudio === audio) currentAudio = null;
        resolve(true);
      };
      audio.onerror = () => {
        if (currentAudio === audio) currentAudio = null;
        resolve(false);
      };
      audio.play().then(() => resolve(true)).catch(() => resolve(false));
    });
  } catch {
    return false;
  }
}

async function playSingleSentence(sentence: string): Promise<boolean> {
  if (abortPlayback) return false;
  const lang = detectSentenceLanguage(sentence);

  // 1. Direct hardware PulseAudio/PipeWire playback via Main Process
  if (typeof window !== 'undefined' && window.companion?.playSpeech) {
    try {
      const result = await window.companion.playSpeech({ text: sentence, lang });
      if (result.ok) {
        if (result.dataUri) {
          return await new Promise<boolean>(resolve => {
            if (abortPlayback) return resolve(false);
            const audio = new Audio(result.dataUri);
            currentAudio = audio;
            audio.onended = () => {
              if (currentAudio === audio) currentAudio = null;
              resolve(true);
            };
            audio.onerror = () => {
              if (currentAudio === audio) currentAudio = null;
              resolve(false);
            };
            audio.play().catch(() => resolve(false));
          });
        }
        return true;
      }
    } catch {}
  }

  // 2. High-quality natural voice audio stream (works instantly on Linux & all platforms)
  const streamSpoken = await speakOnlineStream(sentence, lang).catch(() => false);
  if (streamSpoken) return true;

  // 3. Fallback to browser speech synthesis
  if (!isSpeechSupported()) return false;

  return await new Promise<boolean>(resolve => {
    try {
      if (abortPlayback) return resolve(false);
      const utterance = new SpeechSynthesisUtterance(sentence);
      currentUtterance = utterance;

      const voice = findBestVoice();
      if (voice) utterance.voice = voice;

      utterance.pitch = 1.08;
      utterance.rate = 1.0;

      utterance.onend = () => {
        currentUtterance = null;
        resolve(true);
      };

      utterance.onerror = () => {
        currentUtterance = null;
        resolve(false);
      };

      window.speechSynthesis.speak(utterance);
    } catch {
      currentUtterance = null;
      resolve(false);
    }
  });
}

export async function speak(
  rawText: string,
  callbacks?: { onEnd?: () => void; onError?: () => void }
): Promise<void> {
  if (getMutedPreference()) return;

  const sentences = splitIntoSentences(rawText, 180);
  if (!sentences.length) return;

  // Stop any active previous speech and increment sequence ID
  stopSpeech();
  abortPlayback = false;
  const playbackId = ++currentPlaybackId;

  try {
    if (typeof window !== 'undefined' && window.companion?.setIsSpeaking) {
      void window.companion.setIsSpeaking(true);
    }
  } catch {}

  let hadSuccess = false;

  for (const sentence of sentences) {
    if (abortPlayback || currentPlaybackId !== playbackId) {
      break;
    }
    const ok = await playSingleSentence(sentence);
    if (ok) hadSuccess = true;
    if (abortPlayback || currentPlaybackId !== playbackId) {
      break;
    }
  }

  if (currentPlaybackId === playbackId) {
    try {
      if (typeof window !== 'undefined' && window.companion?.setIsSpeaking) {
        void window.companion.setIsSpeaking(false);
      }
    } catch {}
    if (hadSuccess) {
      callbacks?.onEnd?.();
    } else {
      callbacks?.onError?.();
    }
  }
}
