import { levelFromRms } from '../shared/onboarding.ts';

export interface MicProbe {
  /** Releases the microphone. Safe to call more than once. */
  stop(): void;
}

/**
 * The setup wizard's microphone check: opens the mic ONLY because the person pressed a button, and turns what it hears into a 0..1 level
 * for the meter. The audio is analysed in memory and thrown away: nothing is recorded, stored or sent anywhere.
 * Rejects with the original getUserMedia error (its `name` tells "blocked" from "no microphone").
 */
export async function startMicProbe(onLevel: (level: number) => void): Promise<MicProbe> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const read = () => {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    onLevel(levelFromRms(Math.sqrt(sum / data.length)));
  };
  // A timer (not requestAnimationFrame) so the meter keeps moving even when the window is only partly visible.
  timer = setInterval(read, 50);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      try { source.disconnect(); } catch { /* already disconnected */ }
      stream.getTracks().forEach(track => track.stop());
      void ctx.close().catch(() => {});
      onLevel(0);
    },
  };
}
