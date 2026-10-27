// Pure helpers for the 3D hero and scroll story. No three.js or DOM here, so they stay cheap to import and easy to test.

export const clamp = (n: number, a = 0, b = 1) => Math.min(b, Math.max(a, n));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / Math.max(1e-5, edge1 - edge0));
  return t * t * (3 - 2 * t);
};
export const quintic = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

// Scroll progress (0..1 over the pinned story) at the middle of each of the seven scenes.
export const SCENE_CENTERS = [0.02, 0.177, 0.335, 0.494, 0.652, 0.811, 0.975] as const;

// side is a fraction of the viewport width (positive = right half), so props always stay clear of the text column.
export type SceneKeyframe = { side: number; y: number; scale: number; rotY: number; rotX: number; camZ: number };
export const SCENE_KEYFRAMES: readonly SceneKeyframe[] = [
  { side: 0.28, y: 0.0, scale: 1.0, rotY: -0.2, rotX: 0.0, camZ: 7.0 }, // 01 hello: text left, her right
  { side: -0.255, y: 0.02, scale: 1.04, rotY: 0.24, rotX: -0.02, camZ: 6.8 }, // 02 voice: text right, her left
  { side: 0.255, y: 0.1, scale: 0.94, rotY: -0.22, rotX: 0.02, camZ: 7.0 }, // 03 what she does
  { side: -0.275, y: 0.06, scale: 0.96, rotY: 0.2, rotX: 0.0, camZ: 7.0 }, // 04 tools: approval card
  { side: 0.265, y: 0.1, scale: 0.94, rotY: -0.2, rotX: 0.02, camZ: 7.0 }, // 05 screen help
  { side: -0.265, y: 0.04, scale: 0.96, rotY: 0.2, rotX: 0.0, camZ: 7.0 }, // 06 privacy
  { side: 0.255, y: 0.0, scale: 0.98, rotY: -0.2, rotX: 0.0, camZ: 7.0 }, // 07 coming soon
];

export type JourneyPose = SceneKeyframe & { arc: number };

export function sampleJourneyPose(p: number): JourneyPose {
  const last = SCENE_CENTERS.length - 1;
  if (p <= SCENE_CENTERS[0]) return { ...SCENE_KEYFRAMES[0], arc: 0 };
  if (p >= SCENE_CENTERS[last]) return { ...SCENE_KEYFRAMES[last], arc: 0 };
  let idx = 0;
  for (let i = 0; i < last; i++) {
    if (p >= SCENE_CENTERS[i] && p <= SCENE_CENTERS[i + 1]) { idx = i; break; }
  }
  const span = SCENE_CENTERS[idx + 1] - SCENE_CENTERS[idx];
  const rawT = clamp((p - SCENE_CENTERS[idx]) / span);
  // Hold steady near each scene, then glide with a C2 curve in between.
  const plateau = rawT < 0.16 ? 0 : rawT > 0.84 ? 1 : (rawT - 0.16) / 0.68;
  const u = quintic(plateau);
  const a = SCENE_KEYFRAMES[idx];
  const b = SCENE_KEYFRAMES[idx + 1];
  const arc = Math.sin(u * Math.PI);
  return {
    side: lerp(a.side, b.side, u),
    y: lerp(a.y, b.y, u) + arc * 0.08,
    scale: lerp(a.scale, b.scale, u) - arc * 0.03,
    rotY: lerp(a.rotY, b.rotY, u),
    rotX: lerp(a.rotX, b.rotX, u),
    camZ: lerp(a.camZ, b.camZ, u) + arc * 0.12,
    arc,
  };
}

// A trapezoid window: fades in over [a0, a1], holds, fades out over [b0, b1].
export const windowWeight = (p: number, a0: number, a1: number, b0: number, b1: number) =>
  smoothstep(a0, a1, p) * (1 - smoothstep(b0, b1, p));

export type StoryWeights = { cards: number; voice: number; approval: number; screen: number; lock: number };

// Which story prop is visible at each scroll position (0 = hidden, 1 = fully shown).
export function sampleStoryWeights(p: number): StoryWeights {
  return {
    cards: Math.max(windowWeight(p, -1, -0.5, 0.06, 0.1), windowWeight(p, 0.27, 0.3, 0.385, 0.415)),
    voice: windowWeight(p, 0.1, 0.13, 0.235, 0.265),
    approval: windowWeight(p, 0.43, 0.46, 0.535, 0.57),
    screen: windowWeight(p, 0.585, 0.615, 0.695, 0.73),
    lock: windowWeight(p, 0.745, 0.775, 0.855, 0.89),
  };
}

export type VoiceMode = 'idle' | 'listening' | 'speaking';
export type VoiceDemo = { mode: VoiceMode; listen: number; speak: number; level: number };

// A made-up, repeating "conversation" so the hero feels alive: rest, listen for her name, then answer.
// It is an illustration only. Nothing here reads a microphone.
export const VOICE_DEMO_CYCLE_S = 10;
export function sampleVoiceDemo(t: number, reducedMotion = false): VoiceDemo {
  if (reducedMotion) return { mode: 'idle', listen: 0, speak: 0, level: 0 };
  const c = ((t % VOICE_DEMO_CYCLE_S) + VOICE_DEMO_CYCLE_S) % VOICE_DEMO_CYCLE_S;
  const listen = smoothstep(2.6, 3.0, c) * (1 - smoothstep(5.2, 5.6, c));
  const speak = smoothstep(5.8, 6.1, c) * (1 - smoothstep(9.2, 9.6, c));
  const mode: VoiceMode = speak > 0.5 ? 'speaking' : listen > 0.5 ? 'listening' : 'idle';
  // Layered sines read as syllables; the envelope keeps the ends soft.
  const wobble = 0.5 + 0.5 * Math.sin(t * 9.1) * Math.sin(t * 3.7 + 1.3) * 0.7 + 0.3 * Math.sin(t * 15.3);
  const level = clamp(speak * (0.25 + 0.75 * clamp(wobble)) + listen * 0.32 * (0.4 + 0.6 * clamp(0.5 + 0.5 * Math.sin(t * 6.2) * Math.sin(t * 2.1))));
  return { mode, listen, speak, level };
}

export type RendererEnv = {
  coarsePointer: boolean;
  reducedMotion: boolean;
  saveData: boolean;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  webgl: boolean;
};

// Decides between the full WebGL hero and the lightweight CSS/SVG companion.
export function chooseRenderer(env: RendererEnv): 'webgl' | 'css' {
  if (!env.webgl || env.coarsePointer || env.reducedMotion || env.saveData) return 'css';
  if ((env.hardwareConcurrency ?? 8) <= 2 || (env.deviceMemory ?? 8) <= 2) return 'css';
  return 'webgl';
}

// Quality tier for the WebGL path (post effects and extras are skipped on weaker machines).
export function isLowPower(env: Pick<RendererEnv, 'saveData' | 'hardwareConcurrency' | 'deviceMemory'>, maxTextureSize = 8192) {
  return env.saveData || (env.hardwareConcurrency ?? 8) <= 4 || (env.deviceMemory ?? 8) <= 4 || maxTextureSize <= 4096;
}
