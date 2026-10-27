import * as nodeFs from 'node:fs';
import { join } from 'node:path';

/**
 * Permissions for the folder and files that hold API keys: folder 700, files 600 (owner only).
 * Best effort and it never throws or blocks: it only uses synchronous chmod/stat/mkdir, never safeStorage or any child process.
 * On Windows file modes do not work like this, so nothing is attempted there.
 */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export interface HardenFs {
  mkdirSync(path: string, options: { recursive: boolean; mode: number }): unknown;
  chmodSync(path: string, mode: number): void;
  statSync(path: string): { mode: number };
}

export interface HardenReport {
  skipped: boolean;
  /** The folder is 700 now (or already was). */
  dirOk: boolean;
  /** Files whose mode was tightened to 600. */
  fixedFiles: string[];
  /** Files that could not be tightened (still reported, never thrown). */
  failed: string[];
}

export function hardenKeyFiles(dir: string, fileNames: string[], platform: string, fsApi: HardenFs = nodeFs): HardenReport {
  const report: HardenReport = { skipped: false, dirOk: false, fixedFiles: [], failed: [] };
  if (platform === 'win32') return { ...report, skipped: true };
  try {
    fsApi.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    if ((fsApi.statSync(dir).mode & 0o777) !== PRIVATE_DIR_MODE) fsApi.chmodSync(dir, PRIVATE_DIR_MODE);
    report.dirOk = true;
  } catch {
    report.failed.push(dir);
  }
  for (const name of fileNames) {
    const file = join(dir, name);
    try {
      const mode = fsApi.statSync(file).mode & 0o777;
      if (mode !== PRIVATE_FILE_MODE) {
        fsApi.chmodSync(file, PRIVATE_FILE_MODE);
        report.fixedFiles.push(file);
      }
    } catch (error) {
      // A file that does not exist yet is fine (the store creates it with mode 600 on first write).
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') report.failed.push(file);
    }
  }
  return report;
}
