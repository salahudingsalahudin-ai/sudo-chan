import { buildVisionMessages, isNoVisionError, redactForLog, SCREEN_RULES } from '../shared/screen-assist.ts';
import type { PlainMessage, VisionTarget } from '../shared/screen-assist.ts';

/**
 * One screenshot turn. Non-streaming OpenAI-compatible chat completion with an image_url part,
 * trying the active provider first and then other vision-capable providers that have a key.
 * Keys never leave the main process, and the image is never logged (see redactForLog).
 */

export class VisionError extends Error {}

export interface VisionChatInput {
  targets: VisionTarget[];
  /** Base system prompt; the screenshot rules are appended here. */
  system: string;
  history: PlainMessage[];
  fallbackText: string;
  imageDataUri: string;
  maxTokens?: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  log?: (line: string) => void;
}

export interface VisionChatResult { text: string; provider: string; model: string }

const USER_AGENT = 'Sudo-chan-Companion/1.0 (Linux; x86_64)';

export const NO_VISION_MESSAGE =
  'Screen dekhne ke liye image wala (vision) model chahiye. Cloud mode mein Groq (qwen) ya Gemini ki key lagayein, phir dobara try karein. Main bina dekhe screen ke bare mein andaza nahi lagaungi.';

function messageFromBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    const err = parsed.error;
    return typeof err === 'string' ? err : err?.message ?? '';
  } catch {
    return '';
  }
}

export async function runVisionChat(input: VisionChatInput): Promise<VisionChatResult> {
  const doFetch = input.fetchFn ?? fetch;
  const log = input.log ?? (() => {});
  if (!input.targets.length) throw new VisionError(NO_VISION_MESSAGE);
  const messages = buildVisionMessages(`${input.system}\n\n${SCREEN_RULES}`, input.history, input.fallbackText, input.imageDataUri);
  let lastError = '';
  let sawNoVision = false;

  for (const target of input.targets) {
    try {
      const response = await doFetch(target.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: input.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey}`, 'User-Agent': USER_AGENT },
        body: JSON.stringify({ model: target.model, stream: false, temperature: 0.4, max_tokens: input.maxTokens ?? 900, messages }),
      });
      if (response.ok) {
        const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
        const content = payload.choices?.[0]?.message?.content;
        const text = typeof content === 'string' ? content.trim() : '';
        if (text) {
          log(`[Screen] ${target.provider}/${target.model} ok`);
          return { text, provider: target.provider, model: target.model };
        }
        lastError = 'empty reply';
        log(`[Screen] ${target.provider}/${target.model} empty reply`);
        continue;
      }
      const body = await response.text().catch(() => '');
      if (isNoVisionError(response.status, body)) sawNoVision = true;
      lastError = `${response.status} ${messageFromBody(body).slice(0, 120)}`.trim();
      log(`[Screen] ${target.provider}/${target.model} failed: ${response.status}`);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      lastError = 'network error';
      log(`[Screen] ${target.provider}/${target.model} network error`);
    }
  }
  // Never pretend to have seen the screen.
  if (sawNoVision) throw new VisionError(NO_VISION_MESSAGE);
  throw new VisionError(`Screen dekh kar jawab nahi mil saka (${lastError || 'provider error'}). Thori der baad dobara try karein.`);
}

/** Exposed for tests: what would be sent, with the image replaced. */
export function describeVisionPayload(input: Pick<VisionChatInput, 'system' | 'history' | 'fallbackText' | 'imageDataUri'>): unknown {
  return redactForLog(buildVisionMessages(`${input.system}\n\n${SCREEN_RULES}`, input.history, input.fallbackText, input.imageDataUri));
}
