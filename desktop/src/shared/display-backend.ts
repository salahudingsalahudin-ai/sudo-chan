// Ozone chooses its backend before Electron loads the app's JavaScript.
// Read the original argv, not app.commandLine (which Chromium may have changed).
export function displayBackend(platform: string, args: string[]): { backend: string; relaunch: boolean } {
  if (platform !== 'linux') return { backend: platform, relaunch: false };
  let explicit: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--ozone-platform=')) explicit = args[i].slice('--ozone-platform='.length);
    else if (args[i] === '--ozone-platform') explicit = args[i + 1];
  }
  if (explicit) return { backend: explicit, relaunch: false };
  return { backend: args.includes('--native-wayland') ? 'wayland' : 'x11', relaunch: true };
}
