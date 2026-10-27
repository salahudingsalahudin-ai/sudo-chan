# Releasing Sudo-chan

How a desktop release is built and published. Nothing here publishes by itself: the release workflow only creates a **draft** GitHub Release that you review and publish by hand.

## What exists

| Piece | File | What it does |
| --- | --- | --- |
| Packaging config | `desktop/package.json` (`build`) | electron-builder targets, icons, file allow-list, artifact names |
| Icons | `desktop/assets/icon.{png,ico,icns}` | Rendered from the website icon (`app/icon.svg`) |
| CI | `.github/workflows/ci.yml` | Typecheck + tests for the website and the desktop app on every PR and push to `main` |
| Release | `.github/workflows/release.yml` | On a `v*` tag: build on Linux, Windows, macOS, then create a draft release with `SHA256SUMS.txt` |
| Download page | `app/download/page.tsx`, `lib/releases.ts` | Shows the newest published release, or "no build yet" before the first one |
| Update check | `desktop/src/main/update-check.ts` | Tells the app if a newer release exists. Never downloads or runs anything. **Not wired into the app yet, see below.** |
| Changelog | `CHANGELOG.md` | The section matching the tag becomes the release notes |

Artifact names are `Sudo-chan-<version>-<os>-<arch>.<ext>`. The two Linux names below were produced and checked locally; the Windows and macOS names follow electron-builder's `${os}` values and have not been built yet. For example: `Sudo-chan-0.1.0-linux-x86_64.AppImage`, `Sudo-chan-0.1.0-linux-amd64.deb`, `Sudo-chan-0.1.0-win-x64.exe`, `Sudo-chan-0.1.0-mac-arm64.dmg`.

## Release checklist

1. **Merge** the work you want to ship into `main` and make sure CI is green.
2. **Version.** Set `version` in `desktop/package.json` (semver, for example `0.1.0`). The release workflow fails if the tag does not match it.
3. **Changelog.** In `CHANGELOG.md`, make sure there is a `## [x.y.z] - YYYY-MM-DD` section for this version, honest and user-facing. Copy the "Known limitations" list; do not drop it.
4. **Local checks** (from `desktop/`): `npm run typecheck`, `npm run build`, `npm test`.
5. **Local package** (Linux): `npm run package:linux`, then run the AppImage or `release/linux-unpacked/sudo-chan`. For a headless check: `release/linux-unpacked/sudo-chan --no-sandbox --smoke-test` should print `SUDO_CHAN_READY`. Quit any running Sudo-chan first (single-instance lock).
6. **Tag and push** (this is the step that starts the release build):
   ```
   git tag v0.1.0
   git push origin main
   git push origin v0.1.0
   ```
7. **Watch the Actions tab.** The `Release` workflow runs three builds (linux, windows, macos) and then a `draft-release` job. If a build fails, fix it, delete the tag (`git push --delete origin v0.1.0`, `git tag -d v0.1.0`) and tag again.
8. **Review the draft** under GitHub, Releases:
   - Download every installer and compare with `SHA256SUMS.txt` (`sha256sum -c SHA256SUMS.txt --ignore-missing`).
   - Smoke test on each OS you can reach: it starts, the bot appears, Settings open, chat works with your own key.
   - Read the generated notes. Tick "Set as a pre-release" for early builds.
9. **Publish** the draft. The website `/download` page picks it up within an hour (it caches the GitHub answer for 3600 s) or on the next deploy.
10. **After publishing:** update the landing-page FAQ ("The desktop app is not released yet...") and the planned-privacy section on `/privacy` so the website no longer says there is no app. Announce to the waitlist.

## First release, exact steps for the owner

1. In GitHub, repository Settings, Actions, General: allow Actions, and set workflow permissions to "Read and write" (the release job also declares `contents: write`).
2. Merge this branch (`release`) and the voice work into `main`; push; wait for CI.
3. Follow steps 2 to 9 above with `v0.1.0`.

## Known limitations to repeat in every release note

- Early prototype. Linux first; Windows and macOS builds exist only through CI and are untested until you run them.
- Builds are **unsigned**. Windows SmartScreen ("Windows protected your PC") and macOS Gatekeeper ("developer cannot be verified") will warn. See `/download`.
- Urdu and Roman Urdu speech recognition is unreliable; a good share of short clips may not be understood.
- The default voice is robotic. Natural voices need a Gemini or Azure key; Gemini's free quota is tiny.
- Users must bring their own API key. Keys are stored on the user's computer but not strongly encrypted yet.
- Tools that act on the computer (files, commands) and screen help are on separate branches and are **not** in a release built from `main` unless you merge them. They are off by default and ask first.
- The packaged app was only tested on one Linux machine.

## Code signing (optional, recommended before wider release)

Unsigned builds work but scare users. The workflow has commented-out environment variables in the `Package` step. Never put real values in the file: add them as repository secrets (Settings, Secrets and variables, Actions), remove `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`, and uncomment what you need.

- **Windows:** an Authenticode certificate (`WIN_CSC_LINK` as base64 or URL of the `.pfx`, `WIN_CSC_KEY_PASSWORD`). Without a reputable (EV) certificate SmartScreen may still warn for a while.
- **macOS:** an Apple Developer ID certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`) and notarization (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Set `hardenedRuntime` to `true` in the `mac` section when signing.
- **Linux:** no signing needed; publish the checksums.

## Update check (not wired in yet)

`desktop/src/main/update-check.ts` is a self-contained module: `checkForUpdate(deps, { force })` asks `api.github.com/repos/<owner>/<repo>/releases` for the newest non-draft release, compares it to `app.getVersion()` with semver ordering (a release beats its prerelease), and returns `{ available, version, url, reason }`. It runs at most once per 24 hours (a failed attempt is retried after an hour), sends no credentials, fails silently offline, never downloads or executes anything, only returns `github.com` links, and does nothing at all when the opt-out is set.

It is deliberately **not connected** to the app yet, because the settings, IPC and Settings screen files are being changed on other branches. To connect it after those branches are merged:

1. Add a boolean setting `updateCheckEnabled` (default `true`) to `Settings` in `src/shared/types.ts`, `DEFAULT_SETTINGS` and `validSettings` in `src/shared/validation.ts`, and a toggle in Settings ("Check for updates once a day").
2. In `src/main/index.ts` create the checker and expose it:
   ```ts
   import { checkForUpdate } from './update-check.js';
   const updateInfo = (force = false) => checkForUpdate({
     fetch: (url, init) => fetch(url, init),
     now: () => Date.now(),
     currentVersion: () => app.getVersion(),
     isEnabled: () => state.settings.updateCheckEnabled !== false,
     readState: () => store.get('updates'),
     writeState: next => store.set('updates', next),
   }, { force });
   ```
   Add `updates` to the electron-store schema, call `updateInfo()` a minute after startup, and add an IPC channel for a Settings "Check now" button (`updateInfo(true)`).
3. Show the result as a quiet line in Settings ("Version 0.2.0 is available" with a link that opens the release page in the browser). Do not auto-open it and do not download anything.

## Automatic updates later (electron-updater)

Possible, but it is a larger step with real costs:

- It needs a new dependency (`electron-updater`) and a `publish` provider in the build config, and the release must also upload the `latest.yml` / `latest-mac.yml` / `latest-linux.yml` files and block maps that electron-builder generates.
- **macOS requires code signing and notarization** for auto-update to work at all.
- **Windows** installs updates without signing, but an unsigned updater means users cannot tell a genuine update from a swapped one, and SmartScreen will keep warning. Signing is the real protection: electron-updater checks the new installer's signature publisher when the app is signed.
- **Linux** auto-update works for the AppImage only; `.deb` users update through their package manager.
- Updates replace the program on the user's machine, so an unsigned, unaudited pipeline is a supply-chain risk. Do this only after signing is in place and the release workflow is trusted.

Until then, the update check above (a notice and a link, no download) is the safe option.
