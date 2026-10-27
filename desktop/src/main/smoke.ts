import { app, BrowserWindow } from 'electron';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Smoke-test support. EVERYTHING in this file is inert unless the app was started with `--smoke-test`
 * (see index.ts); normal runs never import a code path from here that does anything.
 *
 * `npm run verify` starts the built app with a throw-away userData dir, HOME pointing at a temp dir, a
 * local fake OpenAI-compatible server, and these environment variables:
 *   SUDO_CHAN_SMOKE_HIDDEN=1       windows are never shown (no flashing on the user's screen)
 *   SUDO_CHAN_SMOKE_REPORT=<file>  where the JSON report is written
 *   SUDO_CHAN_SMOKE_ENDPOINT=<url> base URL of the fake server, for example http://127.0.0.1:41234
 *   SUDO_CHAN_SMOKE_HOME=<dir>     the temp HOME (contains work/hello.txt for the read-only tool turn)
 *   SUDO_CHAN_SMOKE_APPROVAL_MS=<n> shortened approval timeout so the timeout path can be exercised
 */

export interface SmokeCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface SmokeReport {
  ok: boolean;
  checks: SmokeCheck[];
  apiKeys: Record<string, string[]>;
  timingsMs: Record<string, number>;
  error?: string;
}

/** Makes every BrowserWindow stay invisible: webContents still load and run, nothing is drawn on screen. */
export function installHiddenWindows(): void {
  const proto = BrowserWindow.prototype as unknown as Record<string, unknown>;
  for (const method of ['show', 'showInactive', 'focus']) proto[method] = function hiddenNoop() { /* smoke test: never visible */ };
}

export function smokeApprovalTimeoutMs(): number | undefined {
  const raw = Number(process.env.SUDO_CHAN_SMOKE_APPROVAL_MS);
  return Number.isFinite(raw) && raw >= 200 && raw <= 20_000 ? raw : undefined;
}

type Win = BrowserWindow;

function kindOf(win: Win): string {
  try {
    return new URL(win.webContents.getURL()).hash.replace('#', '');
  } catch {
    return '';
  }
}

function findWindow(kind: string): Win | undefined {
  return BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && kindOf(w) === kind && !w.webContents.isLoading());
}

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs: number, stepMs = 100): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() > end) return undefined;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
}

function evalIn<T>(win: Win, body: string): Promise<T> {
  return win.webContents.executeJavaScript(`(async () => { ${body} })()`, true) as Promise<T>;
}

interface ChatMessageLike { role: string; text: string; status?: string }

async function ask(chat: Win, text: string, marker: string, timeoutMs: number): Promise<string | undefined> {
  await evalIn(chat, `return await window.companion.sendMessage(${JSON.stringify(text)});`);
  return until(async () => {
    const state = await evalIn<{ messages: ChatMessageLike[] }>(chat, 'return await window.companion.getMessages();');
    const last = [...state.messages].reverse().find(m => m.role === 'assistant' && m.status === 'complete');
    return last && last.text.includes(marker) ? last.text : undefined;
  }, timeoutMs, 250);
}

export async function runSmoke(): Promise<void> {
  const reportPath = process.env.SUDO_CHAN_SMOKE_REPORT;
  if (!reportPath) return;
  const endpoint = process.env.SUDO_CHAN_SMOKE_ENDPOINT ?? '';
  const home = process.env.SUDO_CHAN_SMOKE_HOME ?? '';
  const started = Date.now();
  const report: SmokeReport = { ok: false, checks: [], apiKeys: {}, timingsMs: {} };
  const check = (name: string, ok: boolean, detail?: string) => { report.checks.push({ name, ok, detail }); };
  const lap = (name: string) => { report.timingsMs[name] = Date.now() - started; };

  try {
    const overlay = await until(() => findWindow('overlay'), 20_000);
    check('overlay window created and loaded', Boolean(overlay), overlay ? undefined : 'no overlay window within 20 s');
    lap('overlay');
    if (!overlay) throw new Error('overlay missing');
    report.apiKeys.overlay = await evalIn<string[]>(overlay, 'return Object.keys(window.companion || {}).sort();');

    const state0 = await evalIn<{ settings: Record<string, unknown> }>(overlay, 'return await window.companion.getState();');
    check('tools default OFF', state0.settings.toolsEnabled !== true);
    check('screen assist default OFF', state0.settings.screenAssistEnabled !== true);

    await evalIn(overlay, 'return await window.companion.openChat();');
    const chat = await until(() => findWindow('chat'), 20_000);
    check('chat window created and loaded', Boolean(chat), chat ? undefined : 'no chat window within 20 s');
    lap('chat');
    if (!chat) throw new Error('chat missing');
    report.apiKeys.chat = await evalIn<string[]>(chat, 'return Object.keys(window.companion || {}).sort();');

    await evalIn(overlay, 'return await window.companion.openSettings();');
    const settings = await until(() => findWindow('settings'), 20_000);
    check('settings window created and loaded', Boolean(settings), settings ? undefined : 'no settings window within 20 s');
    lap('settings');
    if (!settings) throw new Error('settings missing');
    report.apiKeys.settings = await evalIn<string[]>(settings, 'return Object.keys(window.companion || {}).sort();');

    // Window-kind authorisation: the chat window must NOT be allowed to change cloud settings.
    const denied = await evalIn<string>(chat, `try { await window.companion.saveCloudConfig({ provider: 'custom', endpoint: 'http://127.0.0.1:1/v1/chat/completions', model: 'x', apiKey: 'k' }); return 'allowed'; } catch (e) { return String(e && e.message || e); }`);
    check('chat window cannot save cloud config (authorize)', /unavailable in this window/i.test(denied), denied.slice(0, 120));

    // Key storage: the settings window may read the storage description and remove keys; chat and overlay may not.
    const keyDenied = await evalIn<string>(chat, `try { await window.companion.clearSavedKeys(); return 'allowed'; } catch (e) { return String(e && e.message || e); }`);
    const keyInfoDenied = await evalIn<string>(overlay, `try { await window.companion.getKeyStorageInfo(); return 'allowed'; } catch (e) { return String(e && e.message || e); }`);
    check('chat/overlay cannot remove keys or read key-storage info (authorize)', /unavailable in this window/i.test(keyDenied) && /unavailable in this window/i.test(keyInfoDenied), `${keyDenied.slice(0, 60)} / ${keyInfoDenied.slice(0, 60)}`);

    // Free-usage meter: Settings and Chat get the key-free summary, the overlay does not.
    const usageSettings = await evalIn<string>(settings, `try { const u = await window.companion.getUsage(); return u.rows.length + ':' + JSON.stringify(u).length; } catch (e) { return 'error ' + String(e && e.message || e); }`);
    const usageChat = await evalIn<string>(chat, `try { return String((await window.companion.getUsage()).rows.length); } catch (e) { return 'error ' + String(e && e.message || e); }`);
    const usageOverlay = await evalIn<string>(overlay, `try { await window.companion.getUsage(); return 'allowed'; } catch (e) { return String(e && e.message || e); }`);
    check('usage meter: settings + chat get 5 rows, overlay is refused', /^5:\d+$/.test(usageSettings) && usageChat === '5' && /unavailable in this window/i.test(usageOverlay), `${usageSettings} / ${usageChat} / ${usageOverlay.slice(0, 60)}`);

    // Cloud config against the local fake server (settings window only), then a streamed chat round trip.
    const saved = await evalIn<{ ok: boolean; error?: string }>(settings, `return await window.companion.saveCloudConfig({ provider: 'custom', endpoint: ${JSON.stringify(`${endpoint}/v1/chat/completions`)}, model: 'fake-model', apiKey: 'smoke-test-key' });`);
    check('cloud config accepted by the fake server', saved.ok, saved.error);
    await evalIn(chat, `return await window.companion.setAIMode('cloud');`);
    const reply = await ask(chat, 'Say hello for the smoke test', 'SMOKE_REPLY_OK', 20_000);
    check('streamed chat round trip', Boolean(reply), reply ? undefined : 'no completed assistant reply containing SMOKE_REPLY_OK');
    lap('chat-roundtrip');

    const hasTools = typeof (report.apiKeys.chat ?? []).find(k => k === 'getToolApprovals') === 'string';
    if (hasTools) {
      await evalIn(chat, `const s = await window.companion.getState(); return await window.companion.saveSettings({ ...s.settings, toolsEnabled: true });`);
      const listed = await ask(chat, 'SMOKE_LIST please list my work folder', 'SMOKE_TOOL_OK', 25_000);
      check('read-only tool turn (list_dir) runs without a card', Boolean(listed && listed.includes('hello.txt')), listed ? undefined : 'no tool answer');
      lap('tool-list');

      const approvalAsk = ask(chat, 'SMOKE_WRITE please create a file', 'SMOKE_DENIED_SEEN', 30_000);
      const pending = await until(async () => {
        const list = await evalIn<unknown[]>(chat, 'return await window.companion.getToolApprovals();');
        return list.length > 0 ? list : undefined;
      }, 10_000, 100);
      check('write tool raises an approval request', Boolean(pending), pending ? undefined : 'no pending approval');
      const answer = await approvalAsk;
      check('unanswered approval is denied on timeout (model told "NOT done")', Boolean(answer), answer ? undefined : 'no denial reply');
      lap('tool-approval');

      // "Aaj ka kaam": the assistant's add_task tool and the chat window's panel share one tasks.json (own temp userData here).
      const added = await ask(chat, 'SMOKE_TASK please add a task', 'SMOKE_TOOL_OK', 25_000);
      check('task tool add_task runs without a card', Boolean(added && /Added t1: smoke task \(due tomorrow\)/.test(added)), added ? added.slice(0, 120) : 'no tool answer');
      const panel = await evalIn<{ plan: Array<{ id: string; title: string }>; openCount: number }>(chat, 'return await window.companion.getTasks();');
      check('chat panel sees the task the assistant added', panel.openCount === 1 && panel.plan[0]?.title === 'smoke task', JSON.stringify(panel).slice(0, 120));
      const overlayTasks = await evalIn<string>(overlay, 'try { await window.companion.getTasks(); return "allowed"; } catch (e) { return String(e && e.message || e); }');
      check('overlay cannot read the tasks (authorize)', /unavailable in this window/i.test(overlayTasks), overlayTasks.slice(0, 80));
      await evalIn(chat, `const s = await window.companion.getState(); return await window.companion.saveSettings({ ...s.settings, toolsEnabled: false });`);
      const manual = await evalIn<{ ok: boolean; view: { openCount: number } }>(chat, 'return await window.companion.addTaskText("parson subah report bhejna");');
      check('panel adds a task with tools OFF', manual.ok && manual.view.openCount === 2, JSON.stringify(manual).slice(0, 100));
      const checked = await evalIn<{ ok: boolean; view: { openCount: number; doneToday: unknown[] } }>(chat, 'return await window.companion.taskAction("t1", "done");');
      check('panel can check a task off', checked.ok && checked.view.openCount === 1 && checked.view.doneToday.length === 1, JSON.stringify(checked).slice(0, 100));
      if (process.platform !== 'win32') {
        const tasksMode = statSync(join(app.getPath('userData'), 'tasks.json')).mode & 0o777;
        check('tasks.json is mode 600 and not inside config.json', tasksMode === 0o600 && !readFileSync(join(app.getPath('userData'), 'config.json'), 'utf8').includes('smoke task'), tasksMode.toString(8));
      }
      lap('tasks');
    } else {
      check('tools not present on this branch (skipped)', true, 'preload has no getToolApprovals');
    }
    void home;

    // Key files are owner-only, the settings window can read the storage description, and "Remove saved keys" really clears them (fake key only).
    const configFile = join(app.getPath('userData'), 'config.json');
    if (process.platform !== 'win32') {
      const fileMode = statSync(configFile).mode & 0o777;
      const dirMode = statSync(app.getPath('userData')).mode & 0o777;
      check('config.json is 600 and its folder is 700', fileMode === 0o600 && dirMode === 0o700, `${fileMode.toString(8)} / ${dirMode.toString(8)}`);
    }
    const info = await evalIn<{ encrypted: boolean; hint: string }>(settings, 'return await window.companion.getKeyStorageInfo();');
    check('settings can read the key-storage description (smoke run: not encrypted)', info.encrypted === false && /not encrypted/i.test(info.hint), info.hint.slice(0, 80));
    const cleared = await evalIn<{ ok: boolean; removed?: number }>(settings, 'return await window.companion.clearSavedKeys();');
    const ai = await evalIn<{ cloud: { apiKeySet: boolean; maskedKey: string } }>(settings, 'return await window.companion.getAI();');
    const leftover = readFileSync(configFile, 'utf8').includes(Buffer.from('smoke-test-key').toString('base64'));
    check('"Remove saved keys" clears the key from memory and from config.json', cleared.ok && (cleared.removed ?? 0) >= 1 && !ai.cloud.apiKeySet && !ai.cloud.maskedKey && !leftover, `removed=${cleared.removed} apiKeySet=${ai.cloud.apiKeySet} onDisk=${leftover}`);
    lap('keys');
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    report.ok = report.error === undefined && report.checks.every(c => c.ok);
    lap('total');
    try { writeFileSync(reportPath, JSON.stringify(report, null, 2)); } catch { /* the verify script treats a missing report as a failure */ }
    setTimeout(() => app.exit(report.ok ? 0 : 1), 400);
    app.quit();
  }
}
