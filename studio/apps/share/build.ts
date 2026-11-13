import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/main.ts'], bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile: 'dist/server.mjs' });
await cp('public', 'dist/public', { recursive: true });
await build({ entryPoints: ['src/client.ts'], bundle: true, platform: 'browser', target: 'es2022', outfile: 'dist/public/app.js' });
