# Releasing Sudo-chan

How a desktop release is built and published. Nothing here publishes by itself: the release workflow only creates a **draft** GitHub Release that you review and publish by hand.

## What exists

| Piece | File | What it does |
| --- | --- | --- |
| Packaging config | `desktop/package.json` (`build`) | electron-builder targets, icons, file allow-list, artifact names |
| Icons | `desktop/assets/icon.{png,ico,icns}` | Rendered from the website icon (`app/icon.svg`) |
| CI | `.github/workflows/ci.yml` | Typecheck + tests for the website and the desktop app on every PR and push to `main` |
| Release | `.github/workflows/release.yml` | On a `v*` tag: build on Linux, Windows, macOS, then create a draft release with `SHA256SUMS` |
| Website Download section | `content.ts` (`RELEASE_PUBLISHED`), `components/DownloadPanel.tsx`, `app/download/page.tsx` (branch `download-cta`) | Off by default. One constant turns the "Coming soon" waitlist into a Download section that links to the latest GitHub release |
| Update check | `desktop/src/shared/update-check.ts`, wired in `desktop/src/main/index.ts` | Asks GitHub (from the main process only) at startup and at most once per 24 h whether a newer release exists. Shows one calm line in Settings. Never downloads or runs anything. Setting `updateCheckEnabled` turns it off |
| Changelog | `CHANGELOG.md` | The section matching the tag becomes the release notes |

Artifact names are `Sudo-chan-<version>-<os>-<arch>.<ext>`; the checksum file is named `SHA256SUMS`. The two Linux names below were produced and checked locally; the Windows and macOS names follow electron-builder's `${os}` values and have not been built yet. For example: `Sudo-chan-0.1.0-linux-x86_64.AppImage`, `Sudo-chan-0.1.0-linux-amd64.deb`, `Sudo-chan-0.1.0-win-x64.exe`, `Sudo-chan-0.1.0-mac-arm64.dmg`.

## Release checklist

1. **Merge** the work you want to ship into `main` and make sure CI is green.
2. **Version.** Set `version` in `desktop/package.json` (semver, for example `0.1.0`). The release workflow fails if the tag does not match it.
3. **Changelog.** In `CHANGELOG.md`, make sure there is a `## [x.y.z] - YYYY-MM-DD` section for this version, honest and user-facing. Copy the "Known limitations" list; do not drop it.
4. **Local checks** (from `desktop/`): `npm run typecheck`, `npm run build`, `npm test`.
5. **Local package** (Linux): `npm run package:linux`, then run the AppImage or `release/linux-unpacked/sudo-chan`. For a headless check: `release/linux-unpacked/sudo-chan --no-sandbox --smoke-test` should print `SUDO_CHAN_READY` (the app uses its own throw-away userData in smoke mode). Quit any running Sudo-chan first (single-instance lock).
6. **Tag and push** (this is the step that starts the release build):
   ```
   git tag v0.1.0
   git push origin main
   git push origin v0.1.0
   ```
7. **Watch the Actions tab.** The `Release` workflow runs three builds (linux, windows, macos) and then a `draft-release` job. If a build fails, fix it, delete the tag (`git push --delete origin v0.1.0`, `git tag -d v0.1.0`) and tag again.
8. **Review the draft** under GitHub, Releases:
   - Download every installer and compare with `SHA256SUMS` (`sha256sum -c SHA256SUMS --ignore-missing`).
   - Smoke test on each OS you can reach: it starts, the bot appears, Settings open, chat works with your own key.
   - Read the generated notes. Tick "Set as a pre-release" for early builds.
9. **Publish** the draft (this is the moment the app becomes public).
10. **Flip the website switch** (see "Owner steps" below). Announce to the waitlist.

## Owner steps for the first release (exact order)

Nothing below happens by itself; every step is yours. The website keeps saying "Coming soon" until step 8.

1. **Fix the placeholder contact.** `desktop/package.json` uses `noreply@sudo-chan.vercel.app` as author/maintainer email (it ends up in the `.deb` control file). Replace it with a real address if you want one shown, and change `author.name` ("Sid") if you want another name. Also change `copyright` and `homepage` if needed.
2. **Merge the branches** you want to ship (`installer-release` for the desktop app, `download-cta` for the website) into `main`, push, and wait for CI to be green. Merging `download-cta` alone changes nothing visible: `RELEASE_PUBLISHED` is `false`.
3. **GitHub settings:** repository Settings, Actions, General: allow Actions, workflow permissions "Read and write".
4. **Build the files** either (a) with CI: tag `v0.1.0` (steps 2 to 7 of the checklist above) and use the draft the workflow creates, or (b) by hand, with the Linux files built on this laptop:
   ```
   cd desktop && npm run package:linux          # AppImage + deb into desktop/release/
   cd release && sha256sum Sudo-chan-0.1.0-linux-* > SHA256SUMS
   ```
5. **Create the GitHub release** (repository, Releases, Draft a new release): tag `v0.1.0`, title `Sudo-chan 0.1.0`, tick **Set as a pre-release**, paste the `0.1.0` section of `CHANGELOG.md` as the notes.
6. **Upload** `Sudo-chan-0.1.0-linux-x86_64.AppImage`, `Sudo-chan-0.1.0-linux-amd64.deb` and `SHA256SUMS` (the exact file names; the Linux check on the website and the in-app update check both expect a normal published, non-draft release). Re-run `sha256sum -c SHA256SUMS` on the downloaded files before publishing.
7. **Publish the release.**
8. **Flip the website switch:** in `content.ts` change `export const RELEASE_PUBLISHED: boolean = false;` to `true`, run `npm test` and `npm run build`, commit, push to `main`.
9. **Deploy** the website (your usual Vercel flow). The "Coming soon" text, the waitlist block and the "not released" lines then become the Download section; `/download` goes live and appears in the sitemap.
10. **Smoke test as a stranger:** open the site, click Download, install the AppImage or `.deb` on a clean machine, run `sha256sum -c SHA256SUMS --ignore-missing`.

To take the download down again, set `RELEASE_PUBLISHED` back to `false` and redeploy.

## Known limitations to repeat in every release note

- Early prototype. Linux first; Windows and macOS builds exist only through CI and are untested until you run them.
- Builds are **unsigned**. Windows SmartScreen ("Windows protected your PC") and macOS Gatekeeper ("developer cannot be verified") will warn. See `/download`.
- Urdu and Roman Urdu speech recognition is unreliable; a good share of short clips may not be understood.
- The default voice is robotic. Natural voices need a Gemini or Azure key; Gemini's free quota is tiny.
- Users must bring their own API key. Keys are stored on the user's computer but not strongly encrypted yet.
- Tools that act on the computer (files, commands) and screen help are on separate branches and are **not** in a release built from `main` unless you merge them. They are off by default and ask first.
- The packaged app was only tested on one Linux machine. On Ubuntu 24.04 and other systems that restrict unprivileged user namespaces, the AppImage may need `--no-sandbox` (the `.deb` installs a setuid sandbox helper and does not).

## Code signing (optional, recommended before wider release)

Unsigned builds work but scare users. The workflow has commented-out environment variables in the `Package` step. Never put real values in the file: add them as repository secrets (Settings, Secrets and variables, Actions), remove `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`, and uncomment what you need.

- **Windows:** an Authenticode certificate (`WIN_CSC_LINK` as base64 or URL of the `.pfx`, `WIN_CSC_KEY_PASSWORD`). Without a reputable (EV) certificate SmartScreen may still warn for a while.
- **macOS:** an Apple Developer ID certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`) and notarization (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Set `hardenedRuntime` to `true` in the `mac` section when signing.
- **Linux:** no signing needed; publish the checksums.

## Update check (wired in)

`desktop/src/shared/update-check.ts` is a pure module (injected `fetch`, clock and storage) and `desktop/src/main/index.ts` runs it:

- Only in the **main process**. The renderer has no network access (CSP `connect-src 'none'`); it asks `getUpdateNotice()` over IPC, restricted to the Settings window, and receives a version number and nothing else.
- Runs about 20 s after startup and then is re-evaluated every hour, but a real request to `api.github.com/repos/salahudingsalahudin-ai/sudo-chan/releases` happens **at most once per 24 hours** (a failed attempt is retried after an hour). No token, no identifiers, 6 s timeout, fails silently offline. Never runs in `--smoke-test`.
- Shows **one calm line in Settings** ("Version x.y.z is available...") in the privacy card. No popup, no sound, nothing on the overlay or chat, no automatic download, no link is opened for the user.
- Turned off by the Settings switch "Check for new versions" (`updateCheckEnabled`, default on). Off means no request at all.
- Newest non-draft release wins (prereleases count); a tag like `v0.2.0` is compared with `app.getVersion()` using semver ordering.

## Automatic updates later (electron-updater)

Possible, but it is a larger step with real costs:

- It needs a new dependency (`electron-updater`) and a `publish` provider in the build config, and the release must also upload the `latest.yml` / `latest-mac.yml` / `latest-linux.yml` files and block maps that electron-builder generates.
- **macOS requires code signing and notarization** for auto-update to work at all.
- **Windows** installs updates without signing, but an unsigned updater means users cannot tell a genuine update from a swapped one, and SmartScreen will keep warning. Signing is the real protection: electron-updater checks the new installer's signature publisher when the app is signed.
- **Linux** auto-update works for the AppImage only; `.deb` users update through their package manager.
- Updates replace the program on the user's machine, so an unsigned, unaudited pipeline is a supply-chain risk. Do this only after signing is in place and the release workflow is trusted.

Until then, the update check above (a notice and a link, no download) is the safe option.
