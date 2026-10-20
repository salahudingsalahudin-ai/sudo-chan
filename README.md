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
2. Copy `.env.example` to `.env.local` and fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the Supabase project settings. These values are used by the server route only; never add a `NEXT_PUBLIC_` prefix to the service-role key.
3. Restart the Next.js dev server after changing environment variables.

The API is `POST /api/waitlist`. It validates and lowercases email addresses, returns a friendly duplicate response, and limits each IP to five submissions per minute. The in-memory limiter is per running Node.js process, so use a shared rate-limit store if deploying across multiple server instances.

## Character model

The scene in `components/SudoChanCanvas.tsx` looks for `public/models/sudo-chan.glb` and loads it when present. If it is absent or fails to load, it renders the procedural ceramic bot instead. Replace the GLB at that path to use a production character model. Keep the model centered around the origin and facing the camera along negative Z; the existing visor and chest effects assume that orientation. `components/SudoChanJourney.tsx` dynamically imports the 3D scene only when WebGL is available; touch devices and reduced-motion mode use the tracked static companion.

All landing page copy and scene labels are collected in `content.ts`.

## Notes

- Seven chapters create a 910vh scroll journey. ScrollTrigger scrubs the 3D camera and world transitions, while Lenis smooths scrolling.
- The procedural fallback keeps the page usable without a model asset. The optional GLB can include a rig or use the existing runtime head tracking.
- Three.js effects are capped at DPR 2. Touch devices hide the custom cursor; reduced-motion preferences suppress UI animation.
- Latest production build: 142 KB first-load JavaScript. The WebGL scene is code-split and adds about 272 KiB gzip only on desktop browsers that support WebGL.
