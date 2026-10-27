import { WordEndpointer } from '../shared/local-wake/endpointer.ts';

export interface WordRecording {
  samples: Float32Array;
  sampleRate: number;
  /** 'done' = a word was heard and finished; 'timeout' = nothing was said. */
  outcome: 'done' | 'timeout' | 'cancelled';
}

/**
 * Records ONE spoken word for enrolment or the self-test, with the same mic settings the always-listening pipeline uses
 * (echo cancellation, noise suppression, auto gain), so the stored features look like what it will hear later.
 * The samples live only in the returned array: the caller turns them into feature vectors and drops them. Nothing is written anywhere.
 */
export async function recordWord(onLevel: (level: number) => void, cancelled: () => boolean): Promise<WordRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(2048, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);
  const chunks: Float32Array[] = [];
  const endpointer = new WordEndpointer();
  const sampleRate = ctx.sampleRate;
  return new Promise<WordRecording>(resolve => {
    let finished = false;
    const finish = (outcome: WordRecording['outcome']) => {
      if (finished) return;
      finished = true;
      processor.onaudioprocess = null;
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach(track => track.stop());
      void ctx.close();
      let total = 0;
      for (const chunk of chunks) total += chunk.length;
      const samples = new Float32Array(total);
      let at = 0;
      for (const chunk of chunks) { samples.set(chunk, at); at += chunk.length; }
      onLevel(0);
      resolve({ samples, sampleRate, outcome });
    };
    processor.onaudioprocess = event => {
      if (cancelled()) return finish('cancelled');
      const input = event.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(input));
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      onLevel(Math.min(1, rms * 18));
      const state = endpointer.feed(rms, (input.length / sampleRate) * 1000);
      if (state === 'done' || state === 'timeout') finish(state);
    };
  });
}
