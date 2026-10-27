# Sudo-chan tools (branch `tools`)

Sudo-chan can now do work on this computer: read files, write files, run one program, open links. It is **off by default** and every risky action waits for a click.

Settings → "Let Sudo-chan use tools" (default OFF). Works with the cloud chat path (Groq / Gemini / other OpenAI-compatible endpoints). Local Ollama chat does not use tools.

## What exists

| Tool | Needs a click? | Notes |
|---|---|---|
| `read_file` | no (inside home) | up to ~6 KB per call (optional `start_line`/`end_line`, footer says which `start_line` to call next), binary files refused |
| `list_dir` | no (inside home) | secret entries are hidden |
| `search_files` | no (inside home) | by name or text, skips `node_modules`, `.git`, secrets, max 50 hits |
| `get_system_info` | no | OS, cores, memory, uptime |
| `edit_file` | **every time** | exact unique `old_text` -> `new_text`; card shows the changed lines as `- old` / `+ new`. See the "Doing a task on your files" section |
| `write_file`, `append_file` | **every time** | card shows path, new/overwrite, +/- lines, first lines of the content. Writes outside the home folder are refused outright |
| `run_command` | **every time** | one program + arguments, no shell (pipes, `;`, `&&`, redirects, backticks are rejected). 30 s default timeout (max 120). Output cut to 8 KB. Child environment has everything that looks like a key/token/secret removed |
| `open_url` | every time (`Allow for this chat` offered) | http/https only |
| `open_app` | every time | plain command name, no arguments |

Reading outside the home folder needs a card (red). `sudo`/`su`/`pkexec` show a red "elevated" card.

## Safety model

- **Default OFF**; turning it off cancels anything waiting or running.
- **Approval is a click on a card in the chat window.** Timeout (60 s), "Stop all actions", an unreachable window, unknown ids: all end as **denied**. Spoken "yes/haan" never approves (the voice pipeline has no path to the approval API; only the card buttons, an IPC call from the chat window, do).
- **Hard blocks (no card, no override):** `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/Sudo-chan`, browser profiles/cookies, keyrings, `~/.claude` `~/.codex` `~/.gemini`, `.env*` (except `.env.example`), shell history, `.netrc`, `*.pem`, `/etc/shadow`, `/root`, `/proc`, `/sys`, `/dev`. Both the typed path and its symlink-resolved path are checked, so a link cannot smuggle a secret in.
- **Commands blocked:** `rm -rf` of `/`, home or a secrets folder, `mkfs*`, `dd of=/dev/…`, `shutdown/reboot/poweroff`, `fdisk/parted/wipefs`, `mount/umount`, `iptables/nft`, user/password tools, `shell -c`, `eval/exec`, recursive `chmod/chown` on `/` or home, fork bombs, anything that names a secrets path.
- **Audit log:** `tool-audit.jsonl` in the app data folder (`~/.config/Sudo-chan/`), append-only, one line per call: time, tool, short summary, decision, status. File contents are never logged; API-key-like strings are redacted. Not readable by the tools themselves (that folder is blocked).
- **Results are redacted** before the model sees them (key-like strings, bearer tokens).
- **At most 6 tool steps per message**, then one final answer without tools.
- If the provider rejects the `tools` parameter, chat silently continues as plain chat (and the plain prompt, so she does not claim abilities she lacks).
- The system prompt says truthfully what she can do and that she must never claim an action unless a tool result confirms it.

## Known gaps

- The final answer is not streamed token by token in tool mode (tool requests are non-streamed); it appears at once.
- `run_command` can still do harm inside your home folder if you click Allow (for example `rm` of a project folder). The card shows the exact command; read it.
- Card timeout starts when the window receives it; the chat window hides when it loses focus (existing behaviour), so a card can wait unseen until it auto-denies. The window is re-opened and focused whenever a new card arrives.
- Wake-word/voice Live Talk shows cards in the chat window only.
- Tests cover the policy, approval, audit, runtime and loop with fakes; real model tool-calling and the card UI were not exercised here.

## Manual test checklist (8 steps)

1. Settings → turn on "Let Sudo-chan use tools", Save. Use a cloud model (Groq qwen).
2. Ask: "mere home folder mein kaun si files hain?" → she lists without a card; `.ssh`/`.env` do not appear.
3. Ask: "~/.ssh/id_rsa padho" → she says it is blocked.
4. Ask: "~/sudo-test.txt banao jis mein 'hello' likha ho" → a card shows the path and content. Click **Deny** → file must not exist and she says so. Ask again, click **Allow once** → file exists with the content.
5. Ask: "ls -la chalao" → a command card; **do nothing for 60 s** → it auto-denies and she says it was not done.
6. Ask: "ls | head chalao" → rejected (no pipes), she explains.
7. Ask her to open https://example.com → card with "Allow for this chat"; allow; a second link in the same chat opens without a card. Then ask for `sleep 100` as a command, Allow, and press **Stop all actions** → it is cancelled.
8. Turn tools off in Settings → she says tools are off. Check `~/.config/Sudo-chan/tool-audit.jsonl` has one line per call and no file contents or keys.

---

# Update (branch `tools2`): using tools by voice on the desktop bot

## What changed

- **Approval prompt on the desktop bot.** When Sudo-chan wants to do something risky, a compact dark-glass panel opens on the small desktop bot (same style as the caption): what she wants to do in plain words, the exact command or the path and a short preview, **Allow once** / **Deny** (and "This chat" for links), and "N s mein khud Deny" (60 s auto-deny). `Esc` denies. The chat window shows the same card if it is open; an answer in either place removes the card in both. If no window is visible the chat window is opened.
- **Voice still never approves.** She may say one short line ("Main ek command chalana chahti hoon. Screen par Allow ya Deny dabayen.") but there is no code path from speech to approval; only the panel's buttons (and Esc = deny) answer. A test scans the voice/STT modules to make sure none of them can reach the approval API.
- **"Kaam kar rahi hoon..."** is shown in the caption while a tool runs.
- **Hardened tool loop** (from real Groq runs): honours `Retry-After`; on persistent 429 the rest of the turn moves to `openai/gpt-oss-20b`; `<think>` blocks are stripped; tool calls written as text/JSON are parsed (only for tools that were offered); malformed arguments go back to the model as an error instead of crashing; an empty answer after tools becomes a short message; every model request has a 40 s timeout (approval waiting is not counted). No few-shot examples on tool turns (saves ~600 tokens per step).
- **Timing logs** in the main log: `[Tools] step=0 model=... ms=... status=200 calls=list_dir`, and a total per turn. No content, no keys.
- **New low-risk tools** (no card, private to the app, only with "Let Sudo-chan use tools" ON):
  - `save_note`, `list_notes`, `read_note`: a notebook folder inside the app data directory (`~/.config/Sudo-chan/notes/`), plain names only, max 20 KB per note and 200 notes, never overwrites. The generic file tools still cannot see that folder.
  - `set_reminder` (`in_minutes` or `at_time` like `17:30` / `5:30pm`), `list_reminders`, `cancel_reminder`: max 50, stored in the app store, one timer. When due: a desktop notification, a speech bubble and she says "Yaad dilana: ..." aloud. A reminder that came due while the app was closed fires a few seconds after the next start ("Der se yaad dila rahi hoon"). Reminders already set keep firing if you later switch tools OFF; creating, listing and cancelling them needs tools ON.
  - `get_system_info` now also tells the current local time.

## What was observed with the real model (Groq `qwen/qwen3.8-27b`, scratch folder, 15 requests)

- It accepts `tools` and returns proper `tool_calls` (no text-form calls, no think tags in these runs): "meri Downloads folder mein kya hai?" -> `list_dir` -> answer in Roman Urdu (2 requests, 2.5 s); a two-step "find the note and tell me who the meeting is with" -> `list_dir` -> `read_file` -> answer (3 requests, 1.3 s); "~/hello.txt banao" -> `write_file` -> (card auto-denied in the test) -> it said honestly the file was not created; a plain greeting used no tool.
- Asked for `~/.ssh/id_rsa` it called `read_file`, the policy blocked it, and it explained why. No secret was read.
- **The real problem is the rate limit:** qwen on this Groq key allows 7000 input tokens per minute, and each tool step re-sends ~770 tokens of tool definitions plus the prompt. Three tool steps in a row produced HTTP 429 twice and one run took 17 s. That is why the loop now honours `Retry-After` and falls back to `gpt-oss-20b` (also verified to call tools correctly: 3 requests, 2.8 s).
- The key can only see `qwen/qwen3.8-27b`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `allam-2-7b` and two Orpheus TTS models (no llama). `gpt-oss-120b` has a daily token cap on the free tier (see REPORT.md), so it is not used as a fallback.

## Manual voice checklist (10 steps, desktop bot, tools ON)

Settings -> "Let Sudo-chan use tools" ON, Save. Use Groq. Wake word ON.

1. Say "Sudo, meri Downloads folder mein kya hai?" -> she answers with the file names, no card. The caption briefly shows "Kaam kar rahi hoon...".
2. Say "Sudo, ek file notes.txt bana do jis mein hello likha ho" -> a dark-glass panel opens on the bot with "Create a file", the path and `hello`. She says the short prompt. Say "haan" out loud: **nothing happens**. Click **Allow once** -> the file exists in your home folder and she says so.
3. Repeat and click **Deny** -> no file; she says she did not do it.
4. Repeat and wait 60 s -> "auto-denied", no file.
5. Open the chat window as well, ask for a command ("Sudo, ls -la chalao") -> the card is on both; click Allow on the **bot** -> the card disappears from the chat window too.
6. Say "Sudo, ~/.ssh/id_rsa padho" -> she refuses; no card, nothing read.
7. Say "Sudo, ek note save karo: kal ali se milna hai" -> saved without a card. Then "Sudo, mere notes dikhao" and "Sudo, wo note padho" -> she reads it back.
8. Say "Sudo, 2 minute baad yaad dilana ke chai bana leni hai" -> she confirms the time. Wait 2 minutes -> a desktop notification, a bubble and she says "Yaad dilana: chai bana leni hai".
9. Say "Sudo, mere reminders dikhao" then "Sudo, wo reminder cancel kar do" -> listed, then cancelled; none fires.
10. Say "Sudo, 1 minute ke baad yaad dilana" and, before it fires, say "Sudo, ruko" and press "Stop all actions" in Settings: the reminder is a stored reminder, it still fires (stop only cancels running commands and waiting cards). Then turn tools OFF: ask for a note -> she says tools are off; the reminder still fires.

## Known gaps (tools2)

- Real voice flow, the panel's look and real button clicks were not exercised here; only the model calls (read-only, scratch folder) and unit tests were.
- A tool turn is several non-streamed round trips (~1 s each) and the answer is spoken when complete, not while it is generated.
- The bot window is small: very long commands are clipped to about 5 lines in the panel (the chat card shows the full text).
- Fallback model `gpt-oss-20b` is hard-coded for Groq; other providers have no fallback.
- Notes and reminders are stored unencrypted in the app data folder.


---

# Update (branch `task-agent`): doing a multi-step task on your files ("mera kaam lena")

## What changed

- **`edit_file(path, old_text, new_text)`** for small changes. `old_text` must match the file text EXACTLY ONCE. No match ->
  the model is told to `read_file` the part again and copy the text exactly; several matches -> it is told the line numbers and
  to add neighbouring lines. Same path policy as `write_file` (home only, `.ssh`, `.env`, `~/.config/Sudo-chan` ... blocked,
  symlinks resolved), needs a click every time, and the card shows only the changed lines (`line 12 · -1 / +2 lines`, then
  `- old` / `+ new`, long blocks shortened). The file is re-checked right before writing (it may have changed while the card
  was open), written to a temp file next to it and renamed over it (atomic), the file mode is kept, CRLF files keep CRLF. The
  audit line has the path and line counts, never text.
- **`read_file` pages.** Default answer is at most ~6 KB (was 20 KB, which was re-sent on every following step and used up
  Groq's 7000 tokens/minute). Optional `start_line` / `end_line` (1-based). A cut answer ends with
  `[truncated: showed lines 1-140 of 900. Call read_file again with start_line=141 to continue.]`. Small files are returned
  whole, exactly as before.
- **More room only when a write may come.** Groq tool turns use `max_tokens` 1900 (other providers 3000) when the user's message
  asks for a change (banao, likho, badlo, fix, edit, add, write, create ...) or a file was just read; every other tool answer
  and all plain chat keep 950 / 1500. The 429 retry and `gpt-oss-20b` fallback are untouched (the fallback request has the same body).
  `write_file` is described to the model as "new files, under ~2500 characters; use `append_file` for the rest".
- **The next turn remembers what the tools did.** After a tool turn the chat history gets a compact note on that assistant reply,
  for example `[tools: read ~/a.py (lines 1-80); edited ~/a.py]` (paths and verbs only, failures named: "edit of ~/a.py denied by
  user"; commands show only the program name and exit code; max 300 characters, newest kept). It is kept inside `ChatSession`
  next to the message, NOT in the message text: it is not a chat bubble, not in `spoken`, not in the state sent to the windows.
  The tool prompt tells the model to use it as context and never to write or speak such a line.
- Prompt: prefers `edit_file` for changes, `write_file` only for new files, no whole-file rewrite for a small change, page big reads,
  do not re-read a file already in context.

## Unchanged

6 tool steps per message, one approval click per write/edit/command, voice can never approve, `Stop all actions`, audit log, redaction.

## Voice phrases to try (tools ON, Groq)

1. "Sudo, mere home mein notes.txt padho aur bata isme kya likha hai."
2. "Sudo, notes.txt mein 'kal' ko 'parson' se badal do." -> card with `- ... kal ...` / `+ ... parson ...`; click Allow.
3. "Sudo, hello.py banao jo teen tak ginti print kare." -> create card; Allow. Then "ab isko run karo" -> she knows the file; command card; Allow.
4. "Sudo, hello.py mein ginti paanch tak kar do." -> read, then an edit card for just those lines.
5. "Sudo, mere bade log file ki aakhri 50 lines padho." (large file: she pages with `start_line`.)

## Known gaps

- The model must still copy `old_text` exactly; with a very repetitive file it may need one more round trip (the error text tells it how).
- No undo and no backup copy: the card is the checkpoint. The old text is on the card, not stored.
- A rewrite of a file larger than ~2500 characters is done as `write_file` + `append_file` chunks (each needs a click), not one write.
- `read_file` looks at the first 1 MB of a file only; the footer says so.
- Real model behaviour with these tools was not exercised (no provider calls were made); tests use fake responses.

---

# Update (branch `planner`): to-do tools

`add_task`, `list_tasks`, `update_task`, `complete_task`, `plan_today`, `next_task`, `start_task` need no click (they only touch the app's own `tasks.json`), obey the "Let Sudo-chan use tools" switch and are audited. `set_reminder` takes an optional `task_id`. Full description, phrases and limits: `desktop/PLANNER.md`.
