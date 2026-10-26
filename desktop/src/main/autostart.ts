import { app } from 'electron';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function setLaunchAtLogin(enabled: boolean) {
  if (!app.isPackaged) throw new Error('Install the app before enabling launch at login.');
  if (process.platform !== 'linux') { app.setLoginItemSettings({ openAtLogin: enabled }); return; }
  const folder = join(app.getPath('appData'), 'autostart');
  const destination = join(folder, 'app.sudochan.desktop.desktop');
  if (!enabled) { if (existsSync(destination)) unlinkSync(destination); return; }
  const executable = process.env.APPIMAGE || process.execPath;
  if (/[\n\r]/.test(executable)) throw new Error('Unsupported executable path.');
  const quoted = executable.replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%');
  mkdirSync(folder, { recursive: true });
  writeFileSync(destination, `[Desktop Entry]\nType=Application\nName=Sudo-chan\nComment=A quiet desktop companion\nExec="${quoted}"\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`, { mode: 0o600 });
}
