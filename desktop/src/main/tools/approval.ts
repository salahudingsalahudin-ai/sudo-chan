import type { ApprovalDecision, ToolApprovalRequest } from './types.js';

export const APPROVAL_TIMEOUT_MS = 60_000;

export interface ApprovalDeps {
  /** Show the card to the user. Return false if nothing could display it (the request is then denied). */
  emit: (request: ToolApprovalRequest) => boolean;
  timeoutMs?: number;
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Pending {
  request: ToolApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  timer: unknown;
}

export type ApprovalInput = Omit<ToolApprovalRequest, 'id' | 'expiresInMs'>;

/**
 * Every risky tool call waits here for an explicit click. Nothing is ever approved by default:
 * timeouts, "Stop all", an unreachable window and unknown ids all end as a denial.
 * Voice never reaches this class; only the card's buttons (an IPC call from the chat window) do.
 */
export class ApprovalManager {
  private pending = new Map<string, Pending>();
  private chatAllowed = new Set<string>();
  private deps: ApprovalDeps;
  private counter = 0;

  constructor(deps: ApprovalDeps) {
    this.deps = deps;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  isAllowedForChat(tool: string): boolean {
    return this.chatAllowed.has(tool);
  }

  resetChat() {
    this.chatAllowed.clear();
  }

  request(input: ApprovalInput): Promise<ApprovalDecision> {
    const timeoutMs = this.deps.timeoutMs ?? APPROVAL_TIMEOUT_MS;
    const id = this.deps.newId ? this.deps.newId() : `appr-${Date.now().toString(36)}-${++this.counter}`;
    const request: ToolApprovalRequest = { ...input, id, expiresInMs: timeoutMs };
    return new Promise<ApprovalDecision>(resolve => {
      const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
      const timer = setTimer(() => this.finish(id, 'timeout'), timeoutMs);
      this.pending.set(id, { request, resolve, timer });
      let shown = false;
      try {
        shown = this.deps.emit(request);
      } catch {
        shown = false;
      }
      if (!shown) this.finish(id, 'deny');
    });
  }

  /** Called when the user clicks a button on the card. Returns false for an unknown or already finished id. */
  respond(id: string, decision: unknown): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    if (decision === 'allow') return this.finish(id, 'allow');
    if (decision === 'allow-chat') {
      if (!entry.request.allowForChat) return this.finish(id, 'allow');
      this.chatAllowed.add(entry.request.tool);
      return this.finish(id, 'allow-chat');
    }
    return this.finish(id, 'deny');
  }

  /** Emergency stop: every waiting card is closed as denied. */
  stopAll() {
    for (const id of [...this.pending.keys()]) this.finish(id, 'stopped');
  }

  private finish(id: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    const clear = this.deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    clear(entry.timer);
    entry.resolve(decision);
    return true;
  }
}

export function isApproved(decision: ApprovalDecision): boolean {
  return decision === 'allow' || decision === 'allow-chat';
}
