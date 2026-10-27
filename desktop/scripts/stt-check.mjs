#!/usr/bin/env node
// STT self-check you run yourself with real recordings (no audio is stored by the app, so there is nothing to replay).
//
//   node scripts/stt-check.mjs recordings/            # every *.wav in the folder
//   node scripts/stt-check.mjs a.wav b.wav --mode accurate --language auto
//   node scripts/stt-check.mjs recordings/ --expect phrases.json     # { "01-wake.wav": "Sudo kaise ho" }
//
// File names may start with the phrase number of TEST-URDU.md (01-..., 02-...); then the expected phrase is looked up there.
// Keys: environment GROQ_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY first; otherwise read-only from the app's config.json
// (~/.config/Sudo-chan/config.json, base64 "rawKey" entries only; keys the app encrypted with the OS keyring cannot be read here,
// set the env vars instead). Keys are never printed. Each file costs 1-2 real STT requests (the same router as the app,
// including its single retry only when you pass --clip, which sends the clip facts the app sends).
//
// WAV: 16-bit PCM, mono, 16 kHz is what the app sends. Record e.g. with:  arecord -f S16_LE -r 16000 -c 1 -d 4 01-wake.wav
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SttRouter } from '../src/main/stt.ts';
import { wavClipStats } from '../src/shared/clip-stats.ts';
import { aliasForMatching, detectScript } from '../src/shared/transcript-normalize.ts';
import { matchWakeWord } from '../src/shared/wake-word.ts';
import { isStopCommand } from '../src/shared/stop-intent.ts';
import { classifyIntent } from '../src/shared/intent.ts';

const here = resolve(fileURLToPath(import.meta.url), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); if (i < 0) return fallback; const v = args[i + 1]; args.splice(i, 2); return v ?? fallback; };
const mode = flag('mode', 'fast');
const language = flag('language', 'auto');
const expectFile = flag('expect', '');
const useClip = args.includes('--clip');
const inputs = args.filter(a => !a.startsWith('--'));
if (!inputs.length) {
  console.error('Usage: node scripts/stt-check.mjs <folder|file.wav ...> [--mode fast|accurate] [--language auto|en|ur] [--expect phrases.json] [--clip]');
  process.exit(2);
}

// ---- keys (never printed)
function storedKey(id) {
  const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Sudo-chan', 'config.json');
  if (!existsSync(file)) return '';
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    const entry = cfg?.providers?.[id] ?? (cfg?.cloud?.provider === id ? cfg.cloud : undefined);
    return entry?.rawKey ? Buffer.from(entry.rawKey, 'base64').toString('utf8') : '';
  } catch { return ''; }
}
const keys = {
  groq: process.env.GROQ_API_KEY || storedKey('groq'),
  gemini: process.env.GEMINI_API_KEY || storedKey('gemini'),
  openai: process.env.OPENAI_API_KEY || storedKey('openai'),
};
console.log(`keys available: groq=${keys.groq ? 'yes' : 'no'} gemini=${keys.gemini ? 'yes' : 'no'} openai=${keys.openai ? 'yes' : 'no'}  mode=${mode} language=${language}`);
if (!keys.groq && !keys.gemini && !keys.openai) {
  console.error('No key found. Set GROQ_API_KEY and/or GEMINI_API_KEY (the app may store its keys encrypted).');
  process.exit(1);
}

// ---- expected phrases
let expected = {};
if (expectFile) expected = JSON.parse(readFileSync(expectFile, 'utf8'));
const doc = join(here, '..', 'TEST-URDU.md');
const numbered = {};
if (existsSync(doc)) for (const m of readFileSync(doc, 'utf8').matchAll(/^\s*(\d{1,2})\.\s+\*\*[^*]*\*\*\s+"([^"]+)"/gm)) numbered[String(Number(m[1]))] = m[2];

const files = [];
for (const input of inputs) {
  if (statSync(input).isDirectory()) for (const f of readdirSync(input).sort()) { if (extname(f).toLowerCase() === '.wav') files.push(join(input, f)); }
  else files.push(input);
}

const router = new SttRouter({
  fetch: (url, init) => fetch(url, init),
  getKey: id => keys[id] ?? '',
  now: () => Date.now(),
  getMode: () => mode,
});

const rows = [];
for (const file of files) {
  const bytes = readFileSync(file);
  const stats = wavClipStats(bytes);
  const name = basename(file);
  const num = /^(\d{1,2})[-_ ]/.exec(name)?.[1];
  const want = expected[name] ?? (num ? numbered[String(Number(num))] : undefined) ?? '';
  const started = Date.now();
  const out = await router.transcribe({
    base64: bytes.toString('base64'), mimeType: 'audio/wav', language,
    clip: useClip && stats ? { seconds: stats.seconds, rms: stats.rms, voicedMs: stats.voicedMs, botActive: false } : undefined,
  });
  const got = out.ok ? out.text : `(${out.reason ?? 'failed'}${out.rateLimited ? ', rate limited' : ''})`;
  const match = out.ok ? aliasForMatching(out.text) : '';
  const wake = out.ok ? matchWakeWord(out.text, 'Sudo', undefined) : { matched: false };
  rows.push({
    file: name, expected: want, got, script: out.ok ? detectScript(out.text) : '-', provider: out.provider ?? '-', retried: out.retried ? 'yes' : '',
    wake: wake.matched ? 'WAKE' : '', stop: out.ok && isStopCommand(out.text) ? 'STOP' : '', intent: out.ok ? classifyIntent(wake.matched ? wake.rest : out.text) : '-',
    canon: match !== out.text && out.ok ? match : '', ms: Date.now() - started, sec: stats ? stats.seconds.toFixed(1) : '?', rms: stats ? stats.rms.toFixed(3) : '?',
  });
}
console.table(rows.map(r => ({ file: r.file, expected: r.expected, got: r.got, script: r.script, via: r.provider + (r.retried ? '+retry' : ''), wake: r.wake, stop: r.stop, intent: r.intent, ms: r.ms, sec: r.sec, rms: r.rms })));
const canon = rows.filter(r => r.canon);
if (canon.length) { console.log('normaliser aliases (matching only):'); for (const r of canon) console.log(`  ${r.file}: ${r.canon}`); }
const empty = rows.filter(r => r.got.startsWith('('));
console.log(`${rows.length} clips, ${rows.length - empty.length} transcribed, ${empty.length} empty or failed.`);
