import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [{
    name: 'desktop-development-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'").replace("connect-src 'none'", "connect-src 'self' ws://127.0.0.1:5178");
    },
  }],
  // This app never loads environment files, including the parent website's secrets.
  envDir: false,
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
  },
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
});
