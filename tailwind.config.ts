import type { Config } from 'tailwindcss';
const config: Config = { content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}'], theme: { extend: { colors: { ink: '#0A0A0F', pink: '#ff91b5', mint: '#a1f5d0' }, fontFamily: { sans: ['var(--font-inter)', 'sans-serif'], display: ['var(--font-display)', 'sans-serif'] } } }, plugins: [] };
export default config;
