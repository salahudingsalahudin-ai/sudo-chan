/**
 * The small desktop-bot window has ONE panel slot at the top. Several features want it at the same time:
 * tool approval, screen-assist consent / countdown / notices / "looking" badge, the Live Talk caption and the old
 * greeting bubble. This pure function decides which single panel is visible; the renderer draws exactly that one and the
 * native window shape (main process) opens exactly that panel's region, so a prompt is never hidden or clipped.
 *
 * Priority (highest first): approval > consent > countdown > notice > capturing > caption > hint > speech.
 * Anything that is not first is "queued": it is still in the app state and appears as soon as the panel above it is
 * gone. A caption never hides an approval or a consent prompt. The "sent" / "old screen" screen hints are folded into
 * the caption as a small chip so they never hide her answer.
 */
export type OverlayPanel = 'approval' | 'consent' | 'countdown' | 'notice' | 'capturing' | 'caption' | 'hint' | 'speech';

export type ScreenStatus = 'consent' | 'countdown' | 'capturing' | 'sent' | 'cached' | 'notice' | null | undefined;

export interface OverlayPanelInput {
  /** A tool approval card is waiting on the desktop bot. */
  approvalPending: boolean;
  screenStatus: ScreenStatus;
  /** There is something to caption: Live Talk text on the desktop bot, or "kaam kar rahi hoon..." while tools run. */
  captionWanted: boolean;
  /** The old greeting/pomodoro bubble has text and Live Talk is not on the desktop bot. */
  speechWanted: boolean;
}

export const PANEL_PRIORITY: readonly OverlayPanel[] = ['approval', 'consent', 'countdown', 'notice', 'capturing', 'caption', 'hint', 'speech'];

/** Share of the window height each panel needs (the native shape opens this much at the top). */
export const PANEL_HEIGHT: Record<OverlayPanel, number> = {
  approval: 0.6,
  consent: 0.52,
  countdown: 0.29,
  notice: 0.45,
  capturing: 0.29,
  caption: 0.29,
  hint: 0.29,
  speech: 0.29,
};

export interface OverlayPanelPlan {
  active: OverlayPanel | null;
  queued: OverlayPanel[];
  /** Screen hint chip shown inside the caption (only when the caption is the active panel). */
  chip: 'sent' | 'cached' | null;
}

export function wantedPanels(input: OverlayPanelInput): OverlayPanel[] {
  const wanted = new Set<OverlayPanel>();
  if (input.approvalPending) wanted.add('approval');
  const s = input.screenStatus;
  if (s === 'consent') wanted.add('consent');
  else if (s === 'countdown') wanted.add('countdown');
  else if (s === 'notice') wanted.add('notice');
  else if (s === 'capturing') wanted.add('capturing');
  else if (s === 'sent' || s === 'cached') wanted.add('hint');
  if (input.captionWanted) wanted.add('caption');
  if (input.speechWanted) wanted.add('speech');
  return PANEL_PRIORITY.filter(panel => wanted.has(panel));
}

export function panelPlan(input: OverlayPanelInput): OverlayPanelPlan {
  const [active = null, ...queued] = wantedPanels(input);
  const chip = active === 'caption' && (input.screenStatus === 'sent' || input.screenStatus === 'cached') ? input.screenStatus : null;
  // The hint is merged into the caption, so it is not "queued" behind it.
  return { active, queued: chip ? queued.filter(panel => panel !== 'hint') : queued, chip };
}

/** Main-process view: derive the same plan from the published app state flags. */
export interface PanelStateFlags {
  approvalVisible?: boolean;
  screenStatus?: ScreenStatus;
  captionVisible?: boolean;
  toolStatus?: 'working' | null;
  speech?: string;
}

export function activePanelForState(state: PanelStateFlags): OverlayPanel | null {
  return panelPlan({
    approvalPending: Boolean(state.approvalVisible),
    screenStatus: state.screenStatus,
    captionWanted: Boolean(state.captionVisible || state.toolStatus),
    speechWanted: Boolean(state.speech),
  }).active;
}

/** What Esc means for the visible panel (a prompt is never confirmed by Esc, only refused or cancelled). */
export function escapeAction(panel: OverlayPanel | null): 'deny-approval' | 'decline-consent' | 'cancel-screen' | null {
  if (panel === 'approval') return 'deny-approval';
  if (panel === 'consent') return 'decline-consent';
  if (panel === 'countdown' || panel === 'capturing') return 'cancel-screen';
  return null;
}
