# Quota saver: fewer cloud listening requests while she waits for her name

Branch `quota-saver` (on top of `mic-indicator`). Pure logic: `src/shared/clip-gate.ts`. Tests: `tests/clip-gate.check.mjs` (19) + 1 case in `tests/voice-pipeline.check.mjs`.

## The problem (measured)
Wake mode used to send every detected speech clip to Groq Whisper: ~25 requests in 5.5 idle minutes (about 5 a minute), 20 of them room
talk that never contained the name. Groq's free listening allowance is 2000 requests a day; when it ran out, "Sudo" stopped working.

## What is gated (wake mode only)
Nothing here uses a model. The voice engine measures every clip (length, voiced time, level shape, zero crossings, pauses) and `ClipGate`
decides before the clip leaves the machine. **Live Talk and the 30 s conversation window are never gated** (every utterance is sent, the
budget is untouched). A barge-in clip (you interrupt her) is always sent.

| Step | Rule | Log reason |
|---|---|---|
| Junk | very short peaky burst (crest > 12, door/keyboard); hiss (> 9000 zero crossings/s and flat level); 4 s+ of constant level with no syllable rhythm (music/fan) | `impulse` `hiss` `steady-noise` |
| Monologue | 8 s+ of speech that does not start like "word, pause" is room talk or TV | `long-talk` |
| Shaped, after quiet | a clip that starts 4 s+ after the previous clip, is under 2.5 s, and is a bare name (0.22-0.9 s) or "short word + pause + request": budget burst 3, one token per 15 s | `isolated` |
| Plain, after quiet | any other short clip after quiet, only if the room is not busy (fewer than 3 clips in 2 min): burst 1, one token per 60 s | `isolated` |
| In talk | right after other speech (chatter, TV, her own echo tail): only the shaped kind, one token per 90 s, closed when quota is short | `in-talk` / skipped as `cluster` |
| Repeat | a short quiet-started clip within 15 s of a skipped one (you said it again) is sent, once a minute | `retry` |
| Floor | after 60 s with no request at all, the next speech-like clip is sent whatever the budgets say | `floor` |

Adaptive: when most of the last 8 sent clips had no wake word, the refill gets 2-3x slower and the floor stretches to 2-3 minutes (only while
quota is healthy); wake hits bring it back (one hit also gives the shaped budget a token). Quota pressure: main puts one number
`quotaPressure` (0 = half or more of today's Groq requests left, 1 = none) into the existing transcribe reply, computed from Groq's own
`x-ratelimit-*` headers via `UsageTracker.sttQuotaPressure()`. No new IPC channel, no change to `authorize()`, no overlay privilege.
Pressure >= 0.4 stretches refills (x(1+2p)), >= 0.75 drops the burst to 1, >= 0.5 closes the talk lane, and the floor stays at 60 s.
At 431 of 2000 left the pressure is 0.57: still one attempt a minute, and a quiet-started "Sudo" still goes.

## Trimmed uploads
Wake mode uploads at most the first 3.5 s of the clip (pre-roll included, was 4 s): the name has to come within the first words anyway.
Faster, smaller, fewer audio seconds. Live Talk uploads everything as before. A long command said in one breath right after the name
is therefore cut at 3.5 s in wake mode (as it already was at 4 s); once she wakes, Live Talk takes the rest.

## Log lines (counts only, no text, no audio, once a minute while anything happened)
```
[gate] skipped=7 sent=0 reason=cluster
[gate] skipped=0 sent=2 reason=isolated
```
Look for them in the app output. `reason=isolated|in-talk|retry|floor|barge-in` are sends, the others are skips. Nothing is shown on the overlay.

## Simulated effect (deterministic, `GATE_SIM_REPORT=1 node --test tests/clip-gate.check.mjs`)
"Before" = old behaviour (every clip with 220 ms voiced, 2 s minimum interval). Seeded synthetic clip streams, no audio, no network.

| scenario | minutes | before | after | fewer | wake sent |
|---|---|---|---|---|---|
| quiet room (clicks, hiss, mumbles), 8 seeds | 80 | 148 | 24 | 84% | n/a |
| idle room talk (~4.5 clips/min) + "Sudo" every 2 min, 8 seeds | 80 | 297 | 86 | 71% | 33/40 (see below) |
| TV with scene lulls + "Sudo" in a lull every 2 min, 8 seeds | 80 | 594 | 108 | 82% | 28/40 (see below) |
| TV wall to wall, no lulls, 4 seeds | 40 | 404 | 49 | 88% | n/a |
| TV wall to wall at pressure 0.97 (60 of 2000 left) | 12 | 119 | 14 | 88% | n/a |
| "Sudo" every 2 min, quiet room | 30 | 15 | 15 | 0% | 15/15 |
| echo tail after bot replies, "Sudo" 12 s later | 10 | 15 | 10 | 33% | 5/5 |

Also asserted: Live Talk clips are 100% sent even with a zero budget; at high pressure the longest gap between requests is at most the floor
(60 s) plus one clip's spacing; the bare name and "name, pause, request" are sent 100% of the time in every scenario above.

## The honest risk (read this)
Room talk and "Sudo kaise ho" said in one breath (no pause after the name) look identical to a cheap local check. In a **busy room**
(chatter or TV, 3+ clips in the last 2 minutes) that one-breath form is only sent on the first try about 15-35% of the time in the simulation
(4/11 room talk, 2/14 TV). The repeat rule makes the second try go through in every simulated pair, so the symptom is "say it again". The
bare name ("Sudo", "Sid") and "Sudo, <pause> request" are not affected. In a quiet room nothing changes. If this feels worse in practice,
raise `GATE_BURST` / lower `GATE_REFILL_MS` / raise `BUSY_CLIPS` in `clip-gate.ts` (below).

## Tuning (all in `src/shared/clip-gate.ts`)
`GATE_BURST` (3) and `GATE_REFILL_MS` (15 s): the shaped budget. `PLAIN_REFILL_MS`, `TALK_REFILL_MS` (60 s / 90 s). `BUSY_CLIPS` (3) and
`BUSY_WINDOW_MS` (2 min). `ISOLATION_MS` (4 s of quiet before a clip counts as a command). `GATE_FLOOR_MS` (60 s). `WAKE_TRIM_MS` (3500).
`LONG_CLIP_MS` (8 s). `SHAPED_MAX_MS` (2.5 s). Junk thresholds are in `junkReason`. Re-run the simulator after any change; the tests pin the
promises above (>= 70% fewer requests on the idle/TV scenarios, 100% of the bare name / name+pause utterances, one attempt a minute under pressure).
