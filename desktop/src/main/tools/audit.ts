import type { ToolStatus } from './types.js';

export interface AuditEntry {
  ts: string;
  tool: string;
  /** Short human summary, never file contents. */
  summary: string;
  decision: string;
  status: ToolStatus;
  detail?: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /gsk_[A-Za-z0-9]{10,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /(api[_-]?key|token|secret|password|passwd|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, key, sep) => (typeof key === 'string' && typeof sep === 'string' ? `${key}${sep}[redacted]` : '[redacted]'));
  }
  return out;
}

export interface AuditDeps {
  /** Appends one line (with trailing newline). Injected so tests need no disk and the app uses an append-only file. */
  append: (line: string) => void;
  now?: () => Date;
}

/** Append-only JSONL audit trail of every tool call. Entries are redacted and size-limited. */
export class AuditLog {
  private deps: AuditDeps;

  constructor(deps: AuditDeps) {
    this.deps = deps;
  }

  record(entry: Omit<AuditEntry, 'ts'>) {
    const full: AuditEntry = {
      ts: (this.deps.now ? this.deps.now() : new Date()).toISOString(),
      tool: entry.tool.slice(0, 40),
      summary: redact(entry.summary).slice(0, 300),
      decision: entry.decision.slice(0, 20),
      status: entry.status,
      detail: entry.detail ? redact(entry.detail).slice(0, 300) : undefined,
    };
    try {
      this.deps.append(JSON.stringify(full) + '\n');
    } catch {
      // The audit log must never break a tool call or the app.
    }
  }
}
