# integrate2: the final integrated build

Branch `integrate2` = `integrate-verify` (verify harness, caption and screen-badge shape fixes, on top of `integrate`)
+ `tools2` (hardened tool loop, approval panel on the desktop bot, notes and reminders)
+ `screen2` (screen assist: consent panel, countdown, sensitive-window guard, 2-minute in-memory cache).

Commits: `e5f1f82` (merge tools2), `1c280c5` (merge screen2, panel slot, key storage), plus the docs commit that adds this file.
Nothing was pushed. The running app (branch `voice-fix`) was never touched.

## Conflicts and how they were resolved

| File | Conflict | Resolution |
|---|---|---|
| `src/shared/types.ts` | `AppState` flags (tools2: `approvalVisible`, `toolStatus`; screen2: wider `screenStatus`, `screenCountdown`, `screenNotice`), `DesktopAPI.onReminder`, `CHANNELS.reminderDue` | Kept everything from both sides |
| `src/preload/index.ts` | `onReminder` next to `setCaptionVisible` | Kept both |
| `src/main/index.ts` | `updateOverlayShape()` (three different expressions), `stop` / `toolApprovals` handlers | Shape now comes from the panel slot (below). `stop` keeps screen2's `keepScreen` argument and cancels screen capture + reply + tools; `toolApprovals` stays `['chat', 'overlay']` |
| `src/shared/overlay-shape.ts` | tools2: `speech: boolean \| 'approval'`; screen2: extra `tall` flag | Rewritten around one `panel` argument; the legacy boolean/`tall` forms still work (old tests keep passing) |
| `src/renderer/App.tsx` | Overlay JSX: old screen badge, approval panel, caption, `ScreenPanel`, greeting bubble | Replaced by one panel slot (below). The old `screen-badge` button is gone (ScreenPanel renders badges) |
| `DECISIONS.md` | Both appended sections | Kept both |
| `src/renderer/styles.css` | merged cleanly; added a rule that gives every top panel the same box | |

Not a conflict, but found while merging: the old `OverlayApproval` had its own Esc listener. With several prompts possible
it would also have fired while a different panel was visible, so Esc is now one central handler tied to the visible panel.

## The panel-slot design

The small overlay window has one top region. Five things wanted it: tool **approval**, screen **consent**, the **countdown**
before the first screenshot, **notices** (declined, sensitive window, capture failed), the **"looking" badge**, the Live Talk
**caption** and the old greeting bubble.

`src/shared/overlay-panels.ts` (pure, unit-tested) decides which single panel is visible:

```
approval > consent > countdown > notice > capturing > caption > hint > speech
```

- Exactly one panel is drawn. The rest are **queued**: they are still in the app state and appear as soon as the panel above
  them ends (approval denied -> consent shows; consent answered -> the caption shows).
- A caption can never cover an approval or a consent prompt (tested for every combination).
- The screen hints "📸 Screen bheji gayi" / "📎 Purani screen par based" are folded into the caption as a small chip, so they
  never hide her answer. Alone (no caption) they are the panel.
- **One native shape rule.** `overlayShape(width, height, panel)` opens the region the visible panel needs (`approval` 60 %,
  `notice` 45 %, `consent` 52 %, everything else 29 % of the window height). Main computes the panel with
  `activePanelForState(state)` from the published flags (`approvalVisible`, `screenStatus`, `captionVisible`, `toolStatus`,
  `speech`); the renderer computes it with `panelPlan(...)` from the same inputs, so the drawn panel and the clickable
  region cannot disagree. On Linux a missing region means the panel is invisible or unclickable, so this matters.
- **Same look.** Approval, consent/notice, caption and greeting all use the same box (`top 2 %, left 5 %, width 90 %`) and
  the dark-glass style.
- **Esc** refuses or cancels the visible prompt only: deny the approval, decline the consent, cancel a pending capture
  (`escapeAction`). Esc never grants anything. It works when the overlay has keyboard focus (click the bot first); the
  overlay is a non-activating window, so a global Esc is not possible without a global shortcut.
- **Voice never approves or consents.** `respondToolApproval` is reachable only from the two approval UIs' buttons and the
  Esc-deny; `screenConsent` is called by the two ScreenPanel buttons and by Esc as `screenConsent(false)` only (a test
  asserts `App.tsx` never calls it with anything but `false`, and that no speech/STT/voice module references either API).
  Consent and approval each speak one short line asking the user to click; speaking changes nothing.

## Key saving can no longer hang (new `src/main/key-storage.ts`)

`safeStorage.isEncryptionAvailable()` can block forever on the GNOME keyring of this laptop (a scratch Electron app showed
no answer after 25 s, SIGTERM ignored). It is synchronous, so a timeout cannot protect the main thread. Decision:

- **Linux: safeStorage is never called.** Keys are stored as base64 (`rawKey`). **That is obfuscation, not encryption**; anyone
  who can read `~/.config/Sudo-chan/config.json` can decode them. Rotate keys if the file is ever shared.
- **Windows / macOS:** safeStorage (DPAPI / Keychain) is used; it does not block there.
- `SUDO_CHAN_USE_KEYRING=1` opts a Linux user in at their own risk.
- Reading an old `encryptedKey` entry on Linux returns an empty key (the user re-enters it) instead of risking the hang.
- `index.ts` contains no direct `safeStorage.*` method call any more; `npm run verify` checks that.

## A real bug found by the new tests

The Settings page edits `voiceLanguage` but the dirty check and the sync effect did not list it, so changing only the voice
language did not enable Save. Fixed (`App.tsx`). Test (g) now checks every field Settings edits against both lists.

## Test counts

`npm test` (after `node scripts/build.mjs`): **293 pass, 0 fail** (was 242 after the tools2 merge, 206 on `integrate-verify`).
New: `tests/integrate2.check.mjs` (19 tests): panel priority and queue, caption never hides approval/consent, hint chip, main/renderer
plan equality, Esc actions, shape covers every panel region on all bot sizes, (a) wake screenshot turn while an approval is
pending, (b) stop cancels approvals + screen flow and main wiring of every stop path, (c) prompt matrix tools x screenshot
turn x voice, (d) defaults OFF, (e) cached screenshot cleared on stop/cancel/setting off/2 minutes (kept only for barge-in),
(f) startup and key storage never call safeStorage on Linux, (g) Settings toggles and dirty/sync lists.
Two older source-scan tests were updated to follow the refactor (`approval-ui`, `screen-guard-vision`).

## `npm run verify` (real run on `integrate2`)

```
31 PASS, 0 FAIL, 0 SKIP
PASS build   typecheck (renderer + main)
PASS build   production build (scripts/build.mjs)
PASS tests   unit tests: 293 passed, 0 failed
PASS wiring  start() never touches safeStorage
PASS wiring  tools and screen assist default to OFF
PASS wiring  IPC handlers use authorize() with the intended window kinds
PASS wiring  no console output includes API keys or auth headers
PASS wiring  renderer CSP still blocks page network
PASS wiring  preload exposes exactly the DesktopAPI methods (45)
PASS wiring  overlay panel slot: window shape and renderer use one plan; every panel region is open   (new)
PASS wiring  saving/reading API keys never calls safeStorage directly                                 (new)
PASS wiring  smoke runs use their own userData
PASS smoke   (17 checks) windows load, preload API = DesktopAPI in all 3 windows, streamed chat round trip with a fake
             server, list_dir without a card, write_file raises an approval and is denied on timeout (file not created),
             clean exit, no leftover process
```

## Run the integrated app

The running Sudo-chan must be quit first (single-instance lock). Then:

```
cd "/home/lenovo/Desktop/new 3/.claude/worktrees/agent-af0333173e4acc49b/desktop" && npm run dev
```

`desktop/node_modules` there is a symlink to the main checkout's (untracked, never committed). To go back, quit it and start
the normal app from `/home/lenovo/Desktop/new 3/desktop` (`npm run dev`). In Settings turn on "Let Sudo-chan use tools" and
"Let Sudo-chan look at my screen" (both are OFF by default) to try those features.

## Combined manual checklist (needs a real microphone and screen)

1. Say **"Sudo, kaise ho?"**: the bot wakes, caption shows her answer, she speaks (Google voice unless Gemini/Azure is set up).
2. **Interrupt and resume**: while she speaks, mumble something unclear -> she resumes the sentence; say "ruko ruko" -> she stays stopped.
3. **Mic dot**: click it (green = listening, grey = off); same toggle in the tray menu. The glow follows your voice.
4. **Tools on the bot**: "Sudo, meri Downloads folder mein kya hai?" -> answered without a card. "Sudo, notes.txt bana do" -> the dark-glass approval
   panel appears on the bot (exact path, Allow once / Deny, 60 s timer) and she says one line; saying "haan" does nothing; click Allow or Deny; Esc (after clicking the bot) denies.
5. **Notes and reminders**: "Sudo, 2 minute baad yaad dilana" -> notification + she says it aloud; "Sudo, ye note kar lo ..." -> `save_note`.
6. **Screenshot**: "Sudo, ye kya error hai?" with a harmless window open -> first time: the consent panel on the bot (Allow / Not now; speaking does not
   answer it) -> "Screenshot 3... 2... 1... ✕" -> "👀 Dekh rahi hoon... ✕" -> a short spoken + captioned answer with the "Screen bheji gayi" chip.
7. **Follow-up**: within 2 minutes "aur is error ka fix batao" -> "Purani screen par based" chip, no new capture.
8. **Sensitive window**: open a password manager, a bank page or a login/private window, then ask the same -> she refuses and says why; nothing is sent.
   (The guard only sees apps that expose accessibility info; keep the countdown on.)
9. **Both prompts at once**: trigger a screenshot request while an approval is pending -> the approval stays on top; after you answer it the consent panel appears.
10. **Stop word**: during a countdown, a pending approval or a running tool say "Sudo, ruko" / "stop" -> everything cancels, the cached screenshot is dropped, nothing is sent.

## Risks and what could not be tested

- No microphone, speakers, real wake word, real screenshots, real model answers or real clicks were involved. The smoke run uses
  a local fake OpenAI server and hidden windows, so "how it looks" and "feels" are unverified. The panel slot and window shape are
  proven by logic tests, not by looking at the screen on a Linux X11 overlay.
- Esc only works when the overlay window has focus (it never takes focus by itself).
- Tool turns are not streamed (several ~1 s round trips); Groq's free token-per-minute limit (about 7,000 for qwen) can throttle
  tool and screenshot turns (an image costs ~2,100 tokens).
- Notes and reminders live unencrypted in the app data folder; API keys on Linux are base64 only (see above).
- The screen guard cannot see Chromium/Chrome windows that expose no accessibility info; a page whose title has no keyword passes the guard.
- A reminder that is already set is not stopped by "Stop all actions".
- Mid-merge behaviours that combine voice + tools + screenshot in one real conversation (history containing earlier tool calls and a
  cached screenshot) are covered by mocked tests only.
