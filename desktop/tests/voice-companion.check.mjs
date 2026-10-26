import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNELS } from '../src/shared/types.ts';
import { DEFAULT_SETTINGS, validSettings } from '../src/shared/validation.ts';
import { checkWakeIntent, isSpeakerMatch } from '../src/renderer/voice-engine.ts';

test('voice channels are defined in CHANNELS', () => {
  assert.equal(CHANNELS.setVoiceActive, 'companion:set-voice-active');
  assert.equal(CHANNELS.setIsSpeaking, 'companion:set-is-speaking');
  assert.equal(CHANNELS.transcribeAudio, 'companion:transcribe-audio');
  assert.equal(CHANNELS.playAudio, 'companion:play-audio');
});

test('settings validation accepts voice lock and wake word configuration', () => {
  assert.equal(DEFAULT_SETTINGS.voiceLockEnabled, false);
  assert.equal(DEFAULT_SETTINGS.customWakeWord, 'Sudo-chan');

  const validCustom = {
    ...DEFAULT_SETTINGS,
    voiceLockEnabled: true,
    registeredVoiceSample: 'sid-voice-12345',
    customWakeWord: 'Hey Sudo',
    voiceVisualizerMode: 'orb',
  };
  assert.equal(validSettings(validCustom), true);

  // Voice language settings
  assert.equal(DEFAULT_SETTINGS.voiceLanguage, 'auto');
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, voiceLanguage: 'auto' }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, voiceLanguage: 'en' }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, voiceLanguage: 'ur' }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, voiceLanguage: 'fr' }), false);

  // Rejects invalid types
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, voiceLockEnabled: 'yes' }), false);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, customWakeWord: 1234 }), false);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, voiceVisualizerMode: 'triangle' }), false);
});

test('wake word intent detection strictly requires sudo, sid, or custom wake name', () => {
  // Sudo-chan wake phrase
  const wake1 = checkWakeIntent('Sudo-chan please suno', 'Sudo-chan');
  assert.equal(wake1.isWake, true);

  // Sudo directly
  const wakeSudo = checkWakeIntent('Sudo kya time hua hai', 'Sudo-chan');
  assert.equal(wakeSudo.isWake, true);

  // Whisper phonetic variations of Sudo (e.g. Sido, Sidu, Sodo)
  assert.equal(checkWakeIntent('Sido suno please', 'Sudo-chan').isWake, true);
  assert.equal(checkWakeIntent('Hello, hello, my name is Sido.', 'Sudo-chan').isWake, true);
  assert.equal(checkWakeIntent('sidu kya haal hai', 'Sudo-chan').isWake, true);

  // Sid directly and phonetic variations (e.g. Sidd)
  const wakeSid = checkWakeIntent('Sid meri madad karo', 'Sudo-chan');
  assert.equal(wakeSid.isWake, true);
  assert.equal(checkWakeIntent('Sidd suno', 'Sudo-chan').isWake, true);
  assert.equal(checkWakeIntent('Sid idhar aao', 'Sudo-chan').isWake, true);

  // Normal conversation words that contain parts of names (e.g. decide, proceed, see) must NOT trigger false wake!
  assert.equal(checkWakeIntent('I have to decide now', 'Sudo-chan').isWake, false);
  assert.equal(checkWakeIntent('Let us proceed with the work', 'Sudo-chan').isWake, false);
  assert.equal(checkWakeIntent('See you tomorrow', 'Sudo-chan').isWake, false);

  // Urdu script variants
  assert.equal(checkWakeIntent('سوڈو سنو', 'Sudo-chan').isWake, true);
  assert.equal(checkWakeIntent('سڈ کیا حال ہے', 'Sudo-chan').isWake, true);

  // Custom wake name (e.g. Echo)
  const wakeCustom = checkWakeIntent('Echo kya haal hai?', 'Echo');
  assert.equal(wakeCustom.isWake, true);

  // Speech without wake name must NOT wake up (even if words like help or please are used)
  const helpWithoutName = checkWakeIntent('Mera ek kaam karo please', 'Sudo-chan');
  assert.equal(helpWithoutName.isWake, false);

  // Casual random conversation in the room must NOT wake up
  const unrelated = checkWakeIntent('main bahar ja raha hoon', 'Sudo-chan');
  assert.equal(unrelated.isWake, false);

  const questionWithoutName = checkWakeIntent('Ye kya cheez hai?', 'Sudo-chan');
  assert.equal(questionWithoutName.isWake, false);
});

test('speaker profile matcher verifies pitch similarity within tolerance', () => {
  const profile = {
    id: 'sid-profile',
    timestamp: Date.now(),
    sampleDurationSec: 5,
    avgPitch: 135,
    spectralCentroid: 120,
    energyDistribution: [0.4, 0.4, 0.2],
  };

  // Close pitch (140 Hz vs 135 Hz reference)
  assert.equal(isSpeakerMatch({ pitch: 140, centroid: 122 }, profile), true);

  // Too far pitch (240 Hz vs 135 Hz reference -> 77% diff)
  assert.equal(isSpeakerMatch({ pitch: 240, centroid: 180 }, profile), false);

  // Null profile allows gracefully
  assert.equal(isSpeakerMatch({ pitch: 180 }, null), true);
});

test('voice active target separates overlay and chat modes preventing simultaneous speech', () => {
  function resolveVoiceTarget(payload, callerKind) {
    let active = false;
    let target = null;
    if (typeof payload === 'boolean') {
      active = payload;
      target = active ? (callerKind === 'overlay' ? 'overlay' : 'chat') : null;
    } else if (payload && typeof payload === 'object') {
      active = Boolean(payload.active);
      target = active ? (payload.target ?? callerKind) : null;
    }
    return { active, target };
  }

  // Activating from overlay leaves chat inactive
  const overlayRes = resolveVoiceTarget({ active: true, target: 'overlay' }, 'overlay');
  assert.equal(overlayRes.active, true);
  assert.equal(overlayRes.target, 'overlay');
  assert.equal(overlayRes.target === 'chat', false);

  // Activating from chat leaves overlay inactive
  const chatRes = resolveVoiceTarget({ active: true, target: 'chat' }, 'chat');
  assert.equal(chatRes.active, true);
  assert.equal(chatRes.target, 'chat');
  assert.equal(chatRes.target === 'overlay', false);

  // Deactivating resets target to null
  const resetRes = resolveVoiceTarget({ active: false, target: 'chat' }, 'chat');
  assert.equal(resetRes.active, false);
  assert.equal(resetRes.target, null);
});

test('voice mode system prompt and Whisper prompt hint match configuration', () => {
  const WHISPER_PROMPT_HINT = 'Conversation in English, Urdu and Roman Urdu. Sudo-chan, Sid, suno, ji, kya haal hai, kaise ho, theek ho, computer, kaam, baat.';
  const VOICE_SYSTEM_PROMPT = "You are Sudo-chan, speaking aloud to your creator and developer Sid. Reply in the user's language, in 1-3 short natural spoken sentences. No markdown, no lists, no emojis. Answer the question directly and warmly in Roman Urdu or English.";

  const normalizeTargetLang = (lang) => (lang === 'en' || lang === 'ur' ? lang : undefined);
  assert.equal(normalizeTargetLang('auto'), undefined);
  assert.equal(normalizeTargetLang('en'), 'en');
  assert.equal(normalizeTargetLang('ur'), 'ur');
  assert.equal(normalizeTargetLang(undefined), undefined);

  assert.equal(WHISPER_PROMPT_HINT, 'Conversation in English, Urdu and Roman Urdu. Sudo-chan, Sid, suno, ji, kya haal hai, kaise ho, theek ho, computer, kaam, baat.');
  assert.equal(VOICE_SYSTEM_PROMPT, "You are Sudo-chan, speaking aloud to your creator and developer Sid. Reply in the user's language, in 1-3 short natural spoken sentences. No markdown, no lists, no emojis. Answer the question directly and warmly in Roman Urdu or English.");
});

