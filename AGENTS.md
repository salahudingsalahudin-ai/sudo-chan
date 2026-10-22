# Repository Guidelines

## Project Structure & Module Organization

Sudo-chan is a Next.js 14 App Router application using React, TypeScript, Tailwind CSS, and React Three Fiber.

- `app/`: pages, layouts, global styles, metadata, and API routes, including `app/api/waitlist/route.ts`.
- `components/`: interface components and the animated 3D journey; `sudoChanConfig.ts` holds scene configuration.
- `content.ts`: centralized landing-page copy and scene labels.
- `lib/`: shared helpers; `supabase/schema.sql`: database setup.
- `tests/`: Vitest API tests. The optional character asset belongs at `public/models/sudo-chan.glb`; the scene supports a procedural fallback.

## Build, Test, and Development Commands

Run commands from this directory:

- `npm ci`: install dependencies from the committed lockfile.
- `npm run dev`: start local development at `http://localhost:3000`.
- `npm run build`: compile the production application and check types.
- `npm start`: serve an existing production build.
- `npm test`: run Vitest once; `npm test -- --watch` enables watch mode.
- `npx tsc --noEmit`: check TypeScript without emitting files.

`npm run lint` invokes Next.js linting, but no ESLint dependency or configuration is currently committed. No formatter is configured.

## Coding Style & Naming Conventions

Follow nearby code: two-space indentation, single quotes, and semicolons. Keep TypeScript strict and use explicit types at API boundaries. Use PascalCase component filenames, camelCase helpers, and Next.js conventions such as `page.tsx` and `route.ts`. The `@/*` alias resolves from the repository root. Keep browser-dependent components behind appropriate client boundaries and preserve reduced-motion and touch-device behavior.

## Testing Guidelines

Name tests `tests/*.test.ts` and use Vitest. Existing waitlist tests mock Supabase; extend them for validation, duplicate submissions, rate limits, and failure paths without contacting production services. No coverage threshold is configured. Run affected tests and a production build for code changes; visually check desktop, mobile, and theme behavior for interface changes.

## Commit & Pull Request Guidelines

Use short imperative subjects matching history, such as “Fix quiet-day layout and bot reveal.” Keep commits focused. Pull requests should explain changed behavior, link relevant issues, report validation, and include screenshots for visual changes.

## Security & Configuration

Copy `.env.example` to `.env.local`; configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `RATE_LIMIT_SALT`. Apply `supabase/schema.sql` for database setup. Keep credentials server-side, never prefix the service-role key with `NEXT_PUBLIC_`, and never commit local environment files.
