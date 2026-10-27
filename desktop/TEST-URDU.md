# Urdu / Roman Urdu / English voice test (20 phrases)

Record each phrase on your real mic at your normal (quiet) volume, 2-4 seconds, and save it under the number shown
(`01-wake.wav`, `02-wake.wav`, ...). The app stores no audio, so this is the only way to get real data.

```
mkdir -p ~/stt-test && cd ~/stt-test
arecord -f S16_LE -r 16000 -c 1 -d 4 01-wake.wav        # repeat for 02..20 (say the phrase right after pressing Enter)
cd "<repo>/desktop"
GROQ_API_KEY=... GEMINI_API_KEY=... node scripts/stt-check.mjs ~/stt-test --mode fast --clip
```

The script uses the same router as the app. It reads `GROQ_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` from the environment, or
(read-only) base64 keys from `~/.config/Sudo-chan/config.json`; it never prints a key. About 1-2 requests per file, so 20 files
cost about 20-40 requests of your daily allowance: run it once, not in a loop. Add `--mode accurate` to compare Gemini-first.
It prints a table: expected phrase, what came back, script, provider, wake/stop/intent verdicts, milliseconds, clip length and rms.

Judge by MEANING, not exact spelling: "Sudo, kaise ho" vs "सुडो कैसे हो" is fine if the WAKE column says WAKE.

Format: number, kind, phrase to say, what must happen.

1. **wake** "Sudo, kaise ho?" - WAKE, intent chat
2. **wake** "Sid, suno" - WAKE
3. **wake** "Sudo-chan" (just the name) - WAKE, nothing else needed
4. **wake-urdu** "سوڈو، کیسے ہو؟" (say it in Urdu) - WAKE even if the text comes back in Urdu or Hindi script
5. **stop** "ruko" - STOP
6. **stop** "ruk jao" - STOP
7. **stop** "bas karo" - STOP
8. **stop** "chup ho jao" - STOP
9. **stop-urdu** "رکو" - STOP
10. **stop-hindi** "बस" (say "bas") - STOP
11. **screen** "meri screen dekho" - intent screen
12. **screen** "ye kya hai?" (pointing at something on screen) - intent screen
13. **screen-urdu** "میری سکرین دیکھو" - intent screen
14. **task** "notes.txt bana do" - intent task
15. **task** "ek reminder laga do paanch minute baad" - intent task
16. **task** "yeh file khol do" - intent task
17. **chat** "aaj mausam kaisa hai?" - intent chat, readable transcript
18. **chat** "mujhe computer ka kaam batao" - intent chat
19. **english** "What time is it right now?" - correct English text
20. **mixed** "Sudo, mera email check kar do please" - WAKE, intent task

## What to send back

- The table the script prints (it contains only text, no keys).
- For every row that came back empty: was it a quiet phrase, a one-word phrase, or a noisy room?
- Whether the failures are mostly fast mode or also accurate mode (run both once).
