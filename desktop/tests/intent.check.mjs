import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyIntent, normalizeIntentText, routeSpeech, taskStrength } from '../src/shared/intent.ts';

const SCREEN = [
  // English
  'look at my screen', 'what\'s on my screen', 'what is on my screen?', 'Look at this', 'see this', 'take a look at this', 'check this out',
  'what is this?', 'what does this mean', 'what do you see', 'look at what I\'m doing', 'can you see my screen', 'read my screen', 'describe my screen',
  'take a screenshot', 'what is this error', 'explain this error', 'what does this button do', 'what is this popup',
  // Roman Urdu / Hinglish
  'meri screen dekho', 'screen dekh', 'screen dekho zara', 'meri screen par kya hai', 'screen pe kya chal raha hai', 'screenshot lo', 'mera screenshot dekho',
  'ye kya hai', 'yeh kya hai?', 'ye kya hai bhai', 'ye error kya hai', 'is error ka matlab kya hai', 'isme kya likha hai', 'is code mein kya galat hai',
  'ye button kya karta hai', 'ye popup kya hai', 'ye dekho', 'dekho ye', 'isko dekho', 'yahan dekho', 'dekho main kya kar raha hoon', 'dekho main kya likh rahi hoon',
  'kya dikh raha hai', 'tumhe kya dikh raha hai', 'screen par ye error kya hai', 'meri screen dekh ke ye kaam kar do', 'screen dekh kar bata do ye kya hai',
  'iska matlab kya hai', 'ye line kya karti hai',
  // Urdu script
  'میری اسکرین دیکھو', 'اسکرین دیکھو', 'میری سکرین پر کیا ہے', 'یہ کیا ہے', 'یہ دیکھو', 'اس میں کیا لکھا ہے', 'دیکھو میں کیا کر رہا ہوں', 'تمہیں کیا دکھ رہا ہے', 'اسکرین شاٹ لو', 'یہ ایرر کیا ہے',
];

const TASK = [
  'notes.txt bana do', 'ek file bana do', 'file banao', 'ye kaam kar do', 'script chalao', 'chala do', 'likho hello world', 'ye likh do', 'notes.txt padho', 'file padh do',
  'ye save karo', 'save kar do', 'notes.txt khol do', 'file kholo', 'delete karo', 'old.txt delete kar do', 'ye file hata do', 'mita do', 'reminder lagao', 'kal subah ka reminder laga do',
  'yaad dila dena', 'create a file called todo.md', 'write hello to notes.txt', 'open notes.txt', 'run the script', 'list the files', 'delete notes.txt', 'remove old.log', 'read notes.txt',
  'please save this as a.txt', 'remind me at five', 'set a reminder for tomorrow', 'files dikhao', 'rename karo', 'ye file edit kar do', 'window band karo', 'terminal kholo',
  'bana do ek folder', 'test.py chalao', 'download karo', 'note kar lo', 'show me the files', 'can you open notes.txt', 'make a file called x.txt',
  'meri screen par notes.txt khol do', 'ye window band karo', 'ye message delete kar do',
  'بنا دو', 'فائل بناؤ', 'نوٹس پڑھو', 'یہ سیو کرو', 'فائل کھول دو', 'ڈیلیٹ کر دو', 'ریمائنڈر لگاؤ', 'یہ کام کر دو', 'یہ لکھ دو',
];

const CHAT = [
  // plain talk
  'kaise ho', 'kya haal hai', 'aaj mausam kaisa hai', 'hello', 'tum kaun ho', 'mujhe ek joke sunao', 'good morning', 'how are you', 'tell me a story', 'thank you', 'shukriya',
  'mujhe bhook lagi hai', 'aaj main bohat thaka hoon', 'ek ghazal sunao', 'what is the capital of France', 'kitne baje hain',
  // traps: "dekho" as an interjection
  'dekho yaar mujhe nahi pata', 'dekho, kal meeting hai', 'dekho bhai main busy hoon', 'dekhte hain kya hota hai', 'dekho mujhe neend aa rahi hai',
  // traps: "bank ka kaam", file / window mentions
  'bank ka kaam hai', 'bank ka kaam kal karenge', 'mera kaam ho gaya', 'file bohat bari hai', 'ye file kya hai', 'is file mein kya likha hai', 'window kitni bari hai',
  'windows ya mac kaun sa behtar hai', 'screen kitni bari hai', 'screen ki brightness kam karni hai', 'screen share kaise karte hain', 'screen band', 'ye kya bakwas thi kal',
  // English sentences that only contain trigger words
  'what is the error in python', 'how do I delete a file', 'what does delete do', 'how to open a window', 'make me laugh', 'that makes sense', 'i like to write poems',
  'the delete button is red', 'kya tum code likh sakte ho', 'mujhe likhna pasand hai', 'banana khana hai', 'iska matlab ye hai ki main kal aaunga', 'kya ye theek hai',
  'ye mera dost hai', 'wo kya kar raha hai', 'main kya karun', 'dekho main kya kar sakta hoon', 'ye kitna acha hai',
  // Urdu script chat
  'آپ کیسے ہیں', 'آج موسم کیسا ہے', 'دیکھو یار مجھے نہیں پتا', 'بینک کا کام ہے', 'مجھے لکھنا پسند ہے',
];

const ROWS = [...SCREEN.map(t => ['screen', t]), ...TASK.map(t => ['task', t]), ...CHAT.map(t => ['chat', t])];

test('the phrase table is large enough', () => {
  assert.ok(ROWS.length >= 150, `only ${ROWS.length} phrases`);
  assert.ok(SCREEN.length >= 50 && TASK.length >= 50 && CHAT.length >= 50);
});

test('every phrase routes as expected', () => {
  const wrong = ROWS.filter(([want, text]) => classifyIntent(text) !== want).map(([want, text]) => `${want} <- got ${classifyIntent(text)}: ${text}`);
  assert.deepEqual(wrong, []);
});

test('privacy: no chat or task phrase can ever return screen', () => {
  for (const [want, text] of ROWS) if (want !== 'screen') assert.notEqual(classifyIntent(text), 'screen', text);
});

test('empty, whitespace and punctuation-only input is chat', () => {
  for (const text of ['', '   ', '?', '...', null, undefined]) assert.equal(classifyIntent(text), 'chat');
});

test('screen + task: screen only when the user explicitly looks at the screen, otherwise task', () => {
  assert.equal(classifyIntent('meri screen dekh ke ye kaam kar do'), 'screen');
  assert.equal(classifyIntent('look at my screen and then fix it'.replace('fix it', 'open notes.txt')), 'screen');
  assert.equal(classifyIntent('dekho ye kaam kar do'), 'task');
  assert.equal(classifyIntent('ye dekh ke notes.txt bana do'), 'task');
  assert.equal(classifyIntent('screen par notes.txt khol do'), 'task');
  assert.equal(classifyIntent('screenshot save kar do'), 'task');
});

test('implicitScreen:false keeps only explicit screen requests', () => {
  assert.equal(classifyIntent('ye kya hai', { implicitScreen: false }), 'chat');
  assert.equal(classifyIntent('ye dekho', { implicitScreen: false }), 'chat');
  assert.equal(classifyIntent('meri screen dekho', { implicitScreen: false }), 'screen');
});

test('spelling variants and noisy speech-to-text output', () => {
  assert.equal(classifyIntent('SUDO, MERI SCREEN DEKHO!!'), 'screen');
  assert.equal(classifyIntent('  meri   screen\tdekho  '), 'screen');
  assert.equal(classifyIntent('Meri Screen Dekhiye'), 'screen');
  assert.equal(classifyIntent('میری اسکرین دیکھیے'), 'screen');
  assert.equal(classifyIntent('مدد'), 'chat');
  assert.equal(classifyIntent('ي ه'), 'chat');
});

test('normalizeIntentText keeps file names together and unifies Urdu letters', () => {
  assert.equal(normalizeIntentText('Notes.TXT, bana do!'), 'notes.txt bana do');
  assert.equal(normalizeIntentText('Sudo-chan'), 'sudo chan');
  assert.equal(normalizeIntentText('كيا هے'), normalizeIntentText('کیا ہے'));
});

test('the classifier is pure: same input, same answer, nothing stored', () => {
  for (const [, text] of ROWS.slice(0, 20)) assert.equal(classifyIntent(text), classifyIntent(text));
});

test('routeSpeech: screen only when screen assist is ON and the words point at the screen', () => {
  const on = { screenAssist: true, afterWake: true };
  const off = { screenAssist: false, afterWake: true };
  assert.equal(routeSpeech('meri screen dekho', on), 'screen');
  assert.equal(routeSpeech('meri screen dekho', off), 'message', 'setting off: never a screenshot');
  assert.equal(routeSpeech('kaise ho?', on), 'message');
  assert.equal(routeSpeech('notes.txt bana do', on), 'message');
  assert.equal(routeSpeech('ye kya hai', on), 'screen');
  assert.equal(routeSpeech('', on), 'screen', 'a bare name keeps its old behaviour');
  assert.equal(routeSpeech('   ', on), 'screen');
  assert.equal(routeSpeech('', { screenAssist: true, afterWake: false }), 'message', 'silence inside the Live Talk window is never a capture');
  assert.equal(routeSpeech('', off), 'message');
  assert.equal(routeSpeech('meri screen dekho', { screenAssist: true, afterWake: false }), 'screen', 'inside the Live Talk window too');
  assert.equal(routeSpeech('kaise ho', { screenAssist: true, afterWake: false }), 'message');
});

test('taskStrength separates specific commands from a bare "kar do"', () => {
  assert.equal(taskStrength('notes.txt bana do'), 'strong');
  assert.equal(taskStrength('ye theek karo'), 'generic');
  assert.equal(taskStrength('kaise ho'), 'none');
  assert.equal(taskStrength(''), 'none');
});

test('wiring: the overlay routes through routeSpeech in both the wake path and the Live Talk window', () => {
  const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /import \{ routeSpeech \} from '..\/shared\/intent\.ts'/);
  const calls = app.match(/routeSpeech\(/g) ?? [];
  assert.equal(calls.length, 2);
  assert.match(app, /routeSpeech\(match\.rest, \{ screenAssist: Boolean\(currentSettings\.screenAssistEnabled\), afterWake: true \}\)/);
  assert.match(app, /routeSpeech\(text, \{ screenAssist: Boolean\(currentSettings\.screenAssistEnabled\), afterWake: false \}\)/);
  // The old rule "screen assist on => every wake utterance is a screenshot" is gone.
  assert.doesNotMatch(app, /if \(currentSettings\.screenAssistEnabled\) \{\s*\/\/ If the screenshot/);
  // Both screen sends are user-spoken wake turns; no timers start a capture.
  assert.equal((app.match(/source: 'wake'/g) ?? []).length, 2);
});

test('settings privacy text is honest about mic, screen and files', () => {
  const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /never accesses your screen, microphone, or disk files/i);
  assert.match(app, /Mic:<\/strong> only while listening is on/);
  assert.match(app, /only after you click Allow and only while screen assist is on/);
  assert.match(app, /never saved/);
  assert.match(app, /risky actions ask you first/);
});

test('intent.ts is pure: no Electron, fs, network or timers', () => {
  const src = readFileSync(new URL('../src/shared/intent.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from 'electron'|node:fs|fetch\(|setTimeout|setInterval|process\.|require\(/);
});

// ---- Chat window's own voice call uses the same routing ----
import { runChatVoiceTurn } from '../src/shared/chat-voice-turn.ts';

function fakeVoiceApi(screenResult = { ok: true }) {
  const calls = { screen: [], message: [] };
  return {
    calls,
    api: {
      sendScreen: async payload => { calls.screen.push(payload); return screenResult; },
      sendMessage: async (text, voice) => { calls.message.push({ text, voice }); return { ok: true }; },
    },
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('chat voice: a screen phrase starts the screen flow ONLY when screen assist is ON', async () => {
  const on = fakeVoiceApi();
  assert.equal(runChatVoiceTurn('meri screen dekho', true, on.api), 'screen');
  await settle();
  assert.deepEqual(on.calls.screen, [{ text: 'meri screen dekho', source: 'wake' }]);
  assert.equal(on.calls.message.length, 0, 'a successful screen turn is not also sent as a blind message');

  const off = fakeVoiceApi();
  assert.equal(runChatVoiceTurn('meri screen dekho', false, off.api), 'message');
  await settle();
  assert.equal(off.calls.screen.length, 0, 'setting off: never a capture request');
  assert.deepEqual(off.calls.message, [{ text: 'meri screen dekho', voice: true }]);
});

test('chat voice: chat, task and unsure utterances never request a screenshot', async () => {
  for (const phrase of ['kaise ho', 'notes.txt bana do', 'reminder lagao', 'what is the error in python', 'screen ki brightness kam karo', 'isko samjhao', 'ye file kya hai', 'hmm', 'dekho yaar mujhe nahi pata']) {
    const { api, calls } = fakeVoiceApi();
    assert.equal(runChatVoiceTurn(phrase, true, api), 'message', phrase);
    await settle();
    assert.equal(calls.screen.length, 0, `${phrase}: no screenshot`);
    assert.deepEqual(calls.message, [{ text: phrase, voice: true }], phrase);
  }
});

test('chat voice: silence or an empty transcript does nothing, never a capture', async () => {
  const { api, calls } = fakeVoiceApi();
  assert.equal(runChatVoiceTurn('', true, api), 'ignored');
  assert.equal(runChatVoiceTurn('   ', true, api), 'ignored');
  assert.equal(runChatVoiceTurn('meri screen dekho', true, undefined), 'ignored');
  await settle();
  assert.equal(calls.screen.length + calls.message.length, 0);
});

test('chat voice: when the screenshot is not taken the words are still answered, unless the reason was already shown', async () => {
  const failed = fakeVoiceApi({ ok: false });
  runChatVoiceTurn('ye kya hai', true, failed.api);
  await settle();
  assert.deepEqual(failed.calls.message, [{ text: 'ye kya hai', voice: true }]);

  const declined = fakeVoiceApi({ ok: false, handled: true });
  runChatVoiceTurn('ye kya hai', true, declined.api);
  await settle();
  assert.equal(declined.calls.message.length, 0, 'declined/guarded: already announced on the overlay, no blind chat message');
});

test('wiring: the Chat window voice handler goes through runChatVoiceTurn, with no direct capture', () => {
  const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /import \{ runChatVoiceTurn \} from '..\/shared\/chat-voice-turn\.ts'/);
  assert.match(app, /runChatVoiceTurn\(text, Boolean\(settingsRef\.current\.screenAssistEnabled\), api\)/);
  // The chat voice onFinal no longer sends every utterance as a plain message.
  assert.doesNotMatch(app, /setBotSubtitle\(''\);\s*void api\?\.sendMessage\(text\.trim\(\), true\);/);
  const helper = readFileSync(new URL('../src/shared/chat-voice-turn.ts', import.meta.url), 'utf8');
  assert.match(helper, /routeSpeech\(clean, \{ screenAssist, afterWake: false \}\)/);
  assert.doesNotMatch(helper, /setTimeout|setInterval|process\.|from 'electron'/, 'no timers: nothing can capture on its own');
  // Same sources as the overlay: a spoken request, never 'button' (which has a shorter cooldown).
  assert.match(helper, /source: 'wake'/);
});
