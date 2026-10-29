# Mic indicator: why the bot "stopped hearing", and the fix

Branch `mic-indicator` (on top of `fix-phantom-wake`).

## What was wrong

The mic dot was a tiny element inside the `companion-pill` button. The pill opens the chat; the dot toggled
`wakeWordEnabled`. Clicking at or near the dot to open the chat silently turned the microphone off, and the dot gave
almost no visual clue. That is why `config.json` kept showing `wakeWordEnabled: false`.
A second, quieter path: Settings Save sent the whole settings object, so a stale form could write an old `wakeWordEnabled`.

## What it looks like now

The mic switch is its own round 26 px button to the left of the chat pill, 8 px away from it. Clicking the pill never reaches it.

| State | Dot | Bot |
|---|---|---|
| Listening for her name | filled green dot, soft pulsing glow | normal |
| Live Talk | blue dot with a ring | normal |
| Resting (paused) | hollow amber ring | resting look |
| First click to turn off ("armed", 3 s) | amber dot with a slash, blinking | normal |
| Mic OFF | small dim grey dot with a dark diagonal slash | calm, muted colours (less saturated, slightly faded) |

Shapes differ, not only colours (filled, ring, hollow ring, slash), so it works for colour-blind users. No text was added.
Tooltips (also the aria-label), simple English: "Mic is ON, listening for her name. To turn it off, click twice."
/ "Click again to turn the mic off." / "Mic is OFF. She cannot hear her name. Click to turn it on."

## The gesture

- Mic OFF -> ON: one click on the dot.
- Mic ON -> OFF: click the dot, then click it again within 3 seconds. The first click only arms it (amber, slash, blinking).
  After 3 s it disarms by itself.
- During Live Talk, one click on the dot ends Live Talk (it does not change the wake-word setting).
- The tray item "Microphone: listen for my name" works as before (one click).

Pure logic: `src/shared/mic-control.ts` (`micDotPress`, `micDotView`, `MIC_CONFIRM_MS`).

## Settings Save cannot clobber the mic

- The renderer now sends patches: `saveSettings(patch, source)`; IPC payload `{ patch, source }`.
  The Settings window sends only the fields it really changed (`changedSettings(state.settings, form)`). The dot and the tray send
  only `{ wakeWordEnabled }`. The chat sends only `{ voiceVisualizerMode }`.
- Main merges the patch onto its CURRENT settings (`mergeSettings`) and then runs the same `validSettings` as before. A bare
  settings object (old callers, the smoke test) is still accepted and treated as a patch.
- `authorize()` window kinds for the save channel are unchanged: `['settings', 'chat', 'overlay']`.

## The diagnostic line

Whenever `wakeWordEnabled` changes, main prints one line (no secrets):

```
[mic] wakeWordEnabled true->false source=dot|tray|settings|chat
```

`source` is an allow-list. A window can only claim the source that fits it (overlay = dot, Settings window = settings, chat = chat);
`tray` is set only inside main; anything else is logged as `unknown`. It is for the log only and grants nothing.
So the next time the mic flips, `grep '\[mic\]'` in the app output tells you who did it.

## Window shape

The native X11 shape has an explicit region for the mic switch (`overlay-shape.ts`), so the button stays clickable at all three bot sizes.

## Tests

`tests/mic-control.check.mjs` (gesture state machine, merge keeps `wakeWordEnabled`, stale form, source allow-list, log format,
wiring: the switch is not inside the pill) and a new case in `tests/overlay-shape.check.mjs`.

## Update (live-talk-flow)

The dot is only the **name-standby** switch. The bot itself is the Live Talk button (see `LIVE-TALK-FLOW.md`). During Live Talk one click on the dot still ends Live
Talk, now through the same instant stop as the bot. Tooltips: "Name standby is ON. Click twice to turn off. Live Talk = the bot."
