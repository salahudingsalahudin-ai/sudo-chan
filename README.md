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

The scene in `components/SudoChanCanvas.tsx` looks for `public/models/sudo-chan.glb` and loads it when present. If it is absent or fails to load, it renders the procedural ceramic bot instead. Replace the GLB at that path to use a production character model. Keep the model centered around the origin and facing the camera along negative Z; the existing visor and chest effects assume that orientation. `components/SudoChanJourney.tsx` dynamically imports the 3D scene only when WebGL is available; touch devices and reduced-motion mode use the tracked static companion.

All landing page copy and scene labels are collected in `content.ts`.

## Notes

- Seven chapters create a 910vh scroll journey. ScrollTrigger scrubs the 3D camera and world transitions, while Lenis smooths scrolling.
- The procedural fallback keeps the page usable without a model asset. The optional GLB can include a rig or use the existing runtime head tracking.
- Three.js effects are capped at DPR 2. Touch devices hide the custom cursor; reduced-motion preferences suppress UI animation.
- Latest production build: 142 KB first-load JavaScript. The WebGL scene is code-split and adds about 272 KiB gzip only on desktop browsers that support WebGL.

## Validation

- `npm test`: run the Vitest waitlist route tests with mocked Supabase; this does not verify the deployed database or environment configuration.
- `npx tsc --noEmit`: check TypeScript.
- `npm run build`: compile the production application.
- Manually check eye tracking, bot interactions, scroll behavior, keyboard access, reduced motion, mobile layout, both themes, and the browser console.

The desktop companion has an early local Electron prototype in [`desktop/`](./desktop/). Run it separately with its setup and preview notes in [`desktop/README.md`](./desktop/README.md); chat replies are local mock text. It is not a released product and it does not capture the screen or call an AI service. Website privacy controls remain previews.
