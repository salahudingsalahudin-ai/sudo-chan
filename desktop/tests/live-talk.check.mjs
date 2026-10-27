// Live Talk state machine (shared/live-talk.ts): every transition, the one instant-stop sequence (with the REAL tts-player and speech modules under
// fake Web Audio), the single-target rule, standby restore, and static wiring checks on the sources. No microphone, speaker or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  INITIAL_LIVE_STATE, LIVE_STOP_ORDER, LIVE_STOP_REASONS, conversationWindowApplies, isLiveStopReason, lipSyncOn, liveMode, liveStartLine, liveStopLine,
  runLiveStop, runLiveTeardown, standbyUploaderPaused, stopWordAction, transition,
} from '../src/shared/live-talk.ts';

// ---- Fake Web Audio + fake main-process TTS so the REAL tts-player and speech modules run under node ----
const events = [];
const synthCalls = [];
const sources = [];
class FakeSource {
  constructor() { this.onended = null; this.stopped = false; }
  connect() {}
  disconnect() {}
  start() { this.started = true; }
  stop() { this.stopped = true; }
  finish() { const f = this.onended; this.onended = null; f?.(); }
}
class FakeAudioContext {
  constructor() { this.state = 'running'; this.destination = {}; }
  get currentTime() { return 0; }
  createAnalyser() { return { fftSize: 0, connect() {}, getFloatTimeDomainData(buf) { buf.fill(0.1); } }; }
  createBufferSource() { const s = new FakeSource(); sources.push(s); return s; }
  resume() { return Promise.resolve(); }
  async decodeAudioData() { return { duration: 6 }; }
}
globalThis.window = {
  AudioContext: FakeAudioContext,
  addEventListener() {},
  companion: {
    emitSpeechEvent: e => events.push(e),
    playSpeech: async ({ text }) => { synthCalls.push(text); return { ok: true, dataUri: 'data:audio/mp3;base64,AAAA' }; },
  },
};
const player = await import('../src/renderer/tts-player.ts');
const speech = await import('../src/renderer/speech.ts');
test.after(() => { player.stopSpeaking('stop-button'); });
const tick = (ms = 12) => new Promise(r => setTimeout(r, ms));

const S = (over = {}) => ({ ...INITIAL_LIVE_STATE, ...over });
const standby = S();
const off = S({ standby: false });
const liveOverlay = S({ target: 'overlay', origin: 'click' });
const liveOverlayWake = S({ target: 'overlay', origin: 'wake' });
const liveChat = S({ target: 'chat', origin: 'click' });
const effectTypes = t => t.effects.map(e => e.type);
const find = (t, type) => t.effects.find(e => e.type === type);

// ------------------------------------------------------------------ the table, row by row

test('modes: OFF / STANDBY / LIVE-OVERLAY / LIVE-CHAT come from (target, standby) only', () => {
  assert.equal(liveMode(off), 'off');
  assert.equal(liveMode(standby), 'standby');
  assert.equal(liveMode(liveOverlay), 'live-overlay');
  assert.equal(liveMode(liveChat), 'live-chat');
  assert.equal(liveMode(S({ target: 'chat', standby: false })), 'live-chat');
});

test('click on the bot: STANDBY or OFF -> LIVE-OVERLAY at once (greet, start the live mic, no wake word, no dialog)', () => {
  for (const from of [standby, off]) {
    const t = transition(from, { type: 'click-bot' });
    assert.equal(liveMode(t.state), 'live-overlay');
    assert.equal(t.state.origin, 'click');
    assert.deepEqual(effectTypes(t), ['greet', 'start-live']);
    assert.deepEqual(find(t, 'start-live'), { type: 'start-live', target: 'overlay', origin: 'click' });
    assert.equal(t.ignored, false);
  }
});

test('click on the bot again: LIVE-OVERLAY -> STANDBY (or OFF when standby was off), reason=click, one end-live effect', () => {
  const a = transition(liveOverlay, { type: 'click-bot' });
  assert.equal(liveMode(a.state), 'standby');
  assert.deepEqual(a.effects, [{ type: 'end-live', target: 'overlay', reason: 'click' }]);
  assert.equal(a.stopReason, 'click');
  const b = transition(S({ target: 'overlay', origin: 'click', standby: false }), { type: 'click-bot' });
  assert.equal(liveMode(b.state), 'off');
});

test('click on the bot while LIVE-CHAT: switches (the chat ends with reason=switch, the overlay starts); only ONE target at a time', () => {
  const t = transition(liveChat, { type: 'click-bot' });
  assert.equal(liveMode(t.state), 'live-overlay');
  assert.deepEqual(effectTypes(t), ['end-live', 'greet', 'start-live']);
  assert.deepEqual(find(t, 'end-live'), { type: 'end-live', target: 'chat', reason: 'switch' });
  assert.equal(t.stopReason, 'switch');
});

test('Chat "Live Talk here": from any mode -> LIVE-CHAT; from LIVE-OVERLAY it first ends the overlay (switch); a second click is ignored', () => {
  for (const from of [standby, off]) {
    const t = transition(from, { type: 'chat-live-here' });
    assert.equal(liveMode(t.state), 'live-chat');
    assert.deepEqual(effectTypes(t), ['start-live']);
    assert.deepEqual(find(t, 'start-live'), { type: 'start-live', target: 'chat', origin: 'click' });
  }
  const sw = transition(liveOverlay, { type: 'chat-live-here' });
  assert.equal(liveMode(sw.state), 'live-chat');
  assert.deepEqual(effectTypes(sw), ['end-live', 'start-live']);
  assert.deepEqual(find(sw, 'end-live'), { type: 'end-live', target: 'overlay', reason: 'switch' });
  assert.equal(transition(liveChat, { type: 'chat-live-here' }).ignored, true);
});

test('Chat end button: LIVE-CHAT -> STANDBY/OFF (reason=click); ignored when the chat is not the live target', () => {
  const t = transition(liveChat, { type: 'chat-end' });
  assert.equal(liveMode(t.state), 'standby');
  assert.deepEqual(t.effects, [{ type: 'end-live', target: 'chat', reason: 'click' }]);
  assert.equal(transition(liveOverlay, { type: 'chat-end' }).ignored, true);
  assert.equal(transition(standby, { type: 'chat-end' }).ignored, true);
});

test('the round dot while Live Talk is on ends it (same instant stop); outside Live Talk it is not part of this machine', () => {
  assert.equal(liveMode(transition(liveOverlay, { type: 'click-dot-live' }).state), 'standby');
  assert.equal(liveMode(transition(liveChat, { type: 'click-dot-live' }).state), 'standby');
  assert.equal(transition(standby, { type: 'click-dot-live' }).ignored, true);
});

test('wake word: only STANDBY hears it; it opens LIVE-OVERLAY with origin=wake; OFF, LIVE-OVERLAY and LIVE-CHAT ignore it', () => {
  const t = transition(standby, { type: 'wake-word' });
  assert.equal(liveMode(t.state), 'live-overlay');
  assert.equal(t.state.origin, 'wake');
  assert.deepEqual(effectTypes(t), ['greet', 'start-live']);
  for (const from of [off, liveOverlay, liveChat]) assert.equal(transition(from, { type: 'wake-word' }).ignored, true);
});

test('stop words: busy -> cut her voice and the reply, mode unchanged; idle in Live Talk -> ends (reason=stopword); idle in STANDBY/OFF -> nothing', () => {
  for (const from of [liveOverlay, liveChat, standby]) {
    const t = transition(from, { type: 'stop-word', busy: true });
    assert.deepEqual(effectTypes(t), ['cut-speech']);
    assert.equal(liveMode(t.state), liveMode(from));
  }
  assert.equal(transition(off, { type: 'stop-word', busy: true }).ignored, true);
  for (const from of [liveOverlay, liveChat]) {
    const t = transition(from, { type: 'stop-word', busy: false });
    assert.equal(liveMode(t.state), 'standby');
    assert.equal(t.stopReason, 'stopword');
    assert.equal(find(t, 'end-live').reason, 'stopword');
  }
  assert.equal(transition(standby, { type: 'stop-word', busy: false }).ignored, true);
  assert.equal(transition(off, { type: 'stop-word', busy: false }).ignored, true);
  assert.equal(stopWordAction({ mode: 'live-overlay', busy: true }), 'cut');
  assert.equal(stopWordAction({ mode: 'live-chat', busy: false }), 'end-live');
  assert.equal(stopWordAction({ mode: 'standby', busy: false }), 'ignore');
  assert.equal(stopWordAction({ mode: 'standby', busy: true }), 'cut');
  assert.equal(stopWordAction({ mode: 'off', busy: true }), 'ignore');
});

test('the 30 s conversation window: ends ONLY a Live Talk her name opened; a Live Talk the user clicked never times out', () => {
  const t = transition(liveOverlayWake, { type: 'conversation-timeout' });
  assert.equal(liveMode(t.state), 'standby');
  assert.equal(t.stopReason, 'timeout');
  assert.equal(transition(liveOverlay, { type: 'conversation-timeout' }).ignored, true);
  assert.equal(transition(liveChat, { type: 'conversation-timeout' }).ignored, true);
  assert.equal(transition(standby, { type: 'conversation-timeout' }).ignored, true);
  assert.equal(conversationWindowApplies(liveOverlayWake), true);
  assert.equal(conversationWindowApplies(liveOverlay), false);
  assert.equal(conversationWindowApplies(liveChat), false);
});

test('window close: the chat window ends LIVE-CHAT only, the overlay window ends LIVE-OVERLAY only (reason=window)', () => {
  assert.equal(transition(liveChat, { type: 'window-closed', window: 'chat' }).stopReason, 'window');
  assert.equal(transition(liveChat, { type: 'window-closed', window: 'overlay' }).ignored, true);
  assert.equal(transition(liveOverlay, { type: 'window-closed', window: 'overlay' }).stopReason, 'window');
  assert.equal(transition(liveOverlay, { type: 'window-closed', window: 'chat' }).ignored, true);
});

test('app quit ends whatever is live (reason=quit); mic error ends it (reason=error) and returns to STANDBY', () => {
  for (const from of [liveOverlay, liveChat]) {
    const t = transition(from, { type: 'app-quit' });
    assert.equal(t.stopReason, 'quit');
    assert.equal(t.state.target, null);
  }
  const quitIdle = transition(standby, { type: 'app-quit' });
  assert.deepEqual(quitIdle.effects, []);
  const err = transition(liveOverlay, { type: 'error' });
  assert.equal(err.stopReason, 'error');
  assert.equal(liveMode(err.state), 'standby');
  assert.equal(transition(standby, { type: 'error' }).ignored, true);
});

test('standby switch (dot / tray / settings): OFF <-> STANDBY; during Live Talk it only remembers the choice, effects stay empty', () => {
  assert.equal(liveMode(transition(standby, { type: 'standby-set', enabled: false }).state), 'off');
  assert.equal(liveMode(transition(off, { type: 'standby-set', enabled: true }).state), 'standby');
  assert.equal(transition(standby, { type: 'standby-set', enabled: true }).ignored, true);
  const during = transition(liveOverlay, { type: 'standby-set', enabled: false });
  assert.equal(liveMode(during.state), 'live-overlay');
  assert.deepEqual(during.effects, []);
  // ...and when Live Talk ends the remembered choice applies
  assert.equal(liveMode(transition(during.state, { type: 'click-bot' }).state), 'off');
});

test('SPEAKING is a sub-state: it toggles inside any mode and is cleared when Live Talk ends', () => {
  const speaking = transition(liveOverlay, { type: 'speech-start' }).state;
  assert.equal(speaking.speaking, true);
  assert.equal(liveMode(speaking), 'live-overlay');
  assert.equal(transition(speaking, { type: 'speech-start' }).ignored, true);
  assert.equal(transition(speaking, { type: 'speech-stop' }).state.speaking, false);
  assert.equal(transition(speaking, { type: 'click-bot' }).state.speaking, false);
  assert.equal(transition(standby, { type: 'speech-start' }).state.speaking, true);
});

test('A6: Live Talk never flips the standby wish: any sequence of Live Talk events leaves state.standby exactly as it was', () => {
  const live = ['click-bot', 'chat-live-here', 'chat-end', 'wake-word', 'conversation-timeout', 'error', 'click-dot-live'];
  for (const standbyWanted of [true, false]) {
    let state = S({ standby: standbyWanted });
    for (let i = 0; i < 200; i++) {
      const type = live[(i * 7 + (i >> 2)) % live.length];
      state = transition(state, { type }).state;
      state = transition(state, i % 5 === 0 ? { type: 'stop-word', busy: i % 2 === 0 } : { type: 'speech-start' }).state;
      assert.equal(state.standby, standbyWanted);
    }
  }
});

test('A3: at most ONE target is ever live, whatever the event order', () => {
  const kinds = ['click-bot', 'chat-live-here', 'chat-end', 'wake-word', 'error', 'click-dot-live', 'conversation-timeout'];
  let state = standby;
  let live = 0;
  for (let i = 0; i < 500; i++) {
    const t = transition(state, { type: kinds[(i * 5 + (i >> 3)) % kinds.length] });
    const starts = t.effects.filter(e => e.type === 'start-live').length;
    const ends = t.effects.filter(e => e.type === 'end-live').length;
    live += starts - ends;
    assert.ok(live === (t.state.target ? 1 : 0), `live=${live} target=${t.state.target}`);
    state = t.state;
  }
});

test('mode helpers: the standby uploader is paused in both live modes; lip-sync only on the bot being talked to', () => {
  assert.deepEqual(['off', 'standby', 'live-overlay', 'live-chat'].map(standbyUploaderPaused), [false, false, true, true]);
  assert.equal(lipSyncOn('live-overlay', 'overlay'), true);
  assert.equal(lipSyncOn('live-overlay', 'chat'), false);
  assert.equal(lipSyncOn('live-chat', 'chat'), true);
  assert.equal(lipSyncOn('live-chat', 'overlay'), false);
  assert.equal(lipSyncOn('standby', 'overlay'), false);
  assert.equal(lipSyncOn('off', 'chat'), false);
});

test('reasons and log lines: count-only, allow-listed', () => {
  assert.deepEqual([...LIVE_STOP_REASONS].sort(), ['click', 'error', 'quit', 'stopword', 'switch', 'timeout', 'window']);
  assert.equal(isLiveStopReason('click'), true);
  assert.equal(isLiveStopReason('I said so'), false);
  assert.equal(isLiveStopReason(undefined), false);
  assert.equal(liveStartLine('overlay'), '[live] start target=overlay');
  assert.equal(liveStartLine('chat'), '[live] start target=chat');
  assert.equal(liveStopLine('stopword'), '[live] stop reason=stopword');
});

// ------------------------------------------------------------------ instant stop with fakes

function fakeDeps(log, overrides = {}) {
  return {
    cutSpeech: () => log.push('cutSpeech'),
    forgetInterrupted: () => log.push('forgetInterrupted'),
    discardPendingStt: () => log.push('discardPendingStt'),
    closeMic: () => log.push('closeMic'),
    abortReply: () => log.push('abortReply'),
    setLiveOff: reason => log.push(`setLiveOff:${reason}`),
    ...overrides,
  };
}

test('A2: runLiveStop cuts the audio FIRST and in a fixed order; the mic is closed only when standby is not wanted', () => {
  const log = [];
  const ran = runLiveStop(fakeDeps(log), 'click', { standbyWanted: false });
  assert.deepEqual(ran, [...LIVE_STOP_ORDER]);
  assert.deepEqual(log, ['cutSpeech', 'forgetInterrupted', 'discardPendingStt', 'closeMic', 'abortReply', 'setLiveOff:click']);
  const log2 = [];
  runLiveStop(fakeDeps(log2), 'stopword', { standbyWanted: true });
  assert.deepEqual(log2, ['cutSpeech', 'forgetInterrupted', 'discardPendingStt', 'abortReply', 'setLiveOff:stopword']);
  assert.ok(!log2.includes('closeMic'), 'standby keeps its listener');
});

test('a failing step never blocks the stop (the reply is still aborted and the state still goes off)', () => {
  const log = [];
  runLiveStop(fakeDeps(log, { cutSpeech: () => { throw new Error('boom'); }, discardPendingStt: () => { throw new Error('boom'); } }), 'error', { standbyWanted: true });
  assert.deepEqual(log, ['forgetInterrupted', 'abortReply', 'setLiveOff:error']);
});

test('the other window only OBSERVES the end: teardown cuts audio, forgets the interruption, drops the pending clip, and does no IPC', () => {
  const log = [];
  const ran = runLiveTeardown(fakeDeps(log));
  assert.deepEqual(ran, ['cutSpeech', 'forgetInterrupted', 'discardPendingStt']);
  assert.deepEqual(log, ran);
});

test('A2 with the REAL tts-player: the click cuts the audio now, speech:stop is sent exactly once (reason stop-button), the lip-sync closes, and nothing resumes or plays afterwards', async () => {
  player.stopSpeaking('stop-button'); speech.clearInterruptedSpeech();
  events.length = 0; synthCalls.length = 0; sources.length = 0;
  void speech.speak('[warm] First sentence of the answer is here. [calm] Second sentence is a little bit longer than that. [excited] And a third one at the end!');
  await tick();
  assert.equal(player.isSpeakingNow(), true);
  assert.equal(events.filter(e => e.type === 'start').length, 1);
  const first = sources[0];
  const abort = [];
  const ran = runLiveStop({
    cutSpeech: () => player.stopSpeaking('stop-button'),
    forgetInterrupted: speech.clearInterruptedSpeech,
    discardPendingStt: () => {},
    closeMic: () => {},
    abortReply: () => abort.push('abort'),
    setLiveOff: reason => abort.push(`off:${reason}`),
  }, 'click', { standbyWanted: true });
  assert.equal(ran[0], 'cutSpeech');
  // the audio is cut synchronously, before any IPC call could have been answered
  assert.equal(first.stopped, true);
  assert.equal(player.isSpeakingNow(), false);
  const stops = events.filter(e => e.type === 'stop');
  assert.equal(stops.length, 1, 'speech:stop exactly once');
  assert.equal(stops[0].reason, 'stop-button');
  assert.deepEqual(abort, ['abort', 'off:click']);
  // an unclear clip arriving later must not replay anything
  assert.equal(speech.hasInterruptedSpeech(), false);
  assert.equal(speech.resumeInterruptedSpeech(), false);
  // the rest of the reply never starts: let the pending synthesis finish and check no new source plays
  const before = sources.length;
  await tick(30);
  first.finish();
  await tick(30);
  assert.equal(sources.length, before, 'no later sentence was played after the stop');
  assert.equal(player.isSpeakingNow(), false);
  // a second stop is a no-op (no extra speech:stop)
  player.stopSpeaking('stop-button');
  assert.equal(events.filter(e => e.type === 'stop').length, 1);
});

test('a barge-in, then an intentional stop: the interrupted reply is forgotten and cannot be resumed', async () => {
  player.stopSpeaking('stop-button'); speech.clearInterruptedSpeech();
  events.length = 0; sources.length = 0;
  void speech.speak('[warm] One sentence that is long enough to count. [calm] Another sentence that follows the first one closely.');
  await tick();
  player.stopSpeaking('barge-in');
  assert.equal(speech.hasInterruptedSpeech(), true);
  runLiveStop({ cutSpeech: () => player.stopSpeaking('stop-button'), forgetInterrupted: speech.clearInterruptedSpeech, discardPendingStt: () => {}, closeMic: () => {}, abortReply: () => {}, setLiveOff: () => {} }, 'click', { standbyWanted: true });
  assert.equal(speech.hasInterruptedSpeech(), false);
  assert.equal(speech.resumeInterruptedSpeech(), false);
});

// ------------------------------------------------------------------ wiring (reads the sources, comments stripped)

const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const read = file => strip(readFileSync(new URL(file, import.meta.url), 'utf8'));
const app = read('../src/renderer/App.tsx');
const main = read('../src/main/index.ts');

test('wiring A1: the bot (body, orb and antenna) is THE Live Talk button; no double-click handler can toggle it twice', () => {
  assert.match(app, /onClick=\{toggleOverlayLive\}/);
  assert.match(app, /onToggleVoice=\{toggleOverlayLive\}/);
  assert.doesNotMatch(app, /onDoubleClick/);
  const toggle = /const toggleOverlayLive = \(\) => \{([\s\S]*?)\n  \};/.exec(app)?.[1] ?? '';
  assert.match(toggle, /endOverlayLive\('click'\)/);
  assert.match(toggle, /setVoiceActive\(true, 'overlay'\)/);
  // starting needs no wake word, no consent dialog and no timer
  assert.doesNotMatch(toggle, /consent|wakeWindow|sendScreen|matchWakeWord/i);
  assert.match(toggle, /wakeOpened\.current = false/);
});

test('wiring A2: every way of ending Live Talk on the bot goes through runLiveStop (click, dot, stop word, timeout, mic error)', () => {
  for (const reason of ['click', 'stopword', 'timeout', 'error']) assert.match(app, new RegExp(`endOverlayLive\\('${reason}'\\)`), reason);
  assert.match(app, /pressMicDot[\s\S]*?result\.action === 'end-live'\) endOverlayLive\('click'\)/);
  // no leftover bare "end it" call that would skip the audio cut
  assert.doesNotMatch(app, /setVoiceActive\(false\)/);
  assert.match(app, /cutSpeech: \(\) => stopSpeaking\('stop-button'\)/);
  assert.match(app, /discardPendingStt: \(\) => overlaySessionRef\.current\?\.cancelPending\(\)/);
});

test('wiring A3: typing never opens the mic; the Voice button and Ctrl+M are the only ways to start Live Talk in the chat; ending uses the same instant stop', () => {
  // the chat's mic session exists only while the chat is the live target
  const effect = /useEffect\(\(\) => \{\n    if \(!isVoiceMode\) \{[\s\S]*?new VoiceSession\(\)/.exec(app)?.[0] ?? '';
  assert.ok(effect.length > 0, 'the chat voice effect returns early unless isVoiceMode');
  assert.equal((app.match(/setVoiceActive\(true, 'chat'\)/g) ?? []).length, 1, 'one start path for the chat');
  assert.match(app, /const startChatLive = \(\) => \{[\s\S]*?setVoiceActive\(true, 'chat'\)/);
  assert.match(app, /onClick=\{startChatLive\}/);
  assert.match(app, /aria-label="Live Talk here"/);
  assert.match(app, /endChatLive\('click'\)/);
  assert.match(app, /endChatLive\('stopword'\)/);
  assert.match(app, /endChatLive\('error'\)/);
  // the old header icon that duplicated the start button is gone
  assert.doesNotMatch(app, /Start Sudo Live Talk/);
});

test('wiring A3: lip-sync and captions follow only the live target', () => {
  assert.match(app, /useLipSync\(state\.voiceActiveTarget === 'overlay'\)/);
  assert.match(app, /useLipSync\(state\.voiceActiveTarget === 'chat'\)/);
  // the overlay speaks replies only while it is the target; the chat window does not speak while the overlay is
  assert.match(app, /if \(!api \|\| state\.voiceActiveTarget !== 'overlay'\) return;/);
  assert.match(app, /if \(state\.voiceActiveTarget === 'overlay'\) return;/);
});

test('wiring A4: Live Talk answers every utterance; the 30 s window timer runs only for a Live Talk her name opened', () => {
  assert.match(app, /if \(!wakeOpened\.current\) return;/);
  assert.match(app, /decideWakeClip\(\{ features, local, live: isOverlayVoiceActiveRef\.current/);
});

test('wiring A6/A7: main has ONE place that starts, ends and switches Live Talk; stops abort reply, tools, screenshot; a late end from the wrong window is ignored', () => {
  assert.match(main, /function setLiveTarget\(target: 'overlay' \| 'chat' \| null, reason: LiveStopReason = 'click'\)/);
  const body = /function setLiveTarget[\s\S]*?\n\}\n/.exec(main)?.[0] ?? '';
  assert.match(body, /liveStopLine\(target \? 'switch' : reason\)/);
  assert.match(body, /liveStartLine\(target\)/);
  assert.match(body, /cancelScreenCapture\(\)/);
  assert.match(body, /conversation\.stop\(\)/);
  assert.match(body, /stopAllTools\(\)/);
  assert.match(body, /awareness\.end\(\)/);
  const handler = /handle\(CHANNELS\.setVoiceActive[\s\S]*?\n  \}, \['overlay', 'chat'\]\);/.exec(main)?.[0] ?? '';
  assert.ok(handler.length > 0, 'setVoiceActive is restricted to the overlay and chat windows');
  assert.match(handler, /requested === state\.voiceActiveTarget/);
  assert.match(handler, /isLiveStopReason\(p\.reason\)/);
  // window close / hide, and quit
  assert.match(main, /setLiveTarget\(null, 'window'\)/);
  assert.match(main, /setLiveTarget\(null, 'quit'\)/);
  // the temporary hide for a screenshot does not end Live Talk
  assert.match(main, /captureHidden\.has\(chat!\)/);
  // the chat stays up while Live Talk is on in it
  assert.match(main, /chat\.on\('blur', \(\) => \{ if \(state\.voiceActiveTarget !== 'chat'\) chat\?\.hide\(\); \}\)/);
  // wakeWordEnabled is only ever changed by saveSettings (patch based), never by Live Talk
  assert.doesNotMatch(body, /wakeWordEnabled/);
});

test('wiring A8: the three count-only [live] log lines exist and carry no text', () => {
  assert.match(strip(readFileSync(new URL('../src/shared/live-talk.ts', import.meta.url), 'utf8')), /\[live\] start target=\$\{target\}/);
  assert.match(strip(readFileSync(new URL('../src/shared/live-talk.ts', import.meta.url), 'utf8')), /\[live\] stop reason=\$\{reason\}/);
  assert.match(strip(readFileSync(new URL('../src/shared/live-awareness.ts', import.meta.url), 'utf8')), /\[live\] awareness window=\$\{status\}/);
});
