import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalAI, buildSystemPrompt } from '../dist/main/local-ai.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = text => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);
const cloud = { provider: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'qwen/qwen3.8-27b', apiKey: 'test-key' };
const IMAGE = 'data:image/jpeg;base64,/9j/AAAA';
const visionTargets = [{ provider: 'groq', endpoint: 'https://groq.test/chat', model: 'vision-m', apiKey: 'KEY-V' }];
const messages = [{ role: 'user', content: 'ye error kya hai aur file bhi khol do' }];
const fakeTools = (log = []) => ({
  definitions: [{ type: 'function', function: { name: 'get_system_info', description: 'info', parameters: { type: 'object', properties: {} } } }],
  execute: async (name, args) => { log.push([name, args]); return 'OS: linux'; },
});

// LocalAI's vision path uses the global fetch (runVisionChat); the chat path uses the injected one.
async function withGlobalFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('screenshot turn WITH tools enabled: answered by the vision model, tool loop is not used, prompt says so', async () => {
  const visionBodies = [];
  const chatFetchCalls = [];
  const log = [];
  const ai = new LocalAI(async () => { chatFetchCalls.push(1); throw new Error('chat path must not run on a screenshot turn'); });
  const out = [];
  await withGlobalFetch(async (url, init) => {
    visionBodies.push(JSON.parse(init.body));
    return json({ choices: [{ message: { content: 'Ye ek ModuleNotFoundError hai.' } }] });
  }, () => ai.stream('', messages, new AbortController().signal, t => out.push(t), {
    mode: 'cloud',
    cloud,
    tools: fakeTools(log),
    vision: { dataUri: IMAGE, targets: visionTargets, fallbackText: 'f' },
  }));
  assert.deepEqual(out, ['Ye ek ModuleNotFoundError hai.']);
  assert.equal(chatFetchCalls.length, 0);
  assert.equal(log.length, 0, 'no tool may run on a screenshot turn');
  assert.equal(visionBodies.length, 1);
  assert.equal(visionBodies[0].tools, undefined, 'no tools parameter on the vision request');
  const system = visionBodies[0].messages[0].content;
  assert.match(system, /SCREENSHOT ATTACHED/);
  assert.match(system, /NOT available on this screenshot turn/);
  assert.equal(system.includes('[TOOLS ARE ON]'), false);
  assert.equal(visionBodies[0].messages.at(-1).content[1].image_url.url, IMAGE);
});

test('screenshot turn with tools OFF: no mention of tools in the prompt', async () => {
  const bodies = [];
  const ai = new LocalAI(async () => { throw new Error('unused'); });
  await withGlobalFetch(async (url, init) => { bodies.push(JSON.parse(init.body)); return json({ choices: [{ message: { content: 'ok' } }] }); },
    () => ai.stream('', messages, new AbortController().signal, () => {}, { mode: 'cloud', cloud, vision: { dataUri: IMAGE, targets: visionTargets, fallbackText: 'f' } }));
  assert.equal(bodies[0].messages[0].content.includes('NOT available on this screenshot turn'), false);
  assert.equal(bodies[0].messages[0].content.includes('[TOOLS ARE ON]'), false);
});

test('tools turn without screenshot: tool loop runs, no image, prompt says she cannot see the screen', async () => {
  const bodies = [];
  const replies = [
    json({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_system_info', arguments: '{}' } }] } }] }),
    json({ choices: [{ message: { content: 'Aap ka OS linux hai.' } }] }),
  ];
  const ai = new LocalAI(async (url, init) => { bodies.push(JSON.parse(init.body)); return replies.shift(); });
  const log = [];
  const out = [];
  await ai.stream('', messages, new AbortController().signal, t => out.push(t), { mode: 'cloud', cloud, tools: fakeTools(log) });
  assert.deepEqual(out, ['Aap ka OS linux hai.']);
  assert.equal(log.length, 1);
  const system = bodies[0].messages[0].content;
  assert.match(system, /\[TOOLS ARE ON\]/);
  assert.match(system, /this is NOT such a turn/);
  assert.equal(JSON.stringify(bodies[0]).includes('image_url'), false);
});

test('baseline with tools OFF and screen assist OFF: plain streaming, no tools, no image, truthful boundary', async () => {
  const bodies = [];
  const ai = new LocalAI(async (url, init) => { bodies.push(JSON.parse(init.body)); return sse('Salam!'); });
  const out = [];
  await ai.stream('', messages, new AbortController().signal, t => out.push(t), { mode: 'cloud', cloud });
  assert.deepEqual(out, ['Salam!']);
  assert.equal(bodies[0].tools, undefined);
  assert.equal(bodies[0].stream, true);
  const system = bodies[0].messages[0].content;
  assert.equal(system.includes('[TOOLS ARE ON]'), false);
  assert.match(system, /ONLY on a turn where a screenshot is attached/);
  assert.match(system, /cannot modify or delete OS files directly/);
  assert.equal(JSON.stringify(bodies[0]).includes('image_url'), false);
});

test('prompt matrix: never claims files/commands without tools, never claims sight without a screenshot', () => {
  const plain = buildSystemPrompt({});
  const tools = buildSystemPrompt({ tools: true });
  const paused = buildSystemPrompt({ toolsPaused: true });
  assert.match(plain, /cannot see the screen and must say so/);
  assert.match(tools, /cannot see the screen and must say so/);
  assert.match(tools, /with the user's approval/);
  assert.equal(plain.includes("with the user's approval"), false);
  assert.match(paused, /NOT available on this screenshot turn/);
  assert.equal(plain.includes('NOT available on this screenshot turn'), false);
});
