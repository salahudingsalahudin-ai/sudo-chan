# Checking the on-device wake word with your real voice (about 15 minutes)

The code was only tested on synthetic signals. These steps tell you whether it works for you. Keep `localWake` on `off` (the default) until step 5 is good.

## 1. Teach her (Settings > Voice > "Teach her your voice saying Sudo")
Quiet room, normal distance, the mic you use every day, **same mic settings as always** (do not change the input device afterwards).
Press Record, say "Sudo" once, wait for "Got it"; repeat 6 times (5-8 work). Vary it a little: normal, a bit quicker, a bit softer. If a take is refused she says why (too quiet, too loud, too short...). Press Done. Optionally also teach "Sid".

## 2. Self-test (same panel)
"Test (3 times)": say her name 3 times. Expect **Heard 3/3** (2/3 is acceptable, 0-1/3: raise "Name check sensitivity" by 10-20 % and retry, or teach again closer to the mic).
Then say 3 other things (a normal sentence, "radio", "kaise ho") and press the test while saying them: she should not hear them. (The test counts only; nothing is sent.)

## 3. Switch on Assist and look at the counters
Set "On-device name check" to Assist, press Save. Start the app from a terminal and watch for the line (once a minute while anything happened):
```
[wake-local] candidates=2 rejected=7 sent=3 mode=assist
```
`candidates` = clips that sounded like your Sudo, `rejected` = speech clips that did not, `sent` = clips that went to the cloud (candidates + whatever the old quota gate still sent). Counts only; no text, no audio.

## 4. The real-audio script
Do each for a few minutes with the app listening, and write down the counters:
| What you do | Expected |
|---|---|
| 10 x "Sudo" alone, then 10 x "Sudo, kaise ho" in one breath, 5 s apart | candidates >= 16 of 20; she wakes (greeting) at least 16 of 20 times |
| 5 minutes normal talking / phone call, no name | candidates at most 1-3; sent should be well below the old rate |
| 5 minutes of TV or YouTube | candidates 0-2 |
| Someone else says "Sudo" | may or may not trigger (it is a mild voice check, not security) |
| Quiet room, no speech | all counters 0 |
If candidates are high with no one saying the name, lower sensitivity 10 %; if you are missed, raise it 10 %, or re-teach in the room you actually use. The limiter also tightens itself by up to 25 % after unconfirmed candidates and loosens by up to 15 % after misses (until restart).

## 5. Then decide
* Good (>= 80-90 % of your Sudos are candidates, few false ones): leave Assist on for a day. If the Groq allowance stays healthy and she rarely misses, try Strict.
* Bad: set it back to Off. Nothing else changed in behaviour. "Delete my voice samples" removes the stored numbers.

## Numbers to send back when tuning
`candidates/rejected/sent` per minute, how many wake attempts you made and how many woke her, and the sensitivity slider position. Thresholds and limits are listed in `LOCAL-WAKE.md` ("Tuning knobs").

## CPU check (optional)
`node --experimental-strip-types scripts/local-wake-bench.mjs` prints ms per second of audio (synthetic clips; real clips cost the same). On this laptop: 4-9 ms per second of audio, under 2 % of one core at 30 clips a minute.
