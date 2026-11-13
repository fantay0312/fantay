/* SPDX-License-Identifier: AGPL-3.0-only */
/**
 * Writes packages/fantay-tokens/tokens.css from the token tables (src/tokens.ts).
 *   pnpm --filter @fantay/tokens generate            rewrite tokens.css
 *   pnpm --filter @fantay/tokens generate -- --check exit 1 when the committed file is stale
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTokensCss } from '../src/render-css';

const target = resolve(dirname(fileURLToPath(import.meta.url)), '../tokens.css');
const rendered = renderTokensCss();

if (process.argv.includes('--check')) {
  const committed = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (committed !== rendered) {
    console.error(`${target} is stale. Run: pnpm --filter @fantay/tokens generate`);
    process.exitCode = 1;
  } else {
    console.log(`${target} is up to date.`);
  }
} else {
  writeFileSync(target, rendered, 'utf8');
  console.log(`wrote ${target}`);
}
