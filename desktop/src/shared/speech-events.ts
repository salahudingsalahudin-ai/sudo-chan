export type StopReason = 'finish' | 'stop-button' | 'barge-in' | 'new-reply' | 'error' | 'mute' | 'window-closed' | 'app-quit';

export type SpeechEvent =
  | { type: 'start'; id: number }
  | { type: 'level'; id: number; level: number }
  | { type: 'stop'; id: number; reason: StopReason };

export const LIP_SYNC_WATCHDOG_MS = 500;

/**
 * Tracks one spoken reply at a time. begin() emits `start`, end() emits `stop`
 * exactly once per utterance no matter how many code paths call it.
 */
export class UtteranceTracker {
  private nextId = 1;
  private activeId: number | null = null;

  private emit: (event: SpeechEvent) => void;

  constructor(emit: (event: SpeechEvent) => void) {
    this.emit = emit;
  }

  get active(): boolean {
    return this.activeId !== null;
  }

  begin(): number {
    if (this.activeId !== null) this.end('new-reply');
    const id = this.nextId++;
    this.activeId = id;
    this.emit({ type: 'start', id });
    return id;
  }

  level(level: number) {
    if (this.activeId === null) return;
    this.emit({ type: 'level', id: this.activeId, level: Math.max(0, Math.min(1, level)) });
  }

  end(reason: StopReason): boolean {
    if (this.activeId === null) return false;
    const id = this.activeId;
    this.activeId = null;
    this.emit({ type: 'stop', id, reason });
    return true;
  }
}

/**
 * Receiving side (overlay / chat widget): mouth state derived ONLY from real
 * output-level events, with a watchdog that closes the mouth when levels stop.
 */
export class LipSyncModel {
  speaking = false;
  level = 0;
  private lastLevelAt = 0;
  private currentId: number | null = null;

  apply(event: SpeechEvent, now: number) {
    if (event.type === 'start') {
      this.currentId = event.id;
      this.speaking = true;
      this.level = 0;
      this.lastLevelAt = now;
    } else if (event.type === 'level') {
      if (this.currentId !== null && event.id !== this.currentId) return;
      this.currentId = event.id;
      this.speaking = true;
      this.level = event.level;
      this.lastLevelAt = now;
    } else if (event.type === 'stop') {
      if (this.currentId !== null && event.id !== this.currentId) return;
      this.close();
    }
  }

  /** Call regularly. Returns true if the watchdog closed the mouth. */
  tick(now: number): boolean {
    if (this.speaking && now - this.lastLevelAt > LIP_SYNC_WATCHDOG_MS) {
      this.close();
      return true;
    }
    return false;
  }

  reset() {
    this.close();
    this.currentId = null;
  }

  private close() {
    this.speaking = false;
    this.level = 0;
  }
}
