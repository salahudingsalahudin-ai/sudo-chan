# Live Talk flow: one button, one state machine

Branch `live-talk-flow` (on top of main `3f87daa`). Pure logic: `src/shared/live-talk.ts` (the machine, the instant-stop sequence, the log lines) and
`src/shared/live-awareness.ts` (what she may know about your window). Tests: `tests/live-talk.check.mjs`, `tests/live-talk-session.check.mjs`,
`tests/live-awareness.check.mjs`. Count-only logs: `[live] start target=...`, `[live] stop reason=...`, `[live] awareness window=...`.

## Which control is which (the decision)

| Control | What it is | Look |
|---|---|---|
| **The bot** (body, orb, or the antenna on top of her) | **THE Live Talk button.** Click = she is active and the live conversation starts now. Click again = it stops now. | Blue glow, pulsing antenna rings, the dot shows a blue ring |
| The small **round dot** left of the chat pill | Only the **name-standby switch** (green = listening for her name, click twice to turn off). While Live Talk is on, one click on it also ends Live Talk. | Green dot / amber ring / grey slash (shapes differ, see MIC-INDICATOR.md) |
| The **chat pill** ("Right here" / "Live Talk") | Opens the chat window. Nothing else. | Text pill |
| **Voice** button in the chat window composer | Starts Live Talk **in the chat window** ("Live Talk here"). Typing is the default; the mic stays closed until this is clicked. | Mic icon + the word "Voice" next to Send |

Why the bot and not the dot: the bot is big, it is the thing the owner talks to, and it already had a talk antenna and (in orb mode) a clickable orb. The
dot is 26 px and has a deliberate "click twice to turn off" gesture so a stray click cannot silence standby; mixing "start a conversation" into it would
undo that. The two are now told apart by size, shape, colour and by the tooltips ("Name standby is ON ... Live Talk = the bot." vs "Click me to start Live Talk.").
No text was added to the overlay.

Consequence: a **double-click on the bot no longer opens the chat** (a double-click is two clicks, which would start and stop Live Talk). The chat pill, the
tray and `Ctrl+Space` still open it.

## The state machine

Modes: **OFF** (mic closed), **STANDBY** (today's wake mode: the mic hears only her name), **LIVE-OVERLAY** (talking to the desktop bot), **LIVE-CHAT** (talking
in the chat window). **SPEAKING** is a sub-state that can sit on top of any mode; ending Live Talk always clears it.
Only one target is live at a time: starting one ends the other first (`reason=switch`).
"Standby wanted" is the `wakeWordEnabled` setting. Live Talk **never writes it**; it only decides whether the mic goes back to STANDBY or to OFF when Live Talk ends.

| From | Event | To | What happens (audio / mic / lip-sync) |
|---|---|---|---|
| OFF, STANDBY | click the bot | LIVE-OVERLAY | Mic session starts at once in live mode (no name, no consent dialog, existing mic permission only). Little wave, no spoken greeting. STANDBY clip gating is bypassed. Lip-sync only on the bot. Log `start target=overlay`. |
| LIVE-OVERLAY | click the bot (or the dot) | STANDBY, or OFF if standby was off | **Instant stop** (below). Log `stop reason=click`. |
| LIVE-CHAT | click the bot | LIVE-OVERLAY | Chat ends first (`stop reason=switch`: its audio is cut, reply aborted), then the bot starts. |
| any | chat "Voice" / `Ctrl+M` | LIVE-CHAT | Overlay Live Talk (if any) ends with `reason=switch`. Chat mic starts. Lip-sync/captions only in the chat. The desktop bot stays silent. |
| LIVE-CHAT | chat "End Live Talk" | STANDBY / OFF | Instant stop. `reason=click`. |
| STANDBY | her name heard (wake word) | LIVE-OVERLAY (origin = wake) | As today: wave, live mic, the **30 s conversation window** applies. OFF cannot hear it; LIVE-* treats the name as ordinary speech. |
| LIVE-OVERLAY (origin = wake) | 30 s of silence | STANDBY | Instant stop, `reason=timeout`. A Live Talk the user **clicked** has no timer. |
| LIVE-* | stop word ("ruko", "bas", "chup", "stop"...) while she is **busy** (speaking, replying, or just interrupted) | unchanged | Voice and reply are cut, Live Talk carries on (as today). STANDBY: "Sudo, ruko" does the same. |
| LIVE-* | stop word while she is **idle** | STANDBY / OFF | It means "we are done": instant stop, `reason=stopword`. In STANDBY or OFF there is nothing to end. |
| LIVE-CHAT | chat window closed or hidden | STANDBY / OFF | Instant stop, `reason=window`. (A moment's hide for a screenshot does not count.) While LIVE-CHAT is on the chat window no longer hides itself when you click elsewhere. |
| LIVE-OVERLAY | desktop bot hidden (tray "Hide companion") | STANDBY / OFF | `reason=window`. |
| LIVE-* | app quits | OFF | Main aborts reply/tools/screenshot flow, `reason=quit`. The windows close, which cuts any audio. |
| LIVE-* | microphone could not start | STANDBY / OFF | `reason=error`; the chat shows one plain line. |
| STANDBY / OFF | dot / tray / Settings switch | OFF / STANDBY | As before (`[mic] wakeWordEnabled ...` log, patch-based save). During Live Talk the choice is only remembered; it applies when Live Talk ends. |
| any | she starts / stops speaking | SPEAKING on / off | `speech:start` / `speech:stop` from the one player; lip-sync follows only the live target. |

### The instant stop (`runLiveStop`, same in both windows)

1. `stopSpeaking('stop-button')`: the audio source is stopped synchronously, no tail; `speech:stop` is emitted exactly once, so the mouth closes.
2. The "resume where she was interrupted" memory is cleared (no replay after an intentional stop).
3. `VoiceSession.cancelPending()`: the half-recorded clip is dropped and any speech-to-text request still in flight is ignored when it answers (no new turn).
4. The live mic session is closed, unless standby is wanted (then the same mic simply goes back to listening for her name).
5. `stopReply()` in main: cloud stream aborted, pending tool approvals and any screenshot flow cancelled, so nothing is spoken afterwards.
6. `setVoiceActive(false, target, reason)`: main publishes the new state and writes `[live] stop reason=...`.

The window that only *observes* the end (the other window, a closed window) runs steps 1-3 from the state change (`runLiveTeardown`), so every path is covered.
A late "end" from a window that is no longer the target is ignored by main, so it cannot end the other window's Live Talk.

## What the user does (simple English)

1. **Desktop bot:** click the bot. She is live; just talk. Click the bot again (or say "bas" when she is quiet) to stop. The green dot beside the pill is only
   "she hears her name". Click it twice to turn that off. It does not start Live Talk.
2. **Chat window:** typing is normal and the mic is closed. Want to talk instead? Click **Voice** next to Send. Talk, and her answers show in the voice view and are
   saved in the chat. Click **End Live Talk** to go back to typing.
3. Only one of the two can be live. Clicking the other one switches.
4. First Live Talk on the bot: a small question appears, "may she know your window name?" (see below). You can ignore it.

## Awareness: "she knows what I am doing" (privacy first, in layers)

| Layer | What she knows | Gate |
|---|---|---|
| 1 (built) | App name + window title of the **focused** window, text only, never pixels | Live Talk on **and** `liveAwareness = 'window'` (click-only consent) **and** Cloud mode |
| 2 (already there) | A screenshot, when you ask ("meri screen dekho", "ye kya hai") | Existing screen assist: setting, consent click, countdown, sensitive-window guard, 1280 px JPEG, 2-minute memory cache. Live Talk carries on after the answer. |
| 3 (plumbing only) | Nothing yet | Setting `liveKeepAnEye` (default false) exists and validates; **no code reads it**, there is no switch and no timer capture. |

Layer 1 details:
- **Consent.** The first time Live Talk starts on the bot, one calm panel (same box as the screen consent, between "capturing" and the caption in the panel priority)
  asks "Window ka naam jaan loon?" with **Allow / Not now**. Only a click answers (the handler is overlay-only, nothing spoken can reach it, Esc = Not now).
  It does not block anything: she is already listening. It is not spoken. If it is ignored for 25 s it disappears without counting as an answer; any click on a
  button counts, and she never asks again (turn it on later in Settings: "Let her know which window I am using (Live Talk)").
  `liveAwareness` can be switched **on** only by the Settings window or that panel; `chat` / `dot` / `tray` saves cannot (main enforces it).
- **What is sent.** One line in the system prompt of that turn: `app="firefox"; title="..."` (cleaned of quotes/newlines, 40 / 80 characters), marked as untrusted
  text. It is **not** in the chat history, not logged (the Cloud payload log now prints the system prompt's size only), not written anywhere.
- **Sensitive windows.** If the focused window matches the existing screen-guard list (password manager, bank, login, OTP, wallet, private window...) the line is
  dropped at once and nothing is said about it. Only a log line `[live] awareness window=skipped-sensitive`.
- **Rate.** Never more than one AT-SPI window list per 5 s. While Live Talk is on, main refreshes every 10 s, and only if you have talked in the last 2 minutes;
  a turn never waits for it (a slightly old line beats a slow answer).
- **What she is told.** She knows only the name, says so if asked about the window's contents, points to "meri screen dekho", does not narrate your activity
  unprompted, and (without the line) is told she cannot see the screen at all. Honest limit text: `NO_SCREEN_SENTENCE` and `awarenessPrompt()`.
- Not for Local (Ollama) mode, and not for typed messages outside Live Talk.

Layer 3 was **not** built: a screenshot every 60 s costs about 2,100 Groq input tokens each, the free tier allows about 7,000 a minute (so it would steal the budget
from the answers), the AT-SPI list plus a portal capture is about 1.5 s of CPU on this laptop, and "only when the title changed" cannot be trusted for apps that do
not expose accessibility. The setting exists so the plumbing is reviewed first; turning it into a feature should come with its own consent text and the eye glyph.

## Speed (A4)

- Live Talk sends **every** utterance (no ClipGate, no local-name check, no 30 s window for a clicked Live Talk), through the normal speech-to-text path (Fast mode,
  Whisper first); no new retries. Barge-in, resume-after-unclear, the phantom/self-echo filters and the Urdu normaliser are untouched.
- Spoken answers are capped at **450 tokens** (was 1024 for non-Groq, 950 for Groq): the voice prompt asks for 1-3 short sentences, so this only stops a runaway
  answer and spares Groq's tokens-per-minute budget.
- **Known limit:** the answer is streamed from the model but spoken when it is complete (sentence-by-sentence speaking while it streams is not built; it needs a
  queue-based player and would change the resume-after-interruption design). With 1-3 sentences this is the model's time, about 0.5-1.5 s on Groq.

## Known limits

- A double-click on the bot no longer opens the chat (see above).
- Window names need AT-SPI (python3-gi); Chromium-based apps and some Electron apps may not expose a focused window, then she simply knows nothing.
- The awareness question is shown for Live Talk on the **bot** only. If you start Live Talk in the chat first, turn awareness on in Settings.
- With standby ON the mic is not re-opened when Live Talk ends (the same session returns to listening for her name); with standby OFF the mic is closed.
- On quit the windows close, so the audio stop reason is `window-closed`; the `quit` reason is in the `[live]` log.
- The chat window stays on top while Live Talk is on in it (it used to hide whenever you clicked elsewhere, which would have ended "talk here" the moment you worked).
- The first spoken greeting was left out on purpose (the mic is already open and a greeting would cost voice quota and echo into the mic).

## Only a human with a real mic can verify

Everything above is covered by unit/wiring tests with fake audio, fake players and a fake window list, and the real Electron smoke run. A person must check: that one
click really opens the mic within a blink and the glow changes; that the audio really cuts with no tail on the second click, also mid-sentence; that "bas" ends it
only when she is quiet; barge-in feel; that chat Live Talk never makes the bot move its mouth; and that the AT-SPI focused window is right on their desktop.

## 8 things to try by hand

1. Restart, click the bot once: glow turns blue, the dot shows a blue ring, and without saying a name you can say "kaise ho" and she answers.
2. While she is speaking a long answer, click the bot: the voice stops at once (no tail) and the dot goes back to green; wait 10 s, nothing is spoken later.
3. Click the bot, say nothing for a minute: it stays live (no 30 s timeout). Now say "Sudo" from standby instead and stay silent: it ends after about 30 s.
4. In Live Talk say "ruko" while she is talking: she stops, Live Talk stays. Say "bas" when she is quiet: Live Talk ends.
5. Open the chat window and type a few messages: the mic indicator of your OS stays off. Click **Voice**: talk, the chat bot moves its mouth, the desktop bot does not.
   Click the desktop bot while that runs: the chat voice stops and the bot takes over.
6. Click Allow on the window-name question (first Live Talk), open a terminal, ask "main kya kar raha hoon?": she names the terminal, and says she cannot see inside it.
7. Open a password manager or a bank page in the browser and ask the same: she says she does not know (nothing about being blocked). In the terminal
   output of the app you see `[live] awareness window=skipped-sensitive` and no titles.
8. Turn standby off (two clicks on the dot), click the bot, click it again: the dot goes back to grey-off and Settings still says "Listen for my name: Off" (Live Talk never flips it).
