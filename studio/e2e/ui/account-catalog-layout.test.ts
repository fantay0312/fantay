import { expect, test } from '@/playwright/suite';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { seedFantayShell } from '@/playwright/fantay-shell-flag';

test('[P1] account currency and local model icons remain aligned in dense catalogs', async ({ page }, testInfo) => {
  await applyStandardMocks(page);
  await seedFantayShell(page, 'on');
  await page.addInitScript(() => {
    localStorage.setItem('open-design:locale', 'zh-CN');
    localStorage.setItem('open-design:locale-source', 'manual');
  });
  await page.route('**/api/tokentosea/service/models?*', route => route.fulfill({ json: { data: [
    { id: 'jev-1', model: 'jev-1', displayName: 'Jev 1.14', brand: 'typesafe', icon: 'typesafe', provider: 'relay', brandLabel: 'TypeSafe', modality: 'system_one', supplyLabel: '官方直供' },
    { id: 'jev-2', model: 'jev-2', displayName: 'Jev 1.13', brand: 'typesafe', icon: 'typesafe', provider: 'relay', brandLabel: 'TypeSafe', modality: 'system_one', supplyLabel: '官方直供' },
    { id: 'deepseek', model: 'deepseek', displayName: 'DeepSeek Flash', brand: 'deepseek', icon: 'deepseek-color', provider: 'relay', brandLabel: 'DeepSeek', modality: 'chat', supplyLabel: '官方直供' },
  ] } }));
  await page.route('**/api/tokentosea/service/tools', route => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/api/tokentosea/service/wallet', route => route.fulfill({ json: { availableUsd: '100.00' } }));
  await page.route('**/api/tokentosea/currency?*', route => route.fulfill({ json: { base: 'USD', currency: 'CNY', rate: 7, validUntil: Date.now() + 300000, asOf: new Date().toISOString(), source: 'https://www.exchangerate-api.com' } }));
  await page.goto('/settings');
  await page.getByTestId('settings-nav-account').click();
  const account = page.getByTestId('settings-account');
  await expect(account.getByTestId('settings-account-balance')).toHaveText('¥700.00');
  const rows = account.locator('[data-service-id]');
  await expect(rows).toHaveCount(3);
  await expect.poll(() => rows.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(rows.nth(0).locator('img')).toHaveAttribute('src', '/model-brand-icons/typesafe.svg');
  await expect(rows.nth(2).locator('img')).toHaveAttribute('src', '/model-brand-icons/deepseek-color.svg');
  await rows.nth(1).click();
  for (const width of [1280, 820]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await rows.evaluateAll(items => items.map(item => {
      const r = item.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    }));
    expect(bounds.every(row => row.height >= 52)).toBe(true);
    expect(bounds.slice(1).every((row, i) => row.top >= bounds[i]!.bottom)).toBe(true);
  }
  await testInfo.attach('account-catalog', { body: await page.screenshot(), contentType: 'image/png' });
});
