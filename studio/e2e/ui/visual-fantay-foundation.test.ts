// SPDX-License-Identifier: Apache-2.0
// Fantay visual foundation & restyle verification (spec 01 §8, spec 02 §11.2, amendment B20):
// - /fantay-ui gallery and legacy probe in dark and light themes;
// - Home surface inside FantayShell in dark and light themes (composer disabled send, +/palette discs, title);
// - Workspace board header at 1440px (full labels) and 900px (compact icon+tooltip root tabs & Share CTA) in en & zh.
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';

import { seedFantayShell } from '@/playwright/fantay-shell-flag';
import { seedFantayTheme } from '@/playwright/fantay-theme';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { expect, test } from '@/playwright/suite';
import {
  captureVisual,
  captureVisualTarget,
  configureVisualPage,
  gotoVisualHome,
  scrollVisualLocatorIntoStableView,
  waitForVisualFonts,
  waitForVisualProjects,
} from '@/playwright/visual';
import { T } from '@/timeouts';

async function createVisualProject(page: Page, name: string): Promise<string> {
  const projectId = `visual-fantay-${randomUUID()}`;
  const response = await page.request.post('/api/projects', {
    data: {
      id: projectId,
      name,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype' },
    },
  });
  expect(response.ok(), `create project: ${await response.text()}`).toBeTruthy();
  return projectId;
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`Fantay visual foundation · ${theme}`, () => {
    test(`[P2] captures the /fantay-ui primitive gallery and legacy probe (${theme})`, async ({ page }) => {
      test.setTimeout(T.xlong);
      await seedFantayTheme(page, theme);
      await page.goto('/fantay-ui', { waitUntil: 'domcontentloaded' });
      const gallery = page.getByTestId('fx-gallery');
      const probe = page.getByTestId('fx-legacy-probe');
      await expect(gallery).toBeVisible({ timeout: T.long });
      await expect(probe).toBeVisible({ timeout: T.medium });
      await waitForVisualFonts(page);
      await page.mouse.move(0, 0);

      await captureVisualTarget(page, `visual-fantay-gallery-${theme}`, gallery);
      await scrollVisualLocatorIntoStableView(page, probe);
      await captureVisualTarget(page, `visual-fantay-legacy-probe-${theme}`, probe);
    });

    test(`[P2] captures the Fantay shell home surface and composer (${theme})`, async ({ page }) => {
      test.setTimeout(T.xlong);
      await configureVisualPage(page, { projects: [] });
      let releasePlugins!: () => void;
      const pluginsGate = new Promise<void>((resolve) => {
        releasePlugins = resolve;
      });
      await page.route('**/api/plugins', async (route) => {
        await pluginsGate;
        await route.fulfill({ json: { plugins: [] } });
      });
      await seedFantayTheme(page, theme);
      await seedFantayShell(page, 'on');
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoVisualHome(page);

      await expect(page.getByTestId('fantay-shell')).toBeVisible({ timeout: T.long });
      await expect(page.getByTestId('home-hero')).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await waitForVisualProjects(page, []);
      await waitForVisualFonts(page);

      const submit = page.locator('.home-hero__submit');
      await expect(submit).toBeDisabled();
      const submitOpacity = await submit.evaluate((el) => window.getComputedStyle(el).opacity);
      expect(Number(submitOpacity)).toBeLessThan(0.5);

      await captureVisual(page, `visual-fantay-home-${theme}-1440x900`);

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId('fantay-shell')).toBeVisible();
      await expect(page.getByTestId('home-hero')).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await captureVisual(page, `visual-fantay-home-${theme}-390x844`);
      releasePlugins();
    });
  });
}

test.describe('Fantay workspace compact board header (B20)', () => {
  for (const locale of ['en', 'zh'] as const) {
    test(`[P2] fits the board header without clipping at 1440px and 900px (${locale})`, async ({ page }) => {
      test.setTimeout(T.xlong);
      const theme = locale === 'en' ? 'dark' : 'light';
      await applyStandardMocks(page);
      await seedFantayTheme(page, theme);
      await seedFantayShell(page, 'on');
      await page.addInitScript((lang: string) => {
        window.localStorage.setItem('open-design:locale', lang);
      }, locale);

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('fantay-shell')).toBeVisible({ timeout: T.long });

      const projectId = await createVisualProject(page, 'Header layout verification');
      await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
      const boardTab = page.getByTestId('fantay-workspace-root-board');
      const shareBtn = page.getByTestId('fantay-board-share');
      await expect(boardTab).toBeVisible({ timeout: T.long });
      await expect(shareBtn).toBeVisible({ timeout: T.long });
      await expect(page.getByTestId('board-root')).toBeVisible({ timeout: T.long });
      await captureVisual(page, `visual-fantay-board-${theme}-1440x900`);

      // The active workspace tab and share action stay reachable in the narrow header.
      await page.setViewportSize({ width: 900, height: 720 });
      await expect(boardTab).toBeVisible({ timeout: T.medium });
      await expect(shareBtn).toHaveAttribute('data-compact', 'true', { timeout: T.medium });

      // Validate mobile 390×844 viewport in both dark and light themes.
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId('board-root')).toBeVisible();
      await captureVisual(page, `visual-fantay-board-${theme}-390x844`);
    });
  }
});
