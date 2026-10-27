# First-run setup wizard

Branch `first-run-wizard` (on top of `live-talk-flow`). There is no OS installer wizard (AppImage / .deb), so this is the onboarding: seven calm screens, one primary
action each, shown **once**, on a fresh install only. Pure logic and all copy: `src/shared/onboarding.ts`. Screens: `src/renderer/SetupWizard.tsx` + `setup.css`.
Tests: `tests/onboarding.check.mjs` (28). Pictures: `scripts/onboarding-shots.mjs` (see "How to look at it").

## The idea in five lines

- It is a **mode of the Settings window** (`AppState.setupActive`), not a new window kind. `authorize()` rules are unchanged; the two new IPC channels are Settings-only.
- It appears **only** when this launch found no `config.json` yet (a brand-new install) or an earlier run stopped halfway. The owner and everybody with a config, settings or keys never see it.
- It **never blocks the app**: `Esc` or **Skip setup** closes it and records `onboardingDone`; the bot, tray and chat work the whole time.
- A fresh install starts with the **microphone closed** (`wakeWordEnabled: false`) until the wizard asks. Nothing listens before the person clicks **Allow microphone and test**.
- Every switch it offers starts **OFF**, and every choice is saved through the normal Settings path, so every existing rule (click-only consent, approval cards) still applies.

## The screens

Each screen: mascot with a matching face, big heading, one primary button, **Back**, **Skip this step**, **Skip setup** (top right), progress dots, Tab / Enter / arrow keys.

| # | Screen | What happens | Mascot |
|---|---|---|---|
| 1 | **Welcome** | "Hi, I'm Sudo-chan." Language choice **English / Roman Urdu** (changes only the wizard's own copy; saved as `onboardingLanguage`). "About 2 minutes. Skip anything you like." | happy, large |
| 2 | **Microphone** | Nothing opens until **Allow microphone and test** is pressed. A live level meter proves it works ("I can hear you"). Plain text: *she only listens for her name unless you start Live Talk; nothing is recorded or saved*, plus the honest line that short clips go to your AI provider to check the name. After a good test: switch **Keep listening for her name** (on after a successful test; saved as `wakeWordEnabled` when Next is pressed). Errors: denied, no device, busy, other, each with a plain sentence and a platform tip (Linux: PipeWire / PulseAudio, `pavucontrol` Input Devices). | calm, listening glow while testing, worried when blocked |
| 3 | **Her name** | "Say Sudo or Sid". Optional **Teach her your voice**: the existing `LocalWakeSettings` panel (compact mode: no mode / sensitivity rows) with enrolment and the 3-time self-test. The switch **Let this computer check her name first** unlocks only after teaching **and** a self-test that heard her at least once; it saves `localWake: 'assist'` only if switched on. Default stays `off`. | happy |
| 4 | **Her brain** | Three cards (arrow keys move between them). **Sign in** is shown disabled with "Coming soon" and an honest sentence. **Use my own key**: Groq / Gemini toggle, a password box (never echoed), **Test and save** goes through the main process (`saveCloudConfig`: test first, then the existing key store; the page has no network), a "how to get a free key" disclosure (exact page, free-limit sentence). **Offline, or later**: **Check for Ollama** (`checkAI`), then it uses Ollama if models exist. A closing sentence says plainly what works without a brain: she can keep you company, remind you to rest and keep your task list, but cannot chat or understand your voice yet. | calm, eyes looking up |
| 5 | **Your choices** | Three switches, all OFF: **Let her use tools** (every risky action asks first), **Let her look at my screen when I click Allow**, **Let her know which app I'm using during Live Talk** (window name only). Saved on Next as `toolsEnabled`, `screenAssistEnabled`, `liveAwareness`. A disclosure **What she never does** lists four promises and the true key-storage sentence for this platform (Linux: keys are **not** encrypted). | calm, eyes looking down |
| 6 | **Say hello** | **Start Live Talk** starts the same Live Talk the bot's click starts (through `setLiveTarget('overlay')` in main) and shows a blue listening glow; **Stop** ends it. Saying "Sudo" (when standby is on) wakes her the same way. Honest lines appear if there is no brain or no mic. A three-item cheat sheet: *Click me to talk. Say "ruko" to stop me. Double-click the mic dot to turn the mic off.* | happy, listening glow while live |
| 7 | **All set** | Summary read from the real state (mic, voice taught, brain, three switches), how to change it later (**Settings, Run setup again**), where the tray icon is (with a Linux note that some desktops hide it). **Start using Sudo-chan** closes the wizard. | happy |

## States and persistence

State machine (`wizardReducer`): `next` (completes the step; last step finishes), `back`, `skip` (only steps 2 to 6; marks the dot), `goto`, `language`, `dismiss`, `restart`.
`outcome` is `null` while open, `'finished'` or `'dismissed'` after; both write `onboardingDone: true`.

Settings added (`Settings`, `DEFAULT_SETTINGS`, `validSettings`, the Settings page "unsaved changes" test and the re-sync list in `App.tsx`):

| Setting | Meaning |
|---|---|
| `onboardingDone` | default `false`; `true` after Finish or Skip. Nothing re-opens the wizard once it is true except **Run setup again**. |
| `onboardingLanguage` | `'en'` (default) or `'roman-ur'`; the wizard's own copy only. |
| `onboardingStep` | the current step, saved on every move, so closing the app halfway resumes on the same screen (a saved step wins over "has keys"). |

First-run detection (`shouldShowOnboarding`, called in `start()` **before** the store creates `config.json`): `onboardingDone` -> never; saved step -> resume; saved keys/providers -> never;
otherwise "no config file yet". Smoke runs (`--smoke-test`, `npm run verify`) never show it.

Closing the wizard window any other way (the title bar, the tray's Settings entry, `Esc`) fires the window `hide` event: main calls `dismissSetup()` (`setupActive=false`, `onboardingDone: true`).
Quitting the app does not: the saved step resumes next launch.

New IPC (both Settings window only, `handle()` + `authorize(event, 'settings')`, no `ipcMain.on`): `setSetupMode(active)` shows / leaves the wizard (resizes the Settings window to 600x720 and back to 780x760);
`setupLive(active)` starts / stops the "try it" Live Talk, refused unless the wizard is open. The preload and `DesktopAPI` match, and `npm run verify` lists both.

## What is saved where (and what is not)

- Keys: only by the existing `saveCloudConfig` (main tests, then the key store). The page clears the box on success and never shows the key again. No `console` call, no storage, no network in the wizard page (a test checks).
- Voice: the mic test is an in-memory level meter. The "Teach her your voice" panel is the existing component: only feature vectors are stored, never audio.
- The privacy switches go through `saveSettings`. Turning screen help on still opens its own one-time confirmation (the existing native question), because the picture goes to your AI provider.
- The one-time "may she know my window name?" question on the bot is marked answered when the wizard's live demo starts, so the bot does not ask a second time while you are in the wizard.

## Roman Urdu

Every wizard string exists in both languages (a test compares the key sets, placeholders and non-empty text). The embedded **Teach her your voice** panel is the existing English component; it is not translated.

## How to look at it

```
npm run build
flock <heavy.lock> node_modules/electron/dist/electron --ozone-platform=x11 scripts/onboarding-shots.mjs [outDir]
```

`scripts/onboarding-shots.mjs` is test-only. It runs the built app inside Electron with an isolated temp userData folder (never `~/.config/Sudo-chan`), the global shortcut disabled, every `fetch()` refused and a fake microphone, steps
through every screen and writes PNGs with `webContents.capturePage()` (both languages for steps 1, 4, 5 and 7). Do **not** run it while you are using the real app on a small screen: it opens a real window for about a minute.

To see the real thing: start the app with an empty data folder, for example `electron . --user-data-dir=/tmp/sudo-chan-fresh`.

## Known limits

- The mic test needs a real microphone; with none, the screen shows the "no microphone" help (that path is what the screenshots show with a refusing mic).
- Whether the real "say Sudo" wake works depends on the mic, the room and a working AI key; the wizard shows the glow when Live Talk is on but cannot prove the speech-to-text result.
- "Sign in" is a placeholder (see `ACCOUNT-FREE-TIER.md`); the card is disabled and says so.
- The key-page addresses are shown as text to type into a browser: the page cannot open links (no network, no shell access by design).
- The embedded enrolment panel keeps its English text in Roman Urdu mode.
- The wizard was exercised with a fake microphone and fake network; a human must try a real mic, the real Groq / Gemini key test and a real "Sudo" (see the report's "only a human can verify" list).
