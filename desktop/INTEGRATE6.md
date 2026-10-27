# integrate6: review of the three merged branches

Branch `integrate6` = main `3c689fb` + `planner` + `local-wake` + `installer-release`. This note records how they were combined, what the review
found, and what was verified. The review branch is `integrate6-review` (on top of `integrate6` `96fab94`).

## The three merges

| Merge | Branch | Conflicts | How they were resolved |
|---|---|---|---|
| `aa7d7e2` | `planner` | none | Clean. Adds `src/shared/tasks.ts`, `src/main/tasks-store.ts`, seven task tools, the chat "Aaj ka kaam" panel, channels `tasksList/Add/Act/State`. |
| `05e316e` | `local-wake` | `CHANGELOG.md`, `verify-integrated.mjs`, `preload/index.ts`, `shared/types.ts` | Both sides kept. Preload and `DesktopAPI` gained the task methods and the three `*LocalWakeProfile` methods; `verify` expected-kinds list got both `tasks*` (chat) and `localWake*` (get: overlay+settings, save/delete: settings). CHANGELOG sections stacked. |
| `96fab94` | `installer-release` | `CHANGELOG.md`, `verify-integrated.mjs`, `main/index.ts`, `renderer/App.tsx`, `shared/types.ts`, `shared/validation.ts` | Both sides kept. `index.ts` has the lazy `localWake()` file next to the update-check functions; `Settings` got `updateCheckEnabled` beside `localWake*`; `validSettings`/`DEFAULT_SETTINGS` have all three; App.tsx "unsaved changes" test and the re-sync dependency list have all three; `verify` list has `updateNotice` too. |

## Findings

| # | Finding | Status |
|---|---|---|
| 1 | Settings fields, channels, windows: `localWake`, `localWakeSensitivity`, `updateCheckEnabled` are in `DEFAULT_SETTINGS`, `validSettings`, the unsaved-changes test and the re-sync list; the patch save from the mic dot keeps them; bad values are refused. 56 channel keys / values are unique, every handler is registered once; windows: tasks = chat, localWake get = overlay+settings, save/delete = settings, updateNotice = settings. Preload equals `DesktopAPI` (56 members, also checked in the real smoke run). | OK, now guarded by tests |
| 2 | Token budget: a tool turn re-sends about 2,200 tokens of definitions plus about 700 tokens of tool prompt on every step; the planner added about 900 of that (notes and reminders about 400 before it). With Groq's 7,000 input tokens a minute that triggers the 429 fallback to `gpt-oss-20b` early. | Defect (cost), FIXED: `tools/tool-gate.ts` |
| 3 | Startup: `start()` has no `safeStorage`; update timer is skipped in smoke runs and cleared on quit; `tasks.json`, `local-wake.json`, the tool runtime and reminders are created lazily. The overlay pipeline order is coherent: local-wake evaluation and `decideWakeClip` (quota gate + on-device verdict + 2 s gate) run before the cloud request; hallucination / normaliser run in `main/stt.ts` after STT; the phantom / self-echo filter and wake-word match run in `onFinal`; Live Talk and the 30 s window (`isOverlayVoiceActive`) are never gated, barge-in clips never reach `localWake`. | OK |
| 4 | Packaging: `files` is `dist/**/*`, `package.json`, `assets/icon.png`; `tsconfig.node.json` compiles `src/shared` (incl. `local-wake/`). `electron-builder --dir` (Linux, output in a temp folder) put `dist/shared/local-wake/*`, `dist/shared/tasks.js`, `dist/shared/update-check.js`, `dist/main/tasks-store.js`, `dist/main/local-wake-store.js`, `dist/main/tools/tool-gate.js` and `assets/icon.png` into `app.asar`, and no `src`, tests, scripts, `config.json` or `.map`. Runtime dependencies were NOT checked this way: this worktree's `node_modules` is a symlink (the trap in `RELEASING.md`); the new code only imports Node and Electron built-ins, `package.json` dependencies did not change. AppImage / deb were not built. | OK |
| 5 | `CHANGELOG.md` (desktop): sections ran together without a blank line, the local-wake numbers (38 checks / 491 tests) looked like the merged totals. Root `CHANGELOG.md` (the text that goes into release notes) did not mention the planner or the on-device name check. | FIXED |
| 6 | `tests/edit-file.check.mjs` "unique match shows a before/after card" failed once in the full run (it waits a fixed 25 ms for an approval card) and passed alone; same family as the timing flakes noted in the local-wake changelog. First full `verify` smoke step also hit its 90 s kill (`SIGKILL`) while another Electron app and heavy jobs were running; the rerun passed (READY after 2.2 s instead of 5.5 s). | Only suspected: load flakes, not a merge defect |

## What changed on `integrate6-review`

- `src/main/tools/tool-gate.ts` (new): `wantsPlannerTools(messages)` (latest message plus the two before it; English, Roman Urdu, Urdu script, tool names; errs towards offering),
  `withoutPlannerTools(runtime)` (hides the 13 notes / reminders / tasks definitions, same `execute`, never an empty list).
- `src/main/local-ai.ts`: `buildToolsPrompt(planner)`; `TOOLS_PROMPT` is still the full text; `buildSystemPrompt({ plannerTools })`; the cloud tool path uses the gate (log line `[Tools] offering N tool(s)`).
  Saves about 1,300 tokens per step on turns that are not about tasks, notes or reminders (definitions 7,978 -> 3,875 characters, prompt about 2,670 -> about 1,650 characters). Voice prompts are unchanged.
- `tests/integrate6.check.mjs` (10 tests) and two `verify` wiring checks (Settings fields in App.tsx; tool gate wired).
- Docs: `CHANGELOG.md` (desktop and root), `VERIFY.md`, this file.

## Verified (all under `flock`)

- `npm run build`, `npm test`: 638 passed, 0 failed (628 + 10 new); `npm run verify`: 46 PASS, 0 FAIL, 0 SKIP (44 + 2 new wiring checks), including the real Electron smoke run with the planner checks.
- Not verifiable here: real microphone, real provider, a real `npm ci` package (see item 4), the AppImage / deb.
