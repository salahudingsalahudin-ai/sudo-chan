# Free usage meter

Where to look: **Settings > Free usage** (also the "Free usage" tab at the top). The Chat window shows one line,
"Realistic voice limit reached today - using basic voice until HH:MM", only while Gemini voice is blocked.

## What is counted

| Row | Counts | Allowance shown | Tag |
|---|---|---|---|
| Gemini voice | successful Gemini TTS calls today | ~10 per day | estimate |
| Gemini listening | successful Gemini transcriptions today | ~250 per day | estimate |
| Groq listening | requests today (+ about N s of audio) | from Groq headers | exact |
| Groq chat | requests today (+ tokens, tokens left this minute) | from Groq headers | exact |
| Azure voice | characters this month | 500,000 (free plan) | free plan |

Also shown: how many replies used the basic (Google) voice today although a better engine was wanted.

## Where the numbers come from

- **Groq** sends `x-ratelimit-limit-requests`, `remaining-requests`, `limit-tokens`, `remaining-tokens`, `reset-requests`,
  `reset-tokens` on every response (also on 429). The latest values are kept; a snapshot older than 24 h is ignored.
  When `remaining-requests` is 0 the row says "Limit reached - resets at HH:MM".
- **Gemini** sends nothing like that. The allowance is an estimate (`GEMINI_TTS_DAILY_ESTIMATE` in `src/shared/usage.ts`).
  A 429 marks the service blocked until `now + retryAfter` (Retry-After / retryDelay / "retry in 7h11m"; at least 30 min for
  per-day quotas). The block is saved, so a restart does not retry until the reset. Saving a key lifts it.
- **Azure** characters are counted from successful requests (the Test buttons count too).

## Voice policy (`ttsQuality`)

- `best` (default): Gemini for every reply while the key works and it is not in back-off, then Azure, then Google.
- `save`: replies under 3 words skip Gemini (the earlier behaviour).
Cached clips are free in both modes.

## Storage and privacy

- `<userData>/usage.json` (Linux: `~/.config/Sudo-chan/usage.json`), mode 600, written 2 s after the last change and on quit
  (temp file + rename). It is separate from `config.json` and holds only counters, Groq numbers and reset times.
- The IPC summary is the same kind of plain data. Only the Settings and Chat windows may ask (`authorize()`).
- Counters roll over at local midnight; days older than 31 are dropped; Azure months older than 12 are dropped.

## Known limits

- Gemini numbers are an estimate: Google can change the free tier, and the real daily reset may differ from the time shown
  when a 429 carries no retry hint (a per-day quota then shows a 30 min minimum, the router retries then, which costs nothing).
- Groq audio seconds for compressed clips are a rough guess (WAV is exact).
- Only Groq chat is counted for chat; Gemini/OpenAI chat usage is not shown.
- Counts are for this app only; other apps using the same keys are not visible (Groq's headers do include them).
