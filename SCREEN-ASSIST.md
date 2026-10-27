# Screen assist ("Sudo, ye kya hai?")

When you say her name (or press the 👀 button in chat), Sudo-chan takes **one** screenshot, sends it to your cloud AI provider together with your words, and answers about what you are working on ("ye error kya hai?", "is code mein kya galat hai?"). The whole flow works from the small desktop bot: no chat window needed.

Branches: `screen` (first version) and `screen2` (this version, based on `integrate`). Off by default.

## How it works
1. **Trigger.** Overlay wake word accepted (name in the first words, voice lock passed, listening not paused) **and** Settings → "Let Sudo-chan look at my screen" is ON **and** the words point at the screen (`classifyIntent` = screen: "meri screen dekho", "ye kya hai"; see `desktop/INTENT-ROUTING.md`). "Sudo, kaise ho?" or "Sudo, notes.txt bana do" take no screenshot. The same screen phrases also work inside the 30 s Live Talk window. Or the 👀 button in the chat header. Nothing else ever captures: no timer, no background capture, not on ordinary Live Talk turns. "Sudo, ruko" only stops; it never captures.
2. **Sequence (one state machine, `src/shared/screen-flow.ts`, unit-tested).**
   1. *Consent, once.* First time only. From the wake word a compact dark-glass panel appears **on the desktop bot** with **[Allow] [Not now]** (and she says so aloud). Only a click can answer; there is no voice path to consent (ignored for the first 400 ms to avoid stray clicks, auto "Not now" after 60 s, "ruko"/Stop cancels it). From Settings or the chat button the native dialog is used.
   2. *Cooldown / cache.* Wake word again within 10 s: she re-uses the screenshot she already has (badge "📎 Purani screen par based"); with no cached screenshot she says "thori der baad dobara bolein".
   3. *Countdown* (Settings → "Countdown before the first screenshot", default ON): the first capture of a session (app run, or after 10 idle minutes) shows "📸 Screenshot 3... 2... 1... ✕" on the bot. Click ✕ or say "ruko" to cancel; use the time to close anything sensitive.
   4. *Capture + sensitive-window guard in parallel.* The image stays on this computer until the guard answers. If a password manager, bank, login, private/incognito, OTP or wallet window is **on screen**, the screenshot is thrown away and she says why ("Screen par password, bank ya login jaisi window khuli hai...").
   5. *Send.* One vision call; answer is 1-3 short spoken sentences, shown in the caption and spoken.
3. **Capture.** `xdg-desktop-portal` Screenshot (non-interactive) through a tiny python3-gi helper; the PNG the portal leaves in `~/Pictures` is deleted right after reading. Chat/Settings panels are hidden for the capture; the bot stays (it carries the indicator).
4. **Processing.** Downscaled to at most 1280 px wide JPEG, blank frames rejected, a 220 px thumbnail for the chat.
5. **Vision.** One non-streaming OpenAI-compatible call with an `image_url` part: active provider's model, then Groq `qwen/qwen3.8-27b`, then Gemini `gemini-flash-lite-latest`. A Groq rate limit (free tier: 7,000 input tokens/minute, an image is about 2,100) is waited out once if the provider asks for <= 6 s, otherwise the next provider is tried. If no provider can take images she says so and does not guess.
6. **Follow-ups.** The last screenshot is kept **in memory only for 2 minutes**. A follow-up like "aur is error ka fix batao" / "ye kya hai?" (words that point at the screen) re-uses it, with the badge "📎 Purani screen par based" and a prompt line telling her it is N seconds old. Other turns never get an image. It is dropped immediately on Stop / "ruko" / cancel, when the setting is turned off, after 2 minutes, and at app exit. A barge-in (you talk over her to ask the follow-up) keeps it.

### "Dekh ke kaam karo" (screen + task)
Images and tools are never sent in one request. "Sudo, meri screen dekh ke ye kaam kar do" is a screenshot turn: she describes the screen (the answer stays in the chat history as text; the image stays in memory only) and says the task needs a separate request. Say the task right after ("ab notes.txt bana do"): that turn runs the normal tool loop with her description already in history. With tools ON, commands are never treated as screenshot follow-ups.

## What you see and hear on the desktop bot
| Moment | Overlay | Spoken |
|---|---|---|
| First use | Consent panel with Allow / Not now | "Screen dekhne se pehle aap ki ijazat chahiye..." |
| Declined | Notice panel | "Theek hai, main screen nahi dekhungi." |
| First capture of a session | "📸 Screenshot 3... ✕" | |
| Capturing | "👀 Dekh rahi hoon... ✕" (click = cancel) | |
| Sent | "📸 Screen bheji gayi" | the answer |
| Re-using the old screen | "📎 Purani screen par based" | the answer |
| Cannot capture / sensitive window | Notice panel with the reason | the reason |

## Privacy model
- Default OFF. Turning it on asks for consent (the image goes over the internet to Groq/Gemini). Revoke by turning the setting off.
- Never written to disk by the app, never logged (logs redact `data:image`; window titles from the guard are never logged), never in conversation history (only a 220 px thumbnail in the chat), not captured when the voice lock rejects the speaker, or when listening is paused.
- Needs Cloud mode. In Local (Ollama) mode she refuses rather than sending images anywhere.
- Keys stay in the main process.

## Sensitive-window protection: what it can and cannot do
- Investigated on this GNOME 44 Wayland machine: Electron cannot read other windows' titles; `org.gnome.Shell.Introspect.GetWindows` -> AccessDenied; `Shell.Eval` is disabled. **AT-SPI (the accessibility bus) works**: `python3-gi` lists each accessible app's windows with titles and a SHOWING state in about 0.5-1.4 s, no prompt.
- So the guard checks every **visible** window's title and app name against password/bank/login/OTP/wallet/private-window keywords (whole words, e.g. "Bankruptcy" is fine).
- **Gaps:** only apps that expose accessibility information are visible to it. Terminals, GTK apps and Firefox do; Chrome/Chromium-based apps and some Electron apps may not unless accessibility is switched on. A page title that does not contain a keyword is not recognised (a bank page called "Welcome" passes). This is why the countdown exists and defaults to ON. If you want zero risk, close sensitive windows first or keep the setting off.

## Speed (measured here, Oct 2026)
| Step | Time |
|---|---|
| Portal capture incl. python start + file read (3 runs, 1366x768) | 0.64 - 0.91 s |
| Decode + resize + JPEG + thumbnail in Electron (synthetic 1920x1080) | 0.05 - 0.07 s |
| Window guard (AT-SPI), runs in parallel with the capture | 0.5 - 1.4 s (adds at most ~0.5 s) |
| Vision call, Groq qwen, synthetic terminal-error image | 0.79 s and 1.72 s (1280 px), 1.72 s (1024 px) |
Image size does not change the token cost (800 px and 1280 px were both billed ~2,114 tokens), so the 1280 px size stays. Two of four rapid repeats hit Groq's 7,000 input-tokens/minute limit; that is now retried once. Every screen turn logs one line: `[Screen] capture=…ms resize=…ms guard=…ms vision=…ms total=…ms cached=…`.
The earlier "capture ~1.9 s / vision ~2.6 s" figures were single cold measurements; warm numbers are in the table.

## Known gaps (be aware)
- Needs `python3` with `gi` (default on Ubuntu GNOME); if missing she says so ("sudo apt install python3-gi"). The guard degrades to "unknown" without AT-SPI and the countdown still applies.
- The portal screenshot includes everything GNOME renders, including notifications.
- Answer quality depends on the vision model; small text in a 1280 px image can be unreadable.
- Groq free tier limits apply (about 3 screen turns per minute with this key); every follow-up that re-sends the cached image costs another ~2,100 tokens.
- Only `qwen/qwen3.8-27b` on Groq accepts images with this key; Gemini free quota is small.

## Manual test checklist (10 steps, by voice on the desktop bot)
1. Restart the app. Settings → ON "Let Sudo-chan look at my screen" and keep "Countdown" ON. Save. The native dialog appears: choose **Not now** and check the toggle stays OFF; turn it ON again and **Allow**.
2. Revoke test: in `~/.config/Sudo-chan/config.json` remove `screenAssistConsent` (app closed), start the app, turn the setting on again: consent is asked again.
3. Open a terminal with a visible error. Say **"Sudo, ye error kya hai?"**. First time: the consent panel appears on the bot (if not yet allowed) and she asks aloud. Click **Allow** (saying "haan" must do nothing).
4. Watch "📸 Screenshot 3... 2... 1... ✕", then "👀 Dekh rahi hoon...", then a short spoken answer (1-3 sentences) in Roman Urdu and the same text in the caption.
5. Within 2 minutes say **"aur is error ka fix batao"**: the badge shows "📎 Purani screen par based", the answer mentions the screen is a bit old, and no new capture happens (check the log: `[Screen] follow-up ... vision=`).
6. Say **"kaise ho?"**: ordinary answer, no screenshot is attached (no `[Screen]` line).
7. Say **"Sudo, ye kya hai"** again within 10 s: she re-uses the old screenshot (cooldown) instead of refusing.
8. Open a private/incognito Firefox window or a password manager, say **"Sudo, ye kya hai?"**: she refuses aloud and no image is sent (no `vision=` line). Close it and retry.
9. Start a capture and click the **✕** during the countdown (or say "Sudo, ruko"): nothing is captured or sent. After a successful capture, say "Sudo, ruko" and then "ye kya hai?": the old screenshot is gone, so no image is attached.
10. Turn the setting OFF: neither the name nor 👀 captures; turn it ON and check `~/Pictures` has no leftover `Screenshot*.png`, and the log never shows image data.
