import test from 'node:test';
import assert from 'node:assert/strict';
import { matchWakeWord, editDistance, wakeVocabulary, buildWakeHint, WakeGate, ConversationWindow, DEFAULT_WAKE_ALIASES } from '../src/shared/wake-word.ts';

const m = text => matchWakeWord(text, 'Sudo', DEFAULT_WAKE_ALIASES);

test('edit distance', () => {
  assert.equal(editDistance('sudo', 'sudo'), 0);
  assert.equal(editDistance('sudo', 'suddo'), 1);
  assert.equal(editDistance('kitten', 'sitting'), 3);
});

test('matches the name and aliases case-insensitively and returns the command after it', () => {
  assert.deepEqual(m('Sudo, what time is it'), { matched: true, alias: 'Sudo', rest: 'what time is it' });
  assert.equal(m('SID kya haal hai').matched, true);
  assert.equal(m('sid kya haal hai').rest, 'kya haal hai');
  assert.equal(m('Hey sudo').matched, true);
  assert.equal(m('sudo chan suno').matched, true);
  assert.equal(m('sudo chan suno').rest, 'suno');
});

test('fuzzy: one typo tolerated for 4-5 letter names, two for longer, none for 3 letters', () => {
  assert.equal(m('sudoo help me').matched, true);   // sudo + 1
  assert.equal(m('suddo help me').matched, true);   // alias
  assert.equal(m('sudu help me').matched, true);    // sudo + 1
  assert.equal(matchWakeWord('sudochon kya hal', 'Sudo-chan', DEFAULT_WAKE_ALIASES).matched, true); // single word, 1 edit
  assert.equal(m('sad kya hua').matched, false);    // sid has zero tolerance
  assert.equal(m('seed of the plant').matched, false);
  assert.equal(m('pseudo code is fun').matched, false);
});

test('name must be in the first words, not buried in chatter', () => {
  assert.equal(m('I was telling my friend yesterday that sudo is a command').matched, false);
  assert.equal(m('ok so sudo what is up').matched, true);
});

test('empty and no-name transcripts do not match', () => {
  assert.equal(m('').matched, false);
  assert.equal(m('   ').matched, false);
  assert.equal(m('kya haal hai bhai').matched, false);
});

test('custom name and alias list', () => {
  assert.equal(matchWakeWord('jarvis open mail', 'Jarvis', ['Jarvis']).matched, true);
  assert.equal(matchWakeWord('sudo open mail', 'Jarvis', ['Jarvis']).matched, false);
  assert.deepEqual(wakeVocabulary('Sudo', ['sudo', 'Sid']), ['Sudo', 'Sid']);
  assert.match(buildWakeHint('Sudo', ['Sid']), /Sudo, Sid/);
});

test('WakeGate: at most one clip per 2s, silent exponential back-off, recovers on success', () => {
  const g = new WakeGate(2000);
  assert.equal(g.allow(0), true);
  assert.equal(g.allow(500), false);
  assert.equal(g.allow(2000), true);
  g.report(2000, 'rate-limited');
  assert.equal(g.allow(5000), false);        // inside 8s back-off
  assert.equal(g.allow(10_001), true);
  g.report(10_001, 'rate-limited');
  assert.equal(g.blockedForMs, 16_000);       // doubled
  g.report(30_000, 'ok');
  assert.equal(g.blockedForMs, 0);
  assert.equal(g.allow(30_000 + 2500), true);
});

test('ConversationWindow: 30s, extended by each utterance, then closed', () => {
  const w = new ConversationWindow();
  assert.equal(w.isOpen(0), false);
  w.open(1000);
  assert.equal(w.isOpen(30_999), true);
  w.touch(20_000);
  assert.equal(w.isOpen(49_000), true);
  assert.equal(w.isOpen(50_001), false);
  w.touch(60_000);                            // touching a closed window does not reopen it
  assert.equal(w.isOpen(60_001), false);
});

test('settings: wake word is OFF by default and validated', async () => {
  const { DEFAULT_SETTINGS, validSettings } = await import('../src/shared/validation.ts');
  assert.equal(DEFAULT_SETTINGS.wakeWordEnabled, false);
  assert.deepEqual(DEFAULT_SETTINGS.wakeAliases, DEFAULT_WAKE_ALIASES);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, wakeWordEnabled: true, wakeAliases: ['Sudo'] }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, wakeWordEnabled: 'yes' }), false);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, wakeAliases: 'Sudo' }), false);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, wakeAliases: [1] }), false);
});
