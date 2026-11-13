// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { expect, it } from 'vitest';

it('keeps the active viewer visible when a modal menu hides it from assistive technology', () => {
  const css = readFileSync(new NodeURL('../../src/styles/viewer/core.css', import.meta.url), 'utf8');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]*\[data-testid="retained-file-viewer"\][^{}]*\{[^}]*\}/g) ?? [];
  expect(rules.length).toBeGreaterThan(0);
  const style = document.createElement('style'); style.textContent = rules.join('\n'); document.head.append(style);
  const viewer = document.createElement('div'); viewer.dataset.testid = 'retained-file-viewer'; viewer.dataset.viewerActive = 'true'; document.body.append(viewer);
  viewer.setAttribute('aria-hidden', 'true');
  expect(getComputedStyle(viewer).visibility).toBe('visible');
  viewer.dataset.viewerActive = 'false';
  expect(getComputedStyle(viewer).visibility).toBe('hidden');
  viewer.remove(); style.remove();
});
