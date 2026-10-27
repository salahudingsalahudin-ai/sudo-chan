import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseProfile } from '../shared/local-wake/enrollment.ts';
import type { LocalWakeProfile } from '../shared/local-wake/types.ts';

/**
 * userData/local-wake.json: the on-device wake word's derived feature vectors (numbers only, never audio), mode 0600.
 * Every read and write goes through parseProfile, so a damaged or hand-edited file is treated as "not enrolled" and never reaches the voice pipeline.
 */
export class LocalWakeFile {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  read(): LocalWakeProfile | undefined {
    try {
      return parseProfile(readFileSync(this.path, 'utf8'));
    } catch {
      return undefined;
    }
  }

  /** Validates, then writes atomically (temp file + rename). Returns false for anything that is not a well-formed profile. */
  write(value: unknown): boolean {
    const profile = parseProfile(value);
    if (!profile) return false;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, JSON.stringify(profile), { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.path);
      return true;
    } catch {
      return false;
    }
  }

  /** "Delete my voice samples": removes the file. True when nothing is left on disk afterwards. */
  delete(): boolean {
    try {
      rmSync(this.path, { force: true });
      rmSync(`${this.path}.tmp`, { force: true });
    } catch {
      /* checked below */
    }
    return !existsSync(this.path);
  }
}
