# Installer end-to-end test (Linux .deb and AppImage)

Branch `installer-e2e` (on top of `first-run-wizard`, so it holds main + Live Talk + the setup wizard). Version stays **0.1.0**. These are release
**candidates**: built and tested locally on one Linux laptop, **not published, not uploaded, not tagged**. `desktop/release/` is git-ignored.

## The files

| File | Size | sha256 |
| --- | --- | --- |
| `Sudo-chan-0.1.0-linux-x86_64.AppImage` | 125,550,835 bytes (120 MB) | `3a11d60095f2a324790ded4b12cb3617677fb3a79bb94defe4c9b46775bf00b3` |
| `Sudo-chan-0.1.0-linux-amd64.deb` | 100,320,172 bytes (96 MB) | `790bfa3c0b811cf7cdf9624bf246fcbfac609000a43addb0d233e66ec0f0b28e` |
| `SHA256SUMS` | 2 lines, same names as the website guide and the release workflow | `sha256sum -c SHA256SUMS` prints OK for both |

Installed size of the deb: 279,752 KB declared (`Installed-Size`), 274 MB measured after `dpkg -x`. `app.asar` is 7.5 MB and byte-identical in both files.
The hashes change with every rebuild (electron-builder embeds timestamps); rebuild, then rewrite `SHA256SUMS`, and never mix files from two builds.

## The journey, step by step

PASS = done and checked by a script or by reading the files. HUMAN = only a person on a real desktop can confirm it.

| # | Step the user takes | How it was tested here | Result | What only a human can verify |
| --- | --- | --- | --- | --- |
| 1 | Download the files | Built locally with `npm run package:linux`; names match what `content.ts` and `release.yml` expect | PASS | The real GitHub release page and download button (not published) |
| 2 | Verify the checksum | `sha256sum Sudo-chan-0.1.0-linux-* > SHA256SUMS`, then `sha256sum -c SHA256SUMS` | PASS | Doing it on the machine that downloaded the files |
| 3 | `sudo apt install ./Sudo-chan-*.deb` | **Not run** (no sudo, no real install). Inspected instead: `dpkg-deb -I/-c/-e`, `dpkg -x`, postinst and postrm read line by line (section below) | PASS (static) | A real `sudo apt install` on Ubuntu 22.04 and 24.04: dependencies resolve, the postinst runs, the AppArmor profile loads |
| 4 | Find "Sudo-chan" in the app menu | `.desktop` file passes `desktop-file-validate`; `Icon=sudo-chan` resolves to hicolor icons at 8 sizes (16 to 512); `StartupWMClass=sudo-chan` equals the real X11 window class (measured with `xprop` on the running packaged app) | PASS (static + X11 class measured) | That the menu really shows the entry with the right icon, and that the running window groups under it in the dock (GNOME, KDE) |
| 5 | Or: `chmod +x` the AppImage and double-click | `--appimage-extract` (this laptop has no libfuse2); the extracted `AppRun` was launched and driven; `AppRun`, `.desktop`, `.DirIcon` read | PASS (extracted) / HUMAN | A real double-click run through the FUSE mount; on Ubuntu 22.04+ the user needs `sudo apt install libfuse2` |
| 6 | First launch (window appears) | Packaged binary started like a user (no `--smoke-test`) with a fresh `--user-data-dir`: overlay and wizard windows both created and loaded in 5.3 s (deb) and 6.2 s (AppImage `AppRun`) | PASS | How it feels: first paint, the bot's position, multi-monitor |
| 7 | Setup wizard on a fresh install | Same run: `setupActive` true, step `welcome`, heading "Hi, I'm Sudo-chan."; screenshot `packaged-first-run-welcome.png`; all screens photographed from the packaged `app.asar` (22 PNG, none scroll sideways) | PASS | Clicking through it with a real microphone and a real key |
| 8 | Microphone closed until "Allow" | Fresh state has `wakeWordEnabled=false`, `voiceCallActive=false`; `pactl list source-outputs` shows no recording stream from the app | PASS | The real permission prompt and the green mic indicator of the desktop |
| 9 | Risky things off | Fresh state has tools off, screen help off, window-name awareness off | PASS | |
| 10 | Keys folder protected | After the first save: `config.json` mode 600, userData folder mode 700. The default folder is `~/.config/Sudo-chan` (measured with a temp `HOME`) | PASS | |
| 11 | No hidden network or keyring call at startup | verify wiring check (`start()` never touches `safeStorage`) on the packaged `dist`; smoke runs skip the update check; the first-run script quits before the 20 s update check | PASS | A real desktop keyring (GNOME Keyring / KWallet) prompt when the first key is saved |
| 12 | Second launch | Same folder, onboarding marked done: `setupActive=false`, no Settings window | PASS | |
| 13 | Quit and no leftovers | Quit through the app's own quit; exit code 0; `pgrep -f <userData>` empty (both runs, both builds) | PASS | Tray icon "Quit Sudo-chan" |
| 14 | Wayland, tray icon | The app runs through XWayland here (`--ozone-platform=x11`, this laptop is a Wayland session). Window class measured under XWayland | PASS (XWayland) | Native Wayland window behaviour (experimental opt-in), tray icon on GNOME (needs the AppIndicator extension), always-on-top overlay |
| 15 | Ubuntu 24.04 AppArmor (unprivileged user namespaces) | The deb ships `/opt/Sudo-chan/resources/apparmor-profile` (`userns`, `flags=(unconfined)`) which the postinst copies to `/etc/apparmor.d/sudo-chan` only if `apparmor_parser` accepts it; the AppImage's `AppRun` adds `--no-sandbox` when `unshare -Ur true` fails | PASS (static) | A real Ubuntu 24.04: the .deb must start with no `--no-sandbox` and the AppImage must start at all |
| 16 | Uninstall / upgrade keeps the user's data | Reasoned from the control scripts (below) | PASS (static) | `sudo apt remove sudo-chan-desktop`, then reopen and see the settings still there |

## Automated checks run (all on the build above)

| Check | Result |
| --- | --- |
| `npm run build` | PASS |
| `npm test` | 730 tests (725 baseline + 5 new in `tests/installer-config.check.mjs`). `edit_file ... Allow edits it` failed about every second run on its own (25 ms wait); fixed by waiting 120 ms (6 of 6 runs green). `voice-pipeline ... (needs network)` is an optional network test and can fail offline |
| `npm run verify` (source) | 53 PASS, 0 FAIL (baseline) |
| `npm run verify -- --packaged=<deb payload>/sudo-chan` | all 34 smoke checks PASS: READY 4.3 s, wizard not shown in a smoke run, tools / screen help default OFF, exit 0, no leftover processes (52 PASS overall; the single FAIL in each run was the flaky unit test above, which passes alone) |
| `npm run verify -- --packaged=<AppImage squashfs-root>/sudo-chan` | the same, READY 4.1 s |
| `node scripts/packaged-first-run.mjs <deb payload>/sudo-chan` | 15 PASS, 0 FAIL |
| `node scripts/packaged-first-run.mjs <AppImage squashfs-root>/AppRun` | 15 PASS, 0 FAIL |
| `scripts/onboarding-shots.mjs --app=<extracted app.asar>` (stock Electron, code from the packaged asar) | 22 screenshots, no horizontal overflow, finishing leaves `setupActive=false`, `onboardingDone=true`, mic/tools/screen/awareness all off |

Why a separate script: `--smoke-test` by design uses its own throw-away userData and never shows the wizard, so it cannot prove the first-run behaviour.
`scripts/packaged-first-run.mjs` (test-only) starts the packaged binary without `--smoke-test`, with a fresh `--user-data-dir`, a temp `HOME`, and
`--remote-debugging-port` on 127.0.0.1, then reads the windows through the DevTools protocol. The windows are really shown for a few seconds.

```
flock <heavy.lock> node scripts/packaged-first-run.mjs <packaged binary> [shots dir]
flock <heavy.lock> node_modules/electron/dist/electron --ozone-platform=x11 scripts/onboarding-shots.mjs <out dir> --app=<app.asar or extracted app folder>
```

## What was inspected

**The .deb** (`dpkg-deb -I`): Package `sudo-chan-desktop`, Version `0.1.0`, Architecture `amd64`, Maintainer and Vendor `Sid <noreply@sudo-chan.vercel.app>` (the documented placeholder),
Section `utils`, Depends `libgtk-3-0, libnotify4, libnss3, libgbm1, libxss1, libxtst6, libasound2 | libasound2t64, xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0`,
Recommends `libappindicator3-1`, Description "Desktop AI companion". Contents: `/opt/Sudo-chan/` (the Electron app, `sudo-chan` binary, `resources/app.asar`, `resources/apparmor-profile`),
`/usr/share/applications/sudo-chan.desktop`, `/usr/share/icons/hicolor/{16,24,32,48,64,128,256,512}x*/apps/sudo-chan.png`, `/usr/share/doc/sudo-chan-desktop/changelog.gz`.
`/usr/bin/sudo-chan` is created by the postinst (`update-alternatives`). `.desktop`: `Name=Sudo-chan`, `Exec=/opt/Sudo-chan/sudo-chan %U`, `Icon=sudo-chan`, `Categories=Utility;`,
`StartupWMClass=sudo-chan`, `Terminal=false`; `desktop-file-validate` clean.

**postinst:** registers `/usr/bin/sudo-chan` with `update-alternatives`; sets `chrome-sandbox` to 4755 only when the kernel has no user namespaces, otherwise 0755; refreshes the mime and
desktop databases; on systems with AppArmor 4 copies the bundled profile to `/etc/apparmor.d/sudo-chan` and loads it (skipped inside a chroot and when the parser does not accept it).
**postrm:** removes the alternative and unloads and deletes `/etc/apparmor.d/sudo-chan`. Nothing else: no network, no user accounts, no files outside `/opt/Sudo-chan`, `/usr/bin/sudo-chan`, `/etc/apparmor.d/sudo-chan`.

**The AppImage** (`--appimage-extract`, 274 MB extracted): `AppRun` (finds its folder, adds `--no-sandbox` only when user namespaces are missing), `sudo-chan.desktop` (`Exec=AppRun --no-sandbox %U`,
`StartupWMClass=sudo-chan`, validates), `.DirIcon` and `sudo-chan.png` pointing at the 512 px icon.
`app.asar` (673 entries): `dist/main` (34 files), `dist/preload` (2), `dist/renderer` (4), `dist/shared` (40, including `local-wake/`, `onboarding.js`, `live-talk.js`, `tasks.js`), `assets/icon.png`, `package.json`,
and the runtime dependencies (`electron-store`, `conf`, `ajv`, `atomically`, `type-fest`, `react`, `react-dom`, ... 27 packages). There is no `src`, `tests`, `scripts`, `config.json`, `.env`, `*.map` or `*.test.*`.
This was built from a real `node_modules` folder (a copy of the owner's, `npm ls --omit=dev` clean), which is the rule in `RELEASING.md`.

## Uninstall and upgrade (reasoned from the scripts)

The user's data lives in `~/.config/Sudo-chan` (settings, `config.json` with keys, tasks, notes, wake profile). No package file lives there, so `dpkg` does not know about it.
The postrm touches only the three paths above, in every maintainer-script call (`remove`, `purge`, `upgrade`); there is no `rm` of anything under `$HOME`.
Therefore `apt remove` and `apt purge` leave `~/.config/Sudo-chan` alone, and installing a newer `.deb` over 0.1.0 replaces `/opt/Sudo-chan` and keeps it.
During an upgrade dpkg runs the old postrm (removes the alternative and the AppArmor profile) after unpacking and before the new postinst, and the new postinst adds both again, so the end state is complete.
The AppImage installs nothing and shares the same `~/.config/Sudo-chan` with the .deb. Whoever wants a truly clean slate removes that folder by hand (`rm -rf ~/.config/Sudo-chan`); the app never does it.
A first launch of a newer version on an existing `config.json` does not show the wizard again (checked: second launch above).

## Defects found and fixed on this branch

1. **Window class did not match the menu entry.** The running windows had class `sudo-chan-desktop` (Electron took the npm package name), while the `.desktop` said `StartupWMClass=Sudo-chan`.
   The dock / app menu would not group the window under the installed entry. Fixed: `desktopName: "sudo-chan.desktop"` in `package.json` and `StartupWMClass=sudo-chan`; measured again on the rebuilt
   package. electron-builder also warned about the missing `desktopName`.
2. **The icon was one 1024 px PNG** (`/usr/share/icons/hicolor/1024x1024`). Many desktops do not pick that size for menus or launchers. Fixed: `assets/linux-icons/` with 16, 24, 32, 48, 64, 128, 256, 512 px, used by electron-builder for the deb and the AppImage.
3. **The deb did not depend on `libasound2` or `libgbm1`**, which the Electron binary links (speech and microphone use ALSA/Pulse). Fixed: `libgbm1` and `libasound2 | libasound2t64` (the Ubuntu 24.04 name), and `Section: utils` instead of `default`.
4. **Flaky unit tests** `edit_file: unique match ...` and `write_file: shows a preview card ...` (25 ms wait for the approval card is too short on a cold or loaded run). Wait is now 120 ms.
Regression tests: `tests/installer-config.check.mjs` (5 tests: class names agree, icon sizes, artifact names, runtime dependencies, deb depends) and `scripts/packaged-first-run.mjs` (checks the real X11 window class).

## Known limits of this test

- No real `apt install`, no sudo, nothing written outside temp folders; the AppImage was only run extracted. See the HUMAN column.
- The windows were really shown for a few seconds on this machine's X server (XWayland). No Xvfb exists here.
- Only one machine (Ubuntu-like, kernel 6.2, user namespaces allowed). The no-user-namespace and Ubuntu 24.04 paths are read, not run.
- The website's Linux install guide does not mention `libfuse2` (needed by the AppImage on Ubuntu 22.04+); see the owner TODO in `RELEASING.md`.
