/**
 * Level facts about a 16-bit PCM WAV clip (pure). Used by the main process to decide whether an EMPTY transcript of a clip
 * that was clearly speech deserves one second try (see stt-retry.ts), and for the `[STT]` log line.
 */
export interface ClipStats {
  sampleRate: number;
  seconds: number;
  rms: number;
  peak: number;
  /** Milliseconds in 20 ms frames whose own rms is above VOICED_FRAME_RMS. */
  voicedMs: number;
}

export const VOICED_FRAME_RMS = 0.012;
const FRAME_MS = 20;

/** Reads the header (walks the chunks, so extra chunks are fine) and measures the samples. Null for anything that is not 16-bit PCM WAV. */
export function wavClipStats(bytes: Uint8Array): ClipStats | null {
  if (!bytes || bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let sampleRate = 0;
  let channels = 1;
  let bits = 0;
  let dataAt = -1;
  let dataLength = 0;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ' && at + 24 <= bytes.length) {
      channels = view.getUint16(at + 10, true);
      sampleRate = view.getUint32(at + 12, true);
      bits = view.getUint16(at + 22, true);
    } else if (id === 'data') {
      dataAt = at + 8;
      dataLength = Math.min(size, bytes.length - dataAt);
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (dataAt < 0 || bits !== 16 || sampleRate <= 0 || channels < 1) return null;
  const frameSamples = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const total = Math.floor(dataLength / 2 / channels);
  if (total <= 0) return { sampleRate, seconds: 0, rms: 0, peak: 0, voicedMs: 0 };
  let sum = 0;
  let peak = 0;
  let voicedFrames = 0;
  let frameSum = 0;
  let inFrame = 0;
  for (let i = 0; i < total; i++) {
    const v = view.getInt16(dataAt + i * 2 * channels, true) / 32768;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
    frameSum += v * v;
    if (++inFrame === frameSamples) {
      if (Math.sqrt(frameSum / inFrame) >= VOICED_FRAME_RMS) voicedFrames++;
      frameSum = 0;
      inFrame = 0;
    }
  }
  return { sampleRate, seconds: total / sampleRate, rms: Math.sqrt(sum / total), peak, voicedMs: voicedFrames * FRAME_MS };
}
