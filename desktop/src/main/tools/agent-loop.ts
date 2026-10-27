import type { ToolRuntimeLike } from './types.js';

export const MAX_TOOL_STEPS = 6;
const MAX_CALLS_PER_STEP = 4;
const MAX_RETRY_WAIT_MS = 8000;

/** The provider/model does not accept OpenAI-style `tools`; the caller should fall back to plain chat. */
export class ToolsUnsupportedError extends Error {}

export class ToolLoopHttpError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`Cloud API request failed (${status})`);
    this.status = status;
    this.detail = detail;
  }
}

export interface ToolCallMessage {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface LoopMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCallMessage[];
  tool_call_id?: string;
}

export interface LoopOptions {
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  endpoint: string;
  apiKey: string;
  model: string;
  messages: LoopMessage[];
  tools: ToolRuntimeLike;
  signal: AbortSignal;
  onText: (text: string) => void;
  maxSteps?: number;
  maxTokens?: number;
  /** Larger limit for a request that may have to write a file (see wantsWriteBudget). Not used for plain answers. */
  writeMaxTokens?: number;
  temperature?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called before each tool executes (for logging/UI). */
  onToolCall?: (name: string) => void;
  /** Called after each tool finished with its name, parsed arguments and result text (used for the compact history note). */
  onToolResult?: (name: string, args: unknown, result: string) => void;
  /** Used for the rest of the turn if the main model keeps answering 429 (rate limits are per model). */
  fallbackModel?: string;
  /** Timing hook, one call per model round trip (no content, no secrets). */
  onStep?: (info: { step: number; ms: number; model: string; calls: string[]; status: number }) => void;
  /** Limit per model request. Waiting for the user's approval is never counted. */
  requestTimeoutMs?: number;
}

/** Mutable state shared by all requests of one loop run. */
interface LoopState {
  model: string;
  usedFallback: boolean;
  /** The next request may contain a long write/edit, so it gets the larger max_tokens. */
  writeBudget: boolean;
}

const WRITE_INTENT = /\b(write|create|make|edit|change|modify|fix|update|add|append|replace|rename|rewrite|refactor|save|implement|banao|bana\s?do|banado|likho|likh\s?do|likhdo|badlo|badal|theek\s?kar|thik\s?kar|sahi\s?kar|dalo|daal\s?do|jodo|jod\s?do|hatao|mita\s?do|kar\s?do)\b/i;

/**
 * Plain answers keep the small max_tokens (Groq counts the requested tokens against its tokens-per-minute budget).
 * A request gets the larger one only if the user asked for a change, or a file was just read (an edit usually follows).
 */
export function wantsWriteBudget(lastUserText: string, previousCalls: string[]): boolean {
  return WRITE_INTENT.test(lastUserText) || previousCalls.includes('read_file');
}

interface Choice {
  message?: { content?: unknown; tool_calls?: unknown };
}

function looksLikeToolRejection(status: number, detail: string): boolean {
  return (status === 400 || status === 404 || status === 422) && /tool|function/i.test(detail);
}

/** How long the provider asks us to wait (Retry-After header or "try again in 3.2s" text), clamped to 1-8 s. */
export function retryDelayMs(headerValue: string | null | undefined, bodyText: string, fallbackMs: number): number {
  let ms = Number.NaN;
  const header = headerValue ? Number(headerValue) : Number.NaN;
  if (Number.isFinite(header) && header >= 0) ms = header * 1000;
  if (!Number.isFinite(ms)) {
    const match = /try again in\s+(?:(\d+)m)?\s*(\d+(?:\.\d+)?)(ms|s)/i.exec(bodyText);
    if (match) ms = (match[1] ? Number(match[1]) * 60_000 : 0) + Number(match[2]) * (match[3].toLowerCase() === 'ms' ? 1 : 1000);
  }
  if (!Number.isFinite(ms)) ms = fallbackMs;
  return Math.max(1000, Math.min(MAX_RETRY_WAIT_MS, Math.round(ms)));
}

/** Removes reasoning blocks some models put in the visible text. */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/^\s*<\/think>/i, '')
    .trim();
}

/**
 * Some models write a tool call as text instead of using tool_calls:
 * <tool_call>{"name":..,"arguments":{..}}</tool_call>, a bare JSON object, or a ```json block.
 * Only names of tools that were really offered are accepted.
 */
export function parseTextToolCalls(content: string, toolNames: string[]): { calls: ToolCallMessage[]; rest: string } {
  const names = new Set(toolNames);
  const candidates: string[] = [];
  for (const m of content.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi)) candidates.push(m[1].trim());
  for (const m of content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(m[1].trim());
  const trimmed = content.trim();
  if (/^[[{]/.test(trimmed)) candidates.push(trimmed);
  const calls: ToolCallMessage[] = [];
  for (const text of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      const o = item as { name?: unknown; arguments?: unknown; parameters?: unknown; function?: { name?: unknown; arguments?: unknown } } | null;
      const name = typeof o?.name === 'string' ? o.name : typeof o?.function?.name === 'string' ? o.function.name : '';
      if (!names.has(name)) continue;
      const args = o?.arguments ?? o?.parameters ?? o?.function?.arguments ?? {};
      calls.push({ id: `text_${calls.length}_${Date.now()}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
    }
  }
  if (!calls.length) return { calls, rest: content };
  const rest = content.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').replace(/```(?:json)?[\s\S]*?```/gi, '').trim();
  return { calls, rest: /^[[{]/.test(rest) ? '' : rest };
}

async function post(options: LoopOptions, state: LoopState, messages: LoopMessage[], withTools: boolean, step: number): Promise<Choice> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const started = Date.now();
  let delay = 2500;
  for (let attempt = 0; ; attempt++) {
    const body: Record<string, unknown> = {
      model: state.model,
      messages,
      stream: false,
      temperature: options.temperature ?? 0.4,
      max_tokens: state.writeBudget && options.writeMaxTokens ? Math.max(options.writeMaxTokens, options.maxTokens ?? 950) : (options.maxTokens ?? 950),
    };
    if (withTools) {
      body.tools = options.tools.definitions;
      body.tool_choice = 'auto';
    }
    const response = await options.fetchFn(options.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.requestTimeoutMs ?? 40_000)]),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(body),
    });
    if (response.status === 429) {
      const detail = await response.text().catch(() => '');
      if (attempt < 2) {
        await sleep(retryDelayMs(response.headers?.get?.('retry-after'), detail, delay));
        delay *= 2;
        continue;
      }
      // The main model stays rate limited (Groq counts tokens per minute per model): finish this turn on the fallback model.
      if (options.fallbackModel && !state.usedFallback && state.model !== options.fallbackModel) {
        state.model = options.fallbackModel;
        state.usedFallback = true;
        attempt = -1;
        continue;
      }
      throw new ToolLoopHttpError(429, detail);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (withTools && step === 0 && looksLikeToolRejection(response.status, detail)) throw new ToolsUnsupportedError(detail.slice(0, 200));
      throw new ToolLoopHttpError(response.status, detail);
    }
    const payload = (await response.json().catch(() => null)) as { choices?: Choice[] } | null;
    const choice = payload?.choices?.[0];
    if (!choice) throw new ToolLoopHttpError(0, 'empty');
    const calls = (choice.message?.tool_calls as Array<{ function?: { name?: string } }> | undefined)?.map(c => c.function?.name ?? '?') ?? [];
    options.onStep?.({ step, ms: Date.now() - started, model: state.model, calls, status: response.status });
    return choice;
  }
}

function parseCalls(value: unknown): ToolCallMessage[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCallMessage[] = [];
  for (const item of value) {
    const call = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (!call || typeof call.function?.name !== 'string') continue;
    const args = call.function.arguments;
    calls.push({
      id: typeof call.id === 'string' && call.id ? call.id : `call_${calls.length}_${Date.now()}`,
      type: 'function',
      function: { name: call.function.name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) },
    });
  }
  return calls;
}

/**
 * OpenAI-style tool-calling loop (non-streamed requests; the final answer is delivered through onText).
 * At most `maxSteps` rounds of tool calls per user message. Throws ToolsUnsupportedError if the very first
 * request is rejected because of the tools parameter so the caller can fall back to plain chat.
 * Hardened against what real models do: 429 with Retry-After, <think> blocks, tool calls written as text,
 * malformed arguments (reported back to the model), empty answers after tools, and per-request timeouts.
 */
export async function runToolLoop(options: LoopOptions): Promise<{ steps: number; toolCalls: number }> {
  const maxSteps = options.maxSteps ?? MAX_TOOL_STEPS;
  const messages = [...options.messages];
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const state: LoopState = { model: options.model, usedFallback: false, writeBudget: wantsWriteBudget(userText, []) };
  const toolNames = options.tools.definitions.map(d => d.function.name);
  let toolCalls = 0;

  for (let step = 0; step < maxSteps; step++) {
    const choice = await post(options, state, messages, true, step);
    let calls = parseCalls(choice.message?.tool_calls);
    let content = stripThinking(typeof choice.message?.content === 'string' ? choice.message.content : '');
    if (!calls.length && content) {
      const parsed = parseTextToolCalls(content, toolNames);
      if (parsed.calls.length) {
        calls = parsed.calls;
        content = parsed.rest;
      }
    }
    if (!calls.length) {
      if (!content.trim()) {
        if (toolCalls > 0) {
          options.onText('Maine kaam chala diya, lekin jawab likhte waqt masla aaya. Dobara poochiye to main nateeja bata dungi.');
          return { steps: step + 1, toolCalls };
        }
        throw new ToolLoopHttpError(0, 'empty');
      }
      options.onText(content);
      return { steps: step + 1, toolCalls };
    }
    messages.push({ role: 'assistant', content: content || null, tool_calls: calls });
    const stepCalls = calls.map(c => c.function.name);
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      let result: string;
      if (i >= MAX_CALLS_PER_STEP) {
        result = 'Error: too many tool calls in one step; this one was skipped.';
      } else {
        let args: unknown;
        try {
          args = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = undefined;
        }
        if (args === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) {
          result = 'Error: the arguments were not a valid JSON object. Call the tool again with correct arguments.';
        } else {
          options.onToolCall?.(call.function.name);
          toolCalls++;
          result = await options.tools.execute(call.function.name, args, call.id, options.signal);
          try { options.onToolResult?.(call.function.name, args, result); } catch { /* the history note must never break the turn */ }
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
    state.writeBudget = wantsWriteBudget(userText, stepCalls);
  }

  // Step limit reached: ask for a final answer without offering tools.
  state.writeBudget = false;
  messages.push({ role: 'user', content: 'Tool step limit reached. Do not call more tools. Tell the user briefly what was done and what is still pending.' });
  const final = await post(options, state, messages, false, maxSteps);
  const text = stripThinking(typeof final.message?.content === 'string' ? final.message.content : '');
  options.onText(text.trim() ? text : 'I reached the limit of tool steps for one request. Please ask again to continue.');
  return { steps: maxSteps, toolCalls };
}
