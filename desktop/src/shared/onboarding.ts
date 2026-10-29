/**
 * First-run setup wizard: the pure parts (no Electron, no DOM, no network).
 *
 * - the step list and the state machine (next / back / skip / language / dismiss / resume),
 * - "should the wizard be shown at all" (fresh install only; an existing user never sees it),
 * - the copy tables for both languages (English and Roman Urdu) and the little helpers the screens use,
 * - plain-words classification of microphone and key errors.
 *
 * Nothing here grants anything: the screens save settings through the normal Settings path, so every rule that already
 * exists (click-only consent, tools off by default, ...) still applies. See desktop/ONBOARDING.md.
 */

export const ONBOARDING_STEPS = ['welcome', 'mic', 'name', 'brain', 'privacy', 'try', 'done'] as const;
export type OnboardingStep = typeof ONBOARDING_STEPS[number];
export type OnboardingLanguage = 'en' | 'roman-ur';
export const ONBOARDING_LANGUAGES: readonly OnboardingLanguage[] = ['en', 'roman-ur'];
/** Steps that can be skipped on their own. The first and last screens have nothing to skip. */
export const SKIPPABLE_STEPS: readonly OnboardingStep[] = ['mic', 'name', 'brain', 'privacy', 'try'];

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(value);
}
export function isOnboardingLanguage(value: unknown): value is OnboardingLanguage {
  return value === 'en' || value === 'roman-ur';
}

// ------------------------------------------------------------------------------------------ first-run detection

export interface FirstRunInput {
  /** `config.json` already existed in the app's data folder when this launch began (before the store created it). */
  configExisted: boolean;
  /** The saved settings object, or undefined. Only the onboarding fields are read. */
  settings: { onboardingDone?: unknown; onboardingStep?: unknown } | undefined;
  /** Any provider key or cloud entry is saved. A user with keys is never a first-run user. */
  hasSavedKeys: boolean;
  /** Smoke runs (npm run verify) must never open a wizard. */
  smokeRun: boolean;
}

/**
 * Show the wizard when: it was not finished or dismissed, and either this is a brand new install (no config file yet) or an earlier
 * run stopped halfway (a saved `onboardingStep`). Everybody who already has a config file, settings, keys or providers without a
 * saved step (the owner, every user of an older version) never sees it. "Run setup again" in Settings opens it by hand.
 */
export function shouldShowOnboarding(input: FirstRunInput): boolean {
  if (input.smokeRun) return false;
  const s = input.settings;
  if (s?.onboardingDone === true) return false;
  // A saved step means an earlier run of the wizard stopped halfway: resume, even though that run may already have saved a key.
  if (isOnboardingStep(s?.onboardingStep)) return true;
  if (input.hasSavedKeys) return false;
  return !input.configExisted;
}

// ------------------------------------------------------------------------------------------ state machine

export interface WizardState {
  step: OnboardingStep;
  language: OnboardingLanguage;
  /** Steps the user chose to skip (cleared again when they later press Next on it). */
  skipped: OnboardingStep[];
  /** null while the wizard is open; 'finished' after the last screen; 'dismissed' after Skip setup / Esc. Both record onboardingDone. */
  outcome: 'finished' | 'dismissed' | null;
}

export type WizardAction =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'skip' }
  | { type: 'goto'; step: OnboardingStep }
  | { type: 'language'; language: OnboardingLanguage }
  | { type: 'dismiss' }
  | { type: 'restart' };

export function stepIndex(step: OnboardingStep): number { return ONBOARDING_STEPS.indexOf(step); }
export function isLastStep(step: OnboardingStep): boolean { return step === ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1]; }

/** Resume where the last run stopped: the saved step and language, otherwise the beginning in English. */
export function initialWizardState(settings: { onboardingStep?: unknown; onboardingLanguage?: unknown } | undefined): WizardState {
  return {
    step: isOnboardingStep(settings?.onboardingStep) ? settings.onboardingStep : 'welcome',
    language: isOnboardingLanguage(settings?.onboardingLanguage) ? settings.onboardingLanguage : 'en',
    skipped: [],
    outcome: null,
  };
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  if (state.outcome !== null && action.type !== 'restart') return state;
  const index = stepIndex(state.step);
  switch (action.type) {
    case 'next': {
      const skipped = state.skipped.filter(s => s !== state.step);
      if (isLastStep(state.step)) return { ...state, skipped, outcome: 'finished' };
      return { ...state, skipped, step: ONBOARDING_STEPS[index + 1] };
    }
    case 'back':
      return index === 0 ? state : { ...state, step: ONBOARDING_STEPS[index - 1] };
    case 'skip': {
      if (!SKIPPABLE_STEPS.includes(state.step)) return state;
      const skipped = state.skipped.includes(state.step) ? state.skipped : [...state.skipped, state.step];
      return { ...state, skipped, step: ONBOARDING_STEPS[index + 1] };
    }
    case 'goto':
      return isOnboardingStep(action.step) ? { ...state, step: action.step } : state;
    case 'language':
      return isOnboardingLanguage(action.language) ? { ...state, language: action.language } : state;
    case 'dismiss':
      return { ...state, outcome: 'dismissed' };
    case 'restart':
      return { step: 'welcome', language: state.language, skipped: [], outcome: null };
    default:
      return state;
  }
}

export interface ProgressInfo { index: number; total: number; ratio: number }
export function wizardProgress(step: OnboardingStep): ProgressInfo {
  const total = ONBOARDING_STEPS.length;
  const index = stepIndex(step);
  return { index, total, ratio: total <= 1 ? 1 : index / (total - 1) };
}

export interface OnboardingSettingsPatch { onboardingStep?: OnboardingStep; onboardingLanguage?: OnboardingLanguage; onboardingDone?: boolean }

/** What to save after every move, so closing the app halfway resumes at the same screen. Finishing or dismissing records onboardingDone. */
export function persistPatch(state: WizardState): OnboardingSettingsPatch {
  const patch: OnboardingSettingsPatch = { onboardingStep: state.step, onboardingLanguage: state.language };
  if (state.outcome !== null) patch.onboardingDone = true;
  return patch;
}

/** The patch "Run setup again" saves before it reopens the wizard. */
export function restartPatch(language: OnboardingLanguage | undefined): OnboardingSettingsPatch {
  return { onboardingDone: false, onboardingStep: 'welcome', ...(language ? { onboardingLanguage: language } : {}) };
}

// ------------------------------------------------------------------------------------------ choices and the privacy step

export interface PrivacyChoices { tools: boolean; screen: boolean; windowName: boolean }
export const PRIVACY_ALL_OFF: PrivacyChoices = { tools: false, screen: false, windowName: false };

/** The Settings fields the privacy step writes. Everything is explicit true/false so "off" is stored as off. */
export function privacyPatch(choices: PrivacyChoices): { toolsEnabled: boolean; screenAssistEnabled: boolean; liveAwareness: 'off' | 'window' } {
  return { toolsEnabled: choices.tools, screenAssistEnabled: choices.screen, liveAwareness: choices.windowName ? 'window' : 'off' };
}
export function privacyFromSettings(s: { toolsEnabled?: boolean; screenAssistEnabled?: boolean; liveAwareness?: string } | undefined): PrivacyChoices {
  return { tools: s?.toolsEnabled === true, screen: s?.screenAssistEnabled === true, windowName: s?.liveAwareness === 'window' };
}

/** 'assist' only when the person taught her voice, the self-test heard them at least once, and they chose it. Otherwise it stays off. */
export function localWakeChoice(input: { taught: boolean; selfTestHeard: number; wantsAssist: boolean }): 'off' | 'assist' {
  return input.taught && input.selfTestHeard > 0 && input.wantsAssist ? 'assist' : 'off';
}

export type BrainChoice = 'none' | 'key' | 'offline';
export interface Choices {
  mic: 'allowed' | 'skipped' | 'blocked';
  voiceTaught: boolean;
  brain: BrainChoice;
  /** Provider label when a key was saved, for example "Groq". */
  brainLabel?: string;
  privacy: PrivacyChoices;
}

// ------------------------------------------------------------------------------------------ microphone and key errors

export type MicErrorKind = 'denied' | 'no-device' | 'busy' | 'unknown';
/** Maps the name of a getUserMedia error to a friendly category. */
export function micErrorKind(name: unknown): MicErrorKind {
  switch (name) {
    case 'NotAllowedError': case 'SecurityError': case 'PermissionDeniedError': return 'denied';
    case 'NotFoundError': case 'DevicesNotFoundError': case 'OverconstrainedError': return 'no-device';
    case 'NotReadableError': case 'AbortError': case 'TrackStartError': return 'busy';
    default: return 'unknown';
  }
}

/** Which platform-specific tip to show under a microphone problem. */
export function micTipKey(platform: string): 'linuxTip' | 'macTip' | 'winTip' {
  return platform === 'darwin' ? 'macTip' : platform === 'win32' ? 'winTip' : 'linuxTip';
}

/** 0..1 from a root-mean-square value, the same scale the enrolment recorder uses, so the bars look alike everywhere. */
export function levelFromRms(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  return Math.min(1, rms * 18);
}
export const MIC_HEARD_LEVEL = 0.12;
/** Verdict of a mic test from the loudest level seen: 'heard' once it passed the threshold, otherwise 'quiet'. */
export function micTestVerdict(peak: number): 'heard' | 'quiet' {
  return peak >= MIC_HEARD_LEVEL ? 'heard' : 'quiet';
}

export type KeyProvider = 'groq' | 'gemini';
export const KEY_PROVIDERS: readonly KeyProvider[] = ['groq', 'gemini'];
export const KEY_PROVIDER_LABEL: Record<KeyProvider, string> = { groq: 'Groq', gemini: 'Google Gemini' };
export const KEY_PAGE: Record<KeyProvider, string> = { groq: 'console.groq.com/keys', gemini: 'aistudio.google.com/apikey' };

/** Trims spaces, quotes and a pasted "Bearer " prefix. The result is only ever sent to the main process, never shown. */
export function cleanPastedKey(text: string): string {
  return text.trim().replace(/^bearer\s+/i, '').replace(/^["'`]+|["'`]+$/g, '').trim();
}
/** Enables the Test button. Deliberately loose (providers change their key format); the provider itself is the real judge. */
export function keyLooksUsable(text: string): boolean {
  const key = cleanPastedKey(text);
  return key.length >= 16 && key.length <= 400 && !/\s/.test(key);
}

export type KeyErrorKind = 'invalid' | 'network' | 'limit' | 'unknown';
/**
 * Reduces a failure message from the main process to a category, so the screen shows one of our own sentences and never an
 * unknown string (which could carry provider text). The category never contains any part of the key.
 */
export function keyErrorKind(message: unknown): KeyErrorKind {
  const text = typeof message === 'string' ? message.toLowerCase() : '';
  if (/401|403|invalid|unauthor|api key|permission|incorrect/.test(text)) return 'invalid';
  if (/429|quota|rate|limit|too many/.test(text)) return 'limit';
  if (/network|fetch|enotfound|econn|timed? ?out|timeout|offline|reach|dns|socket/.test(text)) return 'network';
  return 'unknown';
}

// ------------------------------------------------------------------------------------------ copy

export interface WizardCopy {
  common: {
    next: string; back: string; skipStep: string; skipAll: string; finish: string; stepOf: string; progress: string; closeHint: string; wizardLabel: string; stepNames: Record<OnboardingStep, string>;
  };
  welcome: { title: string; body: string; time: string; langLabel: string; langNote: string; langEn: string; langRo: string; primary: string };
  mic: {
    title: string; body: string; what: string; flow: string; allow: string; testing: string; heard: string; quiet: string; tryAgain: string; meter: string;
    listenSwitch: string; listenHint: string; blockedTitle: string;
    denied: string; noDevice: string; busy: string; unknown: string; linuxTip: string; macTip: string; winTip: string;
  };
  name: {
    title: string; body: string; say: string; teachTitle: string; teachBody: string; teachOpen: string; teachClose: string;
    assistTitle: string; assistHint: string; assistLocked: string;
  };
  brain: {
    title: string; body: string; honest: string; chosen: string; howTitle: string;
    signinTitle: string; signinBadge: string; signinBody: string;
    keyTitle: string; keyBody: string; providerLabel: string; fieldLabel: string; placeholder: string; test: string; checking: string; ok: string;
    errInvalid: string; errNetwork: string; errLimit: string; errUnknown: string;
    howGroq: string; howGemini: string; limits: string; keyPrivate: string;
    offlineTitle: string; offlineBody: string; offlineCheck: string; offlineChecking: string; offlineFound: string; offlineNone: string;
  };
  privacy: {
    title: string; body: string; offNote: string; on: string; off: string;
    tools: string; toolsHint: string; screen: string; screenHint: string; windowName: string; windowNameHint: string;
    neverOpen: string; neverClose: string; neverTitle: string; never: string[]; keysLinux: string; keysEncrypted: string;
  };
  try: {
    title: string; body: string; start: string; stop: string; listening: string; awake: string; needsBrain: string; needsMic: string;
    cheatTitle: string; cheat: string[];
  };
  done: {
    title: string; body: string; summaryTitle: string; later: string; trayTitle: string; tray: string; trayLinux: string; summary: Record<string, string>;
  };
}

const EN: WizardCopy = {
  common: {
    next: 'Next', back: 'Back', skipStep: 'Skip this step', skipAll: 'Skip setup', finish: 'Start using Sudo-chan', stepOf: 'Step {n} of {total}',
    progress: 'Setup progress', closeHint: 'Esc closes setup any time. Nothing is lost.', wizardLabel: 'Sudo-chan setup',
    stepNames: { welcome: 'Welcome', mic: 'Microphone', name: 'Her name', brain: 'Her brain', privacy: 'Your choices', try: 'Try it', done: 'All set' },
  },
  welcome: {
    title: 'Hi, I’m Sudo-chan.',
    body: 'I live on your desktop and help when you ask. Let’s set me up together. It takes about 2 minutes, and you can skip anything.',
    time: 'About 2 minutes. Skip anything you like.',
    langLabel: 'Language for this setup', langNote: 'This only changes these setup screens.', langEn: 'English', langRo: 'Roman Urdu', primary: 'Let’s begin',
  },
  mic: {
    title: 'Can I hear you?',
    body: 'Press the button and allow the microphone. Then say something: the bar below should move.',
    what: 'What the microphone does: she only listens for her name (Sudo or Sid), unless you start Live Talk. Nothing is recorded or saved.',
    flow: 'To check for her name, short clips of speech go to the AI provider you choose in step 4. Without a key, nothing is sent anywhere.',
    allow: 'Allow microphone and test', testing: 'Listening... say something.', heard: 'I can hear you. The microphone works.',
    quiet: 'Connected, but it is very quiet. Try speaking a little louder or closer.', tryAgain: 'Try again', meter: 'Microphone level',
    listenSwitch: 'Keep listening for her name', listenHint: 'Turn it off any time with the green dot next to the bot.',
    blockedTitle: 'The microphone is not working yet',
    denied: 'Permission was refused. Press the button again and choose Allow, or check your system’s privacy settings.',
    noDevice: 'No microphone was found. Plug one in (or check the cable), then try again.',
    busy: 'Another app may be using the microphone. Close it and try again.',
    unknown: 'The microphone could not start.',
    linuxTip: 'Linux tip: open Sound settings and pick an input device. With PipeWire or PulseAudio, check that the input is not muted (pavucontrol, Input Devices tab).',
    macTip: 'Mac tip: System Settings, Privacy & Security, Microphone, and switch Sudo-chan on.',
    winTip: 'Windows tip: Settings, Privacy & security, Microphone, and allow desktop apps.',
  },
  name: {
    title: 'Her name',
    body: 'Say “Sudo” or “Sid” and she wakes up. That is all you need to remember.',
    say: 'Sudo   ·   Sid',
    teachTitle: 'Teach her your voice (optional)',
    teachBody: 'Say “Sudo” a few times so this computer can recognise it. Only numbers that describe your voice are saved, never a recording. Skip it if you like.',
    teachOpen: 'Teach her now', teachClose: 'Hide this',
    assistTitle: 'Let this computer check her name first', assistHint: 'Saves cloud requests. Off unless you turn it on.',
    assistLocked: 'Available after you teach her and the test hears you.',
  },
  brain: {
    title: 'Her brain',
    body: 'To chat and understand you, she needs an AI. Pick one way. You can change it later.',
    honest: 'Good to know: without a key or Ollama she can still keep you company, remind you to rest and keep your task list, but she cannot chat or understand your voice yet.',
    chosen: 'Chosen', howTitle: 'How to get a free key',
    signinTitle: 'Sign in', signinBadge: 'Coming soon',
    signinBody: 'A free daily allowance with no key. This is not available yet, so please use a key for now.',
    keyTitle: 'Use my own key', keyBody: 'Paste a free key from Groq or Google Gemini. It stays on this computer.',
    providerLabel: 'Provider', fieldLabel: 'Paste your key here', placeholder: 'Paste your key (it is never shown again)',
    test: 'Test and save', checking: 'Checking...', ok: 'Connected. The key is saved on this computer.',
    errInvalid: 'The provider says this key is not valid. Check that you copied all of it, with no spaces.',
    errNetwork: 'Could not reach the provider. Check your internet and try again.',
    errLimit: 'The provider says the free limit is used up for now. Try again later.',
    errUnknown: 'That did not work. Check the key and try again.',
    howGroq: 'Open console.groq.com/keys in your browser, sign in, press “Create API Key” and copy it.',
    howGemini: 'Open aistudio.google.com/apikey in your browser, sign in with Google, press “Create API key” and copy it.',
    limits: 'Free keys have daily limits. If you reach one, she says so and tries again later.',
    keyPrivate: 'The key is kept on this computer and sent only to the provider you picked.',
    offlineTitle: 'Offline, or later', offlineBody: 'Run an AI on this computer with Ollama, or skip and add a brain later in Settings.',
    offlineCheck: 'Check for Ollama', offlineChecking: 'Looking for Ollama...',
    offlineFound: 'Ollama found with {n} model(s). She will use it.',
    offlineNone: 'Ollama was not found. Install it from ollama.com when you like, or skip for now.',
  },
  privacy: {
    title: 'Your choices',
    body: 'Everything here starts OFF. Turn on only what you want. You can change it any time in Settings.',
    offNote: 'All three are off until you switch them on.', on: 'On', off: 'Off',
    tools: 'Let her use tools', toolsHint: 'Every risky action asks you first, with a card you must click.',
    screen: 'Let her look at my screen when I click Allow', screenHint: 'One screenshot, only when you ask. She asks you once more to confirm, because the picture goes to your AI provider.',
    windowName: 'Let her know which app I’m using during Live Talk', windowNameHint: 'Only the window name, no picture. Only while Live Talk is on.',
    neverOpen: 'What she never does', neverClose: 'Hide this', neverTitle: 'What she never does',
    never: [
      'She never saves your voice or your screenshots. Voice goes to your AI provider only to be turned into words.',
      'Your voice can never approve an action. Only a click can.',
      'She never looks at your screen on her own. Only when you click Allow.',
      'Your keys stay on this computer and go only to the provider you chose.',
    ],
    keysLinux: 'On Linux your keys are NOT encrypted: they sit in a private file that only your user can read.',
    keysEncrypted: 'On this computer your keys are encrypted by the system.',
  },
  try: {
    title: 'Say hello',
    body: 'Say “Sudo”, or click the bot on your desktop. Or press the button here to try Live Talk now.',
    start: 'Start Live Talk', stop: 'Stop', listening: 'She is listening... say something.', awake: 'She heard you and she is awake.',
    needsBrain: 'She can only answer once she has a brain (step 4).', needsMic: 'The microphone is off, so she cannot hear you yet (step 2).',
    cheatTitle: 'Three things to remember',
    cheat: ['Click me to talk.', 'Say “ruko” to stop me.', 'Double-click the mic dot to turn the mic off.'],
  },
  done: {
    title: 'You’re all set.',
    body: 'Here is what we set up. Everything can be changed later.',
    summaryTitle: 'Your setup',
    later: 'Change anything later: Settings, then “Run setup again”.',
    trayTitle: 'Where to find me', tray: 'I also live in your system tray, the small icon near the clock. Click it to open chat or Settings.',
    trayLinux: 'If you do not see the icon, your desktop may hide tray icons. The bot on your desktop still works.',
    summary: {
      micAllowed: 'Microphone works', micSkipped: 'Microphone: skipped', micBlocked: 'Microphone: not working yet',
      voiceTaught: 'She knows your voice saying Sudo', voiceNotTaught: 'Her name: just say Sudo or Sid',
      brainKey: 'Brain: {label}, key saved', brainOffline: 'Brain: offline with Ollama', brainNone: 'Brain: not set up yet',
      toolsOn: 'Tools: on (every risky action asks first)', toolsOff: 'Tools: off',
      screenOn: 'Screen help: on (only when you click Allow)', screenOff: 'Screen help: off',
      windowOn: 'Knows which app you use in Live Talk', windowOff: 'App name in Live Talk: off',
    },
  },
};

const RO: WizardCopy = {
  common: {
    next: 'Aage', back: 'Peeche', skipStep: 'Yeh step chhor dein', skipAll: 'Setup chhor dein', finish: 'Sudo-chan istemal karein', stepOf: 'Step {n} / {total}',
    progress: 'Setup ki progress', closeHint: 'Esc dabane se setup kisi bhi waqt band ho jata hai. Kuch zaya nahi hota.', wizardLabel: 'Sudo-chan setup',
    stepNames: { welcome: 'Khush aamdeed', mic: 'Microphone', name: 'Us ka naam', brain: 'Us ka dimagh', privacy: 'Aap ke faislay', try: 'Aazmayen', done: 'Tayyar' },
  },
  welcome: {
    title: 'Assalam o Alaikum, main Sudo-chan hoon.',
    body: 'Main aap ke desktop par rehti hoon aur jab aap kahen madad karti hoon. Chalein mil kar setup karte hain. Takreeban 2 minute lagte hain, aur aap kuch bhi chhor sakte hain.',
    time: 'Takreeban 2 minute. Jo marzi chhor dein.',
    langLabel: 'Setup ki zubaan', langNote: 'Sirf setup ki screens ki zubaan badalti hai.', langEn: 'English', langRo: 'Roman Urdu', primary: 'Shuru karein',
  },
  mic: {
    title: 'Kya main aap ko sun sakti hoon?',
    body: 'Button dabayen aur microphone ki ijazat dein. Phir kuch bolein: neeche wali bar hilni chahiye.',
    what: 'Microphone ka kaam: jab tak aap Live Talk shuru na karein, woh sirf us ke naam (Sudo ya Sid) ka intezar karta hai. Kuch record ya save nahi hota.',
    flow: 'Naam check karne ke liye awaaz ke chhote clips us AI provider ko jate hain jo aap step 4 mein chunenge. Key ke baghair kuch kahin nahi jata.',
    allow: 'Microphone ki ijazat dein aur test karein', testing: 'Sun rahi hoon... kuch bolein.', heard: 'Aap ki awaaz aa rahi hai. Microphone theek chal raha hai.',
    quiet: 'Connect hai, lekin awaaz bohat halki hai. Thora zor se ya qareeb se bolein.', tryAgain: 'Dobara koshish karein', meter: 'Microphone ki level',
    listenSwitch: 'Us ke naam ka intezar karti rahe', listenHint: 'Bot ke saath wale hare dot se kisi bhi waqt band kar sakte hain.',
    blockedTitle: 'Microphone abhi kaam nahi kar raha',
    denied: 'Ijazat nahi mili. Button dobara dabayen aur Allow chunein, ya system ki privacy settings dekhein.',
    noDevice: 'Koi microphone nahi mila. Ek laga dein (ya taar check karein), phir dobara koshish karein.',
    busy: 'Shayad koi aur app microphone istemal kar rahi hai. Use band karke dobara koshish karein.',
    unknown: 'Microphone shuru nahi ho saka.',
    linuxTip: 'Linux ka mashwara: Sound settings kholein aur input device chunein. PipeWire ya PulseAudio mein check karein ke input mute na ho (pavucontrol, Input Devices tab).',
    macTip: 'Mac ka mashwara: System Settings, Privacy & Security, Microphone, aur Sudo-chan ko on karein.',
    winTip: 'Windows ka mashwara: Settings, Privacy & security, Microphone, aur desktop apps ko ijazat dein.',
  },
  name: {
    title: 'Us ka naam',
    body: '“Sudo” ya “Sid” kahein aur woh jaag jati hai. Bas itna yaad rakhna hai.',
    say: 'Sudo   ·   Sid',
    teachTitle: 'Usay apni awaaz sikhayen (zaroori nahi)',
    teachBody: 'Kuch baar “Sudo” bolein taake yeh computer pehchan sake. Sirf awaaz ke numbers save hote hain, recording kabhi nahi. Chahein to chhor dein.',
    teachOpen: 'Abhi sikhayen', teachClose: 'Isay chhupayen',
    assistTitle: 'Pehle yeh computer naam check kare', assistHint: 'Cloud requests bachata hai. Aap na chalayen to band rehta hai.',
    assistLocked: 'Sikhane ke baad aur test mein awaaz sunai dene par milta hai.',
  },
  brain: {
    title: 'Us ka dimagh',
    body: 'Baat karne aur aap ko samajhne ke liye usay AI chahiye. Ek tareeqa chunein. Baad mein badal sakte hain.',
    honest: 'Sach yeh hai: key ya Ollama ke baghair woh sath de sakti hai, aaram ki yaad dilati hai aur task list rakhti hai, lekin abhi baat nahi kar sakti aur aap ki awaaz nahi samajh sakti.',
    chosen: 'Chuna gaya', howTitle: 'Free key kaise milti hai',
    signinTitle: 'Sign in', signinBadge: 'Jald aa raha hai',
    signinBody: 'Key ke baghair rozana free hissa. Yeh abhi dastiyab nahi, is liye filhal key istemal karein.',
    keyTitle: 'Meri apni key', keyBody: 'Groq ya Google Gemini ki free key paste karein. Woh isi computer par rehti hai.',
    providerLabel: 'Provider', fieldLabel: 'Apni key yahan paste karein', placeholder: 'Key paste karein (dobara nazar nahi aayegi)',
    test: 'Test karein aur save karein', checking: 'Check ho raha hai...', ok: 'Connect ho gaya. Key is computer par save hai.',
    errInvalid: 'Provider kehta hai yeh key durust nahi. Check karein ke poori copy hui hai aur beech mein space nahi.',
    errNetwork: 'Provider tak nahi pahunch saki. Internet check karke dobara koshish karein.',
    errLimit: 'Provider kehta hai free limit filhal khatam hai. Thori der baad dobara koshish karein.',
    errUnknown: 'Kaam nahi bana. Key check karke dobara koshish karein.',
    howGroq: 'Browser mein console.groq.com/keys kholein, sign in karein, “Create API Key” dabayen aur copy kar lein.',
    howGemini: 'Browser mein aistudio.google.com/apikey kholein, Google se sign in karein, “Create API key” dabayen aur copy kar lein.',
    limits: 'Free keys ki rozana limit hoti hai. Limit khatam ho to woh bata deti hai aur baad mein dobara koshish karti hai.',
    keyPrivate: 'Key isi computer par rehti hai aur sirf aap ke chune hue provider ko jati hai.',
    offlineTitle: 'Offline, ya baad mein', offlineBody: 'Ollama se apne computer par AI chalayen, ya chhor dein aur baad mein Settings mein dimagh lagayen.',
    offlineCheck: 'Ollama check karein', offlineChecking: 'Ollama dhoondh rahi hoon...',
    offlineFound: 'Ollama mil gaya, {n} model ke saath. Woh isay istemal karegi.',
    offlineNone: 'Ollama nahi mila. Jab chahein ollama.com se install kar lein, ya filhal chhor dein.',
  },
  privacy: {
    title: 'Aap ke faislay',
    body: 'Yahan sab kuch pehle se OFF hai. Sirf wohi on karein jo chahiye. Baad mein Settings mein kabhi bhi badal sakte hain.',
    offNote: 'Teenon off hain jab tak aap on na karein.', on: 'On', off: 'Off',
    tools: 'Usay tools istemal karne dein', toolsHint: 'Har khatarnak kaam se pehle woh aap se poochti hai, ek card ke saath jis par click karna parta hai.',
    screen: 'Jab main Allow dabaun to woh meri screen dekh sake', screenHint: 'Sirf ek screenshot, sirf jab aap kahen. Woh aap se ek baar aur poochti hai, kyunke tasveer aap ke AI provider ko jati hai.',
    windowName: 'Live Talk mein usay pata ho main kaun si app istemal kar raha hoon', windowNameHint: 'Sirf window ka naam, tasveer nahi. Sirf jab Live Talk chal raha ho.',
    neverOpen: 'Woh kabhi kya nahi karti', neverClose: 'Isay chhupayen', neverTitle: 'Woh kabhi kya nahi karti',
    never: [
      'Woh aap ki awaaz ya screenshots kabhi save nahi karti. Awaaz sirf lafzon mein badalne ke liye aap ke AI provider ko jati hai.',
      'Aap ki awaaz se koi kaam kabhi manzoor nahi hota. Sirf click se hota hai.',
      'Woh khud se kabhi aap ki screen nahi dekhti. Sirf jab aap Allow dabayen.',
      'Aap ki keys isi computer par rehti hain aur sirf aap ke chune hue provider ko jati hain.',
    ],
    keysLinux: 'Linux par aap ki keys encrypt NAHI hotin: woh ek private file mein hain jo sirf aap ka user parh sakta hai.',
    keysEncrypted: 'Is computer par aap ki keys system ke zariye encrypt hoti hain.',
  },
  try: {
    title: 'Salam karein',
    body: '“Sudo” kahein, ya desktop par bot par click karein. Ya yahan button dabayen aur Live Talk abhi aazmayen.',
    start: 'Live Talk shuru karein', stop: 'Rokein', listening: 'Woh sun rahi hai... kuch kahein.', awake: 'Usne aap ko suna aur woh jaag gayi.',
    needsBrain: 'Woh jawab tab dengi jab dimagh lag jaye (step 4).', needsMic: 'Microphone band hai, is liye woh abhi sun nahi sakti (step 2).',
    cheatTitle: 'Teen baatein yaad rakhein',
    cheat: ['Mujh par click karein, main baat karti hoon.', '“Ruko” kahein to main ruk jaungi.', 'Mic dot par double-click se mic band ho jata hai.'],
  },
  done: {
    title: 'Sab tayyar hai.',
    body: 'Yeh hai jo hum ne set kiya. Sab kuch baad mein badla ja sakta hai.',
    summaryTitle: 'Aap ka setup',
    later: 'Baad mein kuch badalna ho: Settings, phir “Run setup again”.',
    trayTitle: 'Mujhe kahan dhoondhen', tray: 'Main system tray mein bhi hoon, ghadi ke paas chhota icon. Us par click karke chat ya Settings kholein.',
    trayLinux: 'Agar icon nazar na aaye to ho sakta hai aap ka desktop tray icons chhupata ho. Desktop wala bot phir bhi kaam karta hai.',
    summary: {
      micAllowed: 'Microphone theek chal raha hai', micSkipped: 'Microphone: chhor diya', micBlocked: 'Microphone: abhi kaam nahi kar raha',
      voiceTaught: 'Woh Sudo kehte hue aap ki awaaz pehchanti hai', voiceNotTaught: 'Us ka naam: bas Sudo ya Sid kahein',
      brainKey: 'Dimagh: {label}, key save hai', brainOffline: 'Dimagh: Ollama ke saath offline', brainNone: 'Dimagh: abhi set nahi hua',
      toolsOn: 'Tools: on (har khatarnak kaam se pehle poochti hai)', toolsOff: 'Tools: off',
      screenOn: 'Screen madad: on (sirf jab aap Allow dabayen)', screenOff: 'Screen madad: off',
      windowOn: 'Live Talk mein jaanti hai aap kaun si app istemal kar rahe hain', windowOff: 'Live Talk mein app ka naam: off',
    },
  },
};

export const WIZARD_COPY: Record<OnboardingLanguage, WizardCopy> = { en: EN, 'roman-ur': RO };

export function copyFor(language: OnboardingLanguage): WizardCopy {
  return WIZARD_COPY[isOnboardingLanguage(language) ? language : 'en'];
}

/** Replaces {name} placeholders. Unknown placeholders stay as they are. */
export function fillCopy(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
}

/** The summary lines for the last screen, in the chosen language. Reads the choices only; never invents a state. */
export function summaryLines(choices: Choices, language: OnboardingLanguage): string[] {
  const s = copyFor(language).done.summary;
  const lines: string[] = [];
  lines.push(choices.mic === 'allowed' ? s.micAllowed : choices.mic === 'blocked' ? s.micBlocked : s.micSkipped);
  lines.push(choices.voiceTaught ? s.voiceTaught : s.voiceNotTaught);
  lines.push(choices.brain === 'key' ? fillCopy(s.brainKey, { label: choices.brainLabel ?? '' }).replace(/\s+,/, ',') : choices.brain === 'offline' ? s.brainOffline : s.brainNone);
  lines.push(choices.privacy.tools ? s.toolsOn : s.toolsOff);
  lines.push(choices.privacy.screen ? s.screenOn : s.screenOff);
  lines.push(choices.privacy.windowName ? s.windowOn : s.windowOff);
  return lines;
}

/** Which mascot face matches a step. The screens map these onto the existing Bot props (mood, listening glow, eye direction). */
export interface MascotFace { mood: 'calm' | 'worried' | 'happy'; listening: boolean; looking: 'center' | 'up' | 'down'; sleepy: boolean }
export function mascotFor(step: OnboardingStep, flags: { micBlocked?: boolean; micListening?: boolean; liveOn?: boolean; brainOffline?: boolean } = {}): MascotFace {
  switch (step) {
    case 'welcome': return { mood: 'happy', listening: false, looking: 'center', sleepy: false };
    case 'mic': return { mood: flags.micBlocked ? 'worried' : 'calm', listening: Boolean(flags.micListening), looking: 'center', sleepy: false };
    case 'name': return { mood: 'happy', listening: false, looking: 'center', sleepy: false };
    case 'brain': return { mood: 'calm', listening: false, looking: 'up', sleepy: false };
    case 'privacy': return { mood: 'calm', listening: false, looking: 'down', sleepy: false };
    case 'try': return { mood: 'happy', listening: Boolean(flags.liveOn), looking: 'center', sleepy: false };
    case 'done': return { mood: 'happy', listening: false, looking: 'center', sleepy: false };
    default: return { mood: 'calm', listening: false, looking: 'center', sleepy: false };
  }
}
