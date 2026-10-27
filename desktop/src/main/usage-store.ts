import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The usage meter's file (userData/usage.json): counters and reset times only, never a key.
 * Writes are debounced and atomic (temp file + rename), so a crash cannot leave half a file.
 */
export class UsageFile {
  readonly path: string;
  private delayMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: (() => unknown) | undefined;

  constructor(path: string, delayMs = 2000) {
    this.path = path;
    this.delayMs = delayMs;
  }

  /** Parsed file content, or undefined when it is missing or damaged (the meter then starts from zero). */
  read(): unknown {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return undefined;
    }
  }

  /** Asks for a write soon; many changes inside the delay produce one write. */
  schedule(snapshot: () => unknown) {
    this.pending = snapshot;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, this.delayMs);
    this.timer.unref?.();
  }

  /** Writes now if a write is pending (called on quit). Failures are swallowed: the meter is never worth a crash. */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const snapshot = this.pending;
    this.pending = undefined;
    if (!snapshot) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, JSON.stringify(snapshot()), { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.path);
    } catch {
      // Counters are best effort.
    }
  }
}
