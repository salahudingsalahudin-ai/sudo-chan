// Renders 10 sample sentences with Azure Speech into a listening kit (max 12 requests).
// Usage: node scripts/azure-samples.mjs [outDir]   (needs the key + region saved in Settings first)
// The key is read from the app config inside this process only; it is never printed or written anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] ?? '/tmp/claude-1000/-home-lenovo/34364725-11fb-4f5a-8a8e-29ec88fc703d/scratchpad/voice-compare/azure';
const { AzureTtsProvider } = await import(path.join(root, 'src/main/azure-provider.ts'));

const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/Sudo-chan/config.json'), 'utf8'));
const entry = config.providers?.azure;
const key = entry?.rawKey ? Buffer.from(entry.rawKey, 'base64').toString('utf8') : '';
if (!key || !entry?.region) {
  console.log('NO_AZURE_KEY: save the Azure key and region in Settings first, then run this again.');
  process.exit(2);
}

const sentences = [
  { id: 'en1', lang: 'en', emotion: 'warm', text: 'Hello! I am Sudo-chan, your desktop companion. How can I help you today?' },
  { id: 'en2', lang: 'en', emotion: 'excited', text: 'Great news, the build finished without a single error!' },
  { id: 'en3', lang: 'en', emotion: 'soft', text: 'I am sorry about that, let me try again, step by step.' },
  { id: 'en4', lang: 'en', emotion: 'curious', text: 'What are you working on right now, and where did you get stuck?' },
  { id: 'en5', lang: 'en', emotion: 'calm', text: 'Take a breath. We will fix this together, one thing at a time.' },
  { id: 'ru1', lang: 'hi', emotion: 'happy', text: 'Assalam o alaikum Sid! Main Sudo-chan hoon, aapki desktop companion.' },
  { id: 'ru2', lang: 'hi', emotion: 'warm', text: 'Aap fikar mat karein, main aapki madad ke liye yahin hoon.' },
  { id: 'ru3', lang: 'hi', emotion: 'curious', text: 'Aaj aap kis kaam par lage hue hain, aur kahan masla aa raha hai?' },
  { id: 'ur1', lang: 'ur', emotion: 'warm', text: 'السلام علیکم! میں سوڈو چان ہوں، آپ کی ڈیسک ٹاپ ساتھی۔' },
  { id: 'ur2', lang: 'ur', emotion: 'calm', text: 'فکر نہ کریں، ہم یہ مسئلہ مل کر حل کر لیں گے۔' },
];

fs.mkdirSync(outDir, { recursive: true });
const rows = [];
let calls = 0;
for (const route of ['hi', 'ur']) {
  const provider = new AzureTtsProvider({ getKey: () => key, getRegion: () => entry.region, getVoice: () => 'auto', getRomanRoute: () => route });
  for (const s of sentences) {
    // Roman Urdu is the only text whose voice depends on the route; others are rendered once.
    if (route === 'ur' && s.lang !== 'hi') continue;
    if (calls >= 12) break;
    calls++;
    const started = Date.now();
    const r = await provider.synthesize({ text: s.text, lang: s.lang, emotion: s.emotion, speed: 1 });
    const ms = Date.now() - started;
    const name = `${s.id}-${route}.mp3`;
    let seconds = 0;
    if (r.ok) {
      const bytes = Buffer.from(r.dataUri.split(',')[1], 'base64');
      fs.writeFileSync(path.join(outDir, name), bytes);
      seconds = (bytes.length * 8) / 48000; // audio-24khz-48kbitrate-mono-mp3
    }
    rows.push({ ...s, route, ok: r.ok, voice: r.voice, status: r.status, ms, seconds, file: r.ok ? name : '' });
    console.log(`${s.id}/${route} ok=${r.ok} voice=${r.voice ?? '-'} status=${r.status ?? '-'} ms=${ms} audio=${seconds.toFixed(1)}s chars=${s.text.length} chars/s=${seconds ? (s.text.length / seconds).toFixed(1) : '-'}`);
    if (!r.ok && (r.status === 401 || r.status === 403 || r.status === 429)) { console.log('Stopping: Azure refused the request.'); calls = 99; }
  }
}
const esc = t => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
fs.writeFileSync(path.join(outDir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Azure voice samples</title>
<body style="font-family:sans-serif;max-width:760px;margin:24px auto"><h1>Azure Speech samples</h1>
<p>Listen and judge by ear. Roman Urdu is rendered with the Hindi route (<code>hi</code>) and the Urdu route (<code>ur</code>) so you can pick the better one in Settings.</p>
${rows.map(r => `<div style="margin:14px 0"><b>${r.id} / route ${r.route}</b> &middot; ${esc(r.voice ?? 'failed')} &middot; ${r.emotion}<br>${esc(r.text)}<br>${r.ok ? `<audio controls src="${r.file}"></audio>` : `<i>failed (status ${r.status ?? '-'})</i>`}</div>`).join('\n')}</body>`);
console.log(`Wrote ${rows.filter(r => r.ok).length}/${rows.length} samples to ${outDir}`);
