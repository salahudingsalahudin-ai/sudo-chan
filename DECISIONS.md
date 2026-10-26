
## Task B decisions (barge-in)

- Root cause of Bug 1: `VoiceSession.onaudioprocess` returned early whenever `isSpeaking()` was true (mic gated while the bot talks), and `onBargeIn` was declared but never called anywhere.
- Mic + pre-roll now stay live during playback. Frames go to `BargeInDetector` (src/shared/barge-in.ts), a pure class so it is unit-testable without DOM/audio.
- Playback threshold = 0.009 * (2.4 - 1.2*sensitivity), i.e. always 1.2x-2.4x the idle threshold so the bot's own voice leaking through the mic does not trigger it. Required continuous speech = 250 ms (sens 0) .. 150 ms (sens 1), default 0.5 -> 200 ms. Gaps up to 80 ms are tolerated.
- ScriptProcessor buffer reduced 4096 -> 1024 (~21 ms at 48 kHz) for latency; frame duration computed from the buffer length. Pre-roll sized in ms (340 ms idle / 400 ms during playback), not in chunks.
- On trigger the session continues as a normal utterance (pre-roll + frames), so the new sentence is transcribed after the usual 750 ms silence; transcription is never sent while the bot speaks without a barge-in. Minimum utterance length raised 2 -> 8 chunks (same ~170 ms as before at the smaller buffer).
- `onBargeIn(info?)` receives performance.now() timestamps; App's shared `handleBargeIn` calls `stopSpeaking('barge-in')`, then `api.stopReply()` (aborts the LLM stream) and logs/pushes `window.__bargeInLatency`.
- New setting `bargeInSensitivity` (0..1, default 0.5), validated, with a slider in Settings > Voice, Focus & Laptop Health.
- Added `allowImportingTsExtensions` to tsconfig.json because voice-engine.ts is imported directly by node tests (strip-types needs an explicit `.ts` specifier); parameter properties avoided in shared TS for the same reason.

## Task C decisions (lip-sync / central stop)
- Root cause of the stuck mouth: main process played TTS with `pw-play` and set `state.isSpeaking` itself, with no way to cancel an in-flight `playSpeech` call. Pressing Stop while a sentence was still being fetched let it start playing afterwards and set `isSpeaking=true` again; nothing sent a final "stopped". The renderer also played the same audio a second time from the returned data URI. The overlay mouth used a boolean plus infinite CSS animations (timer driven) and the mic level, not the output level.
- Decision: main `playSpeech` now only synthesizes (returns a data URI). Playback, stop and level live in one module, `src/renderer/tts-player.ts`, using Web Audio (`AudioBufferSourceNode` -> `AnalyserNode`). `stopSpeaking(reason)` is the only stop path and emits `speech:stop` exactly once per utterance (`UtteranceTracker`).
- Events `start/level/stop` go renderer -> main (`companion:speech-event`) -> all windows (`companion:speech-broadcast`). Main owns `state.isSpeaking`, ignores stale events from superseded utterances and synthesizes a stop if the source window is destroyed mid-speech.
- Overlay/chat mouth is derived from events via `useLipSync` (500 ms watchdog, ignores events unless `voiceCallActive`). The mouth scale is set from the level; the infinite talking CSS animation was removed for the mouth (`is-talking-level`). Head-bob/cheek animations still key off `speaking`, which is watchdog-bound.
- Removed: Google-stream `Audio()` fallback and local Voice Studio helpers (unused, no analyser, could not be stopped centrally). Kept the browser `speechSynthesis` fallback; it emits start/stop but no level, so the mouth stays closed (honest, not faked).
- Sentence N+1 is synthesized while N plays to avoid gaps that would trip the watchdog.
- Reply file naming: the existing `REPORT.md` is the chatbot-fix report, so the voice report is `REPORT-VOICE.md`.
