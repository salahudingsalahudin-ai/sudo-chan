import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoop, retryDelayMs, stripThinking, parseTextToolCalls, ToolLoopHttpError } from '../src/main/tools/agent-loop.ts';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const reply = (message, finish = 'stop') => json({ choices: [{ finish_reason: finish, message }] });
const toolCall = (name, args, id = 'c1') => reply({ content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] }, 'tool_calls');
const defs = [{ type: 'function', function: { name: 'list_dir', description: 'ls', parameters: { type: 'object', properties: {} } } }];
const makeTools = (log = []) => ({ definitions: defs, execute: async (name, args) => { log.push([name, args]); return 'report.txt'; } });
const base = (fetchFn, extra = {}) => ({
  fetchFn, endpoint: 'https://example.test/v1/chat/completions', apiKey: 'k', model: 'main-model',
  messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal, sleep: async () => {}, ...extra,
});

test('retryDelayMs reads Retry-After, "try again in" text and clamps to 1-8 s', () => {
  assert.equal(retryDelayMs('3', '', 2500), 3000);
  assert.equal(retryDelayMs(null, 'Please try again in 2.5s. Need more', 2500), 2500);
  assert.equal(retryDelayMs(null, 'try again in 400ms', 2500), 1000);
  assert.equal(retryDelayMs(null, 'try again in 1m30s', 2500), 8000);
  assert.equal(retryDelayMs('900', '', 2500), 8000);
  assert.equal(retryDelayMs(null, 'nothing useful', 2500), 2500);
});

test('stripThinking removes closed and unclosed think blocks', () => {
  assert.equal(stripThinking('<think>plan plan</think>Salam!'), 'Salam!');
  assert.equal(stripThinking('Salam <think>unfinished reasoning'), 'Salam');
  assert.equal(stripThinking('plain'), 'plain');
});

test('parseTextToolCalls accepts tagged, fenced and bare JSON, but only for offered tools', () => {
  const names = ['list_dir'];
  const tagged = parseTextToolCalls('Dekhti hoon <tool_call>{"name":"list_dir","arguments":{"path":"~/x"}}</tool_call>', names);
  assert.equal(tagged.calls.length, 1);
  assert.equal(JSON.parse(tagged.calls[0].function.arguments).path, '~/x');
  assert.equal(tagged.rest, 'Dekhti hoon');
  assert.equal(parseTextToolCalls('```json\n{"name":"list_dir","parameters":{"path":"~"}}\n```', names).calls.length, 1);
  assert.equal(parseTextToolCalls('{"function":{"name":"list_dir","arguments":"{\\"path\\":\\"~\\"}"}}', names).calls.length, 1);
  assert.equal(parseTextToolCalls('{"name":"delete_everything","arguments":{}}', names).calls.length, 0, 'unknown tool names are ignored');
  assert.equal(parseTextToolCalls('Sirf baat cheet', names).calls.length, 0);
});

test('a tool call written as text still runs the tool, and the final answer has no think tags', async () => {
  const log = [];
  const answers = [
    reply({ content: '<think>mujhe list karna hai</think><tool_call>{"name":"list_dir","arguments":{"path":"~"}}</tool_call>' }),
    reply({ content: '<think>done</think>Aap ki folder mein report.txt hai.' }),
  ];
  const texts = [];
  const out = await runToolLoop(base(async () => answers.shift(), { tools: makeTools(log), onText: t => texts.push(t) }));
  assert.equal(out.toolCalls, 1);
  assert.deepEqual(log[0], ['list_dir', { path: '~' }]);
  assert.deepEqual(texts, ['Aap ki folder mein report.txt hai.']);
});

test('malformed arguments are reported to the model instead of crashing, then it can retry', async () => {
  const log = [];
  const seen = [];
  const answers = [toolCall('list_dir', '{not json'), toolCall('list_dir', { path: '~' }, 'c2'), reply({ content: 'Mil gaya.' })];
  const texts = [];
  await runToolLoop(base(async (_url, init) => { seen.push(JSON.parse(init.body)); return answers.shift(); }, { tools: makeTools(log), onText: t => texts.push(t) }));
  const toolMsgs = seen[1].messages.filter(m => m.role === 'tool');
  assert.match(toolMsgs[0].content, /not a valid JSON object/);
  assert.equal(log.length, 1, 'only the valid call ran');
  assert.deepEqual(texts, ['Mil gaya.']);
});

test('non-object arguments (array, string) are rejected', async () => {
  const log = [];
  const answers = [toolCall('list_dir', '["~"]'), reply({ content: 'ok' })];
  await runToolLoop(base(async () => answers.shift(), { tools: makeTools(log), onText: () => {} }));
  assert.equal(log.length, 0);
});

test('empty answer after tools gives a friendly message; empty answer with no tools throws', async () => {
  const texts = [];
  const a1 = [toolCall('list_dir', { path: '~' }), reply({ content: '   ' })];
  await runToolLoop(base(async () => a1.shift(), { tools: makeTools(), onText: t => texts.push(t) }));
  assert.match(texts[0], /jawab likhte waqt masla/);
  await assert.rejects(() => runToolLoop(base(async () => reply({ content: '' }), { tools: makeTools(), onText: () => {} })), err => err instanceof ToolLoopHttpError && err.status === 0);
});

test('429 is retried with the provider wait, then the turn moves to the fallback model', async () => {
  const sleeps = [];
  const models = [];
  const fetchFn = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    models.push(model);
    if (model === 'main-model') return new Response('{"error":{"message":"Rate limit. Please try again in 2s."}}', { status: 429, headers: { 'retry-after': '2' } });
    return reply({ content: 'Fallback ne jawab diya.' });
  };
  const texts = [];
  const steps = [];
  await runToolLoop(base(fetchFn, { tools: makeTools(), onText: t => texts.push(t), fallbackModel: 'fallback-model', sleep: async ms => { sleeps.push(ms); }, onStep: s => steps.push(s) }));
  assert.deepEqual(models, ['main-model', 'main-model', 'main-model', 'fallback-model']);
  assert.deepEqual(sleeps, [2000, 2000]);
  assert.deepEqual(texts, ['Fallback ne jawab diya.']);
  assert.equal(steps[0].model, 'fallback-model');
});

test('429 without a fallback model ends as an http error after the retries', async () => {
  let calls = 0;
  await assert.rejects(
    () => runToolLoop(base(async () => { calls++; return new Response('{}', { status: 429 }); }, { tools: makeTools(), onText: () => {} })),
    err => err instanceof ToolLoopHttpError && err.status === 429,
  );
  assert.equal(calls, 3);
});

test('a request that never answers is cut by the per-request timeout', async () => {
  const hang = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('timed out'))));
  await assert.rejects(() => runToolLoop(base(hang, { tools: makeTools(), onText: () => {}, requestTimeoutMs: 30 })), /timed out/);
});

test('step limit: after maxSteps tool rounds the model is asked for a final answer without tools', async () => {
  const bodies = [];
  const fetchFn = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return body.tools ? toolCall('list_dir', { path: '~' }, `c${bodies.length}`) : reply({ content: 'Limit ho gayi.' });
  };
  const texts = [];
  const out = await runToolLoop(base(fetchFn, { tools: makeTools(), onText: t => texts.push(t), maxSteps: 2 }));
  assert.equal(out.steps, 2);
  assert.equal(bodies.length, 3);
  assert.equal(bodies[2].tools, undefined);
  assert.deepEqual(texts, ['Limit ho gayi.']);
});

test('onStep reports model, status and the tool names (no content)', async () => {
  const steps = [];
  const answers = [toolCall('list_dir', { path: '~' }), reply({ content: 'ok' })];
  await runToolLoop(base(async () => answers.shift(), { tools: makeTools(), onText: () => {}, onStep: s => steps.push(s) }));
  assert.deepEqual(steps.map(s => [s.step, s.model, s.status, s.calls.join(',')]), [[0, 'main-model', 200, 'list_dir'], [1, 'main-model', 200, '']]);
  assert.ok(steps.every(s => typeof s.ms === 'number'));
});
