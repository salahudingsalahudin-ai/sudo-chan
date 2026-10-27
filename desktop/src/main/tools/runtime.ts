import type { ApprovalDecision, ToolApprovalRequest, ToolDefinition, ToolRuntimeLike, ToolStatus } from './types.js';
import type { ToolSpec } from './registry.js';

/** The parts of ApprovalManager / AuditLog the runtime needs (kept structural so tests can fake them). */
export interface RuntimeApproval {
  request(input: Omit<ToolApprovalRequest, 'id' | 'expiresInMs'>): Promise<ApprovalDecision>;
  isAllowedForChat(tool: string): boolean;
  stopAll(): void;
}
export interface RuntimeAudit {
  record(entry: { tool: string; summary: string; decision: string; status: ToolStatus; detail?: string }): void;
}

export interface RuntimeOptions {
  specs: ToolSpec[];
  definitions: ToolDefinition[];
  approval: RuntimeApproval;
  audit: RuntimeAudit;
  /** Settings toggle "Let Sudo-chan use tools". */
  isEnabled: () => boolean;
  /** Strips anything that looks like a credential from results before the model sees them. */
  redact?: (text: string) => string;
  /** Number of tools running right now (0 when idle); lets the UI show "working...". */
  onActivity?: (running: number) => void;
}

function approved(decision: ApprovalDecision): boolean {
  return decision === 'allow' || decision === 'allow-chat';
}

/** Runs one tool call: validate -> policy -> (approval) -> execute -> audit. Never throws for expected failures. */
export class ToolRuntime implements ToolRuntimeLike {
  definitions: ToolDefinition[];
  private specs: Map<string, ToolSpec>;
  private options: RuntimeOptions;
  private stop = new AbortController();
  private running = 0;

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.definitions = options.definitions;
    this.specs = new Map(options.specs.map(spec => [spec.name, spec]));
  }

  get activeCommands(): number {
    return this.running;
  }

  /** "Stop all actions": close waiting approval cards and abort anything that is running. */
  stopAll() {
    this.options.approval.stopAll();
    this.stop.abort();
    this.stop = new AbortController();
  }

  async execute(name: string, args: unknown, callId: string, signal: AbortSignal): Promise<string> {
    const clean = (text: string) => (this.options.redact ? this.options.redact(text) : text);
    const audit = this.options.audit;
    if (!this.options.isEnabled()) return 'Error: tools are turned off. The user can enable "Let Sudo-chan use tools" in Settings.';
    const spec = this.specs.get(name);
    if (!spec) return `Error: unknown tool "${name}".`;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Error: tool arguments must be a JSON object.';

    let prepared;
    try {
      prepared = await spec.prepare(args as Record<string, unknown>);
    } catch (error) {
      audit.record({ tool: name, summary: `${name} (call ${callId})`, decision: 'none', status: 'error', detail: (error as Error).message });
      return `Error: ${clean((error as Error).message)}`;
    }
    if ('error' in prepared) {
      audit.record({ tool: name, summary: `${name} (call ${callId})`, decision: 'policy', status: 'denied', detail: prepared.error });
      return `Blocked: ${prepared.error}`;
    }

    let decision: string = 'auto';
    if (prepared.verdict.verdict === 'confirm') {
      if (prepared.allowForChat && this.options.approval.isAllowedForChat(spec.name)) {
        decision = 'allow-chat';
      } else {
        const answer = await this.options.approval.request({
          tool: spec.name,
          risk: spec.risk,
          title: prepared.title,
          detail: prepared.detail,
          elevated: prepared.verdict.elevated,
          allowForChat: prepared.allowForChat,
        });
        decision = answer;
        if (!approved(answer)) {
          const status: ToolStatus = answer === 'timeout' ? 'timeout' : answer === 'stopped' ? 'aborted' : 'denied';
          audit.record({ tool: name, summary: prepared.summary, decision: answer, status });
          return answer === 'timeout'
            ? 'The user did not respond in time, so the action was NOT done.'
            : answer === 'stopped'
              ? 'All actions were stopped by the user. The action was NOT done.'
              : 'The user denied this action. It was NOT done.';
        }
      }
    }

    if (signal.aborted) {
      audit.record({ tool: name, summary: prepared.summary, decision, status: 'aborted' });
      return 'Cancelled before it ran.';
    }
    const combined = AbortSignal.any([signal, this.stop.signal]);
    this.running++;
    this.options.onActivity?.(this.running);
    try {
      const output = await prepared.run(combined);
      const status: ToolStatus = combined.aborted ? 'aborted' : output.startsWith('Error:') ? 'error' : 'ok';
      audit.record({ tool: name, summary: prepared.summary, decision, status });
      return clean(output);
    } catch (error) {
      const message = (error as Error).message ?? 'failed';
      audit.record({ tool: name, summary: prepared.summary, decision, status: combined.aborted ? 'aborted' : 'error', detail: message });
      return `Error: ${clean(message)}`;
    } finally {
      this.running--;
      this.options.onActivity?.(this.running);
    }
  }
}
