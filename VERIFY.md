# Verifying the integrated Sudo-chan build

One command, from `desktop/`:

```
npm run verify            # everything, including the real Electron smoke run
npm run verify -- --skip-smoke   # skip the Electron run (no display, or low memory)
```

`npm run verify -- --packaged=release/linux-unpacked/sudo-chan` runs the smoke step against an electron-builder output instead of `electron .` (see desktop/RELEASING.md).

It prints a PASS/FAIL table and exits non-zero on any FAIL. It takes roughly 30-60 s and needs no API keys, no network
(one optional unit test uses the network and skips itself when offline), no microphone and no speakers.

It never touches your real app data: the smoke run uses a throw-away `userData` directory and a temp `HOME`, and Electron's
single-instance lock lives in `userData`, so it runs fine while your own Sudo-chan is open (proved by the run itself, which
reports whether another Electron was running).

## What runs, in order

The build runs before the unit tests because several tests import `../dist/*`.

| # | Check | What it proves | What it cannot prove |
|---|---|---|---|
| 1 | Typecheck (renderer + main) | Types line up across the merged branches | Runtime behaviour |
| 2 | Production build | `scripts/build.mjs` (tsc + esbuild + vite) works; the smoke run uses this exact output | Packaging (`electron-builder`) |
| 3 | Unit tests (`tests/*.check.mjs`) | Pure logic: policy, approvals, STT router, TTS providers, wake word, stop intent, resume, overlay shape, prompts, **voice pipeline with synthetic audio** | Anything needing a mic, speaker or real network service |
| 4 | Static wiring checks (reads the source, comments stripped) | `start()` never calls `safeStorage` (it can hang on some Linux keyrings); tools and screen assist default OFF; every IPC handler is restricted to the intended window kinds; no `console.*` prints keys/auth headers; renderer CSP still has `connect-src 'none'` and no `unsafe-eval`; preload exposes exactly the `DesktopAPI` methods; the native overlay window shape opens room for the caption, screen badge (and an approval panel if one exists); smoke runs use their own `userData`; on-device wake word is off by default with a 0600 profile that stores no audio; every editable `Settings` field is in the Settings page's unsaved-changes test and re-sync list (a missing one silently drops the setting); tool turns send the notes/reminders/tasks tools only when relevant (Groq token budget) The setup wizard (desktop/ONBOARDING.md) is wired as a fresh-install-only mode of the Settings window: first-run detection before the store exists, mic closed until asked, no network or key echo in the page, `setupMode`/`setupLive` limited to the Settings window. | That the code behind a handler is correct. These are tripwires for accidental removal during merges |
| 5 | Real Electron smoke run (`--smoke-test`) | The built app starts without hanging; overlay, chat and settings windows load; the preload API in each window equals `DesktopAPI`; the chat window is refused cloud-config changes; cloud config against a **local fake OpenAI server**; a streamed chat round trip; (if tools exist) a read-only `list_dir` turn runs without a card, a `write_file` turn raises an approval request that is denied on timeout and the model is told the action was NOT done, and the file is not created; the app exits cleanly with no leftover processes The setup wizard never opens in a smoke run; only the Settings window can switch it on, and its live demo is refused while it is closed. | Real model quality or real tool-calling behaviour, real approval clicks, UI appearance |

### How the smoke run stays invisible and safe
Only active with `--smoke-test` (see `src/main/smoke.ts` and the `smokeTest` / `smokeHidden` lines in `src/main/index.ts`):

- `show`, `showInactive` and `focus` of every window are no-ops (`SUDO_CHAN_SMOKE_HIDDEN=1`): the pages load and run, nothing is drawn. No tray icon is created. I could not watch the screen during the run, so "no flash" is by construction, not by observation.
- The OS microphone permission is denied and the wake word is OFF in the temp settings, so the real mic is never opened.
- The global shortcut is remapped to `Control+Alt+Shift+F24` so your `Ctrl+Space` is not touched.
- `safeStorage` is skipped when saving the fake key (on some machines `isEncryptionAvailable()` blocks forever; see "Known gaps").
- The approval timeout is shortened to 1.5 s with `SUDO_CHAN_SMOKE_APPROVAL_MS`.
- The fake server (started by the script on `127.0.0.1`, random port) answers `/v1/models`, streamed chat, and tool-call turns triggered by the markers `SMOKE_LIST` / `SMOKE_WRITE`.
- A hard 90 s kill timer protects against hangs; leftover processes are checked and killed.

## What this harness cannot verify (needs a person)
Microphone and speakers (VAD on a real room, echo, barge-in feel), real wake-word recognition, real Groq/Gemini/Azure answers
and quality, real screenshots (portal capture, consent dialog, badge), tool calls from the real model, how the overlay looks
(caption, glow, approval panel), Wayland/X11 differences beyond this machine, and packaging. Use `TOOLS.md`,
`SCREEN-ASSIST.md`, `INTEGRATION.md` and `TEST-VOICE.md` for the manual checklists.

## Known gaps found while building this
- **Saving an API key can block the app on this laptop.** `encryptApiKey()` calls `safeStorage.isEncryptionAvailable()`, which can block forever on the GNOME keyring here (verified earlier with a scratch app). Startup no longer calls it, but **saving a key from Settings still does**. The smoke run skips it, so it cannot catch this. A real fix needs a timeout/worker or an explicit "store unencrypted" choice.
- The unit test for the 220 ms voiced-audio filter fails if the filter is removed (checked by mutation).

## Merging `tools2` and `screen2` later
Both branches were started from `integrate` and do not contain this harness or the caption/screen-badge shape fix.
`integrate-verify` (this branch) has both, so build the combined branch from it:

```
cd "/home/lenovo/Desktop/new 3"
git worktree add .claude/worktrees/integrate2 -b integrate2 integrate-verify
cd .claude/worktrees/integrate2
ln -sfn "/home/lenovo/Desktop/new 3/desktop/node_modules" desktop/node_modules   # no npm install needed

git merge tools2            # resolve conflicts (see hot spots), then:
(cd desktop && npm run verify)

git merge screen2           # resolve conflicts, then:
(cd desktop && npm run verify)
```

Run `npm run verify` after EACH merge so a failure points at one branch. If `voice-fix` has newer commits than the
caption fix, `git merge voice-fix` first (the caption commit is already in `integrate-verify` as a cherry-pick, so git will
treat it as already applied or as an identical change).

### Conflict hot spots and what to keep
- `desktop/src/main/index.ts`
  - `sendChat()` / `CHANNELS.send` and the `stop` / `toolsStopAll` handlers: keep `cancelScreenCapture(); conversation.stop(); stopAllTools();` everywhere a stop happens; keep `['chat', 'overlay']` for `stop`.
  - `ApprovalManager({ ... })`: keep the one-line `timeoutMs: smokeTest ? smokeApprovalTimeoutMs() : undefined` (the smoke test needs it).
  - `updateOverlayShape()`: the expression must include **every** overlay panel flag: `state.speech || state.captionVisible || state.screenStatus` plus whatever flag `tools2` adds for an approval panel on the overlay. A missing flag makes that panel invisible/unclickable on Linux (the window shape clips it). `npm run verify` checks caption, screen badge and (by name) an approval panel.
  - Tool approval IPC (`toolApprovals`, `toolApprovalReply`): `tools2` may allow `overlay`; any other extra window kind should be questioned.
- `desktop/src/renderer/App.tsx`: the overlay JSX (`screen-badge`, caption, a new approval panel, glow, dot); `handleUnclear` / stop-intent / resume handlers; the settings dirty-check lists.
- `desktop/src/main/local-ai.ts`: `buildSystemPrompt` must stay truthful in every combination (voice-hearing line, tools on/off, screenshot attached or not); the `options.vision` branch vs the tool loop.
- `desktop/src/shared/types.ts`: `AppState` (`captionVisible`, `screenStatus`, any approval flag), `DesktopAPI`, `CHANNELS`; the preload must expose exactly the `DesktopAPI` methods (verify checks this).
- `desktop/src/renderer/styles.css`: panel positions share the top 29% of the overlay; two panels must not overlap.
- `DECISIONS.md`, `REPORT-VOICE.md`, `TOOLS.md`, `SCREEN-ASSIST.md`, `INTEGRATION.md`: keep both sides.

After the last merge also run the manual checklists with a real microphone.
