import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTranscript, isPhantomTranscript, isSelfEchoTranscript, segmentsLookLikeSilence, SELF_ECHO_WINDOW_MS } from '../src/shared/stt-hallucination.ts';
import { matchWakeWord, buildWakeHint } from '../src/shared/wake-word.ts';
import { BargeInDetector, ECHO_TAIL_MS, ECHO_WARMUP_MS, clipIsEcho, echoMargin, bargeInThreshold } from '../src/shared/barge-in.ts';
import { SttRouter, WHISPER_DEFAULT_PROMPT, buildWhisperPrompt, isValidTranscription } from '../src/main/stt.ts';

// ---------- hallucination filter ----------
test('the exact transcripts from the live log are dropped', () => {
  for (const t of ['Sudo-chan, Sido-chan,', 'Sudo-chan, Sido,', 'Sudo-chan, Sido-chan', 'sudo-chan, sido-chan,', 'Sudo chan, Sido chan']) {
    assert.equal(isPhantomTranscript(t), true, t);
    assert.equal(isValidTranscription(t), false, t);
  }
});

test('names only, 2+ times, are dropped (repeats, aliases, spelling variants, punctuation)', () => {
  for (const t of ['Sid sudo', 'Sid Sid', 'sid, sid, sid', 'Sudo Sudo', 'Sudo, Sid', 'Sudo-chan Sudo-chan', 'Suddo, Sido', 'sidochan sudochan', 'Sudo. Sid. Sudo.', 'SUDO-CHAN, SID', 'Sudo, chan, Sid', 'Sid ... Sudo']) {
    assert.equal(isPhantomTranscript(t), true, t);
  }
});

test('copies of the prompt word list and its boilerplate are dropped', () => {
  for (const t of [
    'Sudo-chan, Sid, suno, ji',
    'Sudo-chan, Sid, suno, ji, kya haal hai, kaise ho, theek hai, mujhe batao, kaam, baat, computer.',
    'Pakistani conversation in Roman Urdu and English.',
    'Pakistani conversation in Roman Urdu and English. Sudo-chan, Sid',
    'Short voice command. The speaker may call the assistant by name: Sudo, Sid, Sudo-chan, Suddo, Sit.',
    'kya haal hai kaise ho theek hai mujhe batao kaam baat computer',
    'Roman Urdu and English',
    'Mujhe Sudo-chan se baat karni hai.',
  ]) assert.equal(isPhantomTranscript(t), true, t);
});

test('known Whisper junk is dropped only when it is the whole transcript', () => {
  for (const t of ['Thanks for watching', 'Thanks for watching!', 'thank you for watching.', 'Thank you.', 'Please subscribe', 'Subtitles by the Amara.org community', '[Music]', '(applause)', '♪ ♪ ♪', '...', ' ', '?!', 'Bye bye.', 'you', 'Transcribed by someone', 'www.example.com']) {
    assert.equal(isPhantomTranscript(t), true, JSON.stringify(t));
  }
  for (const t of ['Sid, thanks for watching my screen', 'thank you Sid, ab batao', 'music chalao', 'Sudo, subscribe karwa do mujhe']) {
    assert.equal(isPhantomTranscript(t), false, t);
  }
});

test('a single name still wakes: it is kept by the filter and matched by the wake gate', () => {
  for (const t of ['Sudo', 'Sudo.', 'Sid', 'Sudo-chan', 'Sudo chan', 'Sudo-chan,', 'Suddo', 'Sudo?']) {
    assert.equal(isPhantomTranscript(t), false, t);
    assert.equal(matchWakeWord(t, 'Sudo', undefined).matched, true, t);
  }
});

test('real sentences are untouched, including ones with a name and prompt-like words', () => {
  const real = [
    'Sudo, kaise ho?', 'Sid ruko', 'Sid, ruko', 'meri screen dekho', 'Sid, meri screen dekho', 'Sudo-chan, ye kya hai',
    'Sid, suno', 'Sid suno ji', 'kaise ho', 'kya haal hai', 'kya haal hai kaise ho', 'Sid, kya haal hai?', 'theek hai, mujhe batao',
    'computer ka kaam batao', 'mujhe batao kya haal hai', 'Sudo open notes please', 'what is the weather today',
    'Sit down please', 'Sid, tum Roman Urdu and English dono samajh sakti ho?', 'aaj ka kaam batao Sid',
    'سڈ یہ کیا ہے', 'مجھے اپنی سکرین دکھاؤ', 'سوڈو، کیسے ہو؟', 'آپ کیسی ہیں', 'Sid, اپنی سکرین دیکھو',
  ];
  for (const t of real) assert.equal(isPhantomTranscript(t), false, t);
});

test('custom wake names count as names: "Jarvis, Jarvis" is dropped, "Jarvis" and "Jarvis kaise ho" are not', () => {
  const o = { names: ['Jarvis'] };
  assert.equal(isPhantomTranscript('Jarvis, Jarvis', o), true);
  assert.equal(isPhantomTranscript('Jarvis, Sudo', o), true);
  assert.equal(isPhantomTranscript('Jarvis', o), false);
  assert.equal(isPhantomTranscript('Jarvis kaise ho', o), false);
  assert.equal(isPhantomTranscript('Jarvis, Jarvis', {}), false); // unknown name without the option
});

test('verdict carries a reason, and "suno" is never mistaken for the name "sudo"', () => {
  assert.equal(classifyTranscript('').reason, 'empty');
  assert.equal(classifyTranscript('Thanks for watching').reason, 'junk');
  assert.equal(classifyTranscript('Sudo-chan, Sido-chan,').reason, 'name-list');
  assert.equal(classifyTranscript('Sudo-chan, Sid, suno, ji').reason, 'prompt-copy');
  assert.equal(classifyTranscript('Sid suno').drop, false);
  assert.equal(classifyTranscript('suno suno').drop, false);
});

// ---------- self-echo safety net ----------
test('self-echo: a name-only transcript within 3 s that matches the bot\'s last words is ignored', () => {
  const said = 'Sid, main sun rahi hoon, bataiye kya kaam hai?';
  assert.equal(isSelfEchoTranscript('Sid', said, 0), true);
  assert.equal(isSelfEchoTranscript('Sudo-chan', 'Haan Sudo-chan yahan hai', 1200), true);
  assert.equal(isSelfEchoTranscript('Sid, main sun rahi hoon', said, 2500), true);
  assert.equal(isSelfEchoTranscript('Sid', said, SELF_ECHO_WINDOW_MS + 1), false);
  assert.equal(isSelfEchoTranscript('Sid, meri screen dekho', said, 500), false);
  assert.equal(isSelfEchoTranscript('Sid ruko', said, 500), false);
  assert.equal(isSelfEchoTranscript('Sid', 'Main sun rahi hoon', 500), false); // bot said no name
  assert.equal(isSelfEchoTranscript('Sid', '', 500), false);
  assert.equal(isSelfEchoTranscript('Sid', undefined, 500), false);
  assert.equal(isSelfEchoTranscript('kaise ho', said, 500), false); // no name at all: not this rule's business
  assert.equal(isSelfEchoTranscript('Sid', said, Number.POSITIVE_INFINITY), false);
});

// ---------- Whisper segments ----------
test('segment confidence: only confident-silence segments are rejected; missing data keeps the text', () => {
  assert.equal(segmentsLookLikeSilence([{ no_speech_prob: 0.9, avg_logprob: -1.4 }]), true);
  assert.equal(segmentsLookLikeSilence([{ no_speech_prob: 0.9, avg_logprob: -1.4 }, { no_speech_prob: 0.8, avg_logprob: -1.2 }]), true);
  assert.equal(segmentsLookLikeSilence([{ no_speech_prob: 0.9, avg_logprob: -0.3 }]), false); // confident words
  assert.equal(segmentsLookLikeSilence([{ no_speech_prob: 0.1, avg_logprob: -1.4 }]), false);
  assert.equal(segmentsLookLikeSilence([{ no_speech_prob: 0.9, avg_logprob: -1.4 }, { no_speech_prob: 0.05, avg_logprob: -0.2 }]), false);
  for (const v of [undefined, null, [], 'x', [{}], [null], [{ no_speech_prob: 0.9 }]]) assert.equal(segmentsLookLikeSilence(v), false);
});

// ---------- Whisper prompt ----------
const NAME_RE = /\b(sudo|sido|sid|suddo|sit)(?:-chan)?\b/gi;
test('the Whisper prompt has the name at most once, never first, and no list of names', () => {
  assert.ok((WHISPER_DEFAULT_PROMPT.match(NAME_RE) ?? []).length <= 1);
  assert.doesNotMatch(WHISPER_DEFAULT_PROMPT, /^(sudo|sid)/i);
  assert.doesNotMatch(WHISPER_DEFAULT_PROMPT, /Sudo-chan, Sid/);
  assert.match(WHISPER_DEFAULT_PROMPT, /Roman Urdu/);
});

test('the wake hint (a list of names) is reduced to ONE name in the Whisper prompt; free hints without names are kept', () => {
  const hint = buildWakeHint('Sudo', ['Sid', 'Sudo-chan', 'Suddo', 'Sit']).replace(/[^\p{L}\p{N}\s,.'-]/gu, ' '); // as main sanitises it
  for (const h of [hint, buildWakeHint('Sudo', undefined)]) {
    const p = buildWhisperPrompt(h);
    assert.ok((p.match(NAME_RE) ?? []).length <= 1, p);
    assert.doesNotMatch(p, /Sid/);
    assert.doesNotMatch(p, /Suddo/);
    assert.doesNotMatch(p, /^(Short|Sudo|Sid)/);
    assert.ok(p.length <= 400);
  }
  assert.equal(buildWhisperPrompt(undefined), WHISPER_DEFAULT_PROMPT);
  assert.equal(buildWhisperPrompt('name is Sudo'), WHISPER_DEFAULT_PROMPT); // hint already names it: not duplicated
  assert.match(buildWhisperPrompt('Quiet room, short command.'), /^Quiet room, short command\. Roman Urdu/);
  assert.match(buildWhisperPrompt(buildWakeHint('Echo', ['Jarvis'])), /Mujhe Echo se baat/);
});

// ---------- SttRouter with a fake Groq server ----------
const ok = body => ({ ok: true, status: 200, json: async () => body });
function groqOnly(body) {
  const seen = [];
  const r = new SttRouter({
    fetch: async (url, init) => { seen.push({ url, form: init.body }); return ok(typeof body === 'function' ? body() : body); },
    getKey: id => (id === 'groq' ? 'W' : ''),
    now: () => 1000,
    getMode: () => 'fast',
  });
  return { r, seen };
}
const req = { base64: Buffer.from('x').toString('base64'), mimeType: 'audio/wav', language: 'auto', hint: buildWakeHint('Sudo', ['Sid']) };

test('Whisper returning the prompt names ("Sudo-chan, Sido-chan,") is rejected by the router, not turned into a wake', async () => {
  for (const text of ['Sudo-chan, Sido-chan,', 'Sudo-chan, Sido,', 'Thanks for watching']) {
    const { r } = groqOnly({ text });
    const out = await r.transcribe(req);
    assert.equal(out.ok, false, text);
  }
});

test('Whisper real speech and a single name still come through', async () => {
  for (const text of ['Sudo', 'Sid, kaise ho?', 'meri screen dekho']) {
    const { r } = groqOnly({ text });
    const out = await r.transcribe(req);
    assert.equal(out.ok, true, text);
    assert.equal(out.text, text);
  }
});

test('Groq request: verbose_json, and a prompt without the name list', async () => {
  const { r, seen } = groqOnly({ text: 'meri screen dekho', segments: [{ no_speech_prob: 0.01, avg_logprob: -0.2 }] });
  const out = await r.transcribe(req);
  assert.equal(out.ok, true);
  assert.equal(seen[0].form.get('response_format'), 'verbose_json');
  const prompt = seen[0].form.get('prompt');
  assert.ok((prompt.match(NAME_RE) ?? []).length <= 1, prompt);
  assert.doesNotMatch(prompt, /Sid/);
});

test('Whisper segments that look like silence reject the text; no segments (old servers) keep it', async () => {
  const silent = groqOnly({ text: 'Sid, kaise ho?', segments: [{ no_speech_prob: 0.93, avg_logprob: -1.6 }] });
  assert.equal((await silent.r.transcribe(req)).ok, false);
  const noSeg = groqOnly({ text: 'Sid, kaise ho?' });
  assert.equal((await noSeg.r.transcribe(req)).ok, true);
});

// ---------- echo-envelope barge-in ----------
const FRAME = 21;
const BASE = 0.009;
const make = (sensitivity = 0.5) => new BargeInDetector({ baseThreshold: BASE, sensitivity });
/** Deterministic syllable-like echo: rms wanders between 0.4x and 1x of `peak`. */
function echoFrame(i, peak) {
  const syllable = 0.7 + 0.3 * Math.sin(i / 5.3);
  const wobble = 0.85 + 0.15 * Math.sin(i * 1.7);
  return Math.max(0.02 * peak, peak * Math.min(1, syllable * wobble * 1.05)) * (0.4 + 0.6 * Math.abs(Math.sin(i / 11)));
}

test('echo-level energy never triggers, even though it is far above the old fixed threshold', () => {
  for (const peak of [0.02, 0.035, 0.05, 0.08, 0.15]) {
    const d = make();
    let above = 0;
    for (let i = 0; i < 1000; i++) { // 21 s of bot speech leaking into the mic
      const rms = echoFrame(i, peak);
      if (rms > bargeInThreshold({ baseThreshold: BASE, sensitivity: 0.5 })) above++;
      assert.equal(d.feed(rms, FRAME, i * FRAME), false, `peak ${peak} frame ${i}`);
    }
    if (peak >= 0.035) assert.ok(above > 100, `the old fixed threshold would have fired (peak ${peak})`);
  }
});

test('speech at +6 dB over the echo triggers within 150-300 ms; speech AT the echo level does not', () => {
  for (const peak of [0.02, 0.05, 0.1]) {
    const d = make();
    let t = 0;
    for (; t < 1500; t += FRAME) assert.equal(d.feed(echoFrame(t / FRAME, peak), FRAME, t), false);
    const t0 = t;
    let at = null;
    for (; t < t0 + 1000 && at === null; t += FRAME) if (d.feed(peak * 2.05, FRAME, t)) at = t + FRAME - t0;
    assert.notEqual(at, null, `peak ${peak}`);
    assert.ok(at >= 150 && at < 300, `latency ${at}`);
  }
  const same = make();
  for (let i = 0; i < 400; i++) assert.equal(same.feed(echoFrame(i, 0.05), FRAME, i * FRAME), false);
  for (let i = 400; i < 600; i++) assert.equal(same.feed(0.05, FRAME, i * FRAME), false);
});

test('a louder echo burst shorter than the minimum run does not fire, and is learned so the next one does not either', () => {
  const d = make();
  let t = 0;
  for (; t < 1500; t += FRAME) d.feed(echoFrame(t / FRAME, 0.03), FRAME, t);
  for (let rep = 0; rep < 6; rep++) {
    for (let i = 0; i < 3; i++, t += FRAME) assert.equal(d.feed(0.09, FRAME, t), false); // 63 ms burst
    for (let i = 0; i < 10; i++, t += FRAME) assert.equal(d.feed(echoFrame(t / FRAME, 0.03), FRAME, t), false);
  }
  assert.ok(d.echoEnvelope >= 0.08 - 1e-9);
});

test('the first 350 ms of a reply only learn the echo: ordinary loudness cannot interrupt, a clearly louder voice can', () => {
  const quiet = make();
  let fired = false;
  for (let t = 0; t < ECHO_WARMUP_MS - FRAME; t += FRAME) fired ||= quiet.feed(0.06, FRAME, t);
  assert.equal(fired, false);

  const loud = make();
  let at = null;
  for (let t = 0; t < ECHO_WARMUP_MS && at === null; t += FRAME) if (loud.feed(0.3, FRAME, t)) at = t + FRAME;
  assert.notEqual(at, null);
  assert.ok(at < 300, `latency ${at}`);
});

test('a user already speaking at normal level before the echo is learned is not frozen out: after warm-up they still interrupt', () => {
  // quiet room: bot echo 0.004, user 0.05 starting 400 ms into the reply
  const d = make();
  let t = 0;
  for (; t < 400; t += FRAME) d.feed(0.004, FRAME, t);
  let at = null;
  const t0 = t;
  for (; t < t0 + 600 && at === null; t += FRAME) if (d.feed(0.05, FRAME, t)) at = t + FRAME - t0;
  assert.ok(at !== null && at < 300, `latency ${at}`);
});

test('echo margin shrinks with sensitivity and the existing sensitivity ordering still holds', () => {
  assert.ok(echoMargin(0) > echoMargin(0.5));
  assert.ok(echoMargin(0.5) > echoMargin(1));
  assert.ok(echoMargin(0.5) < 2.0 && echoMargin(1) > 1);
  const hi = make(1), lo = make(0);
  for (let i = 0; i < 100; i++) { hi.feed(0.03, FRAME, i * FRAME); lo.feed(0.03, FRAME, i * FRAME); }
  assert.ok(hi.currentThreshold() < lo.currentThreshold());
});

test('very loud echo cannot make interruption impossible (threshold is capped)', () => {
  const d = make();
  for (let i = 0; i < 200; i++) d.feed(0.6, FRAME, i * FRAME);
  assert.ok(d.currentThreshold() <= 0.3 + 1e-9);
});

test('echo tail: just after a reply, starting a clip needs to beat the echo envelope; later the plain threshold is back', () => {
  const d = make();
  let t = 0;
  for (; t < 1500; t += FRAME) d.feed(echoFrame(t / FRAME, 0.05), FRAME, t);
  d.idle(t);
  assert.equal(d.inEchoTail(t), true);
  assert.ok(d.idleSpeechThreshold(BASE, t) > 0.05); // echo-level ring-out cannot start a clip
  assert.equal(d.idleSpeechThreshold(BASE, t + 100) > 0.05, true);
  const later = t + ECHO_TAIL_MS + 100;
  d.idle(later);
  assert.equal(d.inEchoTail(later), false);
  assert.equal(d.idleSpeechThreshold(BASE, later), BASE);
  assert.equal(d.echoEnvelope, 0);
});

test('a reply that continues right after the previous sentence keeps the echo level (no new blind warm-up)', () => {
  const d = make();
  let t = 0;
  for (; t < 1500; t += FRAME) d.feed(0.01, FRAME, t);
  d.idle(t); t += 100; // gap between two spoken sentences
  let at = null;
  const t0 = t;
  for (; t < t0 + 600 && at === null; t += FRAME) if (d.feed(0.08, FRAME, t)) at = t + FRAME - t0;
  assert.ok(at !== null && at < 300, `latency ${at}`);
});

test('idle() and reset() clear the run so a new reply starts clean', () => {
  const d = make();
  for (let i = 0; i < 5; i++) d.feed(0.3, FRAME, i * FRAME);
  d.idle(1000);
  d.reset();
  assert.equal(d.echoEnvelope, 0);
  assert.equal(d.speechStartedAt, null);
});

test('clip echo guard: overlapped, no barge-in, at/under the echo envelope -> never sent to STT', () => {
  const base = { overlappedPlayback: true, bargeInFired: false, echoEnvelope: 0.04, sensitivity: 0.5 };
  assert.equal(clipIsEcho({ ...base, overlapPeakRms: 0.04 }), true);
  assert.equal(clipIsEcho({ ...base, overlapPeakRms: 0.05 }), true);
  assert.equal(clipIsEcho({ ...base, overlapPeakRms: 0.1 }), false); // clearly the user
  assert.equal(clipIsEcho({ ...base, bargeInFired: true, overlapPeakRms: 0.04 }), false); // detector already judged it
  assert.equal(clipIsEcho({ ...base, overlappedPlayback: false, overlapPeakRms: 0.001 }), false); // no playback involved
  assert.equal(clipIsEcho({ ...base, echoEnvelope: 0, overlapPeakRms: 0.01 }), false); // nothing known about echo: keep
});
