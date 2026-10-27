# Changelog (desktop)

## usage-meter (on top of integrate2)

- **Realistic voice for every reply.** New setting `ttsQuality` (default `best`): Gemini voice is tried for every reply,
  one-word ones too, while it is not in a 429 back-off. `save` keeps the old rule (only replies of 3+ words use Gemini).
  Cached clips stay free, and the Gemini -> Azure -> Google fall-through is unchanged. Before this, short replies silently
  went to the robotic Google voice (about 72 of 85 replies in one real session).
- **Free usage meter.** New counters (per local day, 31 days kept; Azure per month) saved in `userData/usage.json`, no keys.
  Counts Gemini voice, Gemini listening, Groq listening (requests + audio seconds), Groq chat (requests + tokens), Azure
  characters and basic-voice fallbacks.
- **Real remaining quota for Groq** from the `x-ratelimit-*` response headers (listening, chat, tool turns, screenshot turns).
- **Gemini voice:** used vs an estimated 10 calls a day (always tagged "estimate"); a 429 marks "limit reached" until the
  reset time Google gave, and that is remembered across restarts.
- **Settings > Free usage** section (progress bar per service, `ttsQuality` control). **Chat window** shows one calm line
  only when Gemini voice hit its limit. The overlay bot is unchanged.
- IPC `companion:usage` (`getUsage()`), allowed for the Settings and Chat windows only.
- Tests: `tests/usage-meter.check.mjs` (25 tests); one older test now passes `getQuality: () => 'save'`.
  `npm run verify` got one smoke check for the new channel.

See `USAGE-METER.md`.

## intent-routing (on top of integrate2)

- New `src/shared/intent.ts`: `classifyIntent` (screen / task / chat, English + Roman Urdu + Urdu script) and `routeSpeech`. Default is no screenshot when unsure.
- Wake word: with "look at my screen" ON, only utterances that point at the screen start a screenshot ("meri screen dekho", "ye kya hai"). "Sudo, kaise ho?" and "Sudo, notes.txt bana do" no longer take a screenshot; tasks reach the tool loop.
- Live Talk window: "meri screen dekho" now starts the normal screenshot flow (same consent, countdown, sensitive-window guard and cooldown) instead of plain chat.
- Screenshot follow-ups: with tools ON, a command ("ye file edit kar do") is never treated as a vision follow-up; "file / window / tab / message / fix" alone no longer count as pointing words.
- Screenshot turn prompt: describes the screen and asks the user to repeat the task as a separate request (images and tools are never sent together).
- Settings privacy text no longer claims Sudo-chan never accesses screen / mic / files; it now says when each is used.
- Tests: +16 (309 total), see `tests/intent.check.mjs` and `tests/screen-flow.check.mjs`. Docs: `INTENT-ROUTING.md`, `../SCREEN-ASSIST.md`.
