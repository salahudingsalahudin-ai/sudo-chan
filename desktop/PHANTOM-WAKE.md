# Phantom wake: "it keeps talking by itself"

## What happened (live log)
In about 2 minutes the bot spoke 5 times with nobody addressing it. Every transcript was `Sudo-chan, Sido-chan,` (or `Sudo-chan, Sido,`),
the wake gate matched "Sudo-chan", the bot answered "Sid, main sun rahi hoon...", and each of the 5 replies ended with
`speech:stop reason=barge-in`. Mic source volume 27 percent, clip rms about 0.035-0.07 (very quiet), speaker volume 88 percent.

## Root causes
1. **Prompt leak.** `WHISPER_DEFAULT_PROMPT` started with `Sudo-chan, Sid, suno, ji, ...`, and the standby wake hint
   (`Sudo, Sid, Sudo-chan, Suddo, Sit`) was prepended to it. Whisper treats `prompt` as text that came before the clip; on a quiet or
   noisy clip it just continues that list, so silence came back as the names. A transcript that is only the name is a valid wake.
2. **Self-echo barge-in.** The mic hears the bot through the speakers. `BargeInDetector` used a fixed threshold (0.009 x 1.8 = 0.016); the
   bot's own voice leaked above it, so each reply cut itself off, and the cut-off became a "user clip" that went to Whisper (cause 1)
   and woke the bot again: a self-talk loop. (Confirmed: the pattern needs both; cause 1 turns echo into a wake, cause 2 produces the clips.)

## What changed
| Where | Change |
|---|---|
| `src/main/stt.ts` | New Whisper prompt: one natural sentence, name once and not first. `buildWhisperPrompt(hint)` keeps at most ONE name from the wake hint. `response_format=verbose_json`; silent-looking segments give an empty result. `isValidTranscription` also runs the filter. |
| `src/shared/stt-hallucination.ts` (new, pure) | `classifyTranscript` / `isPhantomTranscript` (junk, names-only 2+, prompt copies), `isSelfEchoTranscript` (name-only echo of the bot's last words within 3 s), `segmentsLookLikeSilence`. |
| `src/shared/barge-in.ts` | Echo envelope (peak-hold, half-life 1.5 s) with margin 1.4-2.0x; 350 ms warm-up; 600 ms echo tail; cap 0.3; `clipIsEcho`. Old API (`feed`, `reset`, thresholds) unchanged. |
| `src/renderer/voice-engine.ts` | Uses `idle()` / tail threshold; tracks whether a clip overlapped playback; drops echo-level overlap clips before STT. |
| `src/renderer/App.tsx`, `speech.ts` | Overlay and chat voice ignore phantom / self-echo transcripts (custom wake names included). |

## Trade-offs
- Saying only "Sid Sid" (name twice, nothing else) no longer wakes it. One name, or a name plus a request, works as before.
- Right after the bot speaks, a bare "Sid" within 3 s is ignored if the bot's last reply contained its name.
- To interrupt, the voice must be roughly 5 dB above the bot's echo in the mic. Raising the barge-in sensitivity slider lowers the margin.
  If the echo is still too strong, lower the speaker volume or use headphones.

## How to check
- Leave it idle in a quiet room for a few minutes with wake word ON: it must stay silent (log: `transcript ignored` / `dropped phantom`).
- Say "Sudo" or "Sid, kaise ho?": it wakes. Let it talk, then say "ruko" at normal volume: it stops. It must NOT cut itself off.
- Logs: `[STT] dropped phantom transcript (name-list)`, `[barge-in] clip overlapped bot playback at echo level -> dropped`.
