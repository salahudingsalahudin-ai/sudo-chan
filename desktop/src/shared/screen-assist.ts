/**
 * Pure helpers for "screen assist": deciding when a capture is allowed, building the
 * OpenAI-compatible image message, redacting images from logs, and picking vision
 * providers. No Electron or Node APIs here so everything can be unit-tested.
 */

export type ScreenSource = 'wake' | 'button';

export const WAKE_COOLDOWN_MS = 10_000;
export const BUTTON_COOLDOWN_MS = 2_000;
export const MAX_IMAGE_WIDTH = 1280;
export const THUMBNAIL_WIDTH = 220;

export const DEFAULT_SCREEN_PROMPT = 'Meri screen dekho aur batao main kya kar raha hoon. Kaise madad kar sakti ho?';

export interface CaptureDecisionInput {
  enabled: boolean;
  consented: boolean;
  source: ScreenSource;
  now: number;
  /** Timestamp of the previous capture, or null if there was none. */
  lastCaptureAt: number | null;
  /** True while a capture or screen turn is already in flight. */
  busy: boolean;
}

export type CaptureDecision = { capture: true } | { capture: false; reason: 'disabled' | 'no-consent' | 'busy' | 'cooldown' };

/**
 * Wake word / button decision. The renderer already refuses to ask when the voice lock rejected
 * the speaker or listening is paused; main re-checks the setting, consent and cooldown.
 */
export function decideCapture(input: CaptureDecisionInput): CaptureDecision {
  if (!input.enabled) return { capture: false, reason: 'disabled' };
  if (!input.consented) return { capture: false, reason: 'no-consent' };
  if (input.busy) return { capture: false, reason: 'busy' };
  const cooldown = input.source === 'button' ? BUTTON_COOLDOWN_MS : WAKE_COOLDOWN_MS;
  if (input.lastCaptureAt !== null && input.now - input.lastCaptureAt < cooldown) return { capture: false, reason: 'cooldown' };
  return { capture: true };
}

/** Target size that keeps aspect ratio and never upscales. */
export function targetSize(width: number, height: number, maxWidth = MAX_IMAGE_WIDTH): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  if (width <= maxWidth) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxWidth / width;
  return { width: maxWidth, height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Black / blank frame detection on a raw 4-bytes-per-pixel bitmap (BGRA or RGBA, same either way here).
 * A real desktop has variation; a failed Wayland capture is typically one flat colour.
 */
export function isBlankFrame(bitmap: Uint8Array, minStdDev = 4): boolean {
  const pixels = Math.floor(bitmap.length / 4);
  if (pixels === 0) return true;
  const step = Math.max(1, Math.floor(pixels / 4000));
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let p = 0; p < pixels; p += step) {
    const i = p * 4;
    const luma = (bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3;
    sum += luma;
    sumSq += luma * luma;
    n++;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return Math.sqrt(variance) < minStdDev;
}

export type VisionTextPart = { type: 'text'; text: string };
export type VisionImagePart = { type: 'image_url'; image_url: { url: string } };
export interface VisionUserMessage { role: 'user'; content: Array<VisionTextPart | VisionImagePart> }

export function buildImageUserMessage(text: string, imageDataUri: string): VisionUserMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: imageDataUri } },
    ],
  };
}

export interface PlainMessage { role: 'user' | 'assistant' | 'system'; content: string }

/**
 * System prompt + earlier text-only turns + the current turn with the screenshot attached.
 * Only the final user message carries the image; earlier turns never re-send it.
 */
export function buildVisionMessages(system: string, history: PlainMessage[], fallbackText: string, imageDataUri: string): Array<PlainMessage | VisionUserMessage> {
  const lastUserIndex = (() => {
    for (let i = history.length - 1; i >= 0; i--) if (history[i].role === 'user') return i;
    return -1;
  })();
  const earlier = lastUserIndex >= 0 ? history.slice(0, lastUserIndex) : history;
  const text = lastUserIndex >= 0 ? history[lastUserIndex].content : fallbackText;
  return [{ role: 'system', content: system }, ...earlier, buildImageUserMessage(text || fallbackText, imageDataUri)];
}

/** Rules appended to the system prompt on turns that really have a screenshot attached. */
export const SCREEN_RULES = [
  '[SCREENSHOT ATTACHED]',
  'A screenshot of the user\'s screen is attached to THIS message. The user asked you to look at it.',
  '- Describe and use only what is actually visible. Never invent text, errors, file names or app content you cannot read.',
  '- If something is too small, cut off or unreadable, say so and ask the user to zoom in or paste the text.',
  '- Start with one short line on what they seem to be working on, then help with their question (explain the error, suggest the fix, next step).',
  '- Do not read out passwords, tokens, card numbers or other secrets that happen to be visible; tell the user they are visible instead.',
  '- Keep the same language and script as the user\'s message (Roman Urdu in Latin letters, or English).',
].join('\n');

/** Replace image payloads with a placeholder so nothing visual ever reaches a log. */
export function redactForLog(value: unknown): unknown {
  if (typeof value === 'string') return value.startsWith('data:image') ? '[image omitted]' : value;
  if (Array.isArray(value)) return value.map(redactForLog);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) out[key] = redactForLog(v);
    return out;
  }
  return value;
}

export interface VisionTarget {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
}

export interface VisionProviderInfo { endpoint: string; model: string; apiKey: string }

/** Vision-capable defaults. Groq's qwen/qwen3.8-27b accepts images (verified); Gemini flash-lite is the fallback. */
export const VISION_DEFAULT_MODELS: Record<string, string> = {
  groq: 'qwen/qwen3.8-27b',
  gemini: 'gemini-flash-lite-latest',
};

/**
 * Active provider first (with the model the user chose), then any other vision provider that has a key.
 * Providers without a known vision model (e.g. custom endpoints) are only used if they are the active one.
 */
export function pickVisionTargets(active: ({ provider: string } & VisionProviderInfo) | null, others: Record<string, VisionProviderInfo | undefined>): VisionTarget[] {
  const targets: VisionTarget[] = [];
  const seen = new Set<string>();
  const add = (provider: string, info: VisionProviderInfo | undefined, model: string | undefined) => {
    if (!info || !info.apiKey || !info.endpoint || !model) return;
    const id = `${provider}/${model}`;
    if (seen.has(id)) return;
    seen.add(id);
    targets.push({ provider, endpoint: info.endpoint, model, apiKey: info.apiKey });
  };
  if (active) add(active.provider, active, active.model);
  // Then each provider's known vision model (also covers an active provider whose chat model has no vision).
  for (const provider of Object.keys(VISION_DEFAULT_MODELS)) {
    add(provider, others[provider] ?? (active && active.provider === provider ? active : undefined), VISION_DEFAULT_MODELS[provider]);
  }
  return targets;
}

/** Provider error that means "this model cannot take images" rather than a transient problem. */
export function isNoVisionError(status: number, body: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /image|vision|multimodal|modalit|content.*(array|type)|unsupported/i.test(body);
}

/** file:///home/me/Pictures/Screenshot.png -> /home/me/Pictures/Screenshot.png (null for anything else). */
export function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return null;
  }
}
