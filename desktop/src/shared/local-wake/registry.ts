// Engine registry: the only place that knows which wake-word engines exist. Adding one later (a Vosk grammar engine, openWakeWord ONNX,
// a tiny local Whisper on candidate clips) means writing a LocalWakeEngine and calling registerEngine(); nothing else changes.
import { templateEngine } from './template-engine.ts';
import type { LocalWakeDetector, LocalWakeEngine, LocalWakeProfile } from './types.ts';

const engines = new Map<string, LocalWakeEngine>();

export function registerEngine(engine: LocalWakeEngine): void {
  engines.set(engine.id, engine);
}

export function getEngine(id: string): LocalWakeEngine | undefined {
  return engines.get(id);
}

export function listEngines(): LocalWakeEngine[] {
  return [...engines.values()];
}

/** Detector for a stored profile, or undefined when its engine is unknown (e.g. the profile was written by a newer build) or its data is damaged. */
export function createDetector(profile: LocalWakeProfile | undefined): LocalWakeDetector | undefined {
  if (!profile) return undefined;
  const engine = engines.get(profile.engine);
  if (!engine) return undefined;
  try {
    return engine.create(profile.data);
  } catch {
    return undefined;
  }
}

registerEngine(templateEngine);
