import type { ToolApprovalEvent, ToolApprovalRequest } from './types.js';

/**
 * Pending approval cards as seen by one window. The same list logic is used by the chat window and by the
 * desktop bot, so an answer in one place (which makes main send `close` to both) removes the card in the other.
 */
export function reduceApprovals(list: ToolApprovalRequest[], event: ToolApprovalEvent): ToolApprovalRequest[] {
  if (event.type === 'close') return list.filter(item => item.id !== event.id);
  if (list.some(item => item.id === event.request.id)) return list;
  return [...list, event.request];
}

/** Merges the list pulled from main when a window opens with anything that arrived meanwhile. */
export function mergeApprovals(pulled: ToolApprovalRequest[], current: ToolApprovalRequest[]): ToolApprovalRequest[] {
  const seen = new Set(pulled.map(item => item.id));
  return [...pulled, ...current.filter(item => !seen.has(item.id))];
}

/** One short Roman Urdu line she may SAY when a card appears. Speaking never approves anything. */
export function approvalSpokenLine(request: Pick<ToolApprovalRequest, 'tool' | 'elevated'>): string {
  if (request.elevated) return 'Main ek zaroori command chalana chahti hoon. Screen par dekh kar Allow ya Deny dabayen.';
  switch (request.tool) {
    case 'run_command': return 'Main ek command chalana chahti hoon. Screen par Allow ya Deny dabayen.';
    case 'write_file':
    case 'append_file': return 'Main ek file likhna chahti hoon. Screen par Allow ya Deny dabayen.';
    case 'open_url': return 'Main ek link kholna chahti hoon. Screen par Allow ya Deny dabayen.';
    case 'open_app': return 'Main ek app kholna chahti hoon. Screen par Allow ya Deny dabayen.';
    default: return 'Mujhe aap ki ijazat chahiye. Screen par Allow ya Deny dabayen.';
  }
}

/** Short plain-words text for the compact desktop-bot panel (the exact command or path stays in `detail`). */
export function approvalHeadline(request: Pick<ToolApprovalRequest, 'title' | 'elevated'>): string {
  return `${request.elevated ? '⚠ ' : ''}${request.title}`;
}

export function approvalSecondsLeft(request: Pick<ToolApprovalRequest, 'expiresInMs'>, shownAt: number, now: number): number {
  return Math.max(0, Math.ceil((request.expiresInMs - (now - shownAt)) / 1000));
}

/** What the main process needs from one window to route a card to it. */
export interface ApprovalPort {
  /** The window exists, is not destroyed and is currently shown to the user. */
  visible(): boolean;
  /** The renderer has loaded and can receive events (a fresh window pulls the pending list itself). */
  ready(): boolean;
  send(event: ToolApprovalEvent): void;
}

export interface ApprovalRouterPorts {
  overlay: ApprovalPort | null;
  chat: ApprovalPort | null;
  /** Opens the chat window as a last resort when no window is visible; returns its port. */
  openChat: () => ApprovalPort | null;
}

/**
 * Chooses where a card is shown. The desktop bot is where the user talks, so it gets the card whenever it is visible;
 * the chat window gets it too if it is open. If neither is visible the chat window is opened. Returns false if
 * nothing could show the card (the request is then denied by the approval manager).
 */
export function routeApprovalRequest(request: ToolApprovalRequest, ports: ApprovalRouterPorts): { shown: boolean; overlay: boolean; chat: boolean } {
  let overlay = false;
  let chat = false;
  if (ports.overlay?.visible()) {
    if (ports.overlay.ready()) ports.overlay.send({ type: 'request', request });
    overlay = true;
  }
  if (ports.chat?.visible()) {
    if (ports.chat.ready()) ports.chat.send({ type: 'request', request });
    chat = true;
  }
  if (!overlay && !chat) {
    const opened = ports.openChat();
    if (opened) {
      if (opened.ready()) opened.send({ type: 'request', request });
      chat = true;
    }
  }
  return { shown: overlay || chat, overlay, chat };
}

/** A card finished (answer, timeout, stop): tell every window that has it so it disappears everywhere. */
export function routeApprovalClose(id: string, ports: Pick<ApprovalRouterPorts, 'overlay' | 'chat'>) {
  ports.overlay?.send({ type: 'close', id });
  ports.chat?.send({ type: 'close', id });
}
