import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, readdirSync, chmodSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as policy from '../src/main/tools/policy.ts';
import { ApprovalManager } from '../src/main/tools/approval.ts';
import { AuditLog, redact } from '../src/main/tools/audit.ts';
import { createRegistry, toDefinitions, editDiffText, READ_PAGE_BYTES } from '../src/main/tools/registry.ts';
import { ToolRuntime } from '../src/main/tools/runtime.ts';
import { runToolLoop, wantsWriteBudget } from '../src/main/tools/agent-loop.ts';
import { describeToolCall, formatToolTrace, MAX_TRACE_CHARS } from '../src/main/tools/trace.ts';
import { LocalAI, TOOLS_PROMPT, buildSystemPrompt } from '../dist/main/local-ai.js';
import { ChatSession } from '../dist/main/chat-session.js';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'sudo-edit-')));
mkdirSync(join(home, '.ssh'));
writeFileSync(join(home, '.ssh', 'id_rsa'), 'PRIVATE');
writeFileSync(join(home, '.env'), 'KEY=abc');
mkdirSync(join(home, 'docs'));
symlinkSync(join(home, '.ssh'), join(home, 'docs', 'sneaky'));
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sudo-edit-out-')));
writeFileSync(join(outside, 'x.txt'), 'one two');

const live = new AbortController().signal;
const tick = () => new Promise(r => setTimeout(r, 120));
function makeRuntime() {
  const cards = [];
  const audit = [];
  const specs = createRegistry(policy, { home, runProgram: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: false }), openDetached: async () => ({ ok: true }) });
  const approval = new ApprovalManager({ emit: r => { cards.push(r); return true; }, setTimer: () => ({}), clearTimer: () => {} });
  const runtime = new ToolRuntime({ specs, definitions: toDefinitions(specs), approval, audit: { record: e => audit.push(e) }, isEnabled: () => true, redact });
  return { runtime, cards, audit, approval };
}
const put = (name, text) => { writeFileSync(join(home, 'docs', name), text); return join(home, 'docs', name); };

// ------------------------------------------------------------------ edit_file
test('edit_file: unique match shows a before/after card, Deny leaves the file untouched, Allow edits it', async () => {
  const { runtime, cards, approval, audit } = makeRuntime();
  const file = put('a.py', 'import os\n\ndef hello():\n    print("hi")\n\nhello()\n');
  const args = { path: '~/docs/a.py', old_text: '    print("hi")', new_text: '    print("hello world")\n    return 1' };
  const denied = runtime.execute('edit_file', args, 'e1', live);
  await tick();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].tool, 'edit_file');
  assert.equal(cards[0].risk, 'write');
  assert.equal(cards[0].title, 'Edit a file');
  assert.ok(cards[0].detail.startsWith(file));
  assert.match(cards[0].detail, /line 4 · -1 \/ \+2 lines/);
  assert.match(cards[0].detail, /^- {5}print\("hi"\)$/m);
  assert.match(cards[0].detail, /^\+ {5}print\("hello world"\)$/m);
  assert.equal(cards[0].detail.includes('import os'), false, 'unchanged lines of the file are not shown');
  approval.respond(cards[0].id, 'deny');
  assert.match(await denied, /denied/);
  assert.equal(readFileSync(file, 'utf8'), 'import os\n\ndef hello():\n    print("hi")\n\nhello()\n');

  const allowed = runtime.execute('edit_file', args, 'e2', live);
  await tick();
  approval.respond(cards[1].id, 'allow');
  assert.match(await allowed, /^OK: edited .*a\.py/);
  assert.equal(readFileSync(file, 'utf8'), 'import os\n\ndef hello():\n    print("hello world")\n    return 1\n\nhello()\n');
  assert.ok(audit.some(e => e.tool === 'edit_file' && e.status === 'ok' && /edit_file .*a\.py/.test(e.summary)));
  assert.ok(audit.some(e => e.tool === 'edit_file' && e.status === 'denied'));
  assert.equal(JSON.stringify(audit).includes('hello world'), false, 'audit never carries file contents');
});

test('edit_file: zero matches and several matches are clear errors, no card, file unchanged', async () => {
  const { runtime, cards } = makeRuntime();
  const file = put('dup.txt', 'foo\nbar\nfoo\nbaz\nfoo\n');
  const none = await runtime.execute('edit_file', { path: '~/docs/dup.txt', old_text: 'nothing here', new_text: 'x' }, 'e1', live);
  assert.match(none, /^Blocked: old_text was not found/);
  assert.match(none, /read_file/);
  const many = await runtime.execute('edit_file', { path: '~/docs/dup.txt', old_text: 'foo', new_text: 'x' }, 'e2', live);
  assert.match(many, /matches 3 places \(lines 1, 3, 5\)/);
  assert.match(many, /neighbouring lines/);
  assert.match(await runtime.execute('edit_file', { path: '~/docs/dup.txt', old_text: '', new_text: 'x' }, 'e3', live), /must not be empty/);
  assert.match(await runtime.execute('edit_file', { path: '~/docs/dup.txt', old_text: 'foo', new_text: 'foo' }, 'e4', live), /identical/);
  assert.match(await runtime.execute('edit_file', { path: '~/docs/missing.txt', old_text: 'a', new_text: 'b' }, 'e5', live), /does not exist/);
  assert.match(await runtime.execute('edit_file', { path: '~/docs/dup.txt', old_text: 'a' }, 'e6', live), /required/);
  assert.equal(cards.length, 0);
  assert.equal(readFileSync(file, 'utf8'), 'foo\nbar\nfoo\nbaz\nfoo\n');
});

test('edit_file: same path policy as write_file (secrets, outside home, symlinks) and always needs a card', async () => {
  const { runtime, cards } = makeRuntime();
  for (const path of ['~/.ssh/id_rsa', '~/.env', '~/.config/Sudo-chan/config.json', '/etc/hosts', join(outside, 'x.txt'), '~/docs/sneaky/id_rsa']) {
    assert.match(await runtime.execute('edit_file', { path, old_text: 'a', new_text: 'b' }, 'b', live), /^Blocked/, path);
  }
  assert.equal(cards.length, 0);
  assert.equal(readFileSync(join(home, '.ssh', 'id_rsa'), 'utf8'), 'PRIVATE');
  assert.equal(readFileSync(join(outside, 'x.txt'), 'utf8'), 'one two');
});

test('edit_file: atomic write keeps the file mode, leaves no temp files, and re-checks after approval', async () => {
  const { runtime, cards, approval } = makeRuntime();
  const file = put('run.sh', '#!/bin/sh\necho one\n');
  chmodSync(file, 0o750);
  const before = readdirSync(join(home, 'docs')).sort();
  const pending = runtime.execute('edit_file', { path: '~/docs/run.sh', old_text: 'echo one', new_text: 'echo two' }, 'e1', live);
  await tick();
  approval.respond(cards[0].id, 'allow');
  assert.match(await pending, /^OK/);
  assert.equal(readFileSync(file, 'utf8'), '#!/bin/sh\necho two\n');
  assert.equal(statSync(file).mode & 0o777, 0o750);
  assert.deepEqual(readdirSync(join(home, 'docs')).sort(), before, 'no temp file left behind');

  // The file changes while the card is open: the stale edit must not be applied blindly.
  const stale = runtime.execute('edit_file', { path: '~/docs/run.sh', old_text: 'echo two', new_text: 'echo three' }, 'e2', live);
  await tick();
  writeFileSync(file, '#!/bin/sh\necho changed\n');
  approval.respond(cards[1].id, 'allow');
  assert.match(await stale, /changed while waiting/);
  assert.equal(readFileSync(file, 'utf8'), '#!/bin/sh\necho changed\n');
});

test('edit_file: a CRLF file can be edited with LF-only text and keeps its line endings', async () => {
  const { runtime, cards, approval } = makeRuntime();
  const file = put('win.txt', 'a\r\nb\r\nc\r\n');
  const pending = runtime.execute('edit_file', { path: '~/docs/win.txt', old_text: 'a\nb', new_text: 'a\nB\nB2' }, 'e1', live);
  await tick();
  approval.respond(cards[0].id, 'allow');
  assert.match(await pending, /^OK/);
  assert.equal(readFileSync(file, 'utf8'), 'a\r\nB\r\nB2\r\nc\r\n');
});

test('edit_file: diff text shows only the changed lines, shortens long blocks, and the tool is offered to the model', () => {
  const d = editDiffText('keep\nold1\nold2\nkeep2', 'keep\nnew1\nkeep2', 10);
  assert.equal(d.text, '- old1\n- old2\n+ new1');
  assert.deepEqual([d.added, d.removed, d.firstLine], [1, 2, 11]);
  const many = editDiffText(Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'), 'x', 1);
  assert.match(many.text, /… \(22 more lines\)/);
  assert.ok(many.text.split('\n').length <= 8 + 1 + 1 + 1);
  assert.ok(toDefinitions(createRegistry(policy, { home, runProgram: async () => ({}), openDetached: async () => ({}) })).some(d => d.function.name === 'edit_file'));
});

// ------------------------------------------------------------------ read_file paging
test('read_file: small files come back whole, with no footer', async () => {
  const { runtime } = makeRuntime();
  put('small.txt', 'one\ntwo\nthree\n');
  assert.equal(await runtime.execute('read_file', { path: '~/docs/small.txt' }, 'r1', live), 'one\ntwo\nthree\n');
});

test('read_file: start_line / end_line return just that range, errors are clear', async () => {
  const { runtime } = makeRuntime();
  put('lines.txt', Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const mid = await runtime.execute('read_file', { path: '~/docs/lines.txt', start_line: 10, end_line: 12 }, 'r1', live);
  assert.match(mid, /^line 10\nline 11\nline 12\n\[showed lines 10-12 of 50\. Call read_file again with start_line=13/);
  const tail = await runtime.execute('read_file', { path: '~/docs/lines.txt', start_line: 49 }, 'r2', live);
  assert.match(tail, /^line 49\nline 50\n\[showed lines 49-50 of 50; end of file/);
  assert.match(await runtime.execute('read_file', { path: '~/docs/lines.txt', start_line: 99 }, 'r3', live), /only 50 line/);
  assert.match(await runtime.execute('read_file', { path: '~/docs/lines.txt', start_line: 0 }, 'r4', live), /whole number/);
  assert.match(await runtime.execute('read_file', { path: '~/docs/lines.txt', start_line: 5, end_line: 2 }, 'r5', live), /smaller than start_line/);
  assert.equal((await runtime.execute('read_file', { path: '~/docs/lines.txt', start_line: '3', end_line: '3' }, 'r6', live)).split('\n')[0], 'line 3');
});

test('read_file: a big file is cut at ~6 KB with a "call again with start_line=N" footer that pages to the end', async () => {
  const { runtime } = makeRuntime();
  const lines = Array.from({ length: 1000 }, (_, i) => `row ${i + 1} ${'x'.repeat(40)}`);
  put('big.txt', lines.join('\n') + '\n');
  const first = await runtime.execute('read_file', { path: '~/docs/big.txt' }, 'r1', live);
  assert.ok(Buffer.byteLength(first) < READ_PAGE_BYTES + 200, `page was ${Buffer.byteLength(first)} bytes`);
  const m = /\[truncated: showed lines 1-(\d+) of 1000\. Call read_file again with start_line=(\d+) to continue\.\]$/.exec(first);
  assert.ok(m, first.slice(-200));
  assert.equal(Number(m[2]), Number(m[1]) + 1);
  const second = await runtime.execute('read_file', { path: '~/docs/big.txt', start_line: Number(m[2]) }, 'r2', live);
  assert.ok(second.startsWith(`row ${m[2]} `));
  // A huge single line cannot blow the page size either.
  put('one-line.txt', 'y'.repeat(100_000));
  assert.ok(Buffer.byteLength(await runtime.execute('read_file', { path: '~/docs/one-line.txt' }, 'r3', live)) < READ_PAGE_BYTES + 300);
  // Secrets stay blocked with the new parameters.
  assert.match(await runtime.execute('read_file', { path: '~/.env', start_line: 1 }, 'r4', live), /^Blocked/);
});

// ------------------------------------------------------------------ prompt, token budget
test('prompt: prefers edit_file for changes, write_file only for new files, pages big reads, explains the tools note', () => {
  assert.match(TOOLS_PROMPT, /edit_file/);
  assert.match(TOOLS_PROMPT, /write_file ONLY for a new file/);
  assert.match(TOOLS_PROMPT, /start_line/);
  assert.match(TOOLS_PROMPT, /\[tools: \.\.\.\]/);
  assert.ok(buildSystemPrompt({ tools: true, model: 'm', provider: 'Groq' }).includes('edit_file'));
  assert.equal(buildSystemPrompt({ model: 'm', provider: 'Groq' }).includes('edit_file'), false);
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const toolCall = (name, args) => ({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
const answer = text => ({ choices: [{ message: { content: text } }] });
const fakeTools = (reply = 'ok') => ({ definitions: [{ type: 'function', function: { name: 'read_file', description: 'x', parameters: { type: 'object', properties: {} } } }], execute: async () => reply });
function loop(userText, replies, extra = {}) {
  const bodies = [];
  const options = {
    fetchFn: async (url, init) => { bodies.push(JSON.parse(init.body)); const r = replies.shift(); return json(r.body ?? r, r.status ?? 200); },
    endpoint: 'https://x/v1', apiKey: 'k', model: 'main', messages: [{ role: 'system', content: 's' }, { role: 'user', content: userText }],
    tools: fakeTools(), signal: live, onText: () => {}, sleep: async () => {}, maxTokens: 950, writeMaxTokens: 1900, ...extra,
  };
  return { bodies, run: () => runToolLoop(options) };
}

test('max_tokens: plain tool answers keep 950; a turn that may write/edit gets 1900; 429 fallback keeps the same body', async () => {
  assert.equal(wantsWriteBudget('mere computer ki info do', ['list_dir']), false);
  assert.equal(wantsWriteBudget('a.py mein fix kar do', []), true);
  assert.equal(wantsWriteBudget('ek script banao', []), true);
  assert.equal(wantsWriteBudget('what is in it', ['read_file']), true);

  const plain = loop('mere home mein kya hai?', [answer('Kuch nahi.')]);
  await plain.run();
  assert.equal(plain.bodies[0].max_tokens, 950);

  const edit = loop('a.py mein hello ko hi se badal do', [toolCall('read_file', { path: '~/a.py' }), toolCall('edit_file', { path: '~/a.py', old_text: 'a', new_text: 'b' }), answer('Ho gaya.')]);
  await edit.run();
  assert.deepEqual(edit.bodies.map(b => b.max_tokens), [1900, 1900, 1900]);

  const readOnly = loop('is file mein kya likha hai', [toolCall('list_dir', {}), answer('Kuch nahi.')]);
  await readOnly.run();
  assert.deepEqual(readOnly.bodies.map(b => b.max_tokens), [950, 950]);

  const limited = loop('ek script banao', [{ status: 429, body: {} }, { status: 429, body: {} }, { status: 429, body: {} }, answer('Done.')], { fallbackModel: 'backup' });
  await limited.run();
  assert.deepEqual(limited.bodies.map(b => b.model), ['main', 'main', 'main', 'backup']);
  assert.deepEqual(limited.bodies.map(b => b.max_tokens), [1900, 1900, 1900, 1900]);
});

// ------------------------------------------------------------------ history trace
test('trace: paths and verbs only, failures named, capped, never contents', () => {
  assert.equal(describeToolCall('read_file', { path: '~/a.py', start_line: 1, end_line: 80 }, 'secret body'), 'read ~/a.py (lines 1-80)');
  assert.equal(describeToolCall('edit_file', { path: '~/a.py', old_text: 'TOPSECRET', new_text: 'x' }, 'OK: edited'), 'edited ~/a.py');
  assert.equal(describeToolCall('edit_file', { path: '~/a.py', old_text: 'a', new_text: 'b' }, 'The user denied this action. It was NOT done.'), 'edit of ~/a.py denied by user');
  assert.equal(describeToolCall('write_file', { path: '~/n.txt', content: 'PASSWORD=123' }, 'OK: wrote 12 bytes'), 'wrote ~/n.txt');
  assert.equal(describeToolCall('run_command', { program: 'python3', args: ['a.py', '--token', 'sk-123'] }, 'Exit code: 0\n--- stdout ---\nhi'), 'ran python3 (exit 0)');
  assert.equal(describeToolCall('save_note', { title: 't', text: 'private' }, 'ok'), null);
  const text = formatToolTrace(['read ~/a.py (lines 1-80)', 'edited ~/a.py']);
  assert.equal(text, '[tools: read ~/a.py (lines 1-80); edited ~/a.py]');
  const long = formatToolTrace(Array.from({ length: 40 }, (_, i) => `edited ~/folder/file-number-${i}.txt`));
  assert.ok(long.length <= MAX_TRACE_CHARS);
  assert.ok(long.includes('file-number-39'), 'newest entries are kept');
  assert.equal(formatToolTrace([]), '');
});

test('history: the next turn sees what the tools did; the note is not in the chat bubble or spoken text', async () => {
  const sent = [];
  const replies = [
    toolCall('read_file', { path: '~/docs/a.py', start_line: 1, end_line: 80 }),
    toolCall('edit_file', { path: '~/docs/a.py', old_text: 'SECRETLINE', new_text: 'x' }),
    answer('Maine a.py badal di.'),
    answer('Chalane ke liye python3 a.py chalayen.'),
  ];
  const ai = new LocalAI(async (url, init) => { sent.push(JSON.parse(init.body)); return json(replies.shift()); });
  const session = new ChatSession(ai, () => {});
  const cloud = { provider: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'qwen/qwen3.8-27b', apiKey: 'test-key' };
  const tools = {
    definitions: [{ type: 'function', function: { name: 'read_file', description: 'x', parameters: { type: 'object', properties: {} } } }, { type: 'function', function: { name: 'edit_file', description: 'x', parameters: { type: 'object', properties: {} } } }],
    execute: async name => (name === 'read_file' ? 'FILE CONTENT SECRETLINE' : 'OK: edited ~/docs/a.py'),
  };
  const wait = async () => { for (let i = 0; i < 100 && session.snapshot().busy; i++) await tick(); };
  assert.deepEqual(session.send('a.py ki pehli line theek karo', '', { mode: 'cloud', cloud, tools, voice: true }), { ok: true });
  await wait();
  const reply = session.snapshot().messages[1];
  assert.equal(reply.text, 'Maine a.py badal di.');
  assert.equal(reply.spoken, 'Maine a.py badal di.');
  assert.equal(reply.text.includes('[tools'), false);

  assert.deepEqual(session.send('ab isko run karo', '', { mode: 'cloud', cloud, tools, voice: true }), { ok: true });
  await wait();
  const history = sent[3].messages.filter(m => m.role !== 'system');
  const prior = history.find(m => m.role === 'assistant');
  assert.equal(prior.content, 'Maine a.py badal di.\n[tools: read ~/docs/a.py (lines 1-80); edited ~/docs/a.py]');
  assert.equal(JSON.stringify(sent[3].messages).includes('SECRETLINE'), false, 'file contents never enter the history');
  const snapshot = JSON.stringify(session.snapshot());
  assert.equal(snapshot.includes('[tools'), false, 'not part of the visible chat state');
  session.clear();
});

test('history: a plain chat turn adds no tools note', async () => {
  const sent = [];
  const replies = [answer('Salam!'), answer('Theek hoon.')];
  const ai = new LocalAI(async (url, init) => { sent.push(JSON.parse(init.body)); return json(replies.shift()); });
  const session = new ChatSession(ai, () => {});
  const cloud = { provider: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'qwen/qwen3.8-27b', apiKey: 'test-key' };
  const opts = { mode: 'cloud', cloud, tools: fakeTools(), voice: true };
  session.send('salam', '', opts);
  for (let i = 0; i < 100 && session.snapshot().busy; i++) await tick();
  session.send('kaise ho', '', opts);
  for (let i = 0; i < 100 && session.snapshot().busy; i++) await tick();
  assert.equal(JSON.stringify(sent[1].messages).includes('[tools:'), false);
});
