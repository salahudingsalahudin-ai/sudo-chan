import { routeSpeech } from './intent.ts';

/** The two calls a spoken turn can make. `DesktopAPI` satisfies this; tests pass fakes. */
export interface VoiceTurnApi {
  sendScreen(payload: { text?: string; voice?: boolean; source: 'wake' | 'button' }): Promise<{ ok: boolean; handled?: boolean }>;
  sendMessage(text: string, voice?: boolean): Promise<unknown>;
}

/**
 * One finished utterance from the Chat window's own voice call.
 * Same routing as the overlay's Live Talk: it starts the screenshot flow (consent once, countdown, sensitive-window guard,
 * cooldown, all in main) ONLY when screen assist is ON and the words clearly point at the screen. Everything else, and
 * anything unsure, is a plain message. Returns which route was taken. Never captures by itself.
 */
export function runChatVoiceTurn(text: string, screenAssist: boolean, api: VoiceTurnApi | undefined): 'screen' | 'message' | 'ignored' {
  const clean = text.trim();
  if (!clean || !api) return 'ignored';
  if (routeSpeech(clean, { screenAssist, afterWake: false }) === 'screen') {
    // If no screenshot is taken (Local mode, cooldown...), still answer the words, unless the reason was already shown and spoken
    // on the overlay (declined, sensitive window, failed capture).
    void api.sendScreen({ text: clean, source: 'wake' }).then(result => { if (!result.ok && !result.handled) void api.sendMessage(clean, true); }, () => { void api.sendMessage(clean, true); });
    return 'screen';
  }
  void api.sendMessage(clean, true);
  return 'message';
}
