# On-device wake word ("is that clip a candidate for Sudo / Sudo-chan / Sid?")

Branch `local-wake` (from `origin/main` 3c689fb). Pure logic: `src/shared/local-wake/`. Setting: `localWake` = `off` (default) | `assist` | `strict`.
Real-audio check for the owner: `TEST-LOCAL-WAKE.md`. **Everything below that says "synthetic" was measured on generated signals, not on a voice.**

## Why
Wake mode sent speech clips to cloud Whisper (Groq free allowance 2000 requests a day). The quota saver (`QUOTA-SAVER.md`) cut idle requests 71-88 %, but
the cloud is still the only judge of "was that my name". Now a cheap local check says "could be the name" first. The cloud stays the safety net:
it confirms the name (`wake-word.ts` unchanged) and takes the actual request. A false local candidate costs one request; a miss degrades to the old gate.

## Research (documentation lookups only, nothing downloaded)
| Option | Licence | Download / size | RAM + CPU on this class of laptop | Custom 1-2 syllable word | Main risk |
|---|---|---|---|---|---|
| (a) Personalised template matching (MFCC + DTW), own code | ours | **none** (a few KB of numbers per user) | tiny; measured below | the user's own 5-8 recordings | fragile to a very different mic/room/voice; no learning from lots of data |
| (b) Vosk / Kaldi WASM, grammar-limited | Apache 2.0 | small models are 36-49 MB (en-us 40 MB, en-in 36 MB, hi 42 MB); **no Urdu model listed** | a recogniser decoding continuously: hundreds of MB and a busy core (estimate, not measured) | grammar words must be in the model's lexicon; "sudo" is out of vocabulary, Roman Urdu has no model | download + OOV word + accent |
| (c) openWakeWord (ONNX) | code Apache 2.0, **pre-trained models CC BY-NC-SA 4.0** | ONNX runtime for the renderer plus 3 small models; sizes not verified | light (the project claims 15-20 models on one Raspberry Pi 3 core) | must be **trained**: thousands of synthetic TTS examples plus negative data, Python/Colab | English TTS training data vs a Pakistani speaker; non-commercial licence on the shipped models |
| (d) Picovoice Porcupine | proprietary SDK | `.ppn` per platform from the Picovoice Console | very light | typed in the Console, trained in seconds | **AccessKey required** ("anyone using Picovoice needs a valid AccessKey"), account and terms outside our control; I could not confirm from the docs whether it validates online or what the free plan allows commercially |
| (e) whisper.cpp `tiny` on candidate clips only | MIT | model file roughly 75 MB (from memory, unverified) | hundreds of MB while loaded; ~1 s of CPU per clip (estimate) | none needed, but Whisper-tiny hallucinates on short Urdu clips and "Sudo" has no fixed spelling | download + weak accuracy exactly where we need it |

### Scoring (0-5, weighted; max 60)
Weights: works offline from the installer with no download 3, accuracy risk for a Pakistani speaker saying "Sudo" 3, CPU+RAM on an i5-6300U 2, licence freedom 2, effort/maintenance 1, speaker check as a bonus 1.

| | offline x3 | accuracy x3 | CPU/RAM x2 | licence x2 | effort x1 | speaker x1 | **total** |
|---|---|---|---|---|---|---|---|
| (a) template DTW | 5 | 3 | 5 | 5 | 4 | 5 | **53** |
| (b) Vosk grammar | 2 | 2 | 3 | 5 | 2 | 0 | 30 |
| (c) openWakeWord | 3 | 3 | 4 | 2 | 1 | 0 | 31 |
| (d) Porcupine | 3 | 4 | 5 | 1 | 4 | 0 | 37 |
| (e) whisper.cpp tiny | 2 | 2 | 2 | 5 | 2 | 0 | 28 |

The scores are my judgement, not measurements. **Chosen: (a)**: the only option that needs no download, no account and no training data,
costs almost nothing, and is trained on exactly the voice, mic and accent that will use it. Its weakness (generalising to other conditions) is
covered by the cloud confirmation and the Assist fallback. (b)-(e) are not implemented; `registry.ts` is where a later engine plugs in.

## How the chosen engine works (`template-dtw`)
1. Resample the clip to 16 kHz with an anti-aliasing low-pass (`dsp.ts`; the app's older helper only interpolated).
2. Frame energy (25 ms window, 20 ms hop), find the first speech span (threshold between the room floor and the peak; no clear peak 10 dB over the floor = "no speech", so fans, hiss and TV bed are rejected cheaply).
3. Features only for the first 3 s from the span start: pre-emphasis, Hamming, FFT 512, 24 mel bands, 12 liftered cepstra + deltas (24 numbers/frame), loudness-levelled before the log so a quiet "Sudo" meets the same floor.
4. Subsequence DTW (`dtw.ts`, open begin and end, 0.55-2x stretch, small penalty for non-diagonal steps) against each enrolled template: so "Sudo", "Sudo-chan", "Sudo kaise ho" and "hey Sudo" all contain a match.
5. Score = mean of the two closest templates (one if fewer than five). Candidate when score <= calibrated threshold x sensitivity scale (0.8x at 0 %, 1.0x at 50 %, 1.25x at 100 %) x (1 + adaptive offset).
6. Calibration at enrolment (`template-engine.ts: calibrate`): leave-one-out scores of the user's own takes; threshold = mean + 2 x max(sd, 20 % of mean). One odd take (> 1.4x the median) is dropped if five remain, otherwise the UI asks for one or two more takes.

Work is sliced (`LocalWakeJob.step(budgetMs)`, 4 ms slices, `setTimeout(0)` between them) because the audio callback shares the renderer thread.
**No Worker**: measured below, one clip costs 12-34 ms in total, once per finished clip, spread over 4 ms slices; the existing per-frame pitch autocorrelation in the audio callback is heavier. A Worker would add a file, CSP/`file://` questions and a copy of the samples for no gain. If a profile ever grows (many words), moving `evaluateCooperative` into a Worker only touches `runtime.ts`.

## Measured (synthetic clips, this machine: i5-6300U; `node --experimental-strip-types scripts/local-wake-bench.mjs`)
| clip | audio | cost | per second of audio |
|---|---|---|---|
| "Sudo" | 1.34 s | 11.9 ms | 8.9 ms |
| "Sudo kaise ho" | 2.43 s | 19.4 ms | 8.0 ms |
| 5 words | 3.51 s | 28.4 ms | 8.1 ms |
| 8 s of chatter (search capped at 4.5 s) | 7.96 s | 34.1 ms | 4.3 ms |
| 3 s of fan noise (no speech) | 3.00 s | 20.4 ms | 6.8 ms |

Worst case 34 ms; at 5 / 15 / 30 finished clips a minute that is 0.28 / 0.85 / 1.7 % of one core (budget was 8 %). Idle silence costs nothing: the check runs only on clips the VAD already ended. Memory: a few hundred KB of temporary arrays per clip, a profile of two words is about 44 KB.

Synthetic accuracy (formant-like synthetic voices; `LOCAL_WAKE_REPORT=1 node --test tests/local-wake.check.mjs`): the owner's synthetic "Sudo" (alone, "-chan", in a sentence, 44.1 kHz) 20/20 candidates; 13 other words x 3 takes + click + fan + silence + 5-word clutter 0 false candidates of 39 (near-words "suno" and "pseudo" DO pass, by design: the cloud decides); 12 synthetic strangers with different pitch/vocal tract 0/12 at 50 % sensitivity. A very quiet take (3.3 vs threshold 3.1) and a noisy-room take (3.25) were misses in the exploration run. **None of this proves anything about a real voice.**

## Modes (Settings > Voice > "On-device name check")
| | not enrolled / check failed / off | candidate | not a candidate |
|---|---|---|---|
| `off` (default) | old quota gate only | (not evaluated) | old gate |
| `assist` | old gate | **sent** (trimmed to 3.5 s) even if the gate would refuse | sent only if the old gate says yes AND quota pressure < 0.4 (or it is the once-a-minute floor) |
| `strict` | old gate | **sent** | never sent |

Always: Live Talk and the 30 s conversation window are never gated or evaluated; barge-in clips are not evaluated; the intent, stop and barge-in logic is untouched; the old 2 s `WakeGate` and error back-off still apply (a refusing stage gives its token back); `wake-word.ts` on the cloud text still decides the wake.
A candidate budget (burst 4, one more per 20 s) turns a flood of candidates into "limited" (treated as non-candidates). The cloud's answer steers the threshold in memory: a candidate the cloud did not confirm tightens it 4 % (floor -25 %), a confirmed one relaxes toward 0, a wake the local check missed (sent by the gate, confirmed) loosens it 5 % (cap +15 %).

## Log (counts only: no audio, no text, no scores), once a minute while anything happened
`[wake-local] candidates=2 rejected=7 sent=3 mode=assist`

## Files
`src/shared/local-wake/`: `types.ts` (interfaces, mode type), `dsp.ts`, `dtw.ts`, `template-engine.ts`, `enrollment.ts` (take validation, calibration, profile parse, self-test text, `EnrollmentSession`), `endpointer.ts`, `registry.ts`, `runtime.ts` (limiter, stats, gate combination, cooperative evaluation, `LocalWakeController`, `decideWakeClip`).
Main: `src/main/local-wake-store.ts` (userData/local-wake.json, 0600, atomic, validated on read and write) and three IPC handlers (`localWakeGet` overlay+settings, `localWakeSave`/`localWakeDelete` settings only); `AppState.localWakeRevision` tells the overlay to reload.
Renderer: `voice-engine.ts` (new optional `localWake` callback, `decideClip(features, local)`), `App.tsx` (controller, `decideWakeClip`), `LocalWakeSettings.tsx`, `local-wake-recorder.ts`.
Tests: `tests/local-wake.check.mjs` (25), `tests/local-wake-pipeline.check.mjs` (4, real `VoiceSession` + `ClipGate` + `WakeGate` with a fake audio stack), helper `tests/helpers/synth-speech.mjs`.

## Privacy
Enrolment records ~2-3 s per take in memory, turns it into 20-60 frames of 24 numbers, and drops the audio. Only those numbers are written (`local-wake.json`, mode 0600, ~22 KB per word). "Delete my voice samples" removes the file. The mic is opened for enrolment and the self-test only, for one take at a time after you press a button in Settings. No network use of any kind in this feature.

## Honest risks
* Synthetic voices are far cleaner than a laptop mic in a room. Expect real recall below the synthetic 100 %; that is what `assist` + the sensitivity slider + the self-test are for. Default stays `off` until the owner validates with real audio.
* Enrolment and listening both use the same `getUserMedia` flags (echo cancellation, noise suppression, AGC on); if those ever change, re-teach.
* A set of takes that mixes two clearly different words can pass the consistency check (leave-one-out only sees nearest neighbours); the self-test is the real gate. `MAX_LOO_SPREAD` (0.2) and `ODD_FACTOR` (1.4) are in `enrollment.ts` if real takes are refused too often.
* Near-words ("suno", "pseudo") pass locally; cloud text matching rejects them or not exactly as before.
* Noise: enrolling in a quiet room and talking in a noisy one raises the score; raise the sensitivity or re-teach in typical conditions.

## Designed, not built: engines that need a model file
`LocalWakeEngine.needsDownload` exists for this. Contract for a later engine: the model is **never** fetched at install or start; Settings shows "Download model (N MB, from <host>)"; one explicit click starts the fetch in the main process, which writes to a temp file, verifies a SHA-256 pinned in the app source (mismatch = delete, error shown), then renames into `userData/models/`; the engine's `create()` returns `undefined` while the file is absent, so the pipeline falls back to the old gate. Nothing in this branch downloads anything.

## Tuning knobs
`dsp.ts` (windows, `TARGET_PEAK_DB`), `dtw.ts` (`STEP_PENALTY`, stretch limits), `template-engine.ts` (`MAX_SEARCH_FRAMES`, `MIN_SNR_DB`, threshold rule in `calibrate`, `effectiveThreshold` scale), `enrollment.ts` (take checks, `MAX_LOO_SPREAD`, `ODD_FACTOR`), `runtime.ts` (`CANDIDATE_BURST`, `CANDIDATE_REFILL_MS`, `ASSIST_MAX_PRESSURE`, offset bounds).
