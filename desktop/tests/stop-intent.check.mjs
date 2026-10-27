import test from 'node:test';
import assert from 'node:assert/strict';
import { isStopCommand, unclearAction, SHORT_INTERRUPTION_MS } from '../src/shared/stop-intent.ts';

test('plain stop words in English, Roman Urdu and Urdu script', () => {
  for (const t of ['stop', 'Stop!', 'STOP.', 'ruko', 'Ruko.', 'ruk', 'ruk jao', 'ruk jaao', 'roko', 'rooko', 'roko roko', 'ruko ruko', 'ruko ruko ruko', 'bas', 'bas karo', 'bas kar do', 'chup', 'chup karo', 'khamosh', 'khamosh ho jao',
    'enough', 'shut up', 'be quiet', 'quiet', 'hold on', 'wait', 'band karo', 'stop it', 'stop please', 'ruko yaar', 'ruko sid', 'ji ruko', 'بس', 'رکو', 'روکو', 'چپ کرو', 'خاموش', 'بس کرو', 'بند کرو']) {
    assert.equal(isStopCommand(t), true, `"${t}" should be a stop command`);
  }
});

test('real requests that merely contain a stop word are not stop commands', () => {
  for (const t of ['ruko mujhe ek sawal poochna hai', 'stop the music and open Chrome', 'bas itna batao ke kya time hua hai', 'wait what is the weather today', 'ruko kya?', 'why did you stop',
    'tum chup kyun ho', 'what does stop mean', 'ek minute ruko main kuch dhoond raha hoon', 'hello', 'kaise ho', '', '   ', 'open Chrome']) {
    assert.equal(isStopCommand(t), false, `"${t}" should NOT be a stop command`);
  }
});

test('length limit: more than 4 words is never a stop command', () => {
  assert.equal(isStopCommand('ruko ruko ruko ruko ruko'), false);
  assert.equal(isStopCommand('stop stop stop stop'), true);
});

test('unclear interruption: short clip stays stopped, longer clip resumes, nothing saved does nothing', () => {
  assert.equal(unclearAction(400, true), 'stay-stopped');
  assert.equal(unclearAction(SHORT_INTERRUPTION_MS - 1, true), 'stay-stopped');
  assert.equal(unclearAction(SHORT_INTERRUPTION_MS, true), 'resume');
  assert.equal(unclearAction(3500, true), 'resume');
  assert.equal(unclearAction(3500, false), 'none');
  assert.equal(unclearAction(100, false), 'none');
});
