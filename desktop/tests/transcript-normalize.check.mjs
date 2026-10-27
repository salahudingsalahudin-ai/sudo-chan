import test from 'node:test';
import assert from 'node:assert/strict';
import { aliasForMatching, foldKey, detectScript, normalizeTranscript, isShortCommandWord, ALIAS_GROUPS } from '../src/shared/transcript-normalize.ts';
import { matchWakeWord } from '../src/shared/wake-word.ts';
import { isStopCommand } from '../src/shared/stop-intent.ts';
import { classifyIntent, taskStrength } from '../src/shared/intent.ts';
import { classifyTranscript, isSelfEchoTranscript } from '../src/shared/stt-hallucination.ts';
import { isValidTranscription } from '../src/main/stt.ts';

test('alias table has no spelling that maps to two canonical words', () => {
  const seen = new Map();
  for (const [canonical, spellings] of Object.entries(ALIAS_GROUPS)) {
    for (const sp of spellings) {
      const k = foldKey(sp);
      if (seen.has(k) && seen.get(k) !== canonical) assert.fail(`${sp} (${k}) is in ${seen.get(k)} and ${canonical}`);
      seen.set(k, canonical);
    }
  }
});

test('wake names in Urdu script, Hindi script and Roman variants become sudo / sid', () => {
  const cases = { 'سوڈو': 'sudo', 'سڈو': 'sudo', 'सुडो': 'sudo', 'सूडो': 'sudo', 'सुदो': 'sudo', 'sudu': 'sudo', 'Soodo': 'sudo', 'सिड': 'sid', 'سڈ': 'sid', 'سِڈ': 'sid', 'Sidd': 'sid' };
  for (const [from, to] of Object.entries(cases)) assert.equal(aliasForMatching(from), to, from);
  assert.equal(aliasForMatching('सुडो चान, मेरी स्क्रीन देखो'), 'sudo chan, meri screen dekho');
  assert.equal(aliasForMatching('سوڈو چان'), 'sudo chan');
  assert.equal(aliasForMatching('सुडोचान'), 'sudochan');
});

test('wake word: script and spelling variants wake, rest comes from the ORIGINAL words', () => {
  for (const t of ['सुडो', 'सुडो, कैसे हो', 'سوڈو', 'سڈ کیسے ہو', 'सिड रुको', 'Sudu kaise ho', 'सुडो चान']) {
    assert.equal(matchWakeWord(t, 'Sudo', undefined).matched, true, t);
  }
  assert.equal(matchWakeWord('सुडो कैसे हो', 'Sudo', undefined).rest, 'कैसे हो');
  assert.equal(matchWakeWord('سڈ میری سکرین دیکھو', 'Sudo', undefined).rest, 'میری سکرین دیکھو');
  // custom name: the default names do not wake it
  assert.equal(matchWakeWord('सुडो कैसे हो', 'Jarvis', ['Jarvis']).matched, false);
});

test('no over-matching: ordinary words and sentences never become the wake name', () => {
  for (const t of ['sudden', 'side', 'sad', 'seed', 'said', 'sudden change of plan', 'the side door', 'I am sad today', 'ek sad kahani', 'سید صاحب', 'bus aa gayi', 'sudoku puzzle', 'pseudo code']) {
    assert.equal(aliasForMatching(t), t, t);
    assert.equal(matchWakeWord(t, 'Sudo', undefined).matched, false, t);
  }
  // normal sentences are not rewritten at all (unknown words, punctuation and spacing stay)
  assert.equal(aliasForMatching('  Mujhe kal   office jana hai, shaam ko!  '), '  Mujhe kal   office jana hai, shaam ko!  ');
  assert.equal(aliasForMatching('the bass guitar is loud, I can see'), 'the bass guitar is loud, I can see');
  assert.equal(aliasForMatching('چین کا سفر'), 'چین کا سفر'); // China: "چین" only becomes "chan" right after a wake name
});

test('stop words in Urdu, Hindi and Roman spellings', () => {
  for (const t of ['रुको', 'रुको रुको', 'रुक जाओ', 'रोको', 'बस', 'बस करो', 'चुप', 'चुप करो', 'खामोश', 'बंद करो', 'बन्द कर दो', 'ठहरो', 'رکو', 'رکو رکو', 'رک جاؤ', 'رک جاو', 'بس', 'چپ کرو', 'خاموش', 'بند کرو', 'ٹھہرو', 'सिड रुको', 'ruko.', 'Ruk jao', 'rooko rooko', 'chupp', 'स्टॉप']) {
    assert.equal(isStopCommand(t), true, t);
  }
});

test('stop words: real requests and questions are still not stop commands', () => {
  for (const t of ['रुको मुझे एक सवाल पूछना है', 'बस इतना बताओ क्या वक़्त हुआ है', 'रुको क्या?', 'तुम चुप क्यों हो', 'رکو مجھے ایک سوال پوچھنا ہے', 'بند دروازہ', 'बंद', 'band', 'bass guitar', 'bus', 'sudden']) {
    assert.equal(isStopCommand(t), false, t);
  }
});

test('intent: Hindi and Urdu script screen and task commands route like their Roman forms', () => {
  assert.equal(classifyIntent('मेरी स्क्रीन देखो'), 'screen');
  assert.equal(classifyIntent('स्क्रीन देखो'), 'screen');
  assert.equal(classifyIntent('यह क्या है'), 'screen');
  assert.equal(classifyIntent('ये देखो'), 'screen');
  assert.equal(classifyIntent('میری سکرین دیکھو'), 'screen');
  assert.equal(classifyIntent('notes.txt बना दो'), 'task');
  assert.equal(classifyIntent('नोट्स बना दो'), 'task');
  assert.equal(classifyIntent('फाइल खोल दो'), 'task');
  assert.equal(classifyIntent('ये फाइल पढ़ो'), 'task');
  assert.equal(classifyIntent('फोल्डर बनाओ'), 'task');
  assert.equal(classifyIntent('file parho'), 'task');
  assert.equal(classifyIntent('notes krdo'), 'task');
  assert.equal(taskStrength('नोट लिख दो'), 'strong');
  assert.equal(taskStrength('कर दो'), 'generic');
});

test('intent: normal chat in other scripts stays chat; existing behaviour is untouched', () => {
  for (const t of ['आज मौसम कैसा है', 'तुम कैसे हो', 'आप कौन हैं', 'کیا حال ہے', 'میں کل آؤں گا', 'hello', 'what is the weather']) {
    assert.equal(classifyIntent(t), 'chat', t);
  }
  assert.equal(classifyIntent('meri screen dekho'), 'screen');
  assert.equal(classifyIntent('اسکرین دیکھو'), 'screen');
});

test('name-list phantom in Hindi / Urdu script is dropped; a single name or real speech is kept', () => {
  for (const t of ['सुडो चान, सिडो चान', 'सुडो सिड', 'سوڈو چان، سڈ']) assert.equal(classifyTranscript(t).drop, true, t);
  for (const t of ['सुडो', 'सुडो कैसे हो', 'सिड रुको', 'سوڈو']) assert.equal(classifyTranscript(t).drop, false, t);
  assert.equal(isSelfEchoTranscript('सुडो', 'Main Sudo hoon', 1000), true);
});

test('one-word commands in any script are valid transcripts (punctuation ignored)', () => {
  for (const t of ['Sudo.', 'Sid,', 'ruko', 'Ruko!', 'रुको', 'रुको।', 'رکو', 'बस', 'چپ', 'stop', 'haan', 'नहीं', 'देखो', 'سوڈو', 'सुडो', 'ruko ruko ruko ruko', 'bas bas bas bas']) {
    assert.equal(isValidTranscription(t), true, t);
  }
  for (const t of ['hmm', 'ha ha ha ha ha ha', 'Thank you.', 'band', 'pizza', '...', '']) assert.equal(isValidTranscription(t), false, t);
  assert.equal(isShortCommandWord('Sudo.'), true);
  assert.equal(isShortCommandWord('hmm'), false);
});

test('normalizeTranscript keeps the original for display and reports the script', () => {
  const n = normalizeTranscript('सुडो रुको');
  assert.equal(n.display, 'सुडो रुको');
  assert.equal(n.match, 'sudo ruko');
  assert.equal(n.script, 'devanagari');
  assert.equal(n.changed, true);
  assert.equal(normalizeTranscript('hello there').changed, false);
  assert.equal(detectScript('رکو'), 'urdu');
  assert.equal(detectScript('Sudo रुको'), 'mixed');
  assert.equal(detectScript('123'), 'none');
  assert.equal(aliasForMatching(''), '');
});

test('token count never changes (callers rely on it to cut the rest from the original)', () => {
  for (const t of ['सुडो-चान, कैसे हो', 'سڈ ، رکو رکو', 'Sudo-chan, Sido-chan,', 'krdo  parho\tbas']) {
    assert.equal(aliasForMatching(t).split(/\s+/).filter(Boolean).length, t.split(/\s+/).filter(Boolean).length, t);
  }
});
