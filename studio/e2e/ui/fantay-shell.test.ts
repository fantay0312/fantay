// SPDX-License-Identifier: Apache-2.0
// Fantay workspace shell (spec 02 §14 e2e, amendments B5/B6/C3/C4, plan R9). The suite seeds the shell `off`
// per context (91 B9); every case here turns it on for its page with `seedFantayShell(page, 'on')`.
import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import { seedFantayShell } from '@/playwright/fantay-shell-flag';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';

const ACCOUNT_ACTIONS_HOST = '#workspace-chrome-account-actions';

async function openShellHome(page: Page): Promise<void> {
  await applyStandardMocks(page);
  await seedFantayShell(page, 'on');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('fantay-shell')).toBeVisible({ timeout: T.long });
}

async function createProject(page: Page, name: string): Promise<string> {
  const projectId = `fantay-shell-${randomUUID()}`;
  const response = await page.request.post('/api/projects', {
    data: { id: projectId, name, skillId: null, designSystemId: null, pendingPrompt: null, metadata: { kind: 'prototype' } },
  });
  expect(response.ok(), `create project: ${await response.text()}`).toBeTruthy();
  return projectId;
}

test.describe('Fantay shell', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('[P1] home renders inside the shell with the sidebar and the creation chips', async ({ page }) => {
    await openShellHome(page);
    await expect(page.getByTestId('fantay-sidebar')).toBeVisible();
    await expect(page.getByTestId('fantay-shell-main')).toBeVisible();
    await expect(page.getByTestId('fantay-home-type-row')).toBeVisible({ timeout: T.long });
    for (const chipId of ['prototype', 'image', 'video', 'motion-design', 'social', 'deck', 'document', 'more']) {
      await expect(page.getByTestId(`fantay-home-chip-${chipId}`)).toBeVisible();
    }
    // the upstream tabs bar and entry rail are not on screen in Fantay mode
    await expect(page.locator('.workspace-tabs-chrome')).toHaveCount(0);
    await expect(page.locator('.entry-nav-rail')).toBeHidden();
  });

  test('[P1] a project created through the API is listed and opens from the sidebar', async ({ page }) => {
    await openShellHome(page);
    const projectId = await createProject(page, 'Fantay shell sidebar project');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const row = page.getByTestId(`fantay-sidebar-project-${projectId}`);
    await expect(row).toBeVisible({ timeout: T.long });
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}`), { timeout: T.long });
    await expect(page.getByTestId('fantay-shell')).toHaveAttribute('data-route-kind', 'project');
    await expect(page.getByTestId(`fantay-sidebar-project-${projectId}`)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('workspace-add-tab')).toBeVisible({ timeout: T.long });
  });

  test('[P1] mod+Backslash flips the sidebar between expanded and the rail (B5)', async ({ page }) => {
    await openShellHome(page);
    const shell = page.getByTestId('fantay-shell');
    await expect(shell).toHaveAttribute('data-sidebar', 'expanded');
    // shell shortcuts skip typing targets: move focus off the Home composer first
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // Desktop Chrome emulates Windows, even when Playwright itself runs on macOS.
    // ControlOrMeta follows the runner OS, so use the browser's declared platform.
    const modifier = await page.evaluate(() => {
      const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
      return /mac|iphone|ipad/i.test(nav.userAgentData?.platform ?? nav.platform) ? 'Meta' : 'Control';
    });
    await page.keyboard.press(modifier + '+Backslash');
    await expect(shell).toHaveAttribute('data-sidebar', 'collapsed');
    await expect(page.getByTestId('fantay-sidebar-rail')).toBeVisible();
    await page.keyboard.press(modifier + '+Backslash');
    await expect(shell).toHaveAttribute('data-sidebar', 'expanded');
  });

  test('[P1] exactly one account-actions host in every sidebar mode (B6)', async ({ page }) => {
    await openShellHome(page);
    await expect(page.locator(ACCOUNT_ACTIONS_HOST)).toHaveCount(1);
    await page.getByTestId('fantay-sidebar-collapse').click();
    await expect(page.getByTestId('fantay-shell')).toHaveAttribute('data-sidebar', 'collapsed');
    await expect(page.locator(ACCOUNT_ACTIONS_HOST)).toHaveCount(1);
    await page.setViewportSize({ width: 820, height: 900 });
    await expect(page.getByTestId('fantay-shell')).toHaveAttribute('data-sidebar-mode', 'overlay');
    await expect(page.locator(ACCOUNT_ACTIONS_HOST)).toHaveCount(1);
    await page.getByTestId('fantay-sidebar-overlay-open').click();
    await expect(page.getByTestId('fantay-sidebar-sheet')).toBeVisible();
    await expect(page.locator(ACCOUNT_ACTIONS_HOST)).toHaveCount(1);
  });

  test('[P1] signed-out sidebar shows 登录 / 注册 and the signed-in account menu carries the theme switch and opens Settings ▸ 账户 (R9, R18)', async ({ page }) => {
    await openShellHome(page);
    await expect(page.getByTestId('fantay-sidebar-account')).toContainText(/登录\s*\/\s*注册|Sign in\s*\/\s*Sign up/);
    await page.route('**/api/tokentosea/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: true,
          signedIn: true,
          pending: false,
          user: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
        }),
      });
    });
    await page.evaluate(() => window.dispatchEvent(new Event('fantay:tokentosea-session-changed')));
    await expect(page.getByTestId('fantay-sidebar-account')).toContainText('Ada');
    await page.getByTestId('fantay-sidebar-account').click();
    const menu = page.getByTestId('fantay-sidebar-account-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('fx-theme-segmented')).toBeVisible();
    await menu.getByTestId('fantay-sidebar-account-profile').click();
    await expect(page).toHaveURL(/\/settings/, { timeout: T.long });
    await expect(page.getByTestId('settings-account')).toBeVisible({ timeout: T.long });
  });

  test('[P1] 社媒设计 offers platform sizes and writes the size into the brief (C4)', async ({ page }) => {
    await openShellHome(page);
    // the row stays disabled until HomeView has the plugin catalog
    await expect(page.getByTestId('fantay-home-chip-social')).toBeEnabled({ timeout: T.long });
    await page.getByTestId('fantay-home-chip-social').click();
    await expect(page.getByTestId('fantay-home-social-menu')).toBeVisible();
    await page.getByTestId('fantay-home-social-xhs').click();
    await expect(page.getByTestId('home-hero-input')).toContainText('1242×1660', { timeout: T.medium });
  });

  test('[P1] materials remains a full page while TokenToSea opens settings', async ({ page }) => {
    await applyStandardMocks(page);
    await seedFantayShell(page, 'on');
    await page.goto('/materials', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/materials$/, { timeout: T.long });
    await expect(page.getByTestId('materials-view')).toBeVisible({ timeout: T.long });
    await expect(page.getByTestId('materials-drawer')).toBeHidden();
    await page.goto('/tokentosea', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/settings/, { timeout: T.long });
    await expect(page.getByTestId('settings-account')).toBeVisible({ timeout: T.long });
  });
});
