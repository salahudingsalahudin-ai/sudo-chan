# Changelog (desktop)

## urdu-stt (on top of mic-indicator): Urdu / Roman Urdu / Hindi-script transcripts now match, one-word commands survive

About half of the quiet-mic Roman Urdu clips came back empty or in a script the wake / stop / intent logic did not match.
Audit and reasoning in `URDU-STT.md`; recording test in `TEST-URDU.md`.

- **Found in code:** one-word commands ("ruko", "bas", "Sudo." with punctuation) were rejected as invalid; "ruko ruko ruko ruko" was
  rejected as repeated garbage; fast mode never asked Gemini after an empty Whisper answer.
- **Transcript normaliser** (`src/shared/transcript-normalize.ts`): Urdu-script, Devanagari and Roman variants of wake names, stop
  words, yes/no and screen/task verbs -> canonical Roman words, for matching only. `wake-word`, `stop-intent`, `intent` and the
  phantom filter try the original text first, then the aliased text (can only add matches). Display / chat text is never rewritten.
- **One retry for empty results of clear speech** (>= 1.2 s, above idle level, bot silent, Groq quota >= 25 %), different strategy
  (other provider, or Whisper without prompt / forced language). Counted in the usage meter. Hallucination-filtered results are never retried.
- **Borderline silence band:** a quiet 3+ word sentence is kept when Whisper's no_speech_prob is 0.6-0.85 and avg_logprob above -1.6;
  the "Sudo-chan, Sido-chan," prompt leak is still rejected. Numbers are reasoned, not measured.
- **Diagnostics:** `[STT] whisper model= lang= segs= nsp= logprob=`, `voiced=` in the clip line, `retried=1`.
- **Self-check:** `scripts/stt-check.mjs` + `TEST-URDU.md` (20 phrases). Not run (needs real audio and keys).
- Tests: `tests/transcript-normalize.check.mjs` (12), `tests/stt-retry.check.mjs` (15). `npm test` 442 pass; `npm run verify` 37/37 (under memory pressure the smoke step and one timing test can flake; a rerun was clean).

## mic-indicator (on top of fix-phantom-wake): the mic can no longer be switched off by accident

Root cause of "the bot stopped hearing me": the mic dot lived inside the chat-opening pill, so a click meant for the pill turned the
microphone off. Details in `MIC-INDICATOR.md`.

- **Separate mic switch** (26 px button, 8 px left of the pill). Clicking the pill never touches the mic.
- **Obvious state, no extra text:** green glowing dot = listening; blue ringed dot = Live Talk; hollow amber ring = resting;
  dim dot with a diagonal slash = OFF (the bot also looks calm and muted). Shapes differ, so it is colour-blind safe.
- **Gesture:** ON = one click. OFF = click, then click again within 3 s (first click arms the dot). The tray item is unchanged.
- **Settings Save no longer overwrites the mic:** renderer sends patches (`{ patch, source }`), main merges onto its current settings
  and validates as before; the Settings window sends only the fields it changed.
- **Log line** `[mic] wakeWordEnabled true->false source=dot|tray|settings|chat` on every change (source is an allow-list, log only).
- Overlay window shape has an explicit region for the mic switch.
- Tests: `tests/mic-control.check.mjs` (20) + 1 overlay-shape case. `npm test` 415 pass; `npm run verify` 37/37.

## fix-phantom-wake (on top of integrate4): the bot no longer wakes and talks by itself

Live log: 5 replies in ~2 minutes with nobody speaking, every "heard" text was `Sudo-chan, Sido-chan,` and every reply ended in
`speech:stop reason=barge-in`. Details in `PHANTOM-WAKE.md`.

- **Prompt leak fixed.** The Whisper `prompt` began with the wake names (and the wake hint added a second name list), so on quiet clips
  Whisper wrote the names back and the wake gate matched. New prompt is one natural sentence with the name once, never first;
  `buildWhisperPrompt()` reduces the wake hint to a single name and never duplicates it.
- **Hallucination filter** `src/shared/stt-hallucination.ts` (pure): drops empty text, stock Whisper junk ("Thanks for watching"),
  names-only transcripts with 2+ names ("Sudo-chan, Sido-chan,", "Sid sudo", "Sid Sid") and copies of our prompt. A single name,
  "Sid, kaise ho?", "Sid ruko", Urdu script all pass. Applied in `isValidTranscription` (every provider) and again in the overlay and chat
  `onFinal` with the user's own wake names.
- **Whisper confidence:** Groq/OpenAI requests use `response_format: verbose_json`; a result whose segments are all
  `no_speech_prob > 0.6` and `avg_logprob < -1` is treated as silence. No segments (fake servers, old servers) means the text is kept.
- **Echo-aware barge-in** (`src/shared/barge-in.ts`): the detector keeps a peak-hold echo envelope of the bot's own voice in the mic and
  needs speech about 1.4 to 2.0 times above it (default 1.7, about +4.6 dB; scales with the existing sensitivity slider) for the usual
  150-250 ms. First 350 ms of each reply only learn the echo (only a clearly louder voice interrupts). Short bursts that die out are
  learned as echo peaks. Threshold is capped at 0.3 so shouting always works. A reply that continues the previous sentence skips the warm-up.
- **Echo tail and clips:** for 600 ms after a reply ends, a new clip must also beat the envelope; a clip that overlapped playback or the
  tail, did not trigger barge-in and stayed at echo level is dropped and never sent to speech-to-text (`clipIsEcho`).
- **Overlay safety net:** within 3 s of the bot's own speech, a transcript that is only its name plus words it just said is ignored
  (`isSelfEchoTranscript`; `getLastBotSpeech()` in `speech.ts`).
- Tests: `tests/phantom-wake.check.mjs` (27 tests). `npm test` 394 pass; `npm run verify` 37/37.

## task-agent (on top of integrate3): "mera kaam lena" on files

- **New tool `edit_file`** (path, old_text, new_text): exact, unique match required (0 or several matches give the model a
  clear instruction), same path policy and approval click as `write_file`, card shows the changed lines as `- old` / `+ new`,
  re-checked just before writing, atomic temp+rename, file mode kept, audit entry without contents.
- **`read_file` paging:** optional `start_line` / `end_line`, default page ~6 KB (was 20 KB) with a
  "call again with start_line=N" footer; small files unchanged. Keeps tool turns inside Groq's 7000 tokens/minute.
- **`max_tokens` for write turns:** 1900 on Groq (3000 elsewhere) only when the message asks for a change or a file was just
  read; everything else stays 950 / 1500. 429 fallback unchanged.
- **Tool trace in history:** `ChatSession` keeps `[tools: read ~/a.py (lines 1-80); edited ~/a.py]` (paths and verbs only, max 300
  chars) beside the assistant reply so "ab isko run karo" has context. Not a bubble, not spoken, not in the window state.
- `TOOLS_PROMPT`: prefer `edit_file`, `write_file` only for new files, page big reads, explains the trace line.
- New: `src/main/tools/trace.ts`. Tests: `tests/edit-file.check.mjs` (14 tests); one older test now expects 10 tools.
  Docs: `TOOLS.md` ("Doing a task on your files").

## key-security (on top of integrate3)

- **Honest key storage text.** Settings no longer says keys are "encrypted via safeStorage". The wording now comes from one
  function, `describeKeyStorage()` in `src/main/key-storage.ts` (shown through the settings-only IPC `getKeyStorageInfo()`),
  so UI and docs cannot drift. On Linux it says plainly: kept in a private file, **not encrypted** (base64 only).
  Windows / macOS name DPAPI / Keychain and admit the plain fallback.
- **Permissions.** `config.json` is written with mode 600 (`configFileMode`), `~/.config/Sudo-chan` is 700, and an older
  world-readable file is tightened at start (`src/main/key-files.ts`, best effort, never throws, synchronous fs only).
  `safeStorage` is still never called at startup; no `secret-tool` / libsecret route was added (cannot be proven non-blocking
  here; noted in `KEY-ROTATION.md` as a future option).
- **Remove saved keys** (Settings, Your privacy): click + confirm; clears the key of every provider (chat, Gemini, Groq, Azure)
  from `config.json` and from memory (`stripAllKeys`, IPC `clearSavedKeys()`, settings window only). Provider, model and
  region are kept. Voice can never trigger it.
- **`KEY-ROTATION.md`**: step-by-step key rotation for Groq and Gemini (and Azure), with "never paste keys in chat".
- **Chat window voice uses the same intent routing as the overlay** (`src/shared/chat-voice-turn.ts`): a screen phrase starts
  the normal screen flow (consent, countdown, sensitive-window guard, cooldown) only when screen assist is ON; chat, task and
  unsure utterances stay plain messages. No new capture path.
- Tests: `tests/key-security.check.mjs` (14 tests) and 5 in `tests/intent.check.mjs`. `npm run verify` got one wiring check
  (config 600 / folder 700 / Remove saved keys wired, IPC kinds) and three smoke checks (chat/overlay refused, 600/700 modes,
  Remove saved keys clears memory and disk).

## usage-meter (on top of integrate2)

- **Realistic voice for every reply.** New setting `ttsQuality` (default `best`): Gemini voice is tried for every reply,
  one-word ones too, while it is not in a 429 back-off. `save` keeps the old rule (only replies of 3+ words use Gemini).
  Cached clips stay free, and the Gemini -> Azure -> Google fall-through is unchanged. Before this, short replies silently
  went to the robotic Google voice (about 72 of 85 replies in one real session).
- **Free usage meter.** New counters (per local day, 31 days kept; Azure per month) saved in `userData/usage.json`, no keys.
  Counts Gemini voice, Gemini listening, Groq listening (requests + audio seconds), Groq chat (requests + tokens), Azure
  characters and basic-voice fallbacks.
- **Real remaining quota for Groq** from the `x-ratelimit-*` response headers (listening, chat, tool turns, screenshot turns).
- **Gemini voice:** used vs an estimated 10 calls a day (always tagged "estimate"); a 429 marks "limit reached" until the
  reset time Google gave, and that is remembered across restarts.
- **Settings > Free usage** section (progress bar per service, `ttsQuality` control). **Chat window** shows one calm line
  only when Gemini voice hit its limit. The overlay bot is unchanged.
- IPC `companion:usage` (`getUsage()`), allowed for the Settings and Chat windows only.
- Tests: `tests/usage-meter.check.mjs` (25 tests); one older test now passes `getQuality: () => 'save'`.
  `npm run verify` got one smoke check for the new channel.

See `USAGE-METER.md`.

## intent-routing (on top of integrate2)

- New `src/shared/intent.ts`: `classifyIntent` (screen / task / chat, English + Roman Urdu + Urdu script) and `routeSpeech`. Default is no screenshot when unsure.
- Wake word: with "look at my screen" ON, only utterances that point at the screen start a screenshot ("meri screen dekho", "ye kya hai"). "Sudo, kaise ho?" and "Sudo, notes.txt bana do" no longer take a screenshot; tasks reach the tool loop.
- Live Talk window: "meri screen dekho" now starts the normal screenshot flow (same consent, countdown, sensitive-window guard and cooldown) instead of plain chat.
- Screenshot follow-ups: with tools ON, a command ("ye file edit kar do") is never treated as a vision follow-up; "file / window / tab / message / fix" alone no longer count as pointing words.
- Screenshot turn prompt: describes the screen and asks the user to repeat the task as a separate request (images and tools are never sent together).
- Settings privacy text no longer claims Sudo-chan never accesses screen / mic / files; it now says when each is used.
- Tests: +16 (309 total), see `tests/intent.check.mjs` and `tests/screen-flow.check.mjs`. Docs: `INTENT-ROUTING.md`, `../SCREEN-ASSIST.md`.
