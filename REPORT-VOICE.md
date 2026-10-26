# Voice fix report (branch `voice-fix`)

(The existing `REPORT.md` is the chatbot-fix report, so this one has its own name.)

Commits: `b90f7ca` B barge-in, `a2a8534` C lip-sync/stop, `86f64ad` E expressive TTS, `d4d943b` D wake word.
Automated checks: `npm run typecheck` clean, `npm test` 70/70 pass, `npm run build` ok. **None of this was tested with a real microphone, speakers or by ear** (see "Not tested").

## A. Investigation (file:line before the fixes)
1. **TTS start/stop.** There was no single stop path. `src/renderer/speech.ts` `stopSpeech()` (l.96) only set a flag and called `setIsSpeaking(false)`. The main process played audio itself with `pw-play` inside `playSpeech` (`src/main/index.ts` l.578-603), which had no cancel: a Stop during the 7 s fetch let the sentence start afterwards and set `isSpeaking=true` again. The renderer then played the same audio a second time from the returned data URI.
2. **Mic while speaking.** Muted. `voice-engine.ts` l.415 returned early whenever `isSpeaking()` was true. `onBargeIn` was declared (l.348) and wired in `App.tsx` (l.117, l.341) but **never called anywhere**. That is the cause of Bug 1.
3. **Overlay speaking signal.** The overlay got a boolean `state.isSpeaking` from main (set by `playSpeech`, `setIsSpeaking`) and drew the mouth with infinite CSS animations plus the *microphone* level. No stop event existed, and the stale-playback race above kept the flag true. That is the cause of Bug 2.
4. **Wake word.** Contrary to the expectation, something existed: the overlay mic ran in standby, sent every speech burst to cloud STT and matched a regex (`checkWakeIntent`). No toggle, no rate limit, no indicator.

## B. Barge-in (Bug 1)
Mic and pre-roll stay live while the bot speaks. `BargeInDetector` (`src/shared/barge-in.ts`) needs 150-250 ms of continuous speech above a threshold 1.2-2.4x the idle one (sensitivity slider in Settings, default 50 %). On trigger: `stopSpeaking('barge-in')`, abort the LLM stream (`stopReply`), keep recording the user's sentence including the pre-roll. Echo cancellation, noise suppression and AGC were already on.
Latency (simulated frames, `tests/barge-in.check.mjs`): speech start to detection **218 ms** at default sensitivity, 252 ms at the lowest. Audio-stop time after detection is logged at runtime (`window.__bargeInLatency`) and is **not measured yet**.

## C. Lip-sync (Bug 2)
`src/renderer/tts-player.ts` is now the only place that starts or stops audio (Web Audio). `stopSpeaking(reason)` is the single stop path (finish, stop-button, barge-in, new-reply, error, mute, window-closed, app-quit) and `UtteranceTracker` guarantees exactly one `speech:stop` per utterance. Level comes from an `AnalyserNode` on the real output. Events go renderer, then main (`companion:speech-event`), then every window; main ignores stale events and sends a stop if the speaking window is destroyed. `useLipSync` has a 500 ms watchdog and ignores everything unless a voice session is active. The mouth scale follows the level; the infinite mouth animation is gone. Main `playSpeech` now only synthesizes.
Tests: stop on every reason emits one stop, idempotent, stale generation cannot play, watchdog, stale events ignored (`tests/speech-events.check.mjs`, real `tts-player` against a fake AudioContext).

## D. Wake word
Setting "Listen for my name" (default **off**; mic is closed otherwise), assistant name plus aliases (default Sudo, Sid, Sudo-chan, Suddo, Sit). Local VAD; only the first 4 s of a clip goes to STT with a name/alias vocabulary hint, at most one clip per 2 s, silent exponential back-off on 429/errors. Fuzzy match: no typos for names up to 3 letters, 1 for 4-5, 2 for 6+, name must be in the first 4 words. On a match the bot greets, Live Talk opens and a 30 s no-name window starts (each utterance extends it; only wake-opened sessions auto-close). Indicator "Listening for <name>" that is also the pause button. Voice lock still applies.
Tests: `tests/wake-word.check.mjs` (matching, gate, window, settings defaults).

## E. Expressive voice
`TtsProvider` interface; Gemini TTS (`gemini-2.5-flash-preview-tts`, default voice Kore, key sent in a header and only in main) with silent Google Translate fallback and a 30-60 s back-off. Voice-mode prompt asks for one `[warm]/[excited]/[calm]/[curious]/[soft]/[happy]` tag per sentence; tags are stripped from displayed text and mapped to style instructions. Markdown, emoji, URLs and code are stripped before TTS. Voice, engine and speed are selectable in Settings. Details and the Gemini experiment: `DECISIONS.md`.
**Honest quality notes:** I cannot listen. Objectively, Gemini returned audio for English, Roman Urdu and Urdu script (non-silent, 3.7-5.5 s clips). Naturalness and Urdu quality need a human ear. **Gemini takes about 4-7 s per sentence** (Google: under 1 s), so the first sentence of each reply is slow; prefetch hides only part of that. Only Kore was sampled properly (parallel calls hit the free-tier 429). Switch to the Google engine in Settings if the delay bothers you.

## Not tested / still weak
- Real mic and speaker behaviour: echo of the bot's own voice on speakers, the 0.009 base threshold and playback multiplier are guesses. Use the sensitivity slider.
- Actual audio output through Electron after replacing `pw-play` with Web Audio (the old `pw-play` path is gone on purpose). If you hear nothing, tell me first.
- Wake word false-accept rate in a noisy room; whether the extra indicator fits the small overlay window on every bot size.
- Whether the real LLM emits the emotion tags reliably.
- `index.ts` reads the Gemini TTS key from `store.get('providers')`; if nothing writes that, TTS silently uses Google unless Gemini is the active cloud provider.
- Security: `~/.config/Sudo-chan/config.json` keeps API keys only base64-encoded (`rawKey`), not encrypted. Out of scope here, but rotate those keys.
- A newer commit `3887770` (Vercel build fix) landed on `main` from another session while I worked; `voice-fix` is based on it.

## How to test each item
See `TEST-VOICE.md`: barge-in steps 3-4, lip-sync steps 2 and 5-8, wake word step 9, voice quality step 10.
Quit the old running Sudo-chan first (an instance from Oct 26 is still running with the old code and makes new launches exit silently).
