import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyModelMeta,
  isTinyModel,
  isRomanUrduInput,
  smartRomanUrduReply,
  isGibberishRomanUrdu,
  fallbackRomanUrduReply,
  getModelsEndpoint,
  LocalAI,
} from '../dist/main/local-ai.js';
import {
  CLOUD_PRESETS,
  maskApiKey,
  validCloudConfig,
} from '../dist/shared/validation.js';

test('heavy model detection flags models by size, parameter count, and RAM threshold', () => {
  const freeRam8GB = 8 * 1024 * 1024 * 1024;
  const freeRam2GB = 2 * 1024 * 1024 * 1024;

  // Tiny 0.5B model on 8GB RAM is light
  const tinyMeta = classifyModelMeta('qwen2.5:0.5b', 398 * 1024 * 1024, '0.5B', freeRam8GB);
  assert.equal(tinyMeta.heavy, false);
  assert.equal(tinyMeta.warning, undefined);
  assert.equal(tinyMeta.sizeLabel, '398 MB');
  assert.equal(isTinyModel('qwen2.5:0.5b'), true);
  assert.equal(isTinyModel('mera-ai:latest'), true);

  // Large 8B model (4.7 GB) is heavy
  const llamaMeta = classifyModelMeta('llama3:latest', 4700 * 1024 * 1024, '8B', freeRam8GB);
  assert.equal(llamaMeta.heavy, true);
  assert.equal(typeof llamaMeta.warning, 'string');
  assert.match(llamaMeta.warning, /bohot heavy hai/);
  assert.match(llamaMeta.warning, /qwen2\.5:0\.5b ya Cloud API/);
  assert.equal(isTinyModel('llama3:latest'), false);

  // Models > 2.2 GB are automatically heavy
  const custom2300MB = classifyModelMeta('custom-model', 2300 * 1024 * 1024, '3B', freeRam8GB);
  assert.equal(custom2300MB.heavy, true);

  // Model exceeding 65% of free RAM is marked heavy even if <= 2.2 GB
  // 1500 MB model on 2000 MB free RAM (65% of 2000 MB = 1300 MB)
  const lowRamMeta = classifyModelMeta('medium-model', 1500 * 1024 * 1024, '2B', freeRam2GB);
  assert.equal(lowRamMeta.heavy, true);
  assert.match(lowRamMeta.warning, /bohot heavy hai/);
});

test('gibberish detector catches Indonesian/Malay hallucinations and repetitive vowel corruption', () => {
  // Hallucination reported by user
  const hallucinatedReply = 'Naa tuk hafi. Madiun, kaa ka kiiyaa...';
  assert.equal(isGibberishRomanUrdu(hallucinatedReply, 'urdu bolo'), true);

  // Other common corruptions
  assert.equal(isGibberishRomanUrdu('saya bisa membantu Anda', 'kya haal hai'), true);
  assert.equal(isGibberishRomanUrdu('kaaa kiiiyuuu baaaiik', 'Assalam o Alaikum'), true);

  // Prompt-echo loops from few-shot confusion
  assert.equal(isGibberishRomanUrdu('Aapka "Assalam o Alaikum! Kya haal hai?" chahiye, aur "Waalaikum Assalam!" aur "Language? urdu bolo" mein aise hoga.', 'urdu bolo'), true);

  // Arabic/Urdu script is rejected when Roman Urdu expected
  assert.equal(isGibberishRomanUrdu('ہلا، آپ کی مدد کے لئے ہم ایس بات سکوں۔', 'hlo'), true);
  assert.equal(isGibberishRomanUrdu('رومان وردو اور ایجین وردو', 'roman urdu may btao'), true);

  // Natural Pakistani Roman Urdu is NOT gibberish
  const cleanReply = 'Assalam o Alaikum! Main Sudo-chan hoon, aapki dost aur desktop companion.';
  assert.equal(isGibberishRomanUrdu(cleanReply, 'kya haal hai'), false);
  assert.equal(isGibberishRomanUrdu("I'm right here with you! Let me know how I can help.", 'hello'), false);
});

test('natural Roman Urdu handlers handle common intents gracefully without hallucinations', () => {
  // Greetings
  const greeting = smartRomanUrduReply('Assalam o Alaikum! Kya haal hai?');
  assert.ok(greeting);
  assert.match(greeting, /Sudo-chan/);

  // Language queries
  const langQuery = smartRomanUrduReply('language?');
  assert.ok(langQuery);
  assert.match(langQuery, /Roman Urdu/);

  const urduBolo = smartRomanUrduReply('urdu bolo');
  assert.ok(urduBolo);
  assert.match(urduBolo, /Roman Urdu/);

  const romanMayBtao = smartRomanUrduReply('roman urdu may btao');
  assert.ok(romanMayBtao);
  assert.match(romanMayBtao, /Roman Urdu/);

  const hloCheck = smartRomanUrduReply('hlo');
  assert.ok(hloCheck);
  assert.match(hloCheck, /Sudo-chan/);

  const userLangCheck = smartRomanUrduReply('kya tum mery sath roman urdu me bol rhy ho ?');
  assert.ok(userLangCheck);
  assert.match(userLangCheck, /Roman Urdu/);

  const introCheck = smartRomanUrduReply('ni matlb tum ho kon zara apna introduce tu karwao');
  assert.ok(introCheck);
  assert.match(introCheck, /Sudo-chan/);

  const detailsCheck = smartRomanUrduReply('tum apny bary may details du');
  assert.ok(detailsCheck);
  assert.match(detailsCheck, /Sudo-chan/);

  const capabilitiesCheck = smartRomanUrduReply('pehly mujy btao tum mery lia kya kar skty ho?');
  assert.ok(capabilitiesCheck);
  assert.match(capabilitiesCheck, /desktop companion/);

  // Gibberish complaint
  const gibberishComplaint = smartRomanUrduReply('ye kya bol rhy ho');
  assert.ok(gibberishComplaint);
  assert.match(gibberishComplaint, /Sorry yaar/);

  // Encouragement
  const encouragement = smartRomanUrduReply('mujhe thori encouragement do');
  assert.ok(encouragement);
  assert.match(encouragement, /himmat mat haaro/);

  // General Roman Urdu fallback
  assert.equal(isRomanUrduInput('aaj bohot zyada kaam hai yaar'), true);
  const fallback = fallbackRomanUrduReply('aaj bohot zyada kaam hai yaar');
  assert.ok(fallback);
  assert.match(fallback, /Main aapki baat samajh rahi hoon/);
});

test('cloud provider presets match required endpoints and default models', () => {
  assert.equal(CLOUD_PRESETS.gemini.endpoint, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(CLOUD_PRESETS.gemini.defaultModel, 'gemini-2.5-flash');

  assert.equal(CLOUD_PRESETS.groq.endpoint, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(CLOUD_PRESETS.groq.defaultModel, 'llama-3.1-8b-instant');

  assert.equal(CLOUD_PRESETS.openai.endpoint, 'https://api.openai.com/v1/chat/completions');
  assert.equal(CLOUD_PRESETS.openai.defaultModel, 'gpt-4o-mini');

  assert.equal(CLOUD_PRESETS.openrouter.endpoint, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(CLOUD_PRESETS.openrouter.defaultModel, 'meta-llama/llama-3.3-70b-instruct:free');
});

test('cloud configuration validation enforces valid providers and endpoints', () => {
  assert.equal(validCloudConfig({
    provider: 'gemini',
    endpoint: CLOUD_PRESETS.gemini.endpoint,
    model: 'gemini-2.5-flash',
    apiKey: 'test-key',
  }), true);

  assert.equal(validCloudConfig({
    provider: 'custom',
    endpoint: 'http://127.0.0.1:8000/v1/chat/completions',
    model: 'custom-model',
  }), true);

  // Insecure remote HTTP is rejected
  assert.equal(validCloudConfig({
    provider: 'custom',
    endpoint: 'http://insecure-api.com/v1/chat/completions',
    model: 'custom-model',
  }), false);

  // Unknown provider rejected
  assert.equal(validCloudConfig({
    provider: 'unsupported',
    endpoint: 'https://api.example.com',
    model: 'model',
  }), false);
});

test('API key masking hides secret while showing last characters', () => {
  assert.equal(maskApiKey(''), '');
  assert.equal(maskApiKey('short'), '••••••••');
  assert.equal(maskApiKey('sk-ant-api03-12345678abcdef'), '••••••••cdef');
  assert.equal(maskApiKey('AIzaSyD-sampleGeminiKey9911'), '••••••••9911');
});

test('getModelsEndpoint resolves correct model discovery endpoints', () => {
  assert.equal(getModelsEndpoint('groq', 'https://api.groq.com/openai/v1/chat/completions'), 'https://api.groq.com/openai/v1/models');
  assert.equal(getModelsEndpoint('openai', 'https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1/models');
  assert.equal(getModelsEndpoint('openrouter', 'https://openrouter.ai/api/v1/chat/completions'), 'https://openrouter.ai/api/v1/models');
  assert.equal(getModelsEndpoint('gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'), 'https://generativelanguage.googleapis.com/v1beta/openai/models');
  assert.equal(getModelsEndpoint('custom', 'https://api.mycustom.ai/v1/chat/completions'), 'https://api.mycustom.ai/v1/models');
});

test('fetchCloudModels fetches and filters models correctly', async () => {
  let capturedAuth = '';
  let capturedUrl = '';

  const mockClient = new LocalAI(async (url, init) => {
    capturedUrl = String(url);
    capturedAuth = String(init?.headers?.Authorization || '');
    return new Response(JSON.stringify({
      data: [
        { id: 'llama-3.1-8b-instant' },
        { id: 'llama-guard-3-8b' },
        { id: 'whisper-large-v3' },
        { id: 'llama-3.3-70b-versatile' },
        { id: 'text-embedding-3-small' },
        { id: 'mixtral-8x7b-32768' },
      ],
    }));
  });

  const models = await mockClient.fetchCloudModels({
    provider: 'groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: 'gsk_test_12345678',
  });

  assert.equal(capturedUrl, 'https://api.groq.com/openai/v1/models');
  assert.equal(capturedAuth, 'Bearer gsk_test_12345678');
  assert.deepEqual(models, [
    'llama-3.1-8b-instant',
    'llama-3.3-70b-versatile',
    'mixtral-8x7b-32768',
  ]);
});

test('fetchCloudModels normalizes Gemini models stripping models/ prefix', async () => {
  const mockClient = new LocalAI(async () => {
    return new Response(JSON.stringify({
      data: [
        { id: 'models/gemini-2.5-flash' },
        { id: 'models/gemini-2.5-pro' },
        { id: 'models/text-embedding-004' },
      ],
    }));
  });

  const models = await mockClient.fetchCloudModels({
    provider: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiKey: 'AIzaSy_test_12345',
  });

  assert.deepEqual(models, ['gemini-2.5-flash', 'gemini-2.5-pro']);
});

test('fetchCloudModels rejects missing API key', async () => {
  const client = new LocalAI();
  await assert.rejects(
    () => client.fetchCloudModels({
      provider: 'groq',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: '',
    }),
    /Enter your API key first/,
  );
});
