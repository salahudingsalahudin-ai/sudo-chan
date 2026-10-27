/**
 * Live Talk as ONE state machine (see desktop/LIVE-TALK-FLOW.md).
 *
 * Modes: OFF (mic closed) / STANDBY (listens only for her name) / LIVE-OVERLAY / LIVE-CHAT.
 * SPEAKING is a sub-state (`speaking`) that can sit on top of any mode.
 *
 * Everything here is pure: no Electron, no DOM, no timers. `transition()` says what a click / wake word / stop word /
 * window close / quit / error does (new state + the effects to run), `runLiveStop()` is the ONE ordered instant-stop
 * sequence both windows use, and the `format*` helpers build the count-only log lines. The renderer and the main process
 * only supply the real side effects.
 */

export type LiveTarget = 'overlay' | 'chat';
export type LiveMode = 'off' | 'standby' | 'live-overlay' | 'live-chat';

/** Why Live Talk ended. Counts only, they go into `[live] stop reason=...`. */
export type LiveStopReason = 'click' | 'stopword' | 'window' | 'quit' | 'error' | 'timeout' | 'switch';
export const LIVE_STOP_REASONS: readonly LiveStopReason[] = ['click', 'stopword', 'window', 'quit', 'error', 'timeout', 'switch'];

export function isLiveStopReason(value: unknown): value is LiveStopReason {
  return typeof value === 'string' && (LIVE_STOP_REASONS as readonly string[]).includes(value);
}

/** How Live Talk began on the overlay: by a click (no time limit) or by her name (the 30 s conversation window applies). */
export type LiveOrigin = 'click' | 'wake';

export interface LiveState {
  /** Who is being talked to right now. Only ONE target can be live at a time. */
  target: LiveTarget | null;
  origin: LiveOrigin | null;
  /** "Listen for my name" (settings.wakeWordEnabled). Live Talk never changes it. */
  standby: boolean;
  /** She is speaking out loud right now (sub-state). */
  speaking: boolean;
}

export const INITIAL_LIVE_STATE: LiveState = { target: null, origin: null, standby: true, speaking: false };

export function liveMode(state: LiveState): LiveMode {
  if (state.target === 'overlay') return 'live-overlay';
  if (state.target === 'chat') return 'live-chat';
  return state.standby ? 'standby' : 'off';
}

export type LiveEvent =
  /** The bot's main talk button on the overlay (toggle). */
  | { type: 'click-bot' }
  /** The small round mic dot while Live Talk is on (it only ends Live Talk; its standby gestures are `standby-set`). */
  | { type: 'click-dot-live' }
  /** The Chat window's own "Live Talk here" mic control. */
  | { type: 'chat-live-here' }
  | { type: 'chat-end' }
  | { type: 'wake-word' }
  /** `busy` = she is speaking, a reply is in flight, or a barge-in just cut her. */
  | { type: 'stop-word'; busy: boolean }
  | { type: 'conversation-timeout' }
  | { type: 'window-closed'; window: 'chat' | 'overlay' }
  | { type: 'app-quit' }
  | { type: 'error' }
  | { type: 'standby-set'; enabled: boolean }
  | { type: 'speech-start' }
  | { type: 'speech-stop' };

/** What the caller must do. `end-live` is always carried out through `runLiveStop` (or its remote twin `runLiveTeardown`). */
export type LiveEffect =
  | { type: 'start-live'; target: LiveTarget; origin: LiveOrigin }
  | { type: 'end-live'; target: LiveTarget; reason: LiveStopReason }
  /** A stop word while she is busy: cut her voice and the reply, Live Talk itself carries on. */
  | { type: 'cut-speech' }
  /** The bot waves hello (visual only: no spoken greeting, no TTS quota). */
  | { type: 'greet' };

export interface LiveTransition {
  state: LiveState;
  effects: LiveEffect[];
  /** True when the event changed nothing (wrong window, mic off, not live...). */
  ignored: boolean;
  /** Set when this transition ended a Live Talk. */
  stopReason?: LiveStopReason;
}

function ignore(state: LiveState): LiveTransition { return { state, effects: [], ignored: true }; }

function end(state: LiveState, reason: LiveStopReason): LiveTransition {
  const target = state.target;
  if (!target) return ignore(state);
  return { state: { ...state, target: null, origin: null, speaking: false }, effects: [{ type: 'end-live', target, reason }], ignored: false, stopReason: reason };
}

function begin(state: LiveState, target: LiveTarget, origin: LiveOrigin): LiveTransition {
  const effects: LiveEffect[] = [];
  let stopReason: LiveStopReason | undefined;
  // Only ONE target at a time: switching ends the other one first, with the same instant stop.
  if (state.target && state.target !== target) { effects.push({ type: 'end-live', target: state.target, reason: 'switch' }); stopReason = 'switch'; }
  if (target === 'overlay') effects.push({ type: 'greet' });
  effects.push({ type: 'start-live', target, origin });
  return { state: { ...state, target, origin, speaking: false }, effects, ignored: false, ...(stopReason ? { stopReason } : {}) };
}

/** The whole table in LIVE-TALK-FLOW.md. Same input, same output: no hidden state. */
export function transition(state: LiveState, event: LiveEvent): LiveTransition {
  switch (event.type) {
    case 'click-bot':
      return state.target === 'overlay' ? end(state, 'click') : begin(state, 'overlay', 'click');
    case 'click-dot-live':
      return state.target ? end(state, 'click') : ignore(state);
    case 'chat-live-here':
      return state.target === 'chat' ? ignore(state) : begin(state, 'chat', 'click');
    case 'chat-end':
      return state.target === 'chat' ? end(state, 'click') : ignore(state);
    case 'wake-word':
      // Only the standby listener hears her name; while Live Talk is on (either target) it is just speech.
      return state.target === null && state.standby ? begin(state, 'overlay', 'wake') : ignore(state);
    case 'stop-word':
      if (event.busy) return state.standby || state.target ? { state: { ...state, speaking: false }, effects: [{ type: 'cut-speech' }], ignored: false } : ignore(state);
      // Idle: in Live Talk "bas" means "we are done"; in standby there is nothing to end.
      return state.target ? end(state, 'stopword') : ignore(state);
    case 'conversation-timeout':
      // The 30 s window belongs to STANDBY (a conversation her name opened). A Live Talk the user started never times out.
      return state.target === 'overlay' && state.origin === 'wake' ? end(state, 'timeout') : ignore(state);
    case 'window-closed':
      return state.target === event.window ? end(state, 'window') : ignore(state);
    case 'app-quit':
      return state.target ? { ...end(state, 'quit'), state: { ...INITIAL_LIVE_STATE, standby: false } } : { state: { ...state, speaking: false, standby: false }, effects: [], ignored: false };
    case 'error':
      return end(state, 'error');
    case 'standby-set':
      return state.standby === event.enabled ? ignore(state) : { state: { ...state, standby: event.enabled }, effects: [], ignored: false };
    case 'speech-start':
      return state.speaking ? ignore(state) : { state: { ...state, speaking: true }, effects: [], ignored: false };
    case 'speech-stop':
      return state.speaking ? { state: { ...state, speaking: false }, effects: [], ignored: false } : ignore(state);
  }
}

/** True when the standby clip uploader (ClipGate, local name check, name matching) must NOT run for this mode. */
export function standbyUploaderPaused(mode: LiveMode): boolean {
  return mode === 'live-overlay' || mode === 'live-chat';
}

/** Only the bot that is being talked to moves its mouth. */
export function lipSyncOn(mode: LiveMode, window: LiveTarget): boolean {
  return (mode === 'live-overlay' && window === 'overlay') || (mode === 'live-chat' && window === 'chat');
}

/** The 30 s conversation-window timer only runs for Live Talk that her name opened. */
export function conversationWindowApplies(state: LiveState): boolean {
  return state.target === 'overlay' && state.origin === 'wake';
}

// ---------------------------------------------------------------- stop words

export type StopWordAction = 'cut' | 'end-live' | 'ignore';

/**
 * A stop command ("ruko", "bas", "chup", "stop"):
 * - she is busy (speaking / replying / just interrupted): cut her voice and the reply, whatever the mode (as today);
 * - Live Talk and she is idle: it means "we are done" and ends Live Talk;
 * - STANDBY and idle: nothing to stop.
 */
export function stopWordAction(input: { mode: LiveMode; busy: boolean }): StopWordAction {
  if (input.mode === 'off') return 'ignore';
  if (input.busy) return 'cut';
  return input.mode === 'standby' ? 'ignore' : 'end-live';
}

// ---------------------------------------------------------------- the instant stop

export interface LiveStopDeps {
  /** tts-player stopSpeaking('stop-button'): the audio is cut NOW (no tail) and speech:stop is emitted exactly once. */
  cutSpeech(): void;
  /** Forget the "resume where she was interrupted" memory: an intentional stop is never replayed. */
  forgetInterrupted(): void;
  /** Drop the half-recorded clip and any speech-to-text request still in flight, so no old words become a new turn. */
  discardPendingStt(): void;
  /** Close the live mic session. Only called when STANDBY is not wanted (otherwise the same mic simply goes back to standby). */
  closeMic(): void;
  /** Abort the cloud reply / stream and pending tools / screenshot flow in the main process. */
  abortReply(): void;
  /** Tell the main process Live Talk is over (publishes the new state and writes `[live] stop reason=...`). */
  setLiveOff(reason: LiveStopReason): void;
}

export const LIVE_STOP_ORDER = ['cutSpeech', 'forgetInterrupted', 'discardPendingStt', 'closeMic', 'abortReply', 'setLiveOff'] as const;

/**
 * Click-to-stop must feel instant: the audio is cut first, synchronously, before any IPC round trip.
 * Returns the steps in the order they ran (tests assert the order).
 */
export function runLiveStop(deps: LiveStopDeps, reason: LiveStopReason, options: { standbyWanted: boolean }): string[] {
  const ran: string[] = [];
  const step = (name: string, fn: () => void) => { ran.push(name); try { fn(); } catch { /* one failing step never blocks the stop */ } };
  step('cutSpeech', () => deps.cutSpeech());
  step('forgetInterrupted', () => deps.forgetInterrupted());
  step('discardPendingStt', () => deps.discardPendingStt());
  if (!options.standbyWanted) step('closeMic', () => deps.closeMic());
  step('abortReply', () => deps.abortReply());
  step('setLiveOff', () => deps.setLiveOff(reason));
  return ran;
}

/** The same cut for a window that only OBSERVES Live Talk ending (the other window, window close, quit): no IPC, idempotent. */
export function runLiveTeardown(deps: Pick<LiveStopDeps, 'cutSpeech' | 'forgetInterrupted' | 'discardPendingStt'>): string[] {
  const ran: string[] = [];
  for (const name of ['cutSpeech', 'forgetInterrupted', 'discardPendingStt'] as const) { ran.push(name); try { deps[name](); } catch { /* keep going */ } }
  return ran;
}

// ---------------------------------------------------------------- log lines (counts only)

export function liveStartLine(target: LiveTarget): string { return `[live] start target=${target}`; }
export function liveStopLine(reason: LiveStopReason): string { return `[live] stop reason=${reason}`; }
