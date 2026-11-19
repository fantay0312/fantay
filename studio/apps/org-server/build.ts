import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/public', { recursive: true });
await build({ entryPoints: ['src/main.ts'], bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile: 'dist/server.mjs' });
// The admin console: one script, its stylesheet, and the Fantay design tokens it is drawn with.
await build({ entryPoints: ['console/src/app.ts'], bundle: true, platform: 'browser', target: 'es2022', format: 'esm', minify: true, outfile: 'dist/public/app.js' });
await cp('console/index.html', 'dist/public/index.html');
await cp('console/style.css', 'dist/public/style.css');
await cp('../../packages/fantay-tokens/tokens.css', 'dist/public/tokens.css');
