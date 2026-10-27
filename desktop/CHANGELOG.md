# Changelog

## Unreleased (branch `intent-routing`)
- New `src/shared/intent.ts`: `classifyIntent` (screen / task / chat, English + Roman Urdu + Urdu script) and `routeSpeech`. Default is no screenshot when unsure.
- Wake word: with "look at my screen" ON, only utterances that point at the screen start a screenshot ("meri screen dekho", "ye kya hai"). "Sudo, kaise ho?" and "Sudo, notes.txt bana do" no longer take a screenshot; tasks reach the tool loop.
- Live Talk window: "meri screen dekho" now starts the normal screenshot flow (same consent, countdown, sensitive-window guard and cooldown) instead of plain chat.
- Screenshot follow-ups: with tools ON, a command ("ye file edit kar do") is never treated as a vision follow-up; "file / window / tab / message / fix" alone no longer count as pointing words.
- Screenshot turn prompt: describes the screen and asks the user to repeat the task as a separate request (images and tools are never sent together).
- Settings privacy text no longer claims Sudo-chan never accesses screen / mic / files; it now says when each is used.
- Tests: +16 (309 total), see `tests/intent.check.mjs` and `tests/screen-flow.check.mjs`. Docs: `INTENT-ROUTING.md`, `../SCREEN-ASSIST.md`.
