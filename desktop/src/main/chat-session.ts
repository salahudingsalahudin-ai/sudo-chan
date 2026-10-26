import type { ActionResult, ChatMessage, ChatState } from '../shared/types.js';
import { stripEmotionTags } from '../shared/speech.js';
import { MAX_MESSAGE_LENGTH } from '../shared/validation.js';
import { LocalAI, LocalAIError } from './local-ai.js';
import type { StreamOptions } from './local-ai.js';

export class ChatSession {
  private messages: ChatMessage[] = [];
  private error = '';
  private revision = 0;
  private active?: { controller: AbortController; reply: ChatMessage };
  constructor(private ai: LocalAI, private changed: (state: ChatState) => void) {}
  snapshot(): ChatState { return structuredClone({ messages: this.messages, busy: Boolean(this.active), error: this.error, revision: this.revision }); }
  private publish() { this.revision++; this.changed(this.snapshot()); }
  send(value: unknown, model: string, options?: StreamOptions): ActionResult {
    if (this.active) return { ok: false, error: 'Wait for this reply, or press Stop first.' };
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_MESSAGE_LENGTH) return { ok: false, error: 'Write a message between 1 and 2,000 characters.' };
    const isCloud = options?.mode === 'cloud';
    if (isCloud) {
      if (!options?.cloud?.apiKey) return { ok: false, error: 'Add your Cloud API key in Settings → Local AI first.' };
    } else if (!model) {
      return { ok: false, error: 'Choose a local model in Settings → Local AI first.' };
    }
    this.error = '';
    const reply: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', text: '', status: 'streaming' };
    this.messages.push({ id: crypto.randomUUID(), role: 'user', text: value.trim() }, reply);
    this.messages = this.messages.slice(-100);
    const request = { controller: new AbortController(), reply };
    this.active = request;
    // Bound recent context (voice mode sends last 10 messages for focused spoken responses)
    let remaining = 10_000;
    const historyLimit = options?.voice ? -10 : -20;
    const context = this.messages.filter(message => message !== reply && (message.role === 'user' || message.status === 'complete'))
      .slice(historyLimit).reverse().flatMap(message => {
        if (message.text.length > remaining) { remaining = 0; return []; }
        remaining -= message.text.length;
        return [{ role: message.role, content: message.text }];
      }).reverse();
    this.publish();
    void this.ai.stream(model, context, request.controller.signal, text => {
      if (this.active !== request) return;
      reply.spoken = (reply.spoken ?? '') + text;
      reply.text = stripEmotionTags(reply.spoken); this.publish();
    }, options).then(() => {
      if (this.active === request) reply.status = 'complete';
    }).catch(error => {
      if (this.active !== request) return;
      reply.status = 'error';
      this.error = error instanceof LocalAIError ? error.message : 'The reply could not finish. Please try again.';
    }).finally(() => {
      if (this.active !== request) return;
      this.active = undefined; this.publish();
    });
    return { ok: true };
  }
  stop() {
    if (!this.active) return;
    const request = this.active;
    this.active = undefined; request.reply.status = 'stopped'; request.controller.abort(); this.publish();
  }
  clear() { this.stop(); this.messages = []; this.error = ''; this.publish(); }
}
