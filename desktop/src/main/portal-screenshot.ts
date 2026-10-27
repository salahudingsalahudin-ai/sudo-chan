import { spawn } from 'node:child_process';
import { fileUriToPath } from '../shared/screen-assist.ts';

/**
 * Non-interactive screenshot through xdg-desktop-portal (org.freedesktop.portal.Screenshot).
 * This is the only method that worked on GNOME Wayland here: `grim` needs wlr-screencopy,
 * the GNOME Shell D-Bus API answers AccessDenied, and Electron's desktopCapturer under
 * XWayland only sees X windows. The portal answers with a Response signal that is sent only to
 * the connection that made the call (so `gdbus` CLI + a separate monitor cannot see it); a small
 * python3-gi helper keeps one connection open for the call and the signal.
 *
 * The portal writes a PNG into ~/Pictures and returns its path; the caller must read it
 * and delete it straight away.
 */

export type PortalResult = { ok: true; path: string } | { ok: false; reason: string };

export const PORTAL_HELPER = `
import json, sys, time
try:
    import gi
    gi.require_version('Gio', '2.0')
    from gi.repository import Gio, GLib
except Exception:
    print(json.dumps({'reason': 'no-python-gi'})); sys.exit(0)
try:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    loop = GLib.MainLoop()
    result = {}
    token = 'sudochan%d' % int(time.time() * 1000)
    sender = bus.get_unique_name()[1:].replace('.', '_')
    path = '/org/freedesktop/portal/desktop/request/%s/%s' % (sender, token)
    def on_response(conn, name, obj, iface, signal, params, data):
        code, res = params.unpack()
        result['code'] = code
        result['uri'] = res.get('uri')
        loop.quit()
    bus.signal_subscribe('org.freedesktop.portal.Desktop', 'org.freedesktop.portal.Request', 'Response', path, None, Gio.DBusSignalFlags.NONE, on_response, None)
    opts = {'interactive': GLib.Variant('b', False), 'handle_token': GLib.Variant('s', token)}
    bus.call_sync('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.freedesktop.portal.Screenshot', 'Screenshot',
                  GLib.Variant('(sa{sv})', ('', opts)), GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE, 5000, None)
    GLib.timeout_add_seconds(20, loop.quit)
    loop.run()
    if 'code' not in result:
        print(json.dumps({'reason': 'portal-timeout'}))
    else:
        print(json.dumps(result))
except Exception as e:
    print(json.dumps({'reason': 'portal-error'}))
`;

export function parseHelperOutput(stdout: string): PortalResult {
  let parsed: { code?: number; uri?: string; reason?: string };
  try {
    parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '');
  } catch {
    return { ok: false, reason: 'portal-bad-output' };
  }
  if (parsed.reason) return { ok: false, reason: parsed.reason };
  if (parsed.code !== 0 || !parsed.uri) return { ok: false, reason: parsed.code === 1 ? 'portal-denied' : 'portal-failed' };
  const path = fileUriToPath(parsed.uri);
  return path ? { ok: true, path } : { ok: false, reason: 'portal-bad-uri' };
}

export function portalScreenshot(timeoutMs = 25_000): Promise<PortalResult> {
  return new Promise(resolve => {
    const child = spawn('python3', ['-I', '-c', PORTAL_HELPER], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, reason: 'no-python3' }); });
    child.on('close', () => { clearTimeout(timer); resolve(parseHelperOutput(stdout)); });
  });
}
