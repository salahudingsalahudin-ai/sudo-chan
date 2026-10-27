import { spawn } from 'node:child_process';
import { evaluateWindowList, parseWindowList } from '../shared/screen-guard.ts';
import type { GuardResult, WindowInfo } from '../shared/screen-guard.ts';

/**
 * Lists the windows that are on screen through the accessibility bus (AT-SPI) so the screenshot can be
 * refused when a password manager, bank page, login or private window is visible. Verified on this
 * GNOME 44 Wayland machine: org.gnome.Shell.Introspect answers AccessDenied and Shell.Eval is disabled,
 * but AT-SPI lists every accessible app's windows with titles in under a second (after a cold start of a few
 * seconds). Apps that do not expose accessibility (many browsers unless accessibility is on) are NOT covered,
 * which is why the first capture of a session also shows a countdown.
 *
 * Titles are inspected in this process only: never logged, never sent anywhere.
 */
export const WINDOW_LIST_HELPER = `
import json, sys
try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except Exception:
    print('[]'); sys.exit(0)
out = []
try:
    Atspi.init()
    desktop = Atspi.get_desktop(0)
    for i in range(min(desktop.get_child_count(), 60)):
        try:
            app = desktop.get_child_at_index(i)
            app_name = app.get_name() or ''
            for j in range(min(app.get_child_count(), 40)):
                w = app.get_child_at_index(j)
                st = w.get_state_set()
                out.append({
                    'app': app_name[:80],
                    'title': (w.get_name() or '')[:160],
                    'showing': bool(st.contains(Atspi.StateType.SHOWING)),
                    'active': bool(st.contains(Atspi.StateType.ACTIVE)),
                })
        except Exception:
            pass
except Exception:
    pass
print(json.dumps(out))
`;

/** Runs the AT-SPI helper once and returns its raw stdout (empty string when python3 is missing or it times out). */
function runWindowHelper(timeoutMs: number): Promise<{ stdout: string; failed: boolean }> {
  return new Promise(resolve => {
    const child = spawn('python3', ['-I', '-c', WINDOW_LIST_HELPER], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.on('error', () => { clearTimeout(timer); resolve({ stdout: '', failed: true }); });
    child.on('close', () => { clearTimeout(timer); resolve({ stdout, failed: false }); });
  });
}

export async function checkVisibleWindows(timeoutMs = 4000): Promise<GuardResult> {
  const { stdout, failed } = await runWindowHelper(timeoutMs);
  return failed ? { status: 'unknown' } : evaluateWindowList(stdout);
}

/**
 * The window list itself, for Live Talk awareness (layer 1): which window has focus. Same helper, same limits; the
 * caller (shared/live-awareness.ts) decides what may be used. Null when the helper is unavailable.
 */
export async function listWindows(timeoutMs = 3000): Promise<WindowInfo[] | null> {
  const { stdout, failed } = await runWindowHelper(timeoutMs);
  return failed ? null : parseWindowList(stdout);
}
