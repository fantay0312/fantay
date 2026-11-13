import { test, expect } from '@/playwright/suite';
import { applyStandardMocks, routeTokenToSeaStatus } from '@/playwright/mock-factory';

test('[P1] language codes keep aligned columns when the selection and text direction change', async ({ page }) => {
  await applyStandardMocks(page);
  await routeTokenToSeaStatus(page, false);
  await page.goto('/onboarding');
  const trigger = page.locator('.lang-pill');
  await expect(trigger).toBeVisible();
  for (const code of ['zh-CN', 'ar', 'en']) {
    await trigger.click();
    await page.locator('.lang-menu-item').filter({ has: page.locator('.lang-menu-code', { hasText: new RegExp(`^${code}$`) }) }).click();
    await expect(page.locator('.lang-menu-popover')).toHaveCount(0);
    await trigger.click();
    await expect.poll(() => page.locator('.lang-menu-check').evaluateAll(checks =>
      Math.max(...checks.map(check => Math.abs(check.getBoundingClientRect().width - 14))),
    )).toBeLessThan(0.5);
    const columns = await page.locator('.lang-menu-item').evaluateAll(items => items.map(item => {
      const code = item.querySelector('.lang-menu-code')!;
      const check = item.querySelector('.lang-menu-check')!;
      const rect = code.getBoundingClientRect();
      return { left: rect.left, right: rect.right, overflow: code.scrollWidth - code.clientWidth, checkWidth: check.getBoundingClientRect().width };
    }));
    expect(columns).toHaveLength(19);
    expect(Math.max(...columns.map(c => c.left)) - Math.min(...columns.map(c => c.left))).toBeLessThan(1);
    expect(Math.max(...columns.map(c => c.right)) - Math.min(...columns.map(c => c.right))).toBeLessThan(1);
    expect(Math.max(...columns.map(c => c.overflow))).toBeLessThanOrEqual(1);
    expect(columns.every(c => Math.abs(c.checkWidth - 14) < 0.5)).toBe(true);
    await expect(page.locator('.lang-menu-check svg')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.lang-menu-popover')).toHaveCount(0);
  }
});
