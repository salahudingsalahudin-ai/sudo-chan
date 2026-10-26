# Sudo-chan tools (branch `tools`)

Sudo-chan can now do work on this computer: read files, write files, run one program, open links. It is **off by default** and every risky action waits for a click.

Settings → "Let Sudo-chan use tools" (default OFF). Works with the cloud chat path (Groq / Gemini / other OpenAI-compatible endpoints). Local Ollama chat does not use tools.

## What exists

| Tool | Needs a click? | Notes |
|---|---|---|
| `read_file` | no (inside home) | up to 20 KB, binary files refused |
| `list_dir` | no (inside home) | secret entries are hidden |
| `search_files` | no (inside home) | by name or text, skips `node_modules`, `.git`, secrets, max 50 hits |
| `get_system_info` | no | OS, cores, memory, uptime |
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
