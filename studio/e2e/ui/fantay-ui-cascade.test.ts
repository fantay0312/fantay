// SPDX-License-Identifier: Apache-2.0
// Fantay UI cascade (spec 01 §2.7 step 3 and §6), in both themes, on the /fantay-ui gallery:
// - every primitive specimen renders the same inside the `.fx` root (scoped preflight on) and in the
//   `.fx-legacy` probe outside it (no preflight, legacy element rules apply): the primitives are
//   self-sufficient, so the cascade layers — not luck — decide the look;
// - the scoped preflight resets raw elements inside `.fx` only, and legacy markup keeps its styles;
// - the one focus ring is 2px solid on keyboard focus.
// The gallery's test-id contract is pinned by apps/web/tests/fantay/ui/gallery.test.tsx.
import type { Page } from '@playwright/test';

import { seedFantayTheme } from '@/playwright/fantay-theme';
import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';

const COMPARED_PROPERTIES = [
  'height',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'color',
  'background-color',
  'border-top-width',
  'border-top-style',
  'border-top-color',
  'border-top-left-radius',
  'box-shadow',
  'transform',
  'cursor',
  'opacity',
] as const;

type ComputedSnapshot = Record<string, string>;

async function computedStyle(page: Page, scope: string, testId: string): Promise<ComputedSnapshot> {
  return page
    .getByTestId(scope)
    .getByTestId(testId)
    .evaluate((element, properties) => {
      const style = window.getComputedStyle(element);
      return Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property)]));
    }, [...COMPARED_PROPERTIES]);
}

async function openGallery(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await seedFantayTheme(page, theme);
  await page.goto('/fantay-ui');
  await expect(page.getByTestId('fx-gallery')).toBeVisible({ timeout: T.long });
  await expect(page.getByTestId('fx-legacy-probe')).toBeVisible({ timeout: T.medium });
  // computed styles at rest: no hover anywhere
  await page.mouse.move(0, 0);
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`Fantay UI cascade · ${theme}`, () => {
    test(`[P1] the gallery loads in the ${theme} theme`, async ({ page }) => {
      await openGallery(page, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.getByTestId('fx-gallery')).toHaveClass(/(?:^|\s)fx(?:\s|$)/);
    });

    test(`[P1] primitives render identically inside .fx and in the legacy probe (${theme})`, async ({ page }) => {
      await openGallery(page, theme);
      const probeIds = await page
        .getByTestId('fx-legacy-probe')
        .locator('[data-testid$="--legacy"]')
        .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid') ?? ''));
      expect(probeIds.length, 'legacy probe specimens').toBeGreaterThanOrEqual(15);

      for (const probeId of probeIds) {
        const id = probeId.replace(/--legacy$/, '');
        const inside = await computedStyle(page, 'fx-gallery', id);
        const outside = await computedStyle(page, 'fx-legacy-probe', probeId);
        expect(outside, `${id}: .fx vs .fx-legacy computed style`).toEqual(inside);
      }
    });

    test(`[P1] button geometry, disabled identity and the focus ring (${theme})`, async ({ page }) => {
      await openGallery(page, theme);
      const primary = await computedStyle(page, 'fx-gallery', 'specimen-button-primary-md');
      expect(primary.height).toBe('32px');
      expect(primary['font-size']).toBe('12.5px');
      expect(primary['font-weight']).toBe('500');
      expect(primary.transform).toBe('none');

      const disabled = await computedStyle(page, 'fx-gallery', 'specimen-button-primary-md-disabled');
      expect(disabled.opacity).toBe('0.45');
      expect(disabled['background-color']).toBe(primary['background-color']);

      // keyboard focus → :focus-visible → the one ring (2px solid)
      await page.getByTestId('specimen-button-primary-sm').focus();
      await page.keyboard.press('Tab');
      const target = page.getByTestId('fx-gallery').getByTestId('specimen-button-primary-md');
      await expect(target).toBeFocused();
      const ring = await target.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return { width: style.outlineWidth, style: style.outlineStyle };
      });
      expect(ring).toEqual({ width: '2px', style: 'solid' });
    });

    test(`[P1] the scoped preflight stops at .fx and legacy markup keeps its styles (${theme})`, async ({ page }) => {
      await openGallery(page, theme);
      const raw = await computedStyle(page, 'fx-gallery', 'fx-raw-button');
      expect(raw.height, 'raw <button> inside .fx is reset by the scoped preflight').not.toBe('36px');

      const legacyRaw = await computedStyle(page, 'fx-legacy-probe', 'legacy-raw-button');
      expect(legacyRaw.height, 'raw <button> outside .fx keeps the legacy element rule').toBe('36px');

      const legacyPrimary = await computedStyle(page, 'fx-legacy-probe', 'legacy-raw-primary');
      expect(legacyPrimary['border-top-left-radius']).toBe('999px');
    });
  });
}
