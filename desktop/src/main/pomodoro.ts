export type PomodoroStatus = 'idle' | 'focus' | 'break';

export interface PomodoroOptions {
  focusMs?: number;
  breakMs?: number;
  onBreak?: (message: string) => void;
  onFocus?: (message: string) => void;
}

export const BREAK_REMINDER_MESSAGE = 'Sid, 25 minutes ho gaye! 5 minute break le lo aur paani pee lo 🍵';
export const FOCUS_RESUME_MESSAGE = 'Break pura hua! Chalein, wapas focus karte hain ✨';

export class PomodoroTimer {
  private status: PomodoroStatus = 'idle';
  private enabled = true;
  private timer?: ReturnType<typeof setTimeout>;
  private phaseStartTime = 0;
  private currentDuration = 0;
  private focusMs: number;
  private readonly breakMs: number;
  private readonly onBreak?: (message: string) => void;
  private readonly onFocus?: (message: string) => void;

  constructor(options?: PomodoroOptions) {
    this.focusMs = options?.focusMs ?? 25 * 60 * 1000;
    this.breakMs = options?.breakMs ?? 5 * 60 * 1000;
    this.onBreak = options?.onBreak;
    this.onFocus = options?.onFocus;
  }

  setDuration(focusMs: number): void {
    this.focusMs = focusMs;
    if (this.status === 'focus') {
      this.currentDuration = focusMs;
      this.phaseStartTime = Date.now();
      this.clear();
      this.timer = setTimeout(() => {
        this.startBreak();
      }, focusMs);
    }
  }

  start(): void {
    if (!this.enabled) return;
    this.clear();
    this.startFocus();
  }

  stop(): void {
    this.clear();
    this.status = 'idle';
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.stop();
    } else if (this.status === 'idle') {
      this.start();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getStatus(): PomodoroStatus {
    return this.status;
  }

  getRemainingMs(): number {
    if (this.status === 'idle' || !this.phaseStartTime) return 0;
    const elapsed = Date.now() - this.phaseStartTime;
    return Math.max(0, this.currentDuration - elapsed);
  }

  getTime(): { status: PomodoroStatus; minutesLeft: number; secondsLeft: number } {
    const ms = this.getRemainingMs();
    const totalSeconds = Math.ceil(ms / 1000);
    const minutesLeft = Math.floor(totalSeconds / 60);
    const secondsLeft = totalSeconds % 60;
    return { status: this.status, minutesLeft, secondsLeft };
  }

  private clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private startFocus(): void {
    this.status = 'focus';
    this.currentDuration = this.focusMs;
    this.phaseStartTime = Date.now();
    this.timer = setTimeout(() => {
      this.startBreak();
    }, this.focusMs);
  }

  private startBreak(): void {
    this.status = 'break';
    this.currentDuration = this.breakMs;
    this.phaseStartTime = Date.now();
    try {
      this.onBreak?.(BREAK_REMINDER_MESSAGE);
    } catch {
      // Prevent callback errors from disrupting timer loop
    }
    this.timer = setTimeout(() => {
      try {
        this.onFocus?.(FOCUS_RESUME_MESSAGE);
      } catch {
        // Prevent callback errors
      }
      this.startFocus();
    }, this.breakMs);
  }
}
