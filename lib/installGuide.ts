// Pure data and helpers for the /download install guide. No React, no browser APIs: everything here is unit-tested.
// File names mirror desktop/package.json "artifactName": Sudo-chan-${version}-${os}-${arch}.${ext}.

import { formatBytes, type LatestRelease } from './releases';

export type OsId = 'linux' | 'windows' | 'macos';
export type DetectedOs = OsId | 'mobile' | 'unknown';
export type PackageFormat = 'deb' | 'appimage';

export const STEP_COUNT = 4;

/** Approximate sizes of the first Linux build. Real sizes from GitHub replace these when known. */
export const APPROX_SIZE = { deb: '96 MB', appimage: '120 MB' } as const;

export const COMMANDS = {
  verify: 'sha256sum -c SHA256SUMS --ignore-missing',
  openFolder: 'cd ~/Downloads',
  debInstall: 'sudo apt install ./Sudo-chan-*.deb',
  appImageChmod: 'chmod +x Sudo-chan-*.AppImage',
  appImageRun: './Sudo-chan-*-linux-x86_64.AppImage',
  fuse: 'sudo apt install libfuse2',
  fixDeps: 'sudo apt -f install',
  settingsDir: 'ls ~/.config/Sudo-chan',
} as const;

export const SETTINGS_DIR = '~/.config/Sudo-chan';

export interface FileNames {
  appImage: string;
  deb: string;
  checksums: string;
}

/** Exact names the build produces. Without a known version the placeholder `<version>` is shown. */
export function fileNames(version?: string): FileNames {
  const v = version && /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version) ? version : '<version>';
  return {
    appImage: `Sudo-chan-${v}-linux-x86_64.AppImage`,
    deb: `Sudo-chan-${v}-linux-amd64.deb`,
    checksums: 'SHA256SUMS',
  };
}

/** What the checksum command prints for a good file, e.g. "Sudo-chan-0.1.0-linux-amd64.deb: OK". */
export function expectedVerifyLine(file: string): string {
  return `${file}: OK`;
}

/** Guess the computer from the browser's user agent. Only used to pre-select a card; the person can change it. */
export function detectOs(userAgent: string): DetectedOs {
  const ua = userAgent.toLowerCase();
  if (!ua) return 'unknown';
  if (/android|iphone|ipad|ipod|mobile/.test(ua)) return 'mobile';
  if (/windows|win32|win64/.test(ua)) return 'windows';
  if (/macintosh|mac os x|macintel/.test(ua)) return 'macos';
  if (/linux|x11|cros/.test(ua)) return 'linux';
  return 'unknown';
}

/** Browsers on Ubuntu or Debian sometimes say so in the user agent. Returns the file we recommend first. */
export function recommendedFormat(userAgent: string): PackageFormat | null {
  return /ubuntu|debian|mint|pop!_os/i.test(userAgent) ? 'deb' : null;
}

export interface OsCard {
  id: OsId;
  name: string;
  status: string;
  ready: boolean;
  detail: string;
}

export const OS_CARDS: readonly OsCard[] = [
  { id: 'linux', name: 'Linux', status: 'Available now', ready: true, detail: 'x86-64 (64-bit Intel or AMD). Ubuntu 22.04 or newer, Debian and similar.' },
  { id: 'windows', name: 'Windows', status: 'Not built yet', ready: false, detail: 'There is no Windows installer yet.' },
  { id: 'macos', name: 'macOS', status: 'Not built yet', ready: false, detail: 'There is no macOS app yet.' },
];

/** Honest message for the picked computer. Linux has none; the other cards explain what is missing. */
export function osMessage(os: DetectedOs): string {
  switch (os) {
    case 'windows':
      return 'There is no Windows build yet, so there is nothing to download for this computer today. When it exists it will be unsigned, and Windows SmartScreen will show "Windows protected your PC". The Linux steps below are for a Linux computer.';
    case 'macos':
      return 'There is no macOS build yet, so there is nothing to download for this computer today. When it exists it will be unsigned, and macOS Gatekeeper will say the developer cannot be verified. The Linux steps below are for a Linux computer.';
    case 'mobile':
      return 'Sudo-chan is a desktop app. Open this page on your computer to install it. The steps below are for Linux.';
    default:
      return '';
  }
}

export interface StepInfo {
  id: string;
  number: number;
  short: string;
  title: string;
}

export const STEPS: readonly StepInfo[] = [
  { id: 'step-1', number: 1, short: 'Computer', title: 'Choose your computer' },
  { id: 'step-2', number: 2, short: 'Download', title: 'Download' },
  { id: 'step-3', number: 3, short: 'Check', title: 'Check it is genuine' },
  { id: 'step-4', number: 4, short: 'Install', title: 'Install and open it' },
];

export function stepHref(number: number): string {
  return `#step-${Math.min(Math.max(Math.round(number), 1), STEP_COUNT)}`;
}

/** Which step is "current" given each step heading's distance from the top of the viewport (negative = scrolled past). */
export function activeStepFromTops(tops: readonly number[], offset: number): number {
  let active = 0;
  for (let i = 0; i < tops.length; i += 1) {
    if (tops[i] <= offset) active = i;
  }
  return Math.min(active, STEP_COUNT - 1);
}

export interface WizardPreviewStep {
  id: 'mic' | 'name' | 'brain' | 'privacy' | 'try';
  title: string;
  body: string;
}

/** The five screens of the first-run setup, shown as a small illustration (the real wizard lives inside the app). */
export const WIZARD_PREVIEW: readonly WizardPreviewStep[] = [
  { id: 'mic', title: 'Microphone', body: 'Pick the mic she listens with.' },
  { id: 'name', title: 'Her name', body: 'Call her what you like.' },
  { id: 'brain', title: 'Her brain', body: 'Add your own AI key.' },
  { id: 'privacy', title: 'Privacy', body: 'Choose what she may do.' },
  { id: 'try', title: 'Try it', body: 'Say hello out loud.' },
];

export interface TroubleItem {
  id: string;
  question: string;
  answer: string;
  command?: string;
  after?: string;
}

export const TROUBLE: readonly TroubleItem[] = [
  {
    id: 'appimage-wont-start',
    question: 'The AppImage does not start',
    answer: 'On Ubuntu 22.04 and newer, AppImages need a small library called libfuse2, and it is not installed by default. Install it, then run the file again. Also check the file is executable (step 4).',
    command: COMMANDS.fuse,
  },
  {
    id: 'deb-dependency',
    question: 'The .deb install says a dependency is missing',
    answer: 'Let apt fetch what is missing, then try the install command again. Using "apt install ./file.deb" (not "dpkg -i") normally pulls dependencies in for you.',
    command: COMMANDS.fixDeps,
  },
  {
    id: 'no-sound',
    question: 'She cannot hear me, or I hear no sound',
    answer: 'Open your system sound settings and check that the right input device (your microphone) and output device are selected and not muted. On modern Ubuntu and Fedora, sound runs through PipeWire, so also check the volume meter moves when you speak. Then open her settings and pick the same microphone.',
  },
  {
    id: 'wayland',
    question: 'The window does not show on Wayland',
    answer: 'On a Wayland desktop she runs through XWayland, a compatibility layer, so that her overlay, shortcuts and window position stay reliable. Make sure XWayland is installed (most desktops include it). If she still does not appear, log out and choose an "X11" or "Xorg" session on the login screen, then start her again.',
  },
  {
    id: 'logs',
    question: 'Where are my settings and logs?',
    answer: `Everything she keeps lives in ${SETTINGS_DIR} on your own computer. If you ask for help, describe what you see or share only the log file. Never paste your API keys into a chat, an issue, an email or this website: nobody who helps you needs them.`,
    command: COMMANDS.settingsDir,
    after: 'This only lists the folder. It does not show or copy any key.',
  },
];

export const INSTALL_COPY = {
  earlyNote: 'Expect rough edges: Urdu and Roman Urdu recognition is still improving, the default voice is a simple synthetic one, and you bring your own AI key. It has been tested on one Linux computer so far.',
  unsignedNote: 'The Linux files are not code-signed. Signing costs money and is planned for later. A checksum (step 3) tells you your copy matches the file we published; it does not prove who made it, so only download from this page or the project releases on GitHub.',
  apparmorNote: 'Ubuntu 24.04 restricts some features Electron apps use. The .deb installs an AppArmor profile for that, so prefer the .deb on 24.04. The AppImage starts itself with --no-sandbox there, which means less isolation. We have not tested either on 24.04 yet.',
  checksumWhy: 'A checksum is a fingerprint of a file. If even one letter of the file changes, the fingerprint changes. Comparing it catches a broken download or a file somebody swapped. SHA256SUMS lists the right fingerprints for this release.',
  checksumFail: 'If it says FAILED, or the file is missing, delete the file and download it again from this page.',
} as const;

export interface GuideRelease {
  /** Real version when GitHub could be read, otherwise undefined and the page shows `<version>`. */
  version?: string;
  latestUrl: string;
  debUrl?: string;
  appImageUrl?: string;
  checksumsUrl?: string;
  debSize?: string;
  appImageSize?: string;
}

/** What the guide needs from GitHub. With no release data every link falls back to the "latest release" page. */
export function buildGuideRelease(latest: LatestRelease | null, latestUrl: string): GuideRelease {
  if (!latest) return { latestUrl };
  const deb = latest.assets.find(a => a.platform === 'linux-deb');
  const appImage = latest.assets.find(a => a.platform === 'linux-appimage');
  return {
    version: latest.version,
    latestUrl,
    debUrl: deb?.url,
    appImageUrl: appImage?.url,
    checksumsUrl: latest.checksumsUrl,
    debSize: deb?.size ? formatBytes(deb.size) : undefined,
    appImageSize: appImage?.size ? formatBytes(appImage.size) : undefined,
  };
}
