import type { MicSource, Settings } from './types.ts';

/**
 * Pure rules for the desktop bot's microphone switch ("Listen for my name").
 *
 * Why this exists: the mic dot used to sit inside the chat-opening pill and a single stray click turned the microphone
 * off (config.json kept showing wakeWordEnabled=false). Three guards now live here so they can be tested without Electron:
 *  1. the dot gesture (turning ON is one click, turning OFF needs a second click within 3 seconds),
 *  2. Save requests are patches merged onto the CURRENT main-process settings, so a stale Settings form cannot flip the mic,
 *  3. every change of wakeWordEnabled gets one diagnostic log line that names who did it.
 */

export const MIC_SOURCES: readonly MicSource[] = ['dot', 'tray', 'settings', 'chat'];
export const MIC_CONFIRM_MS = 3000;

export function isMicSource(value: unknown): value is MicSource {
  return typeof value === 'string' && (MIC_SOURCES as readonly string[]).includes(value);
}

/**
 * The renderer may claim a source, but the main process only believes a claim that fits the window it came from:
 * the overlay can only be "dot", the Settings window only "settings", the chat only "chat". Anything else falls back to
 * what the window kind implies, or "unknown". The source is for the log line only; it never grants anything.
 */
export function resolveMicSource(claimed: unknown, windowKind: string | undefined): MicSource | 'unknown' {
  const implied: MicSource | undefined = windowKind === 'overlay' ? 'dot' : windowKind === 'settings' ? 'settings' : windowKind === 'chat' ? 'chat' : undefined;
  if (isMicSource(claimed) && claimed !== 'tray' && claimed === implied) return claimed;
  return implied ?? 'unknown';
}

export interface SaveRequest { patch: Record<string, unknown>; source: unknown }

/** The IPC payload is `{ patch, source }`. A bare settings object (older callers, the smoke test) is treated as a patch too. */
export function parseSaveRequest(value: unknown): SaveRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, 'patch')) {
    const patch = record.patch;
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return null;
    return { patch: patch as Record<string, unknown>, source: record.source };
  }
  return { patch: record, source: undefined };
}

/** Fields named in the patch win; everything else is taken from the current value. `undefined` in a patch means "not changed". */
export function mergeSettings(current: Settings, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) merged[key] = value;
  return merged;
}

/** Fields whose value differs from the baseline: what a settings form actually changed. */
export function changedSettings(baseline: Settings, edited: Settings): Partial<Settings> {
  const patch: Record<string, unknown> = {};
  const a = baseline as unknown as Record<string, unknown>;
  const b = edited as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key]) && b[key] !== undefined) patch[key] = b[key];
  }
  return patch as Partial<Settings>;
}

/** The one diagnostic line, or null when the mic switch did not change. A missing value means "on" (the default). */
export function micChangeLine(previous: boolean | undefined, next: boolean | undefined, source: string): string | null {
  const before = previous ?? true, after = next ?? true;
  if (before === after) return null;
  const safe = isMicSource(source) ? source : 'unknown';
  return `[mic] wakeWordEnabled ${before}->${after} source=${safe}`;
}

// ---------------------------------------------------------------- the dot gesture

export type MicDotAction = 'enable' | 'arm' | 'disable' | 'end-live';

export interface MicDotInput {
  wakeEnabled: boolean;
  liveActive: boolean;
  /** When the first "turn off" click happened, or null when nothing is waiting for confirmation. */
  armedAt: number | null;
  now: number;
}

/** Turning ON is one click. Turning OFF is two clicks within 3 s: the first only arms the dot, the second confirms. */
export function micDotPress(input: MicDotInput): { action: MicDotAction; armedAt: number | null } {
  if (input.liveActive) return { action: 'end-live', armedAt: null };
  if (!input.wakeEnabled) return { action: 'enable', armedAt: null };
  if (micDotArmed(input.armedAt, input.now)) return { action: 'disable', armedAt: null };
  return { action: 'arm', armedAt: input.now };
}

export function micDotArmed(armedAt: number | null, now: number): boolean {
  return armedAt !== null && now >= armedAt && now - armedAt <= MIC_CONFIRM_MS;
}

export type MicDotMode = 'listening' | 'armed' | 'live' | 'paused' | 'off';

export interface MicDotView { mode: MicDotMode; title: string }

/** Visual mode and tooltip (also the aria-label) for the dot. Simple English, no jargon. */
export function micDotView(input: { wakeEnabled: boolean; liveActive: boolean; paused: boolean; armed: boolean }): MicDotView {
  if (input.liveActive) return { mode: 'live', title: 'Live Talk is on. Click to end it (the bot does the same).' };
  if (!input.wakeEnabled) return { mode: 'off', title: 'Name standby is OFF. Click to turn it on. Live Talk = the bot.' };
  if (input.armed) return { mode: 'armed', title: 'Click again to turn the mic off.' };
  if (input.paused) return { mode: 'paused', title: 'Resting. The mic is on. To turn it off, click twice.' };
  return { mode: 'listening', title: 'Name standby is ON. Click twice to turn off. Live Talk = the bot.' };
}
