import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalAI, LocalAIError, buildSystemPrompt, TOOLS_PROMPT } from '../dist/main/local-ai.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = text => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);
const cloud = { provider: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'qwen/qwen3.8-27b', apiKey: 'test-key' };
const fakeTools = (log = []) => ({
  definitions: [{ type: 'function', function: { name: 'get_system_info', description: 'info', parameters: { type: 'object', properties: {} } } }],
  execute: async (name, args) => { log.push([name, args]); return 'OS: linux'; },
});
const messages = [{ role: 'user', content: 'mere computer ki info do' }];

test('system prompt: tools OFF keeps the old truthful boundary, tools ON describes the real tools', () => {
  const off = buildSystemPrompt({ model: 'm', provider: 'Groq' });
  assert.match(off, /cannot modify or delete OS files directly/);
  assert.equal(off.includes('[TOOLS ARE ON]'), false);

  const on = buildSystemPrompt({ model: 'm', provider: 'Groq', tools: true });
  assert.match(on, /\[TOOLS ARE ON\]/);
  assert.match(on, /NEVER claim you read, wrote, ran or opened anything unless a tool result confirms it/);
  assert.match(on, /NOT by voice/);
  assert.equal(on.includes('cannot modify or delete OS files directly'), false, 'must not wrongly say she cannot touch files when tools are on');
  assert.ok(on.includes(TOOLS_PROMPT));

  const voice = buildSystemPrompt({ voice: true, tools: true });
  assert.match(voice, /approve on screen/);
  assert.equal(buildSystemPrompt({ voice: true }).includes('approve on screen'), false);
});

test('chat with tools: runs the tool loop through the cloud path and delivers the final answer', async () => {
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
  assert.deepEqual(log, [['get_system_info', {}]]);
  assert.equal(bodies[0].tools.length, 1);
  assert.match(bodies[0].messages[0].content, /\[TOOLS ARE ON\]/);
  assert.equal(bodies[0].stream, false);
});

test('chat without tools option: plain streaming, no tools parameter, tool prompt absent', async () => {
  const bodies = [];
  const ai = new LocalAI(async (url, init) => { bodies.push(JSON.parse(init.body)); return sse('Salam!'); });
  const out = [];
  await ai.stream('', messages, new AbortController().signal, t => out.push(t), { mode: 'cloud', cloud });
  assert.deepEqual(out, ['Salam!']);
  assert.equal(bodies[0].tools, undefined);
  assert.equal(bodies[0].stream, true);
  assert.equal(bodies[0].messages[0].content.includes('[TOOLS ARE ON]'), false);
});

test('chat with tools: a provider that rejects tools falls back to plain chat (with the plain prompt)', async () => {
  const bodies = [];
  const ai = new LocalAI(async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return body.tools
      ? json({ error: { message: 'tools are not supported by this model' } }, 400)
      : sse('Main tools use nahi kar sakti, lekin baat kar sakti hoon.');
  });
  const out = [];
  await ai.stream('', messages, new AbortController().signal, t => out.push(t), { mode: 'cloud', cloud, tools: fakeTools() });
  assert.deepEqual(out, ['Main tools use nahi kar sakti, lekin baat kar sakti hoon.']);
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].tools);
  assert.equal(bodies[1].tools, undefined);
  assert.equal(bodies[1].messages[0].content.includes('[TOOLS ARE ON]'), false);
});

test('chat with tools: auth errors and user aborts surface properly, empty tool list means plain chat', async () => {
  const denied = new LocalAI(async () => json({ error: { message: 'bad key' } }, 401));
  await assert.rejects(
    denied.stream('', messages, new AbortController().signal, () => {}, { mode: 'cloud', cloud, tools: fakeTools() }),
    error => error instanceof LocalAIError && /key rejected/.test(error.message),
  );

  const controller = new AbortController();
  const aborting = new LocalAI(async (url, init) => {
    controller.abort();
    init.signal.throwIfAborted();
    return json({});
  });
  await assert.rejects(aborting.stream('', messages, controller.signal, () => {}, { mode: 'cloud', cloud, tools: fakeTools() }));

  const bodies = [];
  const plain = new LocalAI(async (url, init) => { bodies.push(JSON.parse(init.body)); return sse('ok'); });
  await plain.stream('', messages, new AbortController().signal, () => {}, { mode: 'cloud', cloud, tools: { definitions: [], execute: async () => '' } });
  assert.equal(bodies[0].tools, undefined);
});
