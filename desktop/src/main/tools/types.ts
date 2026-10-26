export type ToolRisk = 'read' | 'write' | 'command' | 'open';

/** OpenAI-compatible function tool definition. */
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** What the user sees on an approval card. */
export interface ToolApprovalRequest {
  id: string;
  tool: string;
  risk: ToolRisk;
  title: string;
  detail: string;
  /** Red warning (sudo, outside the home folder, ...). */
  elevated?: boolean;
  /** Offer "Allow for this chat" (only for open_url). */
  allowForChat?: boolean;
  expiresInMs: number;
}

export type ApprovalDecision = 'allow' | 'allow-chat' | 'deny' | 'timeout' | 'stopped';

export type ToolStatus = 'ok' | 'error' | 'denied' | 'timeout' | 'aborted';

/** Verdict from a policy check: run it, ask first, or refuse. */
export interface Verdict {
  verdict: 'allow' | 'confirm' | 'deny';
  reason?: string;
  elevated?: boolean;
}

/** What the agent loop needs from the tool layer. */
export interface ToolRuntimeLike {
  definitions: ToolDefinition[];
  /** Returns the text fed back to the model. Never throws for expected failures. */
  execute(name: string, args: unknown, callId: string, signal: AbortSignal): Promise<string>;
}
