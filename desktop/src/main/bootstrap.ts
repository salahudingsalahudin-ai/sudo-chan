import { app } from 'electron';
import { displayBackend } from '../shared/display-backend.js';

const display = displayBackend(process.platform, process.argv.slice(1));
if (display.relaunch) {
  // A late appendSwitch mixes a Wayland browser with X11 child processes,
  // leaving native windows blank even when renderer screenshots look correct.
  app.relaunch({ args: [...process.argv.slice(1), `--ozone-platform=${display.backend}`] });
  app.exit(0);
} else {
  await import('./index.js');
}
