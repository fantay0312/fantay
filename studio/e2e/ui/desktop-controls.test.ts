import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { seedFantayShell } from '@/playwright/fantay-shell-flag';
import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';

test('desktop controls keep one arrow, visible close icons and bounded popovers', async ({ page }) => {
  test.setTimeout(T.xlong * 2);
  const output = path.resolve(import.meta.dirname, '../../.tmp/desktop-ui-audit-20261029/controls');
  await mkdir(output, { recursive: true });
  await applyStandardMocks(page);
  await seedFantayShell(page, 'on');
  await page.addInitScript(() => {
    localStorage.setItem('open-design:locale', 'zh-CN');
    localStorage.setItem('open-design:locale-source', 'manual');
  });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await page.locator('.settings-nav-item').filter({ has: page.getByText('通用', { exact: true }) }).click();
  const language = page.getByRole('combobox', { name: '界面语言' });
  await expect(language).toBeVisible();
  expect(await language.evaluate((element) => getComputedStyle(element).backgroundImage)).toBe('none');
  const languageArrow = page.locator('.settings-general-select .od-icon');
  expect((await languageArrow.boundingBox())!.width).toBeGreaterThanOrEqual(12);
  await page.locator('.settings-general-select').screenshot({ path: path.join(output, 'language.png') });

  // Read every scrollable portion of General without changing any setting.
  const scroll = await page.locator('.settings-content').evaluate((element) => ({ height: element.clientHeight, content: element.scrollHeight }));
  await page.locator('.settings-content').evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await page.screenshot({ path: path.join(output, 'general-bottom.png'), animations: 'disabled' });
  expect(scroll.content).toBeGreaterThan(scroll.height + 64);

  await page.goto('/automations', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('automations-new').click();
  const close = page.locator('.automation-modal__close');
  await expect(close).toBeVisible();
  const icon = await close.locator('svg').boundingBox();
  expect(icon!.width).toBeGreaterThanOrEqual(12);
  expect(icon!.height).toBeGreaterThanOrEqual(12);
  await page.locator('.automation-template-trigger').click();
  await page.screenshot({ path: path.join(output, 'automation-templates.png'), animations: 'disabled' });
  await page.locator('.automation-template-trigger').click();
  await page.locator('.automation-modal__pills .automation-pill').nth(1).click();
  await page.screenshot({ path: path.join(output, 'automation-schedule.png'), animations: 'disabled' });
  for (const node of await page.locator('.automation-popover:visible').all()) {
    const rect = await node.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(1025);
  }
  await close.click();
  await expect(page.getByTestId('automation-modal')).toBeHidden();

  await page.goto('/design-systems/fantay', { waitUntil: 'domcontentloaded' });
  const publish = page.locator('.ds-publish-card label');
  await expect(publish).toBeVisible({ timeout: T.long });
  const size = await publish.boundingBox();
  expect(size!.width).toBeGreaterThan(50);
  expect(size!.height).toBeLessThan(32);
  await publish.screenshot({ path: path.join(output, 'published-status.png') });
});
