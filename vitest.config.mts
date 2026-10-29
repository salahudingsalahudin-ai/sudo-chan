import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Lets tests import app code: the `@/` alias (as in tsconfig paths) and JSX (tsconfig keeps it for Next to compile).
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
});
