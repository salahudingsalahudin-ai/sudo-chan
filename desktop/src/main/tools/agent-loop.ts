import type { ToolRuntimeLike } from './types.js';

export const MAX_TOOL_STEPS = 6;
const MAX_CALLS_PER_STEP = 4;

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
  temperature?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called before each tool executes (for logging/UI). */
  onToolCall?: (name: string) => void;
}

interface Choice {
  message?: { content?: unknown; tool_calls?: unknown };
}

function looksLikeToolRejection(status: number, detail: string): boolean {
  return (status === 400 || status === 404 || status === 422) && /tool|function/i.test(detail);
}

async function post(options: LoopOptions, messages: LoopMessage[], withTools: boolean, step: number): Promise<Choice> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: false,
    temperature: options.temperature ?? 0.4,
    max_tokens: options.maxTokens ?? 950,
  };
  if (withTools) {
    body.tools = options.tools.definitions;
    body.tool_choice = 'auto';
  }
  let delay = 2500;
  for (let attempt = 0; ; attempt++) {
    const response = await options.fetchFn(options.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: options.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(body),
    });
    if (response.status === 429 && attempt < 2) {
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (withTools && step === 0 && looksLikeToolRejection(response.status, detail)) throw new ToolsUnsupportedError(detail.slice(0, 200));
      throw new ToolLoopHttpError(response.status, detail);
    }
    const payload = (await response.json().catch(() => null)) as { choices?: Choice[] } | null;
    const choice = payload?.choices?.[0];
    if (!choice) throw new ToolLoopHttpError(0, 'empty');
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
 */
export async function runToolLoop(options: LoopOptions): Promise<{ steps: number; toolCalls: number }> {
  const maxSteps = options.maxSteps ?? MAX_TOOL_STEPS;
  const messages = [...options.messages];
  let toolCalls = 0;

  for (let step = 0; step < maxSteps; step++) {
    const choice = await post(options, messages, true, step);
    const calls = parseCalls(choice.message?.tool_calls);
    const content = typeof choice.message?.content === 'string' ? choice.message.content : '';
    if (!calls.length) {
      if (!content.trim()) throw new ToolLoopHttpError(0, 'empty');
      options.onText(content);
      return { steps: step + 1, toolCalls };
    }
    messages.push({ role: 'assistant', content: content || null, tool_calls: calls });
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
        if (args === undefined) {
          result = 'Error: the arguments were not valid JSON.';
        } else {
          options.onToolCall?.(call.function.name);
          toolCalls++;
          result = await options.tools.execute(call.function.name, args, call.id, options.signal);
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }

  // Step limit reached: ask for a final answer without offering tools.
  messages.push({ role: 'user', content: 'Tool step limit reached. Do not call more tools. Tell the user briefly what was done and what is still pending.' });
  const final = await post(options, messages, false, maxSteps);
  const text = typeof final.message?.content === 'string' ? final.message.content : '';
  options.onText(text.trim() ? text : 'I reached the limit of tool steps for one request. Please ask again to continue.');
  return { steps: maxSteps, toolCalls };
}
