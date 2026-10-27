import { describe, expect, it } from 'vitest';
import {
  SCENE_CENTERS,
  SCENE_KEYFRAMES,
  VOICE_DEMO_CYCLE_S,
  chooseRenderer,
  isLowPower,
  sampleJourneyPose,
  sampleStoryWeights,
  sampleVoiceDemo,
  stageDepth,
} from '../lib/heroScene';

const base = { coarsePointer: false, reducedMotion: false, saveData: false, hardwareConcurrency: 8, deviceMemory: 8, webgl: true };

describe('chooseRenderer', () => {
  it('uses WebGL on a capable desktop', () => {
    expect(chooseRenderer(base)).toBe('webgl');
  });
  it.each([
    ['phones and tablets', { coarsePointer: true }],
    ['reduced motion', { reducedMotion: true }],
    ['Save-Data', { saveData: true }],
    ['missing WebGL', { webgl: false }],
    ['2 CPU cores', { hardwareConcurrency: 2 }],
    ['2 GB of memory', { deviceMemory: 2 }],
  ])('falls back to the lightweight bot for %s', (_name, patch) => {
    expect(chooseRenderer({ ...base, ...patch })).toBe('css');
  });
  it('drops post effects on weaker machines', () => {
    expect(isLowPower({ saveData: false, hardwareConcurrency: 4, deviceMemory: 8 })).toBe(true);
    expect(isLowPower({ saveData: false, hardwareConcurrency: 8, deviceMemory: 8 })).toBe(false);
  });
});

describe('journey pose', () => {
  it('hits each keyframe at its scene centre and stays inside the viewport', () => {
    SCENE_CENTERS.forEach((p, i) => {
      const pose = sampleJourneyPose(p);
      expect(pose.side).toBeCloseTo(SCENE_KEYFRAMES[i].side, 5);
      expect(Math.abs(pose.side)).toBeLessThanOrEqual(0.3);
    });
  });
  it('moves smoothly: no jump larger than a few percent per 0.1% of scroll', () => {
    let previous = sampleJourneyPose(0);
    for (let p = 0.001; p <= 1; p += 0.001) {
      const pose = sampleJourneyPose(p);
      expect(Math.abs(pose.side - previous.side)).toBeLessThan(0.02);
      expect(Math.abs(pose.scale - previous.scale)).toBeLessThan(0.02);
      previous = pose;
    }
  });
});

describe('story weights', () => {
  it('shows one explanatory prop per scene and none between scenes', () => {
    expect(sampleStoryWeights(0.02).cards).toBe(1);
    expect(sampleStoryWeights(0.177).voice).toBe(1);
    expect(sampleStoryWeights(0.494).approval).toBe(1);
    expect(sampleStoryWeights(0.652).screen).toBe(1);
    expect(sampleStoryWeights(0.811).lock).toBe(1);
    const join = sampleStoryWeights(0.975);
    expect(Object.values(join).every(w => w === 0)).toBe(true);
  });
});

describe('stage depth', () => {
  it('is light in the hero and join scenes and deep in between', () => {
    expect(stageDepth(0.02)).toBe(0);
    expect(stageDepth(0.4)).toBe(1);
    expect(stageDepth(0.975)).toBe(0);
  });
});

describe('voice demo', () => {
  it('cycles idle, listening, speaking with levels in range', () => {
    const modes = new Set<string>();
    for (let t = 0; t < VOICE_DEMO_CYCLE_S * 2; t += 0.05) {
      const v = sampleVoiceDemo(t);
      modes.add(v.mode);
      expect(v.level).toBeGreaterThanOrEqual(0);
      expect(v.level).toBeLessThanOrEqual(1);
    }
    expect(Array.from(modes).sort()).toEqual(['idle', 'listening', 'speaking']);
  });
  it('is completely still for reduced motion', () => {
    expect(sampleVoiceDemo(4.2, true)).toEqual({ mode: 'idle', listen: 0, speak: 0, level: 0 });
  });
});
