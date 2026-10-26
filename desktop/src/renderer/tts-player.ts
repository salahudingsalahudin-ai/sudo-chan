import { UtteranceTracker, type SpeechEvent, type StopReason } from '../shared/speech-events.ts';
import { dataUriToBytes } from '../shared/audio-data.ts';

/**
 * ONE central place that starts and stops spoken audio. Every end path
 * (finish, Stop button, barge-in, new reply, error, mute, window close)
 * goes through stopSpeaking(); speech:start / speech:level / speech:stop
 * are emitted from here only, and level comes from the real output signal.
 */

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let currentResolve: ((played: boolean) => void) | null = null;
let levelTimer: ReturnType<typeof setInterval> | null = null;
let generation = 0;

const LEVEL_INTERVAL_MS = 33;
const levelBuffer = new Float32Array(1024);

function broadcast(event: SpeechEvent) {
  try {
    window.companion?.emitSpeechEvent?.(event);
  } catch {
    // main process may be shutting down
  }
}

const tracker = new UtteranceTracker(broadcast);

function audioContext(): AudioContext {
  if (!ctx || ctx.state === 'closed') {
    ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.connect(ctx.destination);
  }
  return ctx;
}

function startLevelPump() {
  if (levelTimer) return;
  levelTimer = setInterval(() => {
    if (!analyser || !currentSource) return;
    analyser.getFloatTimeDomainData(levelBuffer);
    let sum = 0;
    for (let i = 0; i < levelBuffer.length; i++) sum += levelBuffer[i] * levelBuffer[i];
    tracker.level(Math.sqrt(sum / levelBuffer.length) * 5);
  }, LEVEL_INTERVAL_MS);
}

function stopLevelPump() {
  if (levelTimer) {
    clearInterval(levelTimer);
    levelTimer = null;
  }
}

/** Current playback generation; compare to detect that a newer reply or a stop superseded you. */
export function currentGeneration(): number {
  return generation;
}

/** Claims the player for a new reply. Anything still playing is cut with reason 'new-reply'. */
export function beginPlayback(): number {
  stopSpeaking('new-reply');
  return generation;
}

export function isSpeakingNow(): boolean {
  return tracker.active || currentSource !== null;
}

/** Decode an audio data URI so it can be played with a precise stop and an output level. */
export async function decodeDataUri(dataUri: string): Promise<AudioBuffer | null> {
  const bytes = dataUriToBytes(dataUri);
  if (!bytes) return null;
  try {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return await audioContext().decodeAudioData(copy);
  } catch (error) {
    console.warn('[TTS] decodeAudioData failed:', (error as Error).message);
    return null;
  }
}

/** Plays a decoded buffer. Resolves true if it played to the end, false if stopped or failed. */
export function playBuffer(buffer: AudioBuffer, forGeneration: number): Promise<boolean> {
  if (forGeneration !== generation) return Promise.resolve(false);
  const context = audioContext();
  return new Promise<boolean>(resolve => {
    void context.resume().then(() => {
      if (forGeneration !== generation) return resolve(false);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser!);
      currentSource = source;
      currentResolve = resolve;
      source.onended = () => {
        if (currentSource === source) {
          currentSource = null;
          currentResolve = null;
          resolve(true);
        }
      };
      if (!tracker.active) tracker.begin();
      startLevelPump();
      source.start();
    }).catch(() => resolve(false));
  });
}

/** The speech:start/stop pair for engines without an analyser (browser speechSynthesis fallback). */
export function markSpeechStart() {
  if (!tracker.active) tracker.begin();
}

/** Normal completion of a reply. Idempotent. */
export function finishPlayback(forGeneration: number) {
  if (forGeneration !== generation) return;
  stopLevelPump();
  tracker.end('finish');
}

/** The single stop path. Safe to call any number of times from anywhere. */
export function stopSpeaking(reason: StopReason): void {
  generation++;
  const source = currentSource;
  const resolve = currentResolve;
  currentSource = null;
  currentResolve = null;
  if (source) {
    source.onended = null;
    try { source.stop(); } catch {}
    try { source.disconnect(); } catch {}
  }
  try {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  } catch {}
  stopLevelPump();
  tracker.end(reason);
  resolve?.(false);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => stopSpeaking('window-closed'));
  window.addEventListener('beforeunload', () => stopSpeaking('window-closed'));
}
