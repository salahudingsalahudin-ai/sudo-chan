// integrate6 review: things that only break when planner + local-wake + installer-release are combined.
// Pure checks plus a few static wiring checks; nothing here touches the network, the real app data folder or Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalAI, TOOLS_PROMPT, buildSystemPrompt, buildToolsPrompt } from '../dist/main/local-ai.js';
import { PLANNER_TOOL_NAMES, wantsPlannerTools, withoutPlannerTools } from '../src/main/tools/tool-gate.ts';
import { createRegistry, toDefinitions } from '../src/main/tools/registry.ts';
import { createNoteSpecs, createReminderSpecs, createTaskSpecs } from '../src/main/tools/extra-tools.ts';
import * as policy from '../src/main/tools/policy.ts';
import { CHANNELS } from '../src/shared/types.ts';
import { DEFAULT_SETTINGS, validSettings } from '../src/shared/validation.ts';
import { mergeSettings, changedSettings } from '../src/shared/mic-control.ts';

const here = dirname(fileURLToPath(import.meta.url));
const read = file => readFileSync(join(here, file), 'utf8');
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content });

// ------------------------------------------------------------------ 1. settings that three branches added
test('every Settings field the Settings page can edit is in the unsaved-changes test AND the re-sync dependency list', () => {
  const types = read('../src/shared/types.ts');
  const iface = /export interface Settings \{([\s\S]*?)\n\}/.exec(types)[1];
  const keys = [...iface.matchAll(/^  (\w+)\??:/gm)].map(m => m[1]);
  assert.ok(keys.includes('localWake') && keys.includes('localWakeSensitivity') && keys.includes('updateCheckEnabled'));
  // Fields no screen edits (no UI reads or writes them anywhere in src/renderer).
  const unused = ['sttProvider', 'sttLanguage', 'ttsVoice', 'micDeviceId', 'vadSensitivity', 'pushToTalk'];
  const renderer = ['App.tsx', 'LocalWakeSettings.tsx', 'UpdateSettings.tsx', 'AzureVoiceSettings.tsx'].map(f => read(`../src/renderer/${f}`)).join('\n');
  for (const key of unused) assert.equal(new RegExp(`\\b${key}\\b`).test(renderer), false, `${key} is now used by the UI: remove it from the unused list and wire it`);
  const app = read('../src/renderer/App.tsx');
  const dirty = /const dirty = ([\s\S]*?);\n  useEffect\(\(\) => setSettings\(state\.settings\), \[([\s\S]*?)\]\);/.exec(app);
  assert.ok(dirty, 'dirty/useEffect block not found');
  for (const key of keys.filter(k => !unused.includes(k))) {
    assert.match(dirty[1], new RegExp(`settings\\.${key}\\b`), `${key} missing from the unsaved-changes comparison`);
    assert.match(dirty[2], new RegExp(`state\\.settings\\.${key}\\b`), `${key} missing from the re-sync dependency list`);
  }
});

test('new settings: defaults, patch merge from other windows, and rejection of bad values', () => {
  assert.equal(DEFAULT_SETTINGS.localWake, 'off');
  assert.equal(DEFAULT_SETTINGS.localWakeSensitivity, 0.5);
  assert.equal(DEFAULT_SETTINGS.updateCheckEnabled, true);
  // The mic dot sends only { wakeWordEnabled }; the new fields must survive the merge.
  const current = { ...DEFAULT_SETTINGS, localWake: 'strict', localWakeSensitivity: 0.8, updateCheckEnabled: false };
  const merged = mergeSettings(current, { wakeWordEnabled: false });
  assert.equal(merged.localWake, 'strict');
  assert.equal(merged.localWakeSensitivity, 0.8);
  assert.equal(merged.updateCheckEnabled, false);
  assert.equal(validSettings(merged), true);
  // The Settings form sends only what changed, including the new fields.
  assert.deepEqual(changedSettings(current, { ...current, localWake: 'assist', updateCheckEnabled: true }), { localWake: 'assist', updateCheckEnabled: true });
  for (const bad of [{ localWake: 'maybe' }, { localWakeSensitivity: 2 }, { localWakeSensitivity: Number.NaN }, { updateCheckEnabled: 'yes' }]) {
    assert.equal(validSettings({ ...DEFAULT_SETTINGS, ...bad }), false, JSON.stringify(bad));
    assert.equal(validSettings(mergeSettings(DEFAULT_SETTINGS, bad)), false, 'a bad patch is refused after merging too');
  }
  // A settings file written before these branches (fields missing) is still valid.
  const { localWake, localWakeSensitivity, updateCheckEnabled, ...old } = DEFAULT_SETTINGS;
  assert.equal(validSettings(old), true);
});

// ------------------------------------------------------------------ 2. IPC surface of the three branches
test('IPC: unique channel keys and values, each registered once, preload covers every renderer-facing channel', () => {
  const body = /export const CHANNELS = \{([\s\S]*?)\} as const/.exec(read('../src/shared/types.ts'))[1];
  const pairs = [...body.matchAll(/(\w+):\s*'([^']+)'/g)];
  const keys = pairs.map(p => p[1]), values = pairs.map(p => p[2]);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(values).size, values.length);
  for (const name of ['tasksList', 'tasksAdd', 'tasksAct', 'tasksState', 'localWakeGet', 'localWakeSave', 'localWakeDelete', 'updateNotice']) assert.ok(name in CHANNELS, name);
  const main = read('../src/main/index.ts');
  const registered = [...main.matchAll(/\n  (?:handle|ipcMain\.on|ipcMain\.handle)\(CHANNELS\.(\w+),/g)].map(m => m[1]);
  assert.equal(new Set(registered).size, registered.length, 'a channel is registered twice');
  const preload = read('../src/preload/index.ts');
  for (const name of ['tasksList', 'tasksAdd', 'tasksAct', 'tasksState', 'localWakeGet', 'localWakeSave', 'localWakeDelete', 'updateNotice']) assert.match(preload, new RegExp(`CHANNELS\\.${name}\\b`), `preload lacks ${name}`);
  assert.match(main, /handle\(CHANNELS\.localWakeGet,[^\n]*\['overlay', 'settings'\]\);/);
  assert.match(main, /handle\(CHANNELS\.localWakeSave,[\s\S]*?\}, 'settings'\);/);
  assert.match(main, /handle\(CHANNELS\.localWakeDelete,[\s\S]*?\}, 'settings'\);/);
  assert.match(main, /handle\(CHANNELS\.tasksList,[^\n]*'chat'\);/);
  assert.match(main, /handle\(CHANNELS\.updateNotice,[^\n]*'settings'\);/);
});

test('startup: the update timer, the lazy stores and the planner never run in a smoke run or block start()', () => {
  const main = read('../src/main/index.ts');
  assert.match(main, /function startUpdateChecks\(\): void \{\s*[^\n]*\n\s*if \(smokeTest\) return;/);
  assert.match(main, /function localWake\(\): LocalWakeFile \{\s*localWakeFile \?\?= new LocalWakeFile/);
  assert.match(main, /function tasksService\(\): TaskService \{\s*taskService \?\?= new TaskService/);
  const start = /async function start\(\) \{([\s\S]*?)\n\}\n/.exec(main)[1];
  assert.equal(/safeStorage|isEncryptionAvailable/.test(start.replace(/\/\/.*$/gm, '')), false);
  assert.equal(/tasksService\(\)|localWake\(\)\.|tools\(\)/.test(start), false, 'start() must not open the tasks/local-wake files or build the tool runtime');
});

// ------------------------------------------------------------------ 3. tool prompt / token budget
function allSpecs() {
  const base = createRegistry(policy, { home: '/tmp', runProgram: async () => ({}), openDetached: async () => ({}) });
  return [...base, ...createNoteSpecs({}), ...createReminderSpecs({}, Date.now, undefined), ...createTaskSpecs({}, {}, () => 'chat')];
}
const fullRuntime = (log = []) => ({ definitions: toDefinitions(allSpecs()), execute: async (name, args) => { log.push(name); return 'ok'; } });

test('tool gate: planner tools are offered for task/reminder/note talk in English, Roman Urdu and Urdu, not for file or chat talk', () => {
  const yes = [
    'aaj mera kya kaam hai', 'ye kaam list mein daal do: bijli ka bill', 'pehla kaam khatam ho gaya', 'mera agla kaam utha lo',
    'remind me in 10 minutes to stretch', 'kal 5 baje yaad dila dena', 'save a note about the meeting', 'add a task to call Ali tomorrow',
    'what is on my plan today?', 'mera plan batao', 'مجھے کل کا کام بتاؤ', 'مجھے یاد دلانا', 'ایک نوٹ لکھو',
  ];
  for (const text of yes) assert.equal(wantsPlannerTools([user(text)]), true, text);
  const no = [
    'mere computer ki info do', 'read ~/main.py and explain the loop', 'package.json mein version kya hai', 'open https://example.com',
    'run ls in my downloads folder', 'hello, how are you?', 'Python mein dictionary se key delete karne ka tareeqa batao',
  ];
  for (const text of no) assert.equal(wantsPlannerTools([user(text)]), false, text);
});

test('tool gate: a short follow-up inherits the topic from the exchange right before it, but not from older turns', () => {
  const talk = [user('kal 5 baje meeting ka task add karo'), assistant('Add kar diya.'), user('haan theek hai')];
  assert.equal(wantsPlannerTools(talk), true);
  const old = [user('kal 5 baje meeting ka task add karo'), assistant('Add kar diya.'), user('package.json dikhao'), assistant('Yeh raha.'), user('aur version?')];
  assert.equal(wantsPlannerTools(old), false);
  assert.equal(wantsPlannerTools([{ role: 'system', content: 'task note reminder' }, user('hello')]), false, 'system text never counts');
});

test('tool gate: withoutPlannerTools drops exactly the 13 notes/reminders/tasks tools, keeps execute, and never returns an empty list', async () => {
  const log = [];
  const gated = withoutPlannerTools(fullRuntime(log));
  const names = gated.definitions.map(d => d.function.name);
  assert.deepEqual(names, ['read_file', 'list_dir', 'search_files', 'write_file', 'append_file', 'edit_file', 'run_command', 'open_url', 'open_app', 'get_system_info']);
  assert.equal(PLANNER_TOOL_NAMES.size, 13);
  for (const name of PLANNER_TOOL_NAMES) assert.ok(allSpecs().some(s => s.name === name), `${name} is a real tool`);
  // Even if the model calls a hidden tool, the real runtime (policy, approvals, audit) still executes it.
  assert.equal(await gated.execute('add_task', { title: 'x' }, 'c1', new AbortController().signal), 'ok');
  assert.deepEqual(log, ['add_task']);
  const onlyPlanner = { definitions: fullRuntime().definitions.filter(d => PLANNER_TOOL_NAMES.has(d.function.name)), execute: async () => '' };
  assert.equal(withoutPlannerTools(onlyPlanner).definitions.length, 13);
});

test('tool prompt: the default text is unchanged, the short text drops the organiser lines and saves tokens', () => {
  assert.equal(TOOLS_PROMPT, buildToolsPrompt(true));
  const short = buildToolsPrompt(false);
  for (const word of ['add_task', 'plan_today', 'save_note', 'set_reminder', 'To-do help']) {
    assert.ok(TOOLS_PROMPT.includes(word), word);
    assert.equal(short.includes(word), false, word);
  }
  for (const word of ['read_file', 'edit_file', 'run_command', 'NEVER claim you read', 'NOT by voice']) assert.ok(short.includes(word), word);
  assert.ok(TOOLS_PROMPT.length - short.length > 900, 'the organiser lines are about 1,000 characters');
  assert.ok(buildSystemPrompt({ tools: true }).includes(TOOLS_PROMPT), 'default stays complete');
  assert.equal(buildSystemPrompt({ tools: true, plannerTools: false }).includes('add_task'), false);
  // Definitions: the 13 organiser tools are about 4,000 characters (~1,100 tokens) of every request.
  const all = JSON.stringify(fullRuntime().definitions).length, gated = JSON.stringify(withoutPlannerTools(fullRuntime()).definitions).length;
  assert.ok(all - gated > 3500, `saved ${all - gated} characters`);
});

test('chat: an unrelated tool turn sends only the file/command tools, a planner turn sends everything', async () => {
  const cloud = { provider: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'qwen/qwen3.8-27b', apiKey: 'test-key' };
  const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const run = async text => {
    const bodies = [];
    const ai = new LocalAI(async (url, init) => { bodies.push(JSON.parse(init.body)); return reply({ choices: [{ message: { content: 'ok' } }] }); });
    await ai.stream('', [user(text)], new AbortController().signal, () => {}, { mode: 'cloud', cloud, tools: fullRuntime() });
    return bodies[0];
  };
  const plain = await run('mere computer ki info do');
  assert.equal(plain.tools.length, 10);
  assert.equal(plain.messages[0].content.includes('add_task'), false);
  assert.match(plain.messages[0].content, /\[TOOLS ARE ON\]/);
  const planner = await run('aaj mera kya kaam hai');
  assert.equal(planner.tools.length, 23);
  assert.match(planner.messages[0].content, /plan_today/);
});

// ------------------------------------------------------------------ 4. packaging still covers the new source folders
test('packaging: the electron-builder file list ships dist (which now holds local-wake, tasks, update-check) and no source, tests or config', () => {
  const pkg = JSON.parse(read('../package.json'));
  assert.ok(pkg.build.files.includes('dist/**/*'));
  assert.equal(pkg.build.files.some(f => /^(src|tests|scripts)\b/.test(f)), false);
  assert.ok(pkg.build.files.includes('!**/config.json'));
  const tsconfig = JSON.parse(read('../tsconfig.node.json'));
  assert.ok(tsconfig.include.includes('src/shared'), 'src/shared (incl. local-wake/) is compiled into dist/shared');
  assert.equal(pkg.main, 'dist/main/bootstrap.js');
});
