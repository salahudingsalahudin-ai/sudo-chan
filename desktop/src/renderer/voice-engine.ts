export interface VoiceProfile {
  id: string;
  timestamp: number;
  sampleDurationSec: number;
  avgPitch: number; // Fundamental voice frequency in Hz (e.g. 110-180 Hz)
  spectralCentroid: number; // Spectral brightness/timbre
  energyDistribution: [number, number, number]; // [bass, mid, treble] ratio
  audioDataUri?: string;
}

const STORAGE_KEY = 'sudo_chan_voice_profile';

export function getVoiceProfile(): VoiceProfile | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveVoiceProfile(profile: VoiceProfile): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {}
}

export function deleteVoiceProfile(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

// High-quality linear resampler to 16 kHz (Whisper's native optimal sample rate)
function downsampleTo16k(samples: Float32Array, sampleRate: number): { samples: Float32Array; sampleRate: number } {
  if (sampleRate <= 16000) return { samples, sampleRate };
  const ratio = sampleRate / 16000;
  const newLength = Math.round(samples.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const base = Math.floor(srcIndex);
    const frac = srcIndex - base;
    const next = Math.min(base + 1, samples.length - 1);
    result[i] = samples[base] * (1 - frac) + samples[next] * frac;
  }
  return { samples: result, sampleRate: 16000 };
}

// Convert audio buffer into standard 16-bit PCM WAV Blob with digital peak normalization
export function encodeWav(rawSamples: Float32Array, rawSampleRate: number): Blob {
  const { samples, sampleRate } = downsampleTo16k(rawSamples, rawSampleRate);
  // Peak normalization: dynamically boost quiet microphones so Whisper hears loud, crisp speech
  let maxPeak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > maxPeak) maxPeak = abs;
  }
  const gain = maxPeak > 0.005 && maxPeak < 0.75 ? Math.min(8.0, 0.85 / maxPeak) : 1.0;

  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  // Write normalized PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] * gain));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: 'audio/wav' });
}

// Auto-correlation based pitch detection for human voice (75Hz - 450Hz)
function autoCorrelate(buf: Float32Array, sampleRate: number): number {
  let rms = 0;
  for (let i = 0; i < buf.length; i++) {
    rms += buf[i] * buf[i];
  }
  rms = Math.sqrt(rms / buf.length);
  if (rms < 0.005) return -1; // Too quiet

  let r1 = 0;
  let r2 = buf.length - 1;
  const thres = 0.2;
  for (let i = 0; i < buf.length / 2; i++) {
    if (Math.abs(buf[i]) < thres) {
      r1 = i;
      break;
    }
  }
  for (let i = 1; i < buf.length / 2; i++) {
    if (Math.abs(buf[buf.length - i]) < thres) {
      r2 = buf.length - i;
      break;
    }
  }

  const sliced = buf.slice(r1, r2);
  const c = new Float32Array(sliced.length);
  for (let i = 0; i < sliced.length; i++) {
    for (let j = 0; j < sliced.length - i; j++) {
      c[i] = c[i] + sliced[j] * sliced[j + i];
    }
  }

  let d = 0;
  while (c[d] > c[d + 1]) d++;
  let maxval = -1;
  let maxpos = -1;
  for (let i = d; i < sliced.length; i++) {
    if (c[i] > maxval) {
      maxval = c[i];
      maxpos = i;
    }
  }
  const T0 = maxpos;
  if (T0 <= 0) return -1;
  return sampleRate / T0;
}

export async function recordVoiceSample(
  durationMs = 5000,
  onProgress?: (secondsRemaining: number) => void
): Promise<{ profile: VoiceProfile; dataUri: string }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  const sampleRate = audioContext.sampleRate;
  const recordedSamples: Float32Array[] = [];

  // Capture audio chunks with ScriptProcessor / AudioWorklet fallback
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const muteGain = audioContext.createGain();
  muteGain.gain.value = 0;
  source.connect(processor);
  processor.connect(muteGain);
  muteGain.connect(audioContext.destination);

  processor.onaudioprocess = e => {
    const input = e.inputBuffer.getChannelData(0);
    recordedSamples.push(new Float32Array(input));
  };

  const timeData = new Float32Array(analyser.fftSize);
  const freqData = new Uint8Array(analyser.frequencyBinCount);

  const pitches: number[] = [];
  let totalCentroid = 0;
  let sampleCount = 0;
  let bassEnergy = 0;
  let midEnergy = 0;
  let highEnergy = 0;

  const startTime = Date.now();
  let remaining = Math.ceil(durationMs / 1000);
  onProgress?.(remaining);

  const intervalId = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const curRemaining = Math.max(0, Math.ceil((durationMs - elapsed) / 1000));
    if (curRemaining !== remaining) {
      remaining = curRemaining;
      onProgress?.(remaining);
    }

    analyser.getFloatTimeDomainData(timeData);
    analyser.getByteFrequencyData(freqData);

    const pitch = autoCorrelate(timeData, sampleRate);
    if (pitch > 70 && pitch < 400) {
      pitches.push(pitch);
    }

    let num = 0;
    let den = 0;
    let b = 0;
    let m = 0;
    let h = 0;
    const binCount = freqData.length;
    for (let i = 0; i < binCount; i++) {
      const val = freqData[i];
      num += i * val;
      den += val;
      if (i < binCount * 0.2) b += val;
      else if (i < binCount * 0.6) m += val;
      else h += val;
    }
    if (den > 0) {
      totalCentroid += num / den;
      sampleCount++;
      bassEnergy += b;
      midEnergy += m;
      highEnergy += h;
    }
  }, 100);

  return new Promise((resolve, reject) => {
    setTimeout(async () => {
      clearInterval(intervalId);
      try {
        processor.disconnect();
        source.disconnect();
        stream.getTracks().forEach(t => t.stop());
        void audioContext.close();

        // Flatten collected audio
        let totalLen = 0;
        for (const chunk of recordedSamples) totalLen += chunk.length;
        const merged = new Float32Array(totalLen);
        let ptr = 0;
        for (const chunk of recordedSamples) {
          merged.set(chunk, ptr);
          ptr += chunk.length;
        }

        const wavBlob = encodeWav(merged, sampleRate);
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUri = reader.result as string;
          const avgPitch = pitches.length
            ? Math.round(pitches.reduce((a, b) => a + b, 0) / pitches.length)
            : 135;
          const avgCentroid = sampleCount ? Math.round(totalCentroid / sampleCount) : 120;
          const totalE = (bassEnergy + midEnergy + highEnergy) || 1;

          const profile: VoiceProfile = {
            id: 'sid-voice-' + Date.now(),
            timestamp: Date.now(),
            sampleDurationSec: Math.round(durationMs / 1000),
            avgPitch,
            spectralCentroid: avgCentroid,
            energyDistribution: [
              Number((bassEnergy / totalE).toFixed(2)),
              Number((midEnergy / totalE).toFixed(2)),
              Number((highEnergy / totalE).toFixed(2)),
            ],
            audioDataUri: dataUri,
          };

          saveVoiceProfile(profile);
          resolve({ profile, dataUri });
        };
        reader.readAsDataURL(wavBlob);
      } catch (err) {
        reject(err);
      }
    }, durationMs);
  });
}

export function isSpeakerMatch(
  current: { pitch?: number; centroid?: number },
  profile: VoiceProfile | null
): boolean {
  if (!profile) return true; // No profile locked, allow
  if (!current.pitch || current.pitch < 65) return false; // If voice profile is locked, strictly require verified voice pitch

  const pitchDiff = Math.abs(current.pitch - profile.avgPitch);
  const pitchRatio = pitchDiff / profile.avgPitch;
  return pitchRatio < 0.38; // Matches within 38% tolerance
}

export function checkWakeIntent(
  transcript: string,
  customWakeWord = 'Sudo-chan'
): { isWake: boolean; isQuestionOrHelp: boolean } {
  const clean = transcript.trim().toLowerCase();
  if (!clean) return { isWake: false, isQuestionOrHelp: false };

  // Custom wake name from settings (e.g. Echo, Jarvis)
  const customEscaped = (customWakeWord || '')
    .trim()
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Strict phonetic variants of Sudo and Sid:
  // Excludes loose English words (like 'seed', 'cid', 'syd', 'sedo') to prevent false triggers!
  const namePatterns = [
    'sudo(?:\\s*chan)?',
    'sido(?:\\s*chan)?',
    'pseudo(?:\\s*chan)?',
    'sudochan',
    'sidochan',
    'sidu',
    'sudu',
    'shudo',
    'sid',
    'sidd',
    'syed',
    'said',
    'سوڈو',
    'سڈ',
    'صدیق',
  ];

  if (customEscaped && !namePatterns.includes(customEscaped)) {
    namePatterns.push(customEscaped);
  }

  const wakePattern = new RegExp(`(?:^|[\\s,.!?()[\\]{}"'\`~;:])(${namePatterns.join('|')})(?:$|[\\s,.!?()[\\]{}"'\`~;:])`, 'i');
  const isWake = wakePattern.test(clean);

  return { isWake, isQuestionOrHelp: isWake };
}

import { BargeInDetector, DEFAULT_BARGE_IN_SENSITIVITY } from '../shared/barge-in.ts';

export interface BargeInInfo {
  /** performance.now() when the user's interrupting speech began */
  speechStartedAt: number;
  /** performance.now() when the detector fired */
  detectedAt: number;
}

export interface VoiceSessionCallbacks {
  isSpeaking?: () => boolean;
  getBargeInSensitivity?: () => number;
  language?: string;
  onInterim?: (text: string) => void;
  onFinal?: (text: string, features?: { pitch?: number; centroid?: number }) => void;
  onAudioLevel?: (level: number) => void;
  onError?: (error: string) => void;
  onBargeIn?: (info?: BargeInInfo) => void;
  /** Return false to drop a finished speech clip without sending it to the cloud (wake-word rate limiting). */
  shouldTranscribe?: () => boolean;
  /** Only the first N ms of a clip is sent. Wake-word listening needs just the name, not a monologue. */
  maxClipMs?: number;
  /** Vocabulary hint for the speech-to-text provider (e.g. the assistant's name and aliases). */
  sttHint?: string;
  onTranscribeResult?: (outcome: 'ok' | 'rate-limited' | 'error') => void;
  /** A finished speech clip produced no usable transcript (not called for clips dropped by shouldTranscribe). */
  onUnclear?: (info: { clipMs: number }) => void;
}

const BARGE_IN_BASE_THRESHOLD = 0.009;
/** Minimum voiced audio (ms) before a clip is sent to speech-to-text. */
const MIN_VOICED_MS = 220;

/**
 * Continuous Voice Activity Detection (VAD) & Instant Speech Recognizer
 * Automatically monitors mic, detects speech bursts, transcribes via Groq Whisper in ~150ms.
 */
export class VoiceSession {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private active = false;
  private isSpeakingSpeech = false;
  private speechChunks: Float32Array[] = [];
  private preRollChunks: Float32Array[] = [];
  private burstPitches: number[] = [];
  /** Milliseconds of actual speech (above threshold) in the current utterance, excluding pre-roll and trailing silence. */
  private voicedMs = 0;
  private silenceTimer: any = null;
  private isProcessingTranscribe = false;
  private callbacks: VoiceSessionCallbacks = {};
  private bargeInDetector = new BargeInDetector({ baseThreshold: BARGE_IN_BASE_THRESHOLD, sensitivity: DEFAULT_BARGE_IN_SENSITIVITY });

  setCallbacks(callbacks: VoiceSessionCallbacks) {
    this.callbacks = callbacks;
  }

  start(callbacks: VoiceSessionCallbacks) {
    if (this.active) {
      this.callbacks = callbacks;
      return;
    }
    this.active = true;
    this.callbacks = callbacks;

    void navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    }).then(stream => {
      if (!this.active) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      this.mediaStream = stream;
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.audioContext = ctx;
      const source = ctx.createMediaStreamSource(stream);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      this.analyser = analyser;
      source.connect(analyser);

      const processor = ctx.createScriptProcessor(1024, 1, 1);
      const muteGain = ctx.createGain();
      muteGain.gain.value = 0;
      this.processor = processor;
      source.connect(processor);
      processor.connect(muteGain);
      muteGain.connect(ctx.destination);

      const sampleRate = ctx.sampleRate;
      const pcmBuffer = new Float32Array(analyser.fftSize);

      processor.onaudioprocess = e => {
        if (!this.active) return;
        const inputData = e.inputBuffer.getChannelData(0);
        const frameMs = (inputData.length / sampleRate) * 1000;
        analyser.getFloatTimeDomainData(pcmBuffer);

        // Calculate Root Mean Square (RMS) volume
        let sum = 0;
        for (let i = 0; i < pcmBuffer.length; i++) {
          sum += pcmBuffer[i] * pcmBuffer[i];
        }
        const rms = Math.sqrt(sum / pcmBuffer.length);
        const normalized = Math.min(1, rms * 18); // 0 to 1 level
        this.callbacks.onAudioLevel?.(normalized);

        // While the bot is speaking: keep mic + pre-roll alive and watch for barge-in only.
        if (this.callbacks.isSpeaking?.()) {
          const now = performance.now();
          this.bargeInDetector.setConfig({
            baseThreshold: BARGE_IN_BASE_THRESHOLD,
            sensitivity: this.callbacks.getBargeInSensitivity?.() ?? DEFAULT_BARGE_IN_SENSITIVITY,
          });
          if (!this.isSpeakingSpeech) {
            this.preRollChunks.push(new Float32Array(inputData));
            // Keep ~400ms of audio so the start of the interruption is not clipped
            const maxChunks = Math.ceil(400 / frameMs);
            while (this.preRollChunks.length > maxChunks) this.preRollChunks.shift();
          }
          if (this.bargeInDetector.feed(rms, frameMs, now)) {
            const speechStartedAt = this.bargeInDetector.speechStartedAt ?? now;
            this.isSpeakingSpeech = true;
            this.speechChunks = [...this.preRollChunks];
            this.preRollChunks = [];
            this.burstPitches = [];
            this.voicedMs = Math.max(0, now - speechStartedAt);
            this.callbacks.onBargeIn?.({ speechStartedAt, detectedAt: now });
            this.callbacks.onInterim?.('🎙️ Sun rahi hoon...');
          }
          // After barge-in the bot is stopped; until isSpeaking() flips we just keep recording below
          if (!this.isSpeakingSpeech) return;
        } else {
          this.bargeInDetector.reset();
        }

        // Sensitive vocal threshold calibrated for natural laptop distance (covers quiet speech 50-70cm from laptop)
        const speechThreshold = 0.009;

        if (rms > speechThreshold) {
          // User is actively speaking
          if (!this.isSpeakingSpeech) {
            this.isSpeakingSpeech = true;
            // Prepend pre-roll audio (~250ms) so first consonants (like "S" in Sudo/Sid) are NEVER clipped
            this.speechChunks = [...this.preRollChunks, new Float32Array(inputData)];
            this.preRollChunks = [];
            this.burstPitches = [];
            this.voicedMs = 0;
            this.callbacks.onInterim?.('🎙️ Sun rahi hoon...');
          } else {
            this.speechChunks.push(new Float32Array(inputData));
          }

          if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
          }

          this.voicedMs += frameMs;

          // Sample pitch during speech burst (covers human voices from 70Hz to 450Hz)
          const pitch = autoCorrelate(pcmBuffer, sampleRate);
          if (pitch > 65 && pitch < 450) {
            this.burstPitches.push(pitch);
          }
        } else if (this.isSpeakingSpeech) {
          // Brief pause after speech started
          this.speechChunks.push(new Float32Array(inputData));

          if (!this.silenceTimer) {
            // Conversational silence timeout (600ms keeps replies snappy while still allowing short natural pauses)
            this.silenceTimer = setTimeout(() => {
              this.silenceTimer = null;
              this.isSpeakingSpeech = false;
              // Clicks, coughs and fan noise produce tiny bursts; every clip sent to the cloud costs ~2 s and
              // blocks real speech while it is processed, so require a minimum of actual voiced audio.
              if (this.voicedMs < MIN_VOICED_MS) {
                this.speechChunks = [];
                this.burstPitches = [];
                this.voicedMs = 0;
              } else if (this.speechChunks.length > 8 && !this.isProcessingTranscribe) {
                const avgPitch = this.burstPitches.length > 0
                  ? Math.round(this.burstPitches.reduce((a, b) => a + b, 0) / this.burstPitches.length)
                  : undefined;
                void this.dispatchTranscription(sampleRate, this.callbacks, avgPitch);
              }
            }, 600);
          }
        } else {
          // Standby background ambient: maintain circular pre-roll buffer (~340ms)
          if (this.preRollChunks.length >= Math.ceil(340 / frameMs)) {
            this.preRollChunks.shift();
          }
          this.preRollChunks.push(new Float32Array(inputData));
        }
      };
    }).catch(err => {
      this.callbacks.onError?.('Microphone access denied: ' + (err as Error).message);
    });
  }

  private async dispatchTranscription(sampleRate: number, callbacks: VoiceSessionCallbacks, burstPitch?: number) {
    this.isProcessingTranscribe = true;
    const spokenMs = Math.round(this.voicedMs);
    this.voicedMs = 0;
    try {
      let total = 0;
      for (const c of this.speechChunks) total += c.length;
      const merged = new Float32Array(total);
      let ptr = 0;
      for (const c of this.speechChunks) {
        merged.set(c, ptr);
        ptr += c.length;
      }
      this.speechChunks = [];
      this.burstPitches = [];

      if (callbacks.shouldTranscribe && !callbacks.shouldTranscribe()) {
        callbacks.onInterim?.('');
        this.isProcessingTranscribe = false;
        return;
      }
      const maxSamples = callbacks.maxClipMs ? Math.floor((callbacks.maxClipMs / 1000) * sampleRate) : 0;
      const clip = maxSamples > 0 && merged.length > maxSamples ? merged.subarray(0, maxSamples) : merged;

      // Length of the actual speech, not of the padded clip: a one-word command is short even with pre-roll and trailing silence.
      const clipMs = spokenMs;
      const wavBlob = encodeWav(clip, sampleRate);
      const reader = new FileReader();
      reader.onloadend = async () => {
        const dataUri = reader.result as string;
        try {
          if (typeof window !== 'undefined' && window.companion?.transcribeAudio) {
            callbacks.onInterim?.('✨ Samajh rahi hoon...');
            const result = await window.companion.transcribeAudio(dataUri, 'audio/wav', callbacks.language, callbacks.sttHint);
            callbacks.onTranscribeResult?.(result.rateLimited ? 'rate-limited' : result.ok || result.error === 'Could not transcribe speech.' ? 'ok' : 'error');
            if (result.ok && result.text) {
              callbacks.onFinal?.(result.text, { pitch: burstPitch });
            } else {
              callbacks.onInterim?.('');
              callbacks.onUnclear?.({ clipMs });
            }
          }
        } catch {
          callbacks.onInterim?.('');
          callbacks.onUnclear?.({ clipMs });
        } finally {
          this.isProcessingTranscribe = false;
        }
      };
      reader.readAsDataURL(wavBlob);
    } catch {
      this.isProcessingTranscribe = false;
    }
  }

  stop() {
    this.active = false;
    this.isSpeakingSpeech = false;
    this.preRollChunks = [];
    this.speechChunks = [];
    this.burstPitches = [];
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
  }
}
