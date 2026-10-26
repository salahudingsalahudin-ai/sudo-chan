# Desktop Phase 1 QA

## Fully closed paused eyes — 24 October 2026

Resolved the previously noted partially open eyes. Paused bots now render two closed eyelid paths instead of compressed open eyes; pupils and highlights are absent. The chat welcome bot now receives the same pause state as the overlay and settings preview. Floating/ground animation pauses too; resume restores the open eyes.

Build, typecheck, all three existing test files and Linux packaging passed. `/tmp/sudo-chan-desktop-qa/paused-eyes.cjs` verified closed eyelids in overlay/settings/chat, normal and reduced-motion modes, greeting while paused, and open eyes after resume, with no JavaScript errors. Visually inspected a native X11 overlay capture and the settings screenshot. Saved the paused companion preview in `screenshots/companion-paused.png`.

## Full regression run — 23 October 2026

Latest result: **5/5 packaged GUI suites passed**, plus production build/typecheck and all three automated test files. GUI tests ran sequentially with isolated storage; native XTest clicks/keys exercised actual desktop input. The app's original packaged files matched all 12 freshly built files before testing.

| Suite | Result | Coverage |
| --- | --- | --- |
| Native clicks | Pass | Greeting, double-click chat, gear settings, no click leak through bot, empty-corner click-through, stale global cursor sample |
| Escape | Pass | Settings/chat dismiss, held Esc, companion-focused Esc and close button all preserve the bot |
| Settings design | Pass | Contrast, live size preview, unsaved edits through pause, validation/save, section navigation, minimum 360×450 layout, reduced motion and native X11 screenshot |
| Chat and persistence | Pass after fix | Mock reply, literal HTML text, actual chat blur dismissal, size/shortcut save, pause/resume, reset, settings/position after restart, empty chat after Quit, software rendering |
| Normal startup | Pass | Launch without display flags, automatic relaunch, gear/settings and saving |

The first run passed 4/5 suites and caught a real Linux position-persistence failure: moving the bot to `(100,127)` was followed by a restart at the default `(1074,432)`. Position updates listened to `moved`, which Electron supports only on macOS/Windows. Changed this to the cross-platform `move` event and save the latest position during normal Quit so an outstanding debounce cannot discard it. [Electron move events](https://www.electronjs.org/docs/latest/api/browser-window#event-move).

Rebuilt the package and reran all five suites. The persistence test now verifies the on-disk position after a move, moves again and quits immediately, then verifies the exact position, size and shortcut after relaunch. No GPU-process crash, `XGetWindowAttributes` error or JavaScript exception was observed in the runtime check. Paused eyes still use vertical scale `0.22`; fully closed eyes remain an outstanding visual request.

Evidence: `/tmp/sudo-chan-desktop-qa/regression-2026-10-23/` contains the original failed run; `regression-2026-10-23-after-fix/` contains the final five passing logs and `results.json`. These temporary artifacts may be cleared by the OS. This is not a Windows/macOS, native Wayland or long-duration performance pass.

## Environment

Tested on Sid's Ubuntu laptop using Electron 45, Node 24, Wayland session and Electron's XWayland compatibility mode. Packaged output is `release/linux-unpacked/sudo-chan-desktop`. Settings smoke tests use temporary, isolated storage.

## Passed

- `npm run typecheck`, `npm run build`, `npm test`, and `npm run package`.
- Packaged production smoke checks passed for keyboard welcome, settings/chat window IPC open paths, hidden-window Escape, close-chat keeping the process alive, and reset position. (UI buttons were not all individually exercised.)
- Launched both the development Electron binary and packaged production application.
- Overlay appears, has transparent background, uses always-on-top and skip-taskbar flags. Main and chat/settings renderers have `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`; browser `require`, `process` and raw IPC are unavailable.
- No JavaScript runtime exceptions in smoke-tested flows.
- Keyboard welcome; chat/settings IPC window-open paths; hidden-window Escape; close-chat keeps the process alive; reset position.
- Settings validation and save, size-based native resize, pause-state propagation, section scrolling, and reduced-motion CSS (`animation-name: none`).
- Local mock chat; user-entered HTML renders as text; session message listing and clear action; a chat window cannot call settings-only IPC.
- Packaged app returns a live mock `loginSupported` state. Launch-at-login was not enabled during testing.

## Linux GPU crash follow-up — 22 October 2026

- User launch reported repeated GPU-process exits with code 139. Linux startup now disables hardware acceleration before Electron is ready, with an explicit `--hardware-acceleration` opt-in.
- Rebuilt the Linux package; typecheck, production build, validation tests and packaging passed.
- Ran `/tmp/sudo-chan-desktop-qa/gpu-smoke.cjs` against the rebuilt packaged app with isolated smoke-test storage and no GPU flags. Greeting, settings, chat reply and screenshots passed; hardware acceleration reported `false`, software compositing was active, and no GPU-process crash was observed during the test (including a 15-second idle observation).
- `XGetWindowAttributes failed` warnings still appeared for two windows. Those tests checked renderer content, not native on-screen presentation; the later blank-settings report showed that this was insufficient. See the follow-up below.

## Blank settings follow-up — 22 October 2026

- The display backend was changed with `appendSwitch` after Electron had already selected Wayland. This mixed a Wayland browser with X11 child processes. Renderer screenshots looked correct while native settings windows could remain blank. Electron's early backend selection is documented in [electron/electron#48301](https://github.com/electron/electron/pull/48301).
- The new bootstrap entrypoint relaunches once with an explicit display argument before loading application windows. Development supplies the argument on the initial launch. Explicit display overrides and native Wayland opt-in are preserved.
- Rebuilt package, typecheck, production build and both test files passed, including backend selection/relaunch regression checks.
- Packaged GUI check clicked the actual gear button, changed size, saved, hid/reopened settings, and sent a chat message. No GPU crash or `XGetWindowAttributes` warning was observed.
- Captured settings directly from the native X11 window using XGetImage, not the browser screenshot API: content was visible (5,443 distinct colors). Screenshot: `/tmp/sudo-chan-desktop-qa/settings-native-x11.png`.
- A second test launched the packaged executable without any display override, verified the automatic relaunch, and clicked gear and Save changes successfully. Both tests used isolated data; the user's running instance still needs a full quit/restart to load the rebuilt package.

## Remaining manual checks

- Verify transparent corners pass clicks through while bot, grip and dock respond; drag bot, restart, and check position persistence with the physical pointer.
- Test `Control+Space` against the laptop's input-method/desktop shortcuts; test the tray menu and native AppIndicator visibility.
- Test installed-app startup at login, monitor disconnect recovery, and the optional native Wayland path. The default GNOME/Wayland path is XWayland; GNOME may need AppIndicator support.
- Verify blur dismissal outside the automated smoke mode and keyboard navigation with a screen reader.
- Windows/macOS installers, signing, system startup behavior and input interactions have not been run on those operating systems.

## Whole-overlay click-through follow-up — 22 October 2026

- User reported that all bot clicks reached the application behind it. The Linux overlay previously disabled all input based on polled global pointer coordinates. A stale/outside cursor sample could therefore leave the entire bot non-interactive.
- Reproduced that failure against the old package by holding the cursor sample outside the overlay and sending native XTest mouse input: greeting stayed empty and the test window behind received the click.
- Replaced Linux cursor polling with [native window regions](https://www.electronjs.org/docs/latest/api/browser-window#winsetshaperects-windows-linux-experimental) for the bot, grip, dock and visible speech. Regions resize with the window; bot controls remain interactive independently of global cursor samples, while outside corners pass input through.
- Typecheck, production build, packaging and all three test files passed. Shape tests cover all sizes, the paused dock's wider footprint, corners and speech visibility.
- Re-ran `/tmp/sudo-chan-desktop-qa/native-click-smoke.cjs --stale-cursor` using native desktop mouse input (not DOM-dispatched clicks). Greeting, double-click chat, gear settings and transparent-corner click-through passed; the bot click did not reach the test backdrop. Window assertions wait for load completion.
- Physical-pointer confirmation on the user's session, dragging, other desktops and other operating systems remain manual checks.

## Escape dismissal follow-up — 23 October 2026

- User confirmed physical single-click greeting, double-click chat, mock reply, settings rendering, size save, drag, reset position and pause/resume. Paused eyes remain partially open; that visual observation is still pending.
- User reported that Escape hid both settings and the companion. The shared renderer Escape handler also dismissed the overlay. Native-key testing confirmed that Escape with companion focus hid it, including the focus target that can receive subsequent key events after a panel closes.
- Escape now dismisses chat/settings only, ignores repeated/composing key events, and the main-process dismiss endpoint refuses to hide the overlay. Explicit tray Hide companion remains available.
- Rebuilt Linux package; typecheck, production build and all three existing test files passed.
- `/tmp/sudo-chan-desktop-qa/escape-smoke.cjs` sent native XTest Escape presses to the packaged app using isolated storage. Settings dismiss, companion-focused Escape, held Escape (1.2 seconds), chat dismiss and settings close-button checks passed; the companion remained visible in every case.

## Settings studio redesign — 23 October 2026

- Replaced the washed-out white settings surface with dark teal panels, mint selection and save controls, brass privacy accents, larger labels and brighter descriptions. The hero includes a live size preview; switches show text status, tabs reflect the visible section, and scrolling no longer fades card text.
- Pending size edits now survive pause/resume broadcasts. Size buttons have explicit accessible names so decorative checkmarks do not change their labels. Settings windows start with a matching dark native background.
- Production build, typecheck, packaging and all three test files passed. `/tmp/sudo-chan-desktop-qa/studio-qa.cjs --packaged` also passed size preview, pause with unsaved edits, invalid shortcut feedback, successful save, section navigation, scroll-to-top selection, reduced motion, Escape and zero JavaScript exceptions.
- Measured text contrast against actual computed surfaces: row titles 12.82:1, descriptions 8.44:1, Save/selected size 9.35:1, footer status 10.69:1, header subtitle 9.42:1. This is a targeted check, not a complete accessibility audit.
- Visually checked default-size screenshots, rhythm/privacy sections, the minimum 360×450 window and a native X11 capture. No horizontal overflow at minimum size. Updated `screenshots/settings.png`; added rhythm and narrow-window screenshots.

## Dependency audit

`npm audit --omit=dev` reported zero production vulnerabilities. The full development dependency tree reports 8 moderate advisories in build tooling (including electron-builder transitive dependencies); no high or critical findings were reported. `npm audit fix --dry-run` did not offer a safe in-place fix, so dependency versions were left unchanged.

This is a development preview. It has no screen capture, microphone, AI connection, account, payment or installer update path.
