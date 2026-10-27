// First-run setup wizard: the pure state machine, first-run detection ("an existing user never sees it"), the copy tables of both languages,
// the settings that carry its progress, and static wiring checks (IPC authorisation, no network in the page, no key echo).
// No Electron, no microphone, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  KEY_PAGE, KEY_PROVIDERS, MIC_HEARD_LEVEL, ONBOARDING_LANGUAGES, ONBOARDING_STEPS, PRIVACY_ALL_OFF, SKIPPABLE_STEPS, WIZARD_COPY,
  cleanPastedKey, copyFor, fillCopy, initialWizardState, isLastStep, isOnboardingLanguage, isOnboardingStep, keyErrorKind, keyLooksUsable, levelFromRms,
  localWakeChoice, mascotFor, micErrorKind, micTestVerdict, micTipKey, persistPatch, privacyFromSettings, privacyPatch, restartPatch,
  shouldShowOnboarding, stepIndex, summaryLines, wizardProgress, wizardReducer,
} from '../src/shared/onboarding.ts';
import { DEFAULT_SETTINGS, validSettings } from '../src/shared/validation.ts';
import { CHANNELS } from '../src/shared/types.ts';
import { changedSettings, mergeSettings } from '../src/shared/mic-control.ts';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const fresh = () => initialWizardState(undefined);
const run = (state, ...actions) => actions.reduce(wizardReducer, state);

// ------------------------------------------------------------------ steps
test('the wizard has seven steps in the planned order, and only the middle five can be skipped', () => {
  assert.deepEqual([...ONBOARDING_STEPS], ['welcome', 'mic', 'name', 'brain', 'privacy', 'try', 'done']);
  assert.deepEqual([...SKIPPABLE_STEPS], ['mic', 'name', 'brain', 'privacy', 'try']);
  assert.equal(isOnboardingStep('mic'), true);
  assert.equal(isOnboardingStep('settings'), false);
  assert.equal(isOnboardingStep(undefined), false);
  assert.equal(isLastStep('done'), true);
  assert.equal(isLastStep('try'), false);
  assert.equal(stepIndex('privacy'), 4);
  assert.deepEqual([...ONBOARDING_LANGUAGES], ['en', 'roman-ur']);
  assert.equal(isOnboardingLanguage('roman-ur'), true);
  assert.equal(isOnboardingLanguage('ur'), false);
});

// ------------------------------------------------------------------ first-run detection
test('a brand new install (no config file yet) shows the wizard', () => {
  assert.equal(shouldShowOnboarding({ configExisted: false, settings: undefined, hasSavedKeys: false, smokeRun: false }), true);
  assert.equal(shouldShowOnboarding({ configExisted: false, settings: { ...DEFAULT_SETTINGS }, hasSavedKeys: false, smokeRun: false }), true);
});

test('an existing user never sees it: config file present, settings saved, keys saved, providers saved', () => {
  // the owner: config.json exists, default-looking settings, keys saved
  assert.equal(shouldShowOnboarding({ configExisted: true, settings: { ...DEFAULT_SETTINGS }, hasSavedKeys: true, smokeRun: false }), false);
  // every user of an older version: a config file, settings without any onboarding field
  const older = { ...DEFAULT_SETTINGS };
  delete older.onboardingDone; delete older.onboardingLanguage;
  assert.equal(shouldShowOnboarding({ configExisted: true, settings: older, hasSavedKeys: false, smokeRun: false }), false);
  assert.equal(shouldShowOnboarding({ configExisted: true, settings: undefined, hasSavedKeys: false, smokeRun: false }), false, 'config present but settings unreadable: still an existing user');
  // keys/providers on disk without a saved wizard step: never
  assert.equal(shouldShowOnboarding({ configExisted: false, settings: undefined, hasSavedKeys: true, smokeRun: false }), false);
  assert.equal(shouldShowOnboarding({ configExisted: true, settings: { onboardingDone: false }, hasSavedKeys: true, smokeRun: false }), false);
});

test('finished or dismissed setup never comes back by itself; smoke runs never open it', () => {
  assert.equal(shouldShowOnboarding({ configExisted: false, settings: { onboardingDone: true }, hasSavedKeys: false, smokeRun: false }), false);
  assert.equal(shouldShowOnboarding({ configExisted: true, settings: { onboardingDone: true, onboardingStep: 'brain' }, hasSavedKeys: false, smokeRun: false }), false);
  assert.equal(shouldShowOnboarding({ configExisted: false, settings: undefined, hasSavedKeys: false, smokeRun: true }), false);
  assert.equal(shouldShowOnboarding({ configExisted: true, settings: { onboardingStep: 'mic' }, hasSavedKeys: false, smokeRun: true }), false);
});

test('a run that stopped halfway resumes (even after a key was saved); a bad saved step does not resume', () => {
  assert.equal(shouldShowOnboarding({ configExisted: true, settings: { onboardingDone: false, onboardingStep: 'privacy' }, hasSavedKeys: true, smokeRun: false }), true);
  assert.equal(shouldShowOnboarding({ configExisted: true, settings: { onboardingStep: 'nonsense' }, hasSavedKeys: false, smokeRun: false }), false);
});

// ------------------------------------------------------------------ resume
test('resume: the saved step and language come back; anything else starts at the welcome screen in English', () => {
  assert.deepEqual(initialWizardState({ onboardingStep: 'brain', onboardingLanguage: 'roman-ur' }), { step: 'brain', language: 'roman-ur', skipped: [], outcome: null });
  assert.deepEqual(fresh(), { step: 'welcome', language: 'en', skipped: [], outcome: null });
  assert.equal(initialWizardState({ onboardingStep: 'x', onboardingLanguage: 'fr' }).step, 'welcome');
  assert.equal(initialWizardState({ onboardingStep: 'x', onboardingLanguage: 'fr' }).language, 'en');
});

// ------------------------------------------------------------------ transitions
test('next walks welcome to done, then finishes; progress follows', () => {
  let s = fresh();
  const seen = [s.step];
  for (let i = 0; i < 6; i++) { s = run(s, { type: 'next' }); seen.push(s.step); }
  assert.deepEqual(seen, [...ONBOARDING_STEPS]);
  assert.equal(s.outcome, null);
  s = run(s, { type: 'next' });
  assert.equal(s.outcome, 'finished');
  assert.equal(s.step, 'done');
  assert.deepEqual(wizardProgress('welcome'), { index: 0, total: 7, ratio: 0 });
  assert.equal(wizardProgress('done').ratio, 1);
});

test('back goes one step and stops at the first screen', () => {
  let s = run(fresh(), { type: 'next' }, { type: 'next' });
  assert.equal(s.step, 'name');
  s = run(s, { type: 'back' });
  assert.equal(s.step, 'mic');
  s = run(s, { type: 'back' }, { type: 'back' }, { type: 'back' });
  assert.equal(s.step, 'welcome');
});

test('skip records the step and moves on; welcome and done cannot be skipped; Next on a skipped step clears the mark', () => {
  let s = run(fresh(), { type: 'skip' });
  assert.equal(s.step, 'welcome', 'welcome has nothing to skip');
  assert.deepEqual(s.skipped, []);
  s = run(s, { type: 'next' }, { type: 'skip' });
  assert.equal(s.step, 'name');
  assert.deepEqual(s.skipped, ['mic']);
  s = run(s, { type: 'back' });
  assert.equal(s.step, 'mic');
  s = run(s, { type: 'next' });
  assert.deepEqual(s.skipped, [], 'completing a step un-skips it');
  const last = run(fresh(), { type: 'goto', step: 'done' }, { type: 'skip' });
  assert.equal(last.step, 'done');
  assert.equal(last.outcome, null);
  // skipping every skippable step twice does not duplicate marks
  let all = run(fresh(), { type: 'next' });
  for (let i = 0; i < 5; i++) all = run(all, { type: 'skip' });
  assert.equal(all.step, 'done');
  assert.deepEqual(all.skipped, ['mic', 'name', 'brain', 'privacy', 'try']);
});

test('language changes the wizard copy language only and keeps the step', () => {
  let s = run(fresh(), { type: 'next' }, { type: 'language', language: 'roman-ur' });
  assert.equal(s.language, 'roman-ur');
  assert.equal(s.step, 'mic');
  assert.equal(run(s, { type: 'language', language: 'ur' }).language, 'roman-ur', 'unknown language ignored');
});

test('dismiss (Skip setup / Esc) closes with the outcome "dismissed" and freezes the machine until restart', () => {
  let s = run(fresh(), { type: 'next' }, { type: 'next' }, { type: 'dismiss' });
  assert.equal(s.outcome, 'dismissed');
  assert.equal(s.step, 'name');
  assert.deepEqual(run(s, { type: 'next' }), s);
  assert.deepEqual(run(s, { type: 'back' }), s);
  assert.deepEqual(run(s, { type: 'skip' }), s);
  const again = run(s, { type: 'restart' });
  assert.deepEqual(again, { step: 'welcome', language: 'en', skipped: [], outcome: null });
  assert.equal(run({ ...s, language: 'roman-ur' }, { type: 'restart' }).language, 'roman-ur', 'restart keeps the language');
});

test('goto only accepts a real step', () => {
  assert.equal(run(fresh(), { type: 'goto', step: 'privacy' }).step, 'privacy');
  assert.equal(run(fresh(), { type: 'goto', step: 'nope' }).step, 'welcome');
});

test('every move is persisted so closing the app halfway resumes; finishing or dismissing records onboardingDone', () => {
  const mid = run(fresh(), { type: 'next' }, { type: 'next' }, { type: 'language', language: 'roman-ur' });
  assert.deepEqual(persistPatch(mid), { onboardingStep: 'name', onboardingLanguage: 'roman-ur' });
  assert.equal(persistPatch(mid).onboardingDone, undefined, 'not done while open');
  assert.equal(persistPatch(run(mid, { type: 'dismiss' })).onboardingDone, true);
  assert.equal(persistPatch(run({ ...mid, step: 'done' }, { type: 'next' })).onboardingDone, true);
  // closing and reopening: the saved patch rebuilds the same screen
  assert.equal(initialWizardState(persistPatch(mid)).step, 'name');
  assert.deepEqual(restartPatch('roman-ur'), { onboardingDone: false, onboardingStep: 'welcome', onboardingLanguage: 'roman-ur' });
  assert.deepEqual(restartPatch(undefined), { onboardingDone: false, onboardingStep: 'welcome' });
});

// ------------------------------------------------------------------ the choices
test('privacy: everything is OFF by default (settings defaults and the wizard), and the patch writes explicit values', () => {
  assert.deepEqual(PRIVACY_ALL_OFF, { tools: false, screen: false, windowName: false });
  assert.deepEqual(privacyFromSettings(DEFAULT_SETTINGS), PRIVACY_ALL_OFF);
  assert.deepEqual(privacyFromSettings(undefined), PRIVACY_ALL_OFF);
  assert.deepEqual(privacyPatch(PRIVACY_ALL_OFF), { toolsEnabled: false, screenAssistEnabled: false, liveAwareness: 'off' });
  assert.deepEqual(privacyPatch({ tools: true, screen: false, windowName: true }), { toolsEnabled: true, screenAssistEnabled: false, liveAwareness: 'window' });
  assert.deepEqual(privacyFromSettings({ toolsEnabled: true, screenAssistEnabled: true, liveAwareness: 'window' }), { tools: true, screen: true, windowName: true });
  assert.equal(DEFAULT_SETTINGS.toolsEnabled, false);
  assert.equal(DEFAULT_SETTINGS.screenAssistEnabled, false);
  assert.equal(DEFAULT_SETTINGS.liveAwareness, 'off');
  assert.equal(DEFAULT_SETTINGS.localWake, 'off', 'the on-device name check stays off unless the person finishes the self-test and chooses it');
});

test('on-device name check turns on only after teaching, a self-test that heard her, and the person choosing it', () => {
  assert.equal(localWakeChoice({ taught: true, selfTestHeard: 2, wantsAssist: true }), 'assist');
  assert.equal(localWakeChoice({ taught: true, selfTestHeard: 0, wantsAssist: true }), 'off');
  assert.equal(localWakeChoice({ taught: false, selfTestHeard: 3, wantsAssist: true }), 'off');
  assert.equal(localWakeChoice({ taught: true, selfTestHeard: 3, wantsAssist: false }), 'off');
});

test('microphone errors become friendly categories, with the right platform tip', () => {
  assert.equal(micErrorKind('NotAllowedError'), 'denied');
  assert.equal(micErrorKind('NotFoundError'), 'no-device');
  assert.equal(micErrorKind('NotReadableError'), 'busy');
  assert.equal(micErrorKind('WeirdError'), 'unknown');
  assert.equal(micErrorKind(undefined), 'unknown');
  assert.equal(micTipKey('linux'), 'linuxTip');
  assert.equal(micTipKey('darwin'), 'macTip');
  assert.equal(micTipKey('win32'), 'winTip');
  for (const language of ONBOARDING_LANGUAGES) assert.match(copyFor(language).mic.linuxTip, /PipeWire/, 'Linux tip names PipeWire/PulseAudio');
  assert.equal(levelFromRms(0), 0);
  assert.equal(levelFromRms(NaN), 0);
  assert.equal(levelFromRms(1), 1);
  assert.ok(levelFromRms(0.02) > 0.3 && levelFromRms(0.02) < 0.4);
  assert.equal(micTestVerdict(MIC_HEARD_LEVEL), 'heard');
  assert.equal(micTestVerdict(MIC_HEARD_LEVEL / 2), 'quiet');
});

test('key helpers: pasted text is cleaned, loose shape check, errors reduce to a category that never contains the key', () => {
  assert.equal(cleanPastedKey('  "gsk_abcdefghijklmnop1234"  '), 'gsk_abcdefghijklmnop1234');
  assert.equal(cleanPastedKey('Bearer gsk_abcdefghijklmnop1234'), 'gsk_abcdefghijklmnop1234');
  assert.equal(keyLooksUsable('gsk_abcdefghijklmnop1234'), true);
  assert.equal(keyLooksUsable('short'), false);
  assert.equal(keyLooksUsable('has a space inside the key text 12345'), false);
  assert.equal(keyLooksUsable(''), false);
  assert.deepEqual([...KEY_PROVIDERS], ['groq', 'gemini']);
  assert.equal(KEY_PAGE.groq, 'console.groq.com/keys');
  assert.equal(KEY_PAGE.gemini, 'aistudio.google.com/apikey');
  assert.equal(keyErrorKind('Request failed: 401 Unauthorized'), 'invalid');
  assert.equal(keyErrorKind('HTTP 429 rate limit reached'), 'limit');
  assert.equal(keyErrorKind('fetch failed ENOTFOUND api.groq.com'), 'network');
  assert.equal(keyErrorKind('something odd'), 'unknown');
  assert.equal(keyErrorKind(undefined), 'unknown');
  const secret = 'gsk_SECRETSECRETSECRET1234';
  assert.ok(['invalid', 'network', 'limit', 'unknown'].includes(keyErrorKind(`bad key ${secret}`)), 'the category is a fixed word, never the message');
});

test('mascot faces match the step (worried when the mic is blocked, listening glow in the mic test and the live demo)', () => {
  assert.equal(mascotFor('welcome').mood, 'happy');
  assert.equal(mascotFor('mic', { micBlocked: true }).mood, 'worried');
  assert.equal(mascotFor('mic', { micListening: true }).listening, true);
  assert.equal(mascotFor('mic').listening, false);
  assert.equal(mascotFor('brain').looking, 'up');
  assert.equal(mascotFor('privacy').looking, 'down');
  assert.equal(mascotFor('try', { liveOn: true }).listening, true);
  assert.equal(mascotFor('try').listening, false);
  assert.equal(mascotFor('done').mood, 'happy');
});

test('summary lines say only what is true, in both languages', () => {
  const base = { mic: 'allowed', voiceTaught: false, brain: 'none', privacy: PRIVACY_ALL_OFF };
  for (const language of ONBOARDING_LANGUAGES) {
    const lines = summaryLines(base, language);
    assert.equal(lines.length, 6);
    assert.equal(new Set(lines).size, 6);
    assert.ok(lines.every(l => l.length > 3 && !/\{\w+\}/.test(l)), 'no unfilled placeholder');
  }
  const en = summaryLines({ mic: 'blocked', voiceTaught: true, brain: 'key', brainLabel: 'Groq', privacy: { tools: true, screen: false, windowName: true } }, 'en');
  assert.match(en[0], /not working/i);
  assert.match(en[1], /knows your voice/);
  assert.match(en[2], /Groq/);
  assert.match(en[3], /Tools: on/);
  assert.match(en[4], /off/);
  assert.match(en[5], /Knows which app/);
  assert.match(summaryLines({ ...base, brain: 'offline' }, 'en')[2], /Ollama/);
  assert.match(summaryLines({ ...base, brain: 'none' }, 'en')[2], /not set up/);
});

// ------------------------------------------------------------------ copy
function paths(value, prefix = '') {
  if (Array.isArray(value)) return [prefix + '[]', ...value.flatMap((v, i) => paths(v, `${prefix}[${i}]`))];
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => paths(v, prefix ? `${prefix}.${k}` : k));
  return [prefix];
}
function leaves(value) {
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (value && typeof value === 'object') return Object.values(value).flatMap(leaves);
  return [value];
}

test('both languages have exactly the same copy keys, no empty strings, and the same placeholders', () => {
  const en = WIZARD_COPY.en;
  const ro = WIZARD_COPY['roman-ur'];
  assert.deepEqual(paths(en), paths(ro));
  for (const language of ONBOARDING_LANGUAGES) {
    for (const text of leaves(WIZARD_COPY[language])) {
      assert.equal(typeof text, 'string');
      assert.ok(text.trim().length > 0, 'empty copy');
    }
  }
  const holders = value => leaves(value).map(t => [...t.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(','));
  assert.deepEqual(holders(en), holders(ro));
  assert.notEqual(en.welcome.title, ro.welcome.title);
  assert.equal(copyFor('xx'), en, 'an unknown language falls back to English');
});

test('copy rules: honest and calm', () => {
  for (const language of ONBOARDING_LANGUAGES) {
    const c = WIZARD_COPY[language];
    assert.equal(c.privacy.never.length, 4);
    assert.equal(c.try.cheat.length, 3);
    for (const step of ONBOARDING_STEPS) assert.ok(c.common.stepNames[step]);
    const all = leaves(c).join('\n');
    assert.doesNotMatch(all, /!!|\bamazing\b|\bawesome\b|\bsuper\b|\bhurry\b/i, 'no pushy words');
  }
  const en = WIZARD_COPY.en;
  assert.match(en.welcome.body, /2 minutes/);
  assert.match(en.welcome.body, /skip anything/);
  assert.match(en.brain.signinBadge, /Coming soon/);
  assert.match(en.brain.signinBody, /not available yet/);
  assert.match(en.brain.honest, /cannot chat or understand your voice/);
  assert.match(en.privacy.keysLinux, /NOT encrypted/);
  assert.match(WIZARD_COPY['roman-ur'].privacy.keysLinux, /NAHI/);
  assert.match(en.privacy.never.join(' '), /voice can never approve an action/i);
  assert.match(en.privacy.never.join(' '), /never saves your voice or your screenshots/i);
  assert.match(en.try.cheat[1], /ruko/);
  assert.match(en.try.cheat[2], /Double-click the mic dot/);
  assert.match(en.privacy.tools + en.privacy.toolsHint, /Every risky action asks you first/);
  assert.match(en.privacy.screen, /click Allow/);
  assert.match(en.privacy.windowName, /which app/);
  assert.match(en.privacy.windowNameHint, /window name, no picture/);
  assert.match(en.done.later, /Run setup again/);
  assert.match(en.mic.what, /only listens for her name/);
});

test('fillCopy fills named placeholders and leaves unknown ones', () => {
  assert.equal(fillCopy('Step {n} of {total}', { n: 2, total: 7 }), 'Step 2 of 7');
  assert.equal(fillCopy('Hello {who}', {}), 'Hello {who}');
});

// ------------------------------------------------------------------ settings
test('settings: onboardingDone / onboardingLanguage / onboardingStep are validated; defaults are "not done" and English', () => {
  assert.equal(DEFAULT_SETTINGS.onboardingDone, false);
  assert.equal(DEFAULT_SETTINGS.onboardingLanguage, 'en');
  assert.equal(validSettings({ ...DEFAULT_SETTINGS }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, onboardingDone: true, onboardingLanguage: 'roman-ur', onboardingStep: 'brain' }), true);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, onboardingDone: 'yes' }), false);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, onboardingLanguage: 'ur' }), false);
  assert.equal(validSettings({ ...DEFAULT_SETTINGS, onboardingStep: 'finish' }), false);
  // older saved settings (no onboarding fields) stay valid, and a patch merges onto them
  const older = { ...DEFAULT_SETTINGS };
  delete older.onboardingDone; delete older.onboardingLanguage;
  assert.equal(validSettings(older), true);
  assert.equal(validSettings(mergeSettings(older, persistPatch(run(fresh(), { type: 'next' })))), true);
  assert.deepEqual(changedSettings(older, { ...older, onboardingDone: true }), { onboardingDone: true });
});

test('the three new settings are in the Settings page "unsaved changes" test AND the re-sync list (a missing entry silently drops a setting)', () => {
  const app = strip(read('../src/renderer/App.tsx'));
  const block = /const dirty = ([\s\S]*?);\n\s*useEffect\(\(\) => setSettings\(state\.settings\), \[([\s\S]*?)\]\);/.exec(app);
  assert.ok(block, 'dirty / useEffect block found');
  for (const key of ['onboardingDone', 'onboardingLanguage', 'onboardingStep']) {
    assert.match(block[1], new RegExp(`settings\\.${key} !== state\\.settings\\.${key}`), `${key} in dirty`);
    assert.match(block[2], new RegExp(`state\\.settings\\.${key}\\b`), `${key} in the re-sync list`);
  }
  const types = read('../src/shared/types.ts');
  for (const key of ['onboardingDone', 'onboardingLanguage', 'onboardingStep']) assert.match(types, new RegExp(`${key}\\?:`));
});

// ------------------------------------------------------------------ wiring
test('IPC: setup mode and the live demo are Settings-window only, registered with handle() (authorize), and there is no new one-way handler', () => {
  const main = strip(read('../src/main/index.ts'));
  assert.equal(CHANNELS.setupMode, 'companion:setup-mode');
  assert.equal(CHANNELS.setupLive, 'companion:setup-live');
  for (const name of ['setupMode', 'setupLive']) {
    const at = main.indexOf(`handle(CHANNELS.${name},`);
    assert.ok(at > 0, `${name} handler registered`);
    const next = main.indexOf('\n  handle(CHANNELS.', at + 10);
    const nextOn = main.indexOf('\n  ipcMain.on(', at + 10);
    const end = Math.min(...[next, nextOn].filter(i => i > 0));
    const body = main.slice(at, end);
    assert.match(body, /,\s*'settings'\);\s*$/, `${name} limited to the settings window`);
  }
  const live = main.slice(main.indexOf('handle(CHANNELS.setupLive,'), main.indexOf('handle(CHANNELS.setupLive,') + 700);
  assert.match(live, /if \(!state\.setupActive\) return/, 'the live demo works only while the wizard is open');
  assert.match(live, /setLiveTarget\('overlay'\)/, 'Live Talk still starts only through setLiveTarget');
  assert.equal((main.match(/state\.voiceActiveTarget = /g) ?? []).length, 1, 'still exactly one place changes the Live Talk target');
  // no setup-related ipcMain.on
  assert.doesNotMatch(main, /ipcMain\.on\(CHANNELS\.setup/);
  const preload = read('../src/preload/index.ts');
  assert.match(preload, /setSetupMode: active => ipcRenderer\.invoke\(CHANNELS\.setupMode, active === true\)/);
  assert.match(preload, /setupLive: active => ipcRenderer\.invoke\(CHANNELS\.setupLive, active === true\)/);
});

test('first run: detection happens before the store creates config.json, the mic stays off on a fresh install, smoke runs never show it, and hiding the window records "skipped"', () => {
  const main = strip(read('../src/main/index.ts'));
  assert.match(main, /const configExisted = existsSync\(join\(configDir, 'config\.json'\)\);/);
  assert.ok(main.indexOf('const configExisted') < main.indexOf('store = new Store'), 'looked at before the store exists');
  assert.match(main, /freshInstall \? \{ \.\.\.DEFAULT_SETTINGS, wakeWordEnabled: false, onboardingStep: 'welcome' as const \}/);
  assert.match(main, /shouldShowOnboarding\(\{[\s\S]*?smokeRun: smokeTest[\s\S]*?\}\)/);
  assert.match(main, /function dismissSetup\(\)[\s\S]*?onboardingDone: true/);
  assert.match(main, /created\.on\('hide', \(\) => \{ if \(!quitting && !captureHidden\.has\(created\)\) dismissSetup\(\); \}\)/);
  assert.match(main, /if \(!active\) endSetupLive\(\)/, 'leaving setup ends a Live Talk the wizard started');
  // no new window kind
  assert.match(main, /export type WindowKind|WindowKind/);
  assert.doesNotMatch(read('../src/shared/types.ts'), /WindowKind = 'overlay' \| 'chat' \| 'settings' \| /);
});

test('the wizard page: no network, no storage of keys, key field is a password box, nothing logs a key, reuses the existing enrolment component', () => {
  const wizard = strip(read('../src/renderer/SetupWizard.tsx'));
  assert.doesNotMatch(wizard, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
  assert.doesNotMatch(wizard, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(wizard, /console\./);
  assert.match(wizard, /type="password"/);
  assert.match(wizard, /autoComplete="off"/);
  assert.match(wizard, /import \{ LocalWakeSettings \} from '\.\/LocalWakeSettings'/);
  assert.match(wizard, /<LocalWakeSettings compact/);
  // the key goes to the main process (test + store) and is cleared from the page on success; the page never re-displays it
  assert.match(wizard, /api\.saveCloudConfig\(/);
  assert.match(wizard, /setKeyText\(''\)/);
  assert.doesNotMatch(wizard, />\s*\{keyText\}|maskedKey/, 'the key is only ever the value of the password box, never printed as text');
  // the wizard cannot start Live Talk through the overlay/chat-only channel
  assert.doesNotMatch(wizard, /setVoiceActive/);
  // privacy switches start from the real settings (all OFF on a fresh install) and are saved through the normal Settings path
  assert.match(wizard, /useState<PrivacyChoices>\(\(\) => privacyFromSettings\(state\.settings\)\)/);
  assert.match(wizard, /saveSettings\(privacyPatch\(privacy\), 'settings'\)/);
  const mic = strip(read('../src/renderer/setup-mic.ts'));
  assert.doesNotMatch(mic, /MediaRecorder|toDataURL|Blob|fetch\(|localStorage/);
  const html = read('../src/renderer/index.html');
  assert.match(html, /connect-src 'none'/);
});

test('the wizard never blocks the app: Esc or Skip setup closes it and records it; Back and Skip are always visible; reduced motion is respected', () => {
  const wizard = strip(read('../src/renderer/SetupWizard.tsx'));
  assert.match(wizard, /wiz-skip-all" onClick=\{dismiss\}/);
  assert.match(wizard, /type: 'dismiss'/);
  const app = strip(read('../src/renderer/App.tsx'));
  assert.match(app, /event\.key !== 'Escape'/);
  assert.match(app, /if \(state\.setupActive\) return <SetupWizard state=\{state\}\/>/);
  assert.match(app, /Run setup again/);
  assert.match(app, /restartPatch\(state\.settings\.onboardingLanguage\)/);
  const css = read('../src/renderer/setup.css');
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /overflow-x: hidden/);
  assert.match(read('../src/renderer/styles.css'), /@import url\('\.\/setup\.css'\)/);
});
