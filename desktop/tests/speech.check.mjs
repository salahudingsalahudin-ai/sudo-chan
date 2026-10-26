import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTextForSpeech } from '../dist/shared/speech.js';

test('cleanTextForSpeech strips markdown formatting for natural voice synthesis', () => {
  // Bold & Italics
  assert.equal(
    cleanTextForSpeech('**Assalam o Alaikum!** Yeh *bohot* acha idea hai.'),
    'Assalam o Alaikum! Yeh bohot acha idea hai.'
  );

  // Markdown links
  assert.equal(
    cleanTextForSpeech('Aap [yahan click karein](https://example.com) aur check karein.'),
    'Aap yahan click karein aur check karein.'
  );

  // Bare URLs
  assert.equal(
    cleanTextForSpeech('Visit https://sudochan.app for details.'),
    'Visit for details.'
  );

  // Code blocks & inline code
  const codeText = 'Yeh code dekhein:\n```javascript\nconsole.log("hello world");\n```\nAur `const x = 5;` bhi.';
  assert.equal(
    cleanTextForSpeech(codeText),
    'Yeh code dekhein: Aur const x = 5; bhi.'
  );

  // Headings & bullet lists
  const listText = '# Subah ka plan\n* Paani peena\n* 25 min focus\n- Thoda walk';
  assert.equal(
    cleanTextForSpeech(listText),
    'Subah ka plan Paani peena 25 min focus Thoda walk'
  );

  // Emojis and decorative symbols
  assert.equal(
    cleanTextForSpeech('Sid, 25 minutes ho gaye! 5 minute break le lo 🍵 aur paani pee lo ✨✦'),
    'Sid, 25 minutes ho gaye! 5 minute break le lo aur paani pee lo'
  );

  // Handles empty or invalid input safely
  assert.equal(cleanTextForSpeech(''), '');
  assert.equal(cleanTextForSpeech(null), '');
  assert.equal(cleanTextForSpeech(undefined), '');
});
