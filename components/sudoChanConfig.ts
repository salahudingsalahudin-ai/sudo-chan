export const USE_REAL_MODEL = false;

export const WELCOME_LINES = [
  "Hi, I'm Sudo-chan. Take your time. I'm right here.",
  "Welcome! Scroll down and I'll show you around.",
  "Hello, human. You create, I'll keep watch.",
  "You found me! Let's explore this together.",
] as const;

export const WELCOME_DURATION_MS = 4_000;
export const EYE_HOVER_THROTTLE_MS = 600;
export const EYE_BLINK_DAMPING = 24;
export const BLINK_CLOSE_DURATION_MS = 100;
export const BLINK_OPEN_DURATION_MS = 180;
export const OUCH_BLINK_CLOSE_DURATION_MS = 45;
export const OUCH_BLINK_OPEN_DURATION_MS = 80;
export const EYE_REDNESS_CLICK_LIMIT = 25;
export const OUCH_EVERY_N_CLICKS = 3;
export const OUCH_BUBBLE_DURATION_MS = 1_400;
export const SLEEP_SECONDS = 8;
export const SLEEP_DURATION_MS = SLEEP_SECONDS * 1_000;
export const REDNESS_DECAY_INTERVAL_MS = 3_000;
export const REDNESS_DECAY_PER_INTERVAL = 0.01;
export const DEBUG_EYE_CLICKS = false;
export const HAPPY_MOUTH_COLOR = '#fff5a8';
export const HAPPY_MOUTH_GLOW = '#ff9d21';
