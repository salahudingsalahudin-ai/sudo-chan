import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PomodoroTimer, BREAK_REMINDER_MESSAGE, FOCUS_RESUME_MESSAGE } from '../dist/main/pomodoro.js';

test('pomodoro timer transitions from focus to break and emits reminder', async () => {
  let breakTriggered = '';
  let focusTriggered = '';

  const timer = new PomodoroTimer({
    focusMs: 40,
    breakMs: 30,
    onBreak: msg => { breakTriggered = msg; },
    onFocus: msg => { focusTriggered = msg; },
  });

  assert.equal(timer.getStatus(), 'idle');
  assert.equal(timer.isEnabled(), true);

  timer.start();
  assert.equal(timer.getStatus(), 'focus');

  // Wait for focus period to elapse
  await new Promise(r => setTimeout(r, 55));
  assert.equal(timer.getStatus(), 'break');
  assert.equal(breakTriggered, BREAK_REMINDER_MESSAGE);

  // Wait for break period to elapse
  await new Promise(r => setTimeout(r, 45));
  assert.equal(timer.getStatus(), 'focus');
  assert.equal(focusTriggered, FOCUS_RESUME_MESSAGE);

  timer.stop();
  assert.equal(timer.getStatus(), 'idle');
});

test('pomodoro timer can be disabled and stopped', async () => {
  let breakCalled = false;
  const timer = new PomodoroTimer({
    focusMs: 30,
    breakMs: 30,
    onBreak: () => { breakCalled = true; },
  });

  timer.start();
  assert.equal(timer.getStatus(), 'focus');

  timer.setEnabled(false);
  assert.equal(timer.isEnabled(), false);
  assert.equal(timer.getStatus(), 'idle');

  // Wait to ensure no break callbacks fire after being disabled
  await new Promise(r => setTimeout(r, 45));
  assert.equal(breakCalled, false);
});
