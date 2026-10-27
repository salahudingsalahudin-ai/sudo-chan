# Changelog (desktop)

## integrate6 review (planner + local-wake + installer-release merged onto main 3c689fb)

Details in `INTEGRATE6.md`. The three branches were merged with hand-resolved conflicts and then reviewed together.

- **Token budget on tool turns:** the file/command tools are always offered, but the 13 notes / reminders / tasks tools (about 1,100 tokens of definitions) and their
  prompt lines (about 200 tokens) are sent only when the latest message or the exchange just before it talks about tasks, reminders, notes or the day's plan
  (`src/main/tools/tool-gate.ts`, English / Roman Urdu / Urdu script, errs towards offering). Every tool step re-sends this list and Groq's free tier allows about
  7,000 input tokens a minute for the main model, so a plain "read this file" turn now costs roughly a third less per step. The tool runtime itself is unchanged
  (a hidden tool called anyway still goes through policy, approval and audit). The default prompt text (`TOOLS_PROMPT`) is unchanged.
- **Tests / verify:** `tests/integrate6.check.mjs` (10: settings fields in the unsaved-changes test and re-sync list, patch merge and validation of the three new
  settings, IPC uniqueness / window kinds / preload, lazy startup, tool gate, prompt size, real `LocalAI` request, packaging file list). Two new `npm run verify`
  wiring checks (Settings fields in App.tsx; tool gate wired). Numbers are in `INTEGRATE6.md`.
- Changelog: blank lines between the merged sections, stale local-wake test counts marked as per-branch numbers.

## planner (on top of integrate5): "Aaj ka kaam" daily planner and "mera kaam utha lo"

Details, phrases to try and known gaps in `PLANNER.md`.

- **Pure logic `src/shared/tasks.ts`:** add / update / complete / start / remove / reorder, today's plan (overdue, due today, in progress, priority; max 5),
  next task, filters, finding a task by id or words, strict validation of everything read from disk, and a date parser for English, Roman Urdu and Urdu script
  (aaj, kal, parson, subah, dopahar, shaam, raat, "5 baje", "saade paanch baje", "agle hafte", "3 din baad", weekdays, "in 2 hours", Urdu digits).
- **Store `src/main/tasks-store.ts`:** `tasks.json` in userData, mode 0600, atomic write (temp + fsync + rename), `.bak` of the last good file, damaged
  file copied to `tasks.corrupt.json` then restored from the backup, size and count caps. Never in `config.json`, no keys.
- **Seven tools** in the existing registry (`add_task`, `list_tasks`, `update_task`, `complete_task`, `plan_today`, `next_task`, `start_task`): auto-approved,
  audited, validated like `save_note`/`set_reminder`, off when "Let Sudo-chan use tools" is off. `TOOLS_PROMPT` explains when to use them, to answer in the
  user's language in 1-3 short spoken sentences, and that starting a task is not doing it. `start_task` adds no permission.
- **Reminders link:** `set_reminder` takes `task_id`; `add_task`/`update_task` with `remind=true` set a reminder at the due time; finishing a task cancels it.
- **Chat window panel** (`TasksPanel.tsx`): collapsed "Aaj ka kaam - N baqi" bar, today's plan with check-off, add box with date words, works with tools OFF.
  Three chat-only IPC channels (`tasksList`, `tasksAdd`, `tasksAct`) plus a chat-only push channel (`tasksState`); preload and `DesktopAPI` updated; the verify
  wiring list knows the new channels. No overlay UI, no popups, no new notifications.
- **Tests:** `tests/tasks.check.mjs` (96: dates, plan, validation, panel actions, in 4 time zones), `tests/tasks-store.check.mjs` (28: file, recovery, caps, tools,
  policy/audit, reminders link, IPC wiring, prompt); 6 new checks in the real Electron smoke run.

## local-wake (on top of main 3c689fb): on-device "is that my name?" check before the cloud

Wake mode still depended on a cloud round trip to judge every clip. Now a local check marks clips as wake-word candidates first. Details, research and scoring in `LOCAL-WAKE.md`; real-voice check in `TEST-LOCAL-WAKE.md`.

- **Engine (`src/shared/local-wake/`, pure):** personalised template matching (resample to 16 kHz, MFCC + deltas, subsequence DTW, leave-one-out calibrated threshold). No model file, no download, no account. Pluggable `LocalWakeEngine` / `LocalWakeDetector` registry.
- **Setting `localWake`** `off` (default) | `assist` | `strict`, plus `localWakeSensitivity` (0..1). Assist: candidates always go, other clips only if the old quota gate says yes and quota is healthy. Strict: only candidates. Live Talk, the 30 s window, barge-in, intent and stop logic untouched; the cloud text still decides the wake.
- **Voice engine:** optional `localWake` callback + `decideClip(features, local)`; evaluation is sliced into 4 ms steps on the renderer thread (measured 8-9 ms CPU per second of clip audio, <2 % of a core at 30 clips a minute; no Worker needed).
- **Limiter:** candidate budget (burst 4, 1 per 20 s) and an adaptive threshold offset (-25 % .. +15 %) steered by the cloud's answers.
- **Settings > Voice:** "Teach her your voice saying Sudo" (5-8 takes, live level meter, quality checks, optional "Sid"), accuracy self-test ("Heard 3/3"), sensitivity, "Delete my voice samples". Nothing on the overlay.
- **Storage:** `userData/local-wake.json`, mode 0600, atomic, validated on read and write; feature vectors only, never audio. Three IPC handlers (get: overlay+settings; save/delete: settings only).
- **Log:** `[wake-local] candidates=N rejected=M sent=K mode=...` once a minute, counts only.
- Tests: `tests/local-wake.check.mjs` (25) + `tests/local-wake-pipeline.check.mjs` (4); one new verify wiring check. (per branch, before the merge) `npm run verify` 38/38, unit tests 491 pass (462 before; two unrelated timing tests flaked under load in earlier runs, a rerun was clean). Everything is verified on synthetic audio only.

## installer-release (on top of main 3c689fb): packaging, update check wired in

- **Packaging** (`package.json` `build`): AppImage + deb for Linux, nsis (Windows) and dmg (macOS, x64 + arm64) configured but NOT built or tested here.
  Artifact names `Sudo-chan-<version>-<os>-<arch>.<ext>`, icons in `assets/`, executable `sudo-chan`, desktop entry + category Utility,
  maintainer/author `Sid <noreply@sudo-chan.vercel.app>` (placeholder, owner TODO). Tray icon now read from `assets/icon.png` (the old
  `build/icon.png` path never existed, so the tray always showed a 1x1 fallback). The Linux X11 relaunch in `bootstrap.ts` is unchanged and works
  the same packaged; `start()` still never touches `safeStorage`.
- **Update check wired in:** `src/shared/update-check.ts` (moved from `src/main`) runs in the main process 20 s after start and is re-evaluated hourly,
  but asks GitHub at most once per 24 h. Settings shows one calm line + a switch (`updateCheckEnabled`, default on); IPC `updateNotice` is Settings-only
  and returns a version number only. Never in smoke runs, never a popup, never on the overlay, no download. Tests in `tests/update-check.check.mjs`.
- Release docs: `RELEASING.md` (owner steps), root `CHANGELOG.md`, `.github/workflows/{ci,release}.yml` (checksum file is `SHA256SUMS`).

## quota-saver (on top of mic-indicator): wake mode stops burning the free Groq listening allowance

Wake mode sent every speech clip to Groq Whisper (~5 requests a minute while idle, 20 of 25 were room talk). Details in `QUOTA-SAVER.md`.

- **`src/shared/clip-gate.ts` (pure):** `ClipGate` decides locally whether a wake-mode clip is worth a cloud request: junk filters
  (impulse, hiss, steady noise), monologue skip, three token budgets (name-shaped after quiet / other after quiet / right after chatter),
  busy-room rule, repeat rule, 60 s floor, back-off on clips without the name, loosening on hits. Live Talk and barge-in are never gated.
- **Quota pressure** (0..1) from Groq's own headers via `UsageTracker.sttQuotaPressure()`, returned inside the existing transcribe reply
  (`quotaPressure`). No new channel, `authorize()` unchanged.
- **Voice engine** measures each clip (`ClipFeatureAccumulator`, `frameStats`) and calls the new `decideClip` callback; wake-mode uploads are
  trimmed to the first 3.5 s (was 4 s). `shouldTranscribe` still works for other callers.
- **Log:** `[gate] skipped=N sent=M reason=...` once a minute per decision class, counts only. Nothing new on the overlay.
- Simulated (8 seeds each): quiet room -84% requests, idle room talk -71%, TV with lulls -82%, TV wall to wall -88%; the bare name and
  "name, pause, request" are always sent. Known cost: "Sudo kaise ho" in one breath in a busy room may need a second try.
- Tests: `tests/clip-gate.check.mjs` (19) + 1 case in `tests/voice-pipeline.check.mjs`.

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
