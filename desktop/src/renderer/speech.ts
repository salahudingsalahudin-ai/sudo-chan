import { cleanTextForSpeech } from '../shared/speech';

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

export function stopAudioPlayback(): void {
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
    stopSpeech();
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

export async function speakOnlineStream(text: string): Promise<boolean> {
  try {
    const chunk = text.slice(0, 240).trim();
    if (!chunk) return false;
    // High-quality natural voice audio stream
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=ur&client=tw-ob`;
    stopSpeech();
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

export async function speak(
  rawText: string,
  callbacks?: { onEnd?: () => void; onError?: () => void }
): Promise<void> {
  if (getMutedPreference()) return;

  const textToSpeak = cleanTextForSpeech(rawText);
  if (!textToSpeak) return;

  try {
    if (typeof window !== 'undefined' && window.companion?.setIsSpeaking) {
      void window.companion.setIsSpeaking(true);
    }
  } catch {}

  const handleEnd = () => {
    try {
      if (typeof window !== 'undefined' && window.companion?.setIsSpeaking) {
        void window.companion.setIsSpeaking(false);
      }
    } catch {}
    callbacks?.onEnd?.();
  };

  const handleError = () => {
    try {
      if (typeof window !== 'undefined' && window.companion?.setIsSpeaking) {
        void window.companion.setIsSpeaking(false);
      }
    } catch {}
    callbacks?.onError?.();
  };

  // 1. Try local VoiceStudio cloned voice engine first (if running)
  const vsSpoken = await speakVoiceStudio(textToSpeak).catch(() => false);
  if (vsSpoken) {
    handleEnd();
    return;
  }

  // 2. Direct hardware PulseAudio playback via Main Process
  if (typeof window !== 'undefined' && window.companion?.playSpeech) {
    try {
      const result = await window.companion.playSpeech(textToSpeak);
      if (result.ok) {
        if (result.dataUri) {
          stopAudioPlayback();
          const audio = new Audio(result.dataUri);
          currentAudio = audio;
          audio.onended = () => { if (currentAudio === audio) currentAudio = null; handleEnd(); };
          audio.onerror = () => { if (currentAudio === audio) currentAudio = null; handleError(); };
          audio.play().catch(() => handleEnd());
        } else {
          handleEnd();
        }
        return;
      }
    } catch {}
  }

  // 3. High-quality natural voice audio stream (works instantly on Linux & all platforms)
  const streamSpoken = await speakOnlineStream(textToSpeak).catch(() => false);
  if (streamSpoken) {
    handleEnd();
    return;
  }

  // 4. Fallback to browser speech synthesis
  if (!isSpeechSupported()) {
    handleEnd();
    return;
  }

  stopSpeech();

  try {
    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    currentUtterance = utterance;

    const voice = findBestVoice();
    if (voice) utterance.voice = voice;

    utterance.pitch = 1.08;
    utterance.rate = 1.0;

    utterance.onend = () => {
      currentUtterance = null;
      handleEnd();
    };

    utterance.onerror = () => {
      currentUtterance = null;
      handleError();
    };

    window.speechSynthesis.speak(utterance);
  } catch {
    currentUtterance = null;
    handleError();
  }
}
