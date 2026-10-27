# Manual voice test checklist

Run `cd desktop && npm run package` (or `npm run dev`), set a Groq or Gemini key in Settings, then work through this list twice: once with **headphones**, once with **laptop speakers**.
In the dev console of the chat window, `window.__bargeInLatency` holds the measured numbers.

1. **Live Talk starts.** Press Ctrl+M in the chat window (or click the bot in the overlay). Status pill shows "Listening".
2. **Normal question.** Ask something with a long answer. Bot speaks; the overlay mouth moves with the loudness of the voice.
3. **Barge-in, stop word.** While she speaks, say "ruko" clearly. Audio must stop within about 0.3-0.4 s. Check `window.__bargeInLatency` (target speech→detect < 300 ms).
4. **Barge-in, new question.** Interrupt with a new question. She stops, answers the new one, and does not continue the old answer.
5. **Stop button.** Ask for a long answer, press "Stop speaking". Audio and mouth stop at once; no sentence resumes afterwards.
6. **Mute.** Toggle voice mute mid-reply. Audio and mouth stop at once.
7. **Close the chat window** mid-reply. Audio stops; the overlay mouth closes within 0.5 s.
8. **Silence check.** With the bot idle, the overlay mouth stays closed. If a reply fails (turn Wi-Fi off), the mouth does not keep moving.
9. **Wake word.** Settings → turn on "Listen for my name". Say "Sudo, what time is it" (also try "Sid", "Suddo", a mumbled "sudu"). The bot reacts and answers; keep talking without the name for 30 s; after 30 s of quiet Live Talk closes. Also say a sentence without her name: nothing happens. Pause from the bot's indicator and confirm no cloud calls happen (mic indicator off in the system tray).
10. **Voice quality.** Settings → Voice: try each Gemini voice and the Google fallback on an English and a Roman Urdu sentence. Note how natural it sounds and whether Urdu is acceptable. Also set your Gemini key wrong on purpose and confirm she still speaks (fallback).

Speakers only: if she interrupts herself (echo), lower "Barge-in sensitivity" in Settings.

## Resume after an unclear interruption
11. **Mumble interrupts, she resumes.** While she speaks a long answer, interrupt with a long mumble or noise (about 2 seconds, nothing recognisable). She stops, and a moment after the recogniser gives up she continues from about where she was cut (a word or two before). Console: `[barge-in] unclear clip=...ms -> resume`.
12. **"ruko ruko" stays stopped.** Interrupt with "ruko ruko" (or "stop", "bas karo", "chup"). She stops and stays silent; her text is not sent as a chat message. Console: `[barge-in] stop command "ruko ruko" -> stay stopped`. A very short unclear sound (< 1 s) also stays stopped.
