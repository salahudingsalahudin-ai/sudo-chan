# "Aaj ka kaam" planner and "mera kaam utha lo" (branch `planner`)

Sudo-chan can keep your daily to-do list and help you with one task at a time. The list is a small local file
(`tasks.json` in the app data folder, mode 600, tasks only, no keys, never inside `config.json`).

## Two ways to use it

1. **By voice or chat (needs Settings -> "Let Sudo-chan use tools" ON).** The assistant uses seven tools that only touch the task
   file, so they need no click (like notes and reminders). Every call is audited in `tool-audit.jsonl` (tool name only, never the task text).
2. **By hand in the chat window (works with tools OFF).** Open the chat; at the top there is a small collapsed bar "Aaj ka kaam - N baqi".
   Click it: today's plan (at most 5), a round button to check a task off, `x` to remove it, and an add box. You can type dates in the
   box: `kal client ko email bhejna` becomes "client ko email bhejna", due tomorrow. Nothing pops up by itself.

Both use the same list. When the assistant adds a task, the open panel updates.

## What you can say

| Say (Roman Urdu / English) | Tool used | What happens |
|---|---|---|
| "Sudo, aaj mera kya kaam hai?" | `plan_today` | Reads your plan: overdue first, then due today, then in progress, then by priority. Max 5. |
| "Ye kaam list mein daal do: kal client ko email bhejna" | `add_task` | Adds it, due tomorrow. |
| "Parson subah 10 baje report bhejni hai, yaad bhi dila dena" | `add_task` with `remind` | Adds it and sets a reminder at the due time. |
| "Pehla kaam khatam ho gaya" / "email wala kaam done" | `complete_task` | Marks it done and cancels its reminder. |
| "Mera agla kaam utha lo" | `start_task` | Marks the next task "in progress", reads it back, then helps (see below). |
| "Agla kaam kya hai?" | `next_task` | Tells you the next one, changes nothing. |
| "Mere saare kaam / late kaam dikhao" | `list_tasks` | `all`, `overdue`, `today` or `done`. |
| "Report wale kaam ko high priority kar do", "dentist wala kaam jumerat ko kar do" | `update_task` | Changes title, notes, priority, due date or status. |

Date words it understands (English, Roman Urdu and Urdu script, Urdu digits too): `aaj`, `kal`, `parson`, `subah`, `dopahar`, `shaam`, `raat`,
`5 baje`, `saade paanch baje` (5:30), `sawa 5 baje` (5:15), `paune 5 baje` (4:45), `agle hafte`, `agle mahine`, `3 din baad`,
`2 ghante baad`, weekdays (`Monday`, `peer`, `mangal`, `budh`, `jumerat`, `juma`, `sanichar`, `itwar`), `tomorrow`, `tonight`, `next week`,
`in 2 hours`, `5pm`, `17:30`, and the same in Urdu script (`کل صبح ۹ بجے`).
A bare hour means the next sensible one: "5 baje" at 3 pm is 5 pm, "10 baje" at 3 pm is 10 pm.
A weekday never means today (the same weekday is a week away). `kal` always means tomorrow.

## "Mera kaam utha lo" in detail

`start_task` only marks the task "in progress" and returns its title and notes. It gives the assistant **no new permission**.
To do the work it uses the existing tools under the existing rules: `read_file`/`list_dir`/`search_files` (home folder only),
`edit_file`/`write_file`/`append_file`/`run_command`/`open_url`/`open_app` (every one needs your click; voice can never approve),
at most 6 tool steps per message. The prompt tells it that starting a task is not doing it and that it may only say what a tool result confirms.
If you deny a card the assistant has to say the work was not done.

## Reminders link

- `add_task`/`update_task` with `remind=true` creates a reminder at the due time (a due day with no time means 09:00). A past time is refused ("That time has already passed").
- `set_reminder` accepts an optional `task_id`.
- Completing (or checking off, or removing) a task cancels its pending reminders. A finished task never reminds.
- Reminders still fire if you later switch tools OFF (existing behaviour).

## Limits and privacy

- 200 tasks in the file (150 open), the newest 50 finished ones are kept, title 160 characters, notes 1000, file read only if under 512 KB.
- Atomic write (temp file, fsync, rename) and a `tasks.json.bak` of the last good file. A damaged file is copied to `tasks.corrupt.json`, then the backup is
  restored; if there is none, the list starts empty (nothing is deleted without a copy).
- The file tools cannot read it (the whole app data folder is a hard block).
- The panel talks to main only through three chat-window IPC channels (`tasksList`, `tasksAdd`, `tasksAct`), all behind `authorize(event, 'chat')`.
  The overlay, settings window and the voice code have no channel to the tasks. New task data is pushed to the chat window only; task titles never go to the overlay.
- No proactive popups and no new notifications. The only thing that can speak by itself is an existing reminder you asked for.
- The assistant cannot delete tasks (use the `x` in the panel). The panel never shows ids.

## 6 phrases to try by voice (tools ON, wake word or Live Talk)

1. "Sudo, ye kaam list mein daal do: kal subah client ko email bhejna."
2. "Sudo, aaj shaam 6 baje bijli ka bill bharna hai, yaad bhi dila dena."
3. "Sudo, aaj mera kya kaam hai?"
4. "Sudo, mera agla kaam utha lo."  (then give a click if she asks to read or edit a file)
5. "Sudo, email wala kaam khatam ho gaya."
6. "Sudo, mere late kaam dikhao." (then "bill wale kaam ko jumerat par kar do")

## Known gaps

- Real model behaviour (does it pick `plan_today` for "aaj mera kya kaam hai", does it keep answers to 1-3 sentences) was not exercised here; only fakes and the
  real Electron smoke run with a fake model were. Expect to adjust the prompt after a real run.
- The seven new tool definitions add about 3 KB (roughly 800 tokens) to every tool turn. On the free Groq key (7000 tokens/minute for qwen) that makes the
  existing 429 fallback to `gpt-oss-20b` a little more likely. If it bites, remove `list_tasks`/`update_task` from the registry first.
- `kal` is always tomorrow (never yesterday); "parson" is always the day after tomorrow.
- The panel does not reorder by drag. The pure `reorderTask` exists (and is tested) and only breaks ties inside the plan, so it has no button yet.
- The panel refreshes when the assistant changes a task or you click; if the file is edited by hand while the app runs, close and reopen the chat window.
- Task text is stored unencrypted in the app data folder, like notes.
