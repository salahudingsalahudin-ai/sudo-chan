import { useEffect, useRef, useState } from 'react';
import { LipSyncModel } from '../shared/speech-events.ts';

/**
 * Mouth state for any window. Driven only by speech:start / speech:level / speech:stop
 * events (real output level from tts-player); a watchdog closes the mouth if levels stop
 * arriving. Returns silence unless a voice session is really active.
 */
export function useLipSync(voiceActive: boolean): { speaking: boolean; level: number } {
  const model = useRef(new LipSyncModel());
  const [view, setView] = useState({ speaking: false, level: 0 });

  useEffect(() => {
    const m = model.current;
    if (!voiceActive) {
      m.reset();
      setView({ speaking: false, level: 0 });
      return;
    }
    const api = window.companion;
    const sync = () => setView(prev => (prev.speaking === m.speaking && Math.abs(prev.level - m.level) < 0.02 ? prev : { speaking: m.speaking, level: m.level }));
    const unsubscribe = api?.onSpeechEvent(event => {
      m.apply(event, performance.now());
      sync();
    });
    const watchdog = setInterval(() => {
      if (m.tick(performance.now())) sync();
    }, 100);
    return () => {
      unsubscribe?.();
      clearInterval(watchdog);
      m.reset();
      setView({ speaking: false, level: 0 });
    };
  }, [voiceActive]);

  return view;
}
