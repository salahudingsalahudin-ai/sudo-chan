# Intent routing ("what does Sudo-chan do with what I said?")

Branch `intent-routing`, based on `integrate2`. Code: `src/shared/intent.ts` (pure, unit-tested in `tests/intent.check.mjs`), wired in `src/renderer/App.tsx` (overlay) and `src/shared/screen-flow.ts` (follow-ups).

## The problem it fixes
With "Let Sudo-chan look at my screen" ON, every utterance after the wake word was a screenshot turn: "Sudo, kaise ho?" took a screenshot and made a vision call, and "Sudo, notes.txt bana do" reached a vision model that has tools paused, so the task was refused. Within two minutes of a screenshot, words like file / window / message / fix also made "ye file edit kar do" a vision follow-up with no tools. Inside the 30 s Live Talk window, "meri screen dekho" went to plain chat, so the model said it cannot see.

## The three routes
`classifyIntent(text) -> 'screen' | 'task' | 'chat'` (English, Roman Urdu / Hinglish, Urdu script). Default is NO screenshot: anything unclear is `chat`.

| Route | What happens | Examples |
|---|---|---|
| `screen` | Starts the screenshot flow (consent once, countdown, sensitive-window guard, cooldown, vision call) - only if the setting is ON | "meri screen dekho", "screen dekh", "look at my screen", "what's on my screen", "ye kya hai", "ye error kya hai", "isme kya likha hai", "ye dekho", "dekho main kya kar raha hoon", "kya dikh raha hai", "میری اسکرین دیکھو", "یہ کیا ہے" |
| `task` | Normal chat turn; the tool loop decides (files, reminders, commands) | "notes.txt bana do", "ye save karo", "khol do", "delete karo", "script chalao", "reminder lagao", "create a file", "run the script", "ye window band karo", "فائل کھول دو" |
| `chat` | Normal chat turn, no image | "kaise ho", "bank ka kaam hai", "dekho yaar mujhe nahi pata", "ye file kya hai", "what is the error in python", "screen ki brightness kam karo" |

`routeSpeech(rest, { screenAssist, afterWake })` turns that into the final decision: `screen` only when screen assist is ON **and** the intent is `screen`; otherwise a plain message.

## Rules in short
- "screen / screenshot / اسکرین" used for looking ("screen dekho", "screen par kya hai", "screenshot lo") is `screen`. "screen band / lock / brightness / share / record" is the device, not a request to look: not `screen`.
- Pointing without the word "screen" needs a clear shape: "ye kya hai", "iska matlab kya hai", "what is this", "ye dekho", "look at this", "ye + error/code/button/popup... + kya", "dekho main kya kar raha hoon", "kya dikh raha hai". Any mention of a file / folder / notes / `name.ext` blocks this path (files are the tool domain).
- Imperative task verbs (Roman Urdu / Urdu script: bana, chalao, likho, padho, save, khol, delete, hatao, mitao, yaad dilao, reminder lagao, edit, download ...; English: create, write, open, run, list, delete, remove, save, read, rename, move, copy, find, remind me ... only at the start of a request, never after "how / what / why ...") are `task`.
- Screen and task in one sentence: `screen` only if the user explicitly says screen AND asks to look / read / explain ("meri screen dekh ke ye kaam kar do"). "screen par notes.txt khol do", "dekho ye kaam kar do", "ye dekh ke notes.txt bana do" are `task`.
- A bare wake word ("Sudo" and nothing else) keeps today's behaviour: with screen assist ON it starts the screenshot flow (same consent / countdown / guard). Silence inside the Live Talk window never captures.

## Where it is applied
1. **Wake word** (overlay `onFinal`): `routeSpeech(match.rest, { screenAssist, afterWake: true })`. `screen` -> `sendScreen({ source: 'wake' })`; otherwise `sendMessage(rest, true)` as before.
2. **Live Talk window** (30 s after the name, no name needed): `routeSpeech(text, { screenAssist, afterWake: false })`. `screen` -> `sendScreen({ source: 'wake' })`, so the consent panel, countdown, sensitive-window guard and cooldown all still apply. Otherwise `sendMessage`.
3. **Follow-ups** (`isScreenFollowUp(text, { toolsEnabled })`, used by `ScreenFlow.followUp` through the new optional `toolsEnabled` dep): with tools ON, a specific command ("ye file edit kar do", "notes.txt bana do", "save kar do") is never a vision follow-up. A bare "karo / kar do" next to a word that really points at the screen ("upar wali line theek karo", "ye error fix karo") stays one. `file`, `window`, `tab`, `message`, `fix` alone no longer count as pointing words. Real follow-ups ("ye line kya karti hai", "aur neeche?", "aur is error ka fix batao") still work.
4. Nothing was loosened: consent still needs a click, the countdown, guard and cooldown are unchanged, and there is still no timer or background capture.

## "Dekh ke kaam karo" (screen + task) - cheapest safe version
Images and tools are never sent in the same request. Turn 1 ("meri screen dekh ke ye kaam kar do") is a screenshot turn: the model describes what it sees (the answer is kept in chat history as text; the image stays in memory only, as before). The system prompt tells it that tools are not available on that turn and that the user can say the task again right after. Turn 2 ("ab notes.txt bana do") is a `task`: normal tool loop, with the description already in history.

## Known misses (by design, privacy first)
- "Sudo, ye dekh lo" style phrases with extra words, "dekh ke batao" alone, or "isko samjhao" (no screen word, no clear shape) are `chat`: say "meri screen dekho" instead.
- "ye file kya hai" / "is file mein kya likha hai" are `chat` on purpose (a file mention never triggers a screenshot).
- `task` vs `chat` is a loose guess; both go to the same chat/tool path, so a miss only matters for the follow-up rule above.
- Roman Urdu spelling varies and speech-to-text mishears: an unrecognised spelling falls back to `chat` (no screenshot). The Chat window's own Live Talk and the typed chat box are not routed by this module (typing uses the 👀 button).
- "kya dikh raha hai" with no object is treated as a screen question.
- Very long rambling sentences are rarely `screen`; pointing phrases are limited to short utterances.
