import { build as bundle } from 'esbuild';
import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.node.json'], { stdio: 'inherit' });
await bundle({ entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' });
await build();
