# Sudo-chan product journey

A deep-scroll product introduction built with Next.js App Router, TypeScript, Tailwind CSS, React Three Fiber, drei, postprocessing, GSAP ScrollTrigger, Lenis, and Framer Motion.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Build and run the production version with `npm run build` and `npm start`.

## Supabase waitlist setup

1. In Supabase SQL Editor, run [`supabase/schema.sql`](./supabase/schema.sql) to create the `public.waitlist` table and its unique, lowercase email constraint.
2. Copy `.env.example` to `.env.local` and configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and a private, random `RATE_LIMIT_SALT`. These values are used by the server route only; never add a `NEXT_PUBLIC_` prefix to the service-role key. Without the salt, submissions return 503. Never share these values in chat or commit local environment files.
3. Restart the Next.js dev server after changing environment variables.

The API is `POST /api/waitlist`. It validates and lowercases email addresses, returns a friendly duplicate response, limits request bodies to 2 KiB, and limits submissions to five attempts per hour per hashed IP. Apply the complete `supabase/schema.sql`, including the `waitlist_rate_limits` table and `consume_waitlist_attempt` RPC: the limiter is shared through Supabase rather than process memory. Raw IPs are not stored by this limiter. Supabase requests have a five-second timeout. `GET /api/waitlist` returns the real count without exposing email addresses.

## Character model

The 3D scene lives in `components/SudoChanCanvas.tsx` with its parts in `components/three/`: a procedural, original anime-style companion (`CompanionBot`, toon-shaded with an outline and a rim light), a listening/speaking glow ring (`ListeningRing`, green = listening, violet = speaking, the same colours as the desktop app), four orbiting UI cards with a depth-of-field style blur (`FloatingCards`) and one explanatory prop per scroll scene (`StoryProps`: wake-word chip, approval card with Allow/Deny, screen frame with a consent button, privacy lock). The listening and speaking animation is a made-up demo loop (`sampleVoiceDemo` in `lib/heroScene.ts`); nothing reads the microphone. Everything is procedural, with no model download. Optionally, if `USE_REAL_MODEL` in `components/sudoChanConfig.ts` is turned on and `public/models/sudo-chan.glb` exists, `components/three/GlbBot.tsx` loads that model instead of the procedural character (the loader is imported on demand). `lib/heroScene.ts` holds the pure helpers (scene poses, story weights, renderer choice) and is unit tested. `components/SudoChanJourney.tsx` mounts the 3D scene only when `chooseRenderer` says so: phones and touch devices, reduced motion, Save-Data, low-core or low-memory devices and missing WebGL get the lightweight SVG twin (`components/CompanionSvg.tsx`). A WebGL context loss also falls back to the SVG companion.

All landing page copy and scene labels are collected in `content.ts`.

## Notes

- Seven chapters create a 910vh scroll journey. ScrollTrigger scrubs the 3D camera and world transitions, while Lenis smooths scrolling.
- The lightweight SVG companion keeps the page usable without WebGL. On phones she greets you in the hero and then steps aside, so she never sits on the text.
- Three.js rendering is capped at DPR 1.5 (1.25 on weaker machines) and stops completely when the scene is off-screen or the tab is hidden. Touch devices hide the custom cursor; reduced-motion preferences suppress UI animation.
- Latest production build: 155 kB first-load JavaScript for `/`. The WebGL scene is code-split (roughly 250 KiB gzip, three.js included) and is imported only on desktop browsers that pass `chooseRenderer`.

## Validation

- `npm test`: run the Vitest waitlist route tests with mocked Supabase; this does not verify the deployed database or environment configuration.
- `npx tsc --noEmit`: check TypeScript.
- `npm run build`: compile the production application.
- Manually check eye tracking, bot interactions, scroll behavior, keyboard access, reduced motion, mobile layout, both themes, and the browser console.

The desktop companion has an early local Electron prototype in [`desktop/`](./desktop/). Run it separately with its setup and preview notes in [`desktop/README.md`](./desktop/README.md); chat replies are local mock text. It is not a released product and it does not capture the screen or call an AI service. The website describes the desktop app's behavior in `content.ts`: keep it honest (microphone only while listening is on; screen only after click-consent, never saved on disk; files only with tools on and click approval; API keys on the user's computer, not encrypted on Linux). The app is not released: there is no download link, only the waitlist.
