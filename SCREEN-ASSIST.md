# Screen assist ("Sudo, ye kya hai?")

When you say her name (or press the 👀 button in chat), Sudo-chan takes **one** screenshot, sends it to your cloud AI provider together with your words, and answers about what you are working on ("ye error kya hai?", "is code mein kya galat hai?").

Branch `screen` (based on `voice-fix`). Off by default.

## How it works
1. **Trigger.** Overlay wake word accepted (name in the first words, voice lock passed, listening not paused) **and** Settings → "Let Sudo-chan look at my screen" is ON. Or the 👀 button in the chat header (only visible when the setting is ON). Nothing else ever captures: no timer, no background capture, not on ordinary Live Talk turns.
2. **Decision (main process re-checks).** setting ON, consent given, no capture in flight, cooldown (10 s for the wake word, 2 s for the button). If the name is said again inside the cooldown she still answers the words, just without a new screenshot.
3. **Capture.** `xdg-desktop-portal` Screenshot (non-interactive) through a tiny python3-gi helper. The portal writes a PNG in `~/Pictures`; the app reads it and **deletes it immediately**. Chat and Settings windows are hidden for the capture; the small bot stays (it shows the indicator).
4. **Processing.** Downscaled to at most 1280 px wide JPEG (~25-250 KB), blank/black frames are rejected, a 220 px thumbnail is made for the chat.
5. **Vision.** One non-streaming OpenAI-compatible chat call with an `image_url` part. Order: the active provider's model, then that provider's vision model (Groq `qwen/qwen3.8-27b`), then Gemini `gemini-flash-lite-latest`. If no provider can take images she says so and does not guess.
6. **Answer.** The screenshot is attached to this turn only. History keeps text only. The system prompt tells her to describe only what is visible, say when text is unreadable, and not read out visible secrets.

## Privacy model
- Default OFF. Turning it on asks a **first-use confirmation** (the image goes over the internet to Groq/Gemini). The consent is stored; revoke by turning the setting off.
- Indicator: overlay shows "👀 Dekh rahi hoon... ✕" while capturing (click = cancel), then "📸 Screen bheji gayi". The chat message shows the thumbnail of exactly what was sent.
- Cancel: click the badge, or press Stop in chat (cancels a pending capture; also stops the reply).
- Never written to disk by the app, never logged (logs redact `data:image`), never in conversation history, not captured when the voice lock rejects the speaker or when listening is paused (the mic is closed then).
- Needs Cloud mode. In Local (Ollama) mode she refuses rather than sending images anywhere.
- Keys stay in the main process.

## Known gaps (be aware)
- **Sensitive windows.** She cannot tell what is on the screen before capturing. On GNOME Wayland an app cannot read the focused window's title, so the "skip if a password/bank window is focused" check could not be implemented reliably and is **not** there. Close password managers and banking pages first, or keep the setting off.
- Needs `python3` with `gi` (default on Ubuntu GNOME). If missing she says so ("sudo apt install python3-gi").
- The portal screenshot includes every monitor/window as GNOME renders it, including notifications.
- Answer quality depends on the vision model; small text in a 1280 px image can be unreadable.
- Groq free tier limits apply; each screen turn is one request.

## Manual test checklist (8 steps)
1. Restart the app. Settings → ON "Let Sudo-chan look at my screen" → Save. A confirmation dialog appears; click **Not now** and verify the toggle stays OFF.
2. Turn it ON again, click **Allow**. Settings shows ON.
3. Cloud mode with a Groq key. Open a terminal with a visible error. In chat click 👀 with the text "ye error kya hai?". Chat/Settings windows vanish for ~1-2 s, the overlay shows "👀 Dekh rahi hoon...", then the message appears with a screenshot thumbnail and a sensible answer in Roman Urdu.
4. Check `~/Pictures` has no new `Screenshot*.png` left behind.
5. Turn on "Listen for my name". Say "Sudo, ye kya error hai?". Bot reacts, badge shows, chat opens with thumbnail and answer.
6. Say only "Sudo". She greets and, looking at the screen once, offers help.
7. Say "Sudo, ..." again within 10 s: she answers the words without a new screenshot. Wait >10 s: new screenshot.
8. Click the badge while it says "Dekh rahi hoon... ✕": the capture is cancelled and nothing is sent. Pause listening from the bot's indicator: saying the name does nothing. Turn the setting OFF: neither the name nor 👀 ever captures.
