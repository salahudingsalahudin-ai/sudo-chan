# Integration: voice-fix + tools + screen

Branch `integrate` (worktree `/home/lenovo/Desktop/new 3/.claude/worktrees/agent-aee23de05faa2681a`).
Built from `voice-fix` (`ba352d3`), then `git merge tools` (3 commits), then `git merge screen` (3 commits).
Nothing was pushed and `main` was not touched.

## What conflicted and how it was resolved

| File | Conflict | Resolution |
|---|---|---|
| `DECISIONS.md` | Appended sections from each branch | Kept all sections (voice, tools, screen, plus the integration notes). |
| `desktop/src/renderer/styles.css` | Azure fields vs tool cards vs screen badge | Kept all three blocks. |
| `desktop/src/shared/types.ts` | `AzureStatus`, tool approval types, `toolsEnabled`/`screenAssistEnabled`, Azure/tool/screen IPC methods and CHANNELS | Kept everything. |
| `desktop/src/shared/validation.ts` | `toolsEnabled` / `screenAssistEnabled` defaults and validation | Kept both (both default OFF). |
| `desktop/src/preload/index.ts` | Azure, tool-approval and screen IPC bridges | Kept all. |
| `desktop/src/main/index.ts` | (1) `StoreSchema.providers` type (voice: `StoredProvider`, screen: `StoredCloud`) (2) the `CHANNELS.send` / `stop` handlers | (1) Kept voice's `StoredProvider` map and screen's `screenAssistConsent`. (2) The handler now just calls `sendChat()` (screen's refactor); `sendChat()` passes `vision` (screen) AND `tools: tools()` when `toolsEnabled` and cloud mode (tools). `CHANNELS.stop` and `toolsStopAll` now cancel a running screen capture, the reply and every running tool. |
| `desktop/src/main/local-ai.ts` | Imports; StreamOptions (`tools` + `vision`); the "Real System Boundaries" line of the system prompt | Imports and options kept. The prompt is rebuilt so it is truthful in every combination (see below). |

## Interaction decisions (screenshot AND tools both on)
- A screenshot turn is answered by the vision model **without tools** (`LocalAI.stream` takes the vision branch first). This is the graceful degradation: no tool can run on a turn the user asked to be answered from a screenshot.
- The vision system prompt then says tools are ON in settings but NOT available on that screenshot turn, and to ask again without the screenshot (`toolsPaused`). She must not claim an action.
- A tools turn without a screenshot says she cannot see the screen ("this is NOT such a turn").
- With both off: unchanged baseline (plain streaming, no `tools` parameter, no image, "cannot modify or delete OS files directly").
- Stop button / "Stop all actions" cancel a pending screen capture, the reply and all running tools.
- Wording fix found by the merged tests: the screen sentence began with a capital "Cannot modify..." which broke the tools test; it is now "you cannot modify or delete OS files directly".
- No code calls `safeStorage` during `start()` (checked: only the save path and decrypt-if-an-encrypted-key-exists call it).

## Test results
- `npm run typecheck`: clean (both projects).
- `node scripts/build.mjs`: ok.
- `npm test` (after building dist): **175/175** (170 from the three branches + 5 new in `tests/integration.check.mjs`).
- New tests (mocked fetch): screenshot + tools turn, screenshot without tools, tools turn without screenshot, baseline both off, prompt matrix.

## Not tested
- Real wake-word -> screenshot -> vision answer with the integrated app, the approval cards on screen, real Groq tool calls, Azure audio. Everything here is unit/mocked level.
- A screenshot turn followed by a tools turn in one conversation (history handling) beyond the mocked cases.

## Combined manual test checklist
1. Quit any running Sudo-chan, start the integrated app (commands below). Bot and chat open.
2. Chat: type a Roman Urdu question. Answer arrives in Roman Urdu (Groq).
3. Voice: Live Talk in the chat window. Only the chat bot lip-syncs; say "ruko" mid-reply, audio stops.
4. Wake word: Settings -> "Listen for my name" ON; say "Sudo, ..." (overlay reacts, 30 s window).
5. Tools: Settings -> "Let Sudo-chan use tools" ON. Ask "mere home folder mein kya hai?" (read, no card). Ask her to create a file in `~/Documents` (a card appears; Deny first, then Allow). Press "Stop all actions" during a command.
6. Screen: Settings -> "Let Sudo-chan look at my screen" ON (consent dialog). Say "Sudo, ye kya hai?" with a terminal error visible: badge "Dekh rahi hoon", thumbnail in chat, answer about the screen. Close password managers/banking first.
7. Both on: with tools ON, ask for a screenshot answer; she answers from the screenshot and says tools are not available on that turn. Then ask the same without the screenshot; the tool card appears.
8. Settings off: turn tools and screen assist OFF; confirm nothing is captured or executed.
9. Azure/TTS: save an Azure key + region in Settings and press the test buttons (optional).

## Running the integrated app later (without disturbing the current one)
The app has a single-instance lock and shares `~/.config/Sudo-chan`, so **quit the running Sudo-chan first** (tray -> Quit, or kill the old `electron ... --ozone-platform` process and its `node scripts/dev.mjs` parent by PID; do not use `pkill -f`).

```
cd "/home/lenovo/Desktop/new 3/.claude/worktrees/agent-aee23de05faa2681a/desktop"
ln -s "/home/lenovo/Desktop/new 3/desktop/node_modules" node_modules   # only if the symlink is missing
npm run dev
```
Dev start takes 30-50 s on this machine. To go back: quit it and start `npm run dev` from `/home/lenovo/Desktop/new 3/desktop` (branch `voice-fix`).

## Merging for real
`integrate` already contains everything. Fast-forward `voice-fix` (or `main`) to `integrate` once the manual checklist passes: `git merge --ff-only integrate`. Then remove the worktrees (`git worktree remove <path>`) and delete the symlinked `desktop/node_modules` only inside worktrees, never the main checkout's.

---

## Refresh 2 (voice-fix up to f11aaf2 merged into `integrate`)

`voice-fix` gained Azure/Gemini quota work, CSP audio decode fix, lip-sync target fix, wake word ON by default with captions, mic dot toggle, glow and tray mic item, fast STT (`sttSpeed`, default fast), resume after an unclear barge-in plus stop commands, minimum voiced clip filter, chat replies sent to the overlay, `sendMessage(text, voice)`, and the "she can hear through the mic" prompt facts. All of it is merged here together with tools and screen assist.

### Conflicts and how they were resolved
- `DECISIONS.md`, `styles.css`: both sides kept.
- `index.ts` (stop handler): kept the tools/screen body (`cancelScreenCapture(); conversation.stop(); stopAllTools();`) and took voice-fix's wider access (`['chat', 'overlay']`), so "ruko" from the desktop bot also cancels a pending screenshot and running tools. Tool approval requests and replies stay chat-only.
- `local-ai.ts` (system prompt): kept the voice-hearing fact AND the tools/screen truthfulness lines. The voice prompt also tells her when tools are paused on a screenshot turn.
- `App.tsx` (5 blocks): approval cards, stop/unclear handlers, screen badge, caption bubble and both settings dirty-checks all kept.

### Fixes made while merging (new interactions)
1. The overlay now also gets chat updates (so the desktop bot can speak and show captions), but screenshot thumbnails are stripped from what the overlay receives (`withoutAttachments`). Approval cards still go to the chat window only.
2. A wake-triggered screenshot request is always a voice turn (it no longer depends on the racy `voiceCallActive`).
3. "Sudo, ruko" (stop command right after the name) now only stops. It no longer opens a conversation window, greets or takes a screenshot.
4. Wake fallback messages (when the screenshot cannot be taken) are also sent as voice.

### Tests
`npm run typecheck`, `node scripts/build.mjs` and `npm test` pass: 197 tests (6 new in `tests/integration-refresh.check.mjs`: prompt matrix for voice/tools/screenshot, stop-after-name, main wiring checks for stop/approvals/overlay attachments/startup safeStorage, settings defaults).

### Not tested
Real mic and speakers, the real wake-triggered screenshot end to end, approval cards on screen, the overlay caption with a real reply, Azure and Gemini audio. The wiring checks in the new test file read source text, so they only protect against accidental removal, not against runtime bugs.

### Extra manual checklist items
- Say "Sudo, kaise ho?": bot wakes, caption shows, she answers aloud (desktop bot only, chat window stays closed).
- Interrupt her mid-sentence with a mumble: she resumes. Interrupt with "ruko ruko": she stays stopped.
- Say "Sudo, ruko" while she talks: she stops, no screenshot, no greeting.
- Click the mic dot: it turns grey and the mic stops; click again to resume. Also try the tray item "Microphone: listen for my name".
- With "Let Sudo-chan use tools" ON, ask her to read a file: the approval card appears in the chat window only (never on the overlay), and saying "yes" aloud does nothing.
- With screen assist ON, say "Sudo, ye error kya hai?": the "Dekh rahi hoon" badge shows on the overlay, the thumbnail shows only in the chat window, and she answers aloud.

### Run the integrated app (quit the running Sudo-chan first: single-instance lock)
```
cd "/home/lenovo/Desktop/new 3/.claude/worktrees/agent-aee23de05faa2681a/desktop" && npm run dev
```
(`desktop/node_modules` in this worktree is a symlink to the main checkout's, so no install is needed.)
