# Urdu / Roman Urdu speech recognition: audit and fixes

Symptom: about half of the real clips (Pakistani Roman Urdu / Urdu / English mix, 2-4 s, quiet mic) gave "Could not transcribe speech",
or a transcript in Urdu / Hindi script or an odd Roman spelling that the wake / stop / intent logic did not match.
No audio was available and no provider was called while writing this: everything below is either **verified by unit tests**
(deterministic logic) or **reasoned** (provider behaviour; needs a real-audio check).

## What the app sends today

| Item | Groq Whisper | Gemini |
|---|---|---|
| Model | `whisper-large-v3`, then `whisper-large-v3-turbo` only after a non-429 error | `gemini-flash-lite-latest`, then `gemini-flash-latest` |
| `language` | only when Settings says English (`en`) or Urdu (`ur`/`ur-PK`); `auto` sends none | not a parameter; the prompt says English / Urdu+English / auto |
| `prompt` | one natural Roman Urdu sentence with the name once, never first (phantom-wake fix) | instruction text: write Urdu in Roman letters, English as English, `[none]` for no speech |
| `temperature` | `0` (Groq then raises it itself if its quality thresholds fail) | `0`, `maxOutputTokens 160` |
| `response_format` | `verbose_json` (segments with `no_speech_prob`, `avg_logprob`, detected `language`) | n/a |
| Timeout | 9 s per request | 9 s |
| Mode | `fast` (default): Groq first, Gemini only for longer garbage; `accurate`: Gemini first | |

## Likely causes of empty / unusable results (found in the code)

Verified in code and fixed (with tests):

1. **One-word commands were thrown away.** `isValidTranscription` accepted a single word only if it was in a tiny list
   (`sid sudo ji haan suno kaho bye hello hi yes no theek kya`) and compared the raw text, so Whisper's usual `Sudo.` / `Sid,` (with
   punctuation) failed too. "ruko", "bas", "chup", "stop", "dekho" and the Urdu / Hindi script forms ("رکو", "रुको") all came back as
   "Could not transcribe speech". That is exactly the stop-while-talking case. Now: punctuation is ignored and a word is valid if it
   is a known command / answer in any script or a stop command.
2. **`ruko ruko ruko ruko` was rejected** as repeated-token garbage (4 words, one repeated). Stop commands are now exempt.
3. **Fast mode never asked Gemini after an EMPTY Whisper result** (0 words < 4 -> immediate failure). Quiet Roman Urdu clips are
   exactly where Whisper says "silence". See the single retry below.
4. **Arabic-script Whisper output** (`رکو`, `سوڈو`) made fast mode spend an extra Gemini request even when the text was already a
   usable command. Now a recognisable command (wake name / stop word / known short command) is accepted as is: one request fewer.
5. **Downstream matchers only knew Roman spellings** (and some Urdu script for stop / intent; Hindi script nowhere). Fixed by the
   normaliser below.

Reasoned from Whisper / Groq behaviour (not measured; **needs a real-audio check**):

6. **Silence filter on quiet Roman Urdu.** The rule (every segment `no_speech_prob > 0.6` AND `avg_logprob < -1`) is Whisper's own
   standard rule. But Urdu written in Latin letters is rare in Whisper's training data, so its `avg_logprob` is often below -1
   even for correct text; on a quiet clip `no_speech_prob` can also sit in 0.6-0.8. Both conditions can then hold for real speech.
   Change: the strict rule stays, except in a **borderline band** (no segment above 0.85 no-speech, every `avg_logprob` above
   -1.6) where a result of **3 or more non-name words that is not a phantom** is kept. The prompt-leak ("Sudo-chan, Sido-chan,",
   1-2 name words) is still rejected by this rule AND by the independent name-list filter. The 0.85 / -1.6 numbers are my reasoning;
   the new `[STT] whisper ... segs= nsp= logprob= lang=` log line prints the real values so you can tune them.
7. **Forced language.** If Settings > Voice Recognition Language is **English**, Whisper is told the audio is English and renders
   Roman Urdu speech as wrong English words (or nothing). If it is **Urdu**, Whisper answers in Urdu script (now handled by the
   normaliser) and the Latin-script prompt conflicts with it. **Recommended: leave it on Auto.** I did not change the setting's
   behaviour, because the user chose it.
8. **Whisper language detection on 2 s clips** can pick Hindi (Devanagari output), Arabic, Persian or even an unrelated language.
   With `auto` the log now shows the detected language per clip. A fixed `language=ur` is not clearly better (cause 7), so no change.
9. **Model choice.** `whisper-large-v3` first is right for Urdu; turbo is known to be weaker on non-English. Not changed. Idea,
   deliberately not done: on a 429 from large-v3, Groq's limits are per model, so turbo might still have quota. In fast mode that
   would pick weaker turbo instead of Gemini (better on Urdu), so it is not worth it.
10. **Minimum length / voiced time** is decided in the renderer (`voice-engine.ts`, `MIN_VOICED_MS`, clip gating). That file belongs
   to the `quota-saver` work and was not touched.

## What changed

| Where | Change |
|---|---|
| `src/shared/transcript-normalize.ts` (new, pure) | `aliasForMatching(text)`: known command tokens in Urdu script, Hindi/Devanagari and creative Roman spellings -> one canonical Roman word (wake names `sudo`/`sid`, "chan" only right after a name, stop words, yes/no, screen / look / task verbs, a few nouns, pointing/question words). Unknown words, spacing and punctuation are untouched; token count never changes. Matching only: display and chat keep the original text. |
| `wake-word.ts`, `stop-intent.ts`, `intent.ts`, `stt-hallucination.ts` | Each matcher tries the ORIGINAL text first, then the aliased text. The second pass can only add matches, so all earlier behaviour is a floor. `matchWakeWord` cuts `rest` from the original words. The name-list phantom filter also recognises Hindi / Urdu script name lists. |
| `src/main/stt.ts` | One-word commands valid (cause 1), stop repeats exempt (2), Arabic-script commands accepted (4), borderline silence band (6), Gemini prompt says one short command word is a valid transcript, bare mode, log line with Whisper `language`, `segs`, `nsp`, `logprob` (numbers only), `reason` / `retried` on the outcome. |
| `src/shared/stt-retry.ts`, `clip-stats.ts` (new, pure) | Retry policy and WAV level measurement (seconds, rms, peak, voiced ms). |
| `src/main/index.ts` | Measures the clip, tells the router whether the bot is speaking / spoke within 4 s (`activeSpeech`, `isSpeaking`, last speech event), logs `voiced=`. |
| `src/shared/usage.ts` | `groqSttRemainingFraction()` from Groq's own headers (unknown when stale or after the reset time). |
| `scripts/stt-check.mjs`, `TEST-URDU.md` | Self-check you run with real recordings. |

## The single retry (quota-neutral)

After the normal pass, **one** more request is made only if ALL hold: the first result was EMPTY (nothing heard; not
hallucination-filtered, not an error, not rate-limited); the clip is at least 1.2 s, rms at least 0.015 (idle noise is about 0.009)
and has at least 300 ms of voiced frames; the bot is not speaking and did not speak in the last 4 s; Groq listening has at least 25 %
of its allowance left (unknown counts as fine); and it has not been retried. The strategy differs from the first pass: another
provider if one is usable (fast: Gemini; accurate: Whisper), otherwise Groq again **without prompt and without forced language**
(Gemini also gets its generic prompt without hint). It is counted by the usage meter like any request. 'fast' / 'accurate'
semantics are unchanged (they only decide the first order).
Volume: worst case +1 request per empty clip of clear speech; cleared noise / echo / short clips cost nothing extra, and
Arabic-script commands now cost one request less. Net effect depends on how many clips are noise; the wake gate's per-clip limit
(other branch) lowers the clip count first.

## Verified vs reasoned

- **Verified (unit tests):** the normaliser per script, no over-matching on normal words / sentences ("sudden", "side", "sad", "seed", "bass", "bus", China), wake `rest` from original words, stop / intent matching in all three scripts, existing stop / intent behaviour, the retry policy, router retry behaviour (once, not on filtered / short / quiet / bot speech / low quota), prompt-leak still dropped, bare retry sends no prompt / language, WAV level maths, borderline band, usage fraction.
- **Reasoned, not measured:** how Whisper / Gemini actually render your voice; the 0.85 / -1.6 band; whether quiet Roman Urdu really lands in that band; best language setting; whether Gemini's prompt addition changes anything; whether the Hindi / Urdu spellings in the alias table are the ones the providers really produce.
- **Needs real audio:** run `TEST-URDU.md` once (fast and accurate) and look at the `lang=` / `nsp=` / `logprob=` log lines. If real speech is still dropped with `nsp` 0.85-0.95, raise `BORDERLINE_NO_SPEECH`; if the table shows spellings the normaliser misses, add them to `ALIAS_GROUPS`.

## Trade-offs

- A Hindi-script word like "बस" ("only") now counts as the stop word `bas` in a 1-4 word utterance of stop words / fillers only (same rule as the Roman word).
- `بند` alone with other words used to be a stop; now "band" needs "karo / kar do" like the Roman form.
- The new Gemini prompt sentence slightly raises the chance of a one-word answer on noise; the hallucination filters and the clip gate still apply.
