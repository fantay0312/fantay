import { expect, test } from '@/playwright/suite';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { seedFantayShell } from '@/playwright/fantay-shell-flag';

test('tool catalog and detail show purpose icons in light and dark themes', async ({ page }, testInfo) => {
  await applyStandardMocks(page);
  await seedFantayShell(page, 'on');
  await page.addInitScript(() => {
    localStorage.setItem('open-design:locale', 'zh-CN');
    localStorage.setItem('open-design:locale-source', 'manual');
  });
  const tools = [
    { id: 'tool_6bce09133ba9995a9d7e9b08abcda670', name: '智能处理 6BCE', description: '车辆年款与评级查询', category: 'ai', icon: 'Car' },
    { id: 'weather', name: '天气查询', description: '天气预报与实时天气', category: 'weather', icon: 'CloudSun' },
    { id: 'air', name: '空气质量', description: '空气污染物与空气质量指数', category: 'weather', icon: 'Wind' },
    { id: 'hotel', name: '酒店研究', description: '酒店信息与住宿查询', category: 'travel', icon: 'Hotel' },
    { id: 'voice', name: '语音制作', description: '语音合成与音频制作', category: 'media', icon: 'AudioLines' },
    { id: 'music', name: '音乐生成', description: '生成与处理音乐', category: 'media', icon: 'Music' },
    { id: 'repo', name: '代码仓库查询', description: '代码仓库与提交查询', category: 'development', icon: 'GitBranch' },
  ];
  await page.route('**/api/tokentosea/service/models?*', route => route.fulfill({ json: { data: [] } }));
  await page.route('**/api/tokentosea/service/tools**', route => route.fulfill({ json: { items: tools, total: tools.length } }));
  await page.route('**/api/tokentosea/service/tools/*/actions', route => route.fulfill({ json: [] }));
  await page.route('**/api/tokentosea/service/wallet', route => route.fulfill({ json: { availableUsd: '0.00' } }));
  await page.goto('/settings');
  await page.getByTestId('settings-nav-account').click();
  const account = page.getByTestId('settings-account');
  await account.getByRole('radio', { name: /工具/ }).click();
  const rows = account.locator('[data-service-id]');
  await expect(rows).toHaveCount(tools.length);
  for (const tool of tools) {
    const row = account.locator(`[data-service-id="${tool.id}"]`);
    await expect(row.locator('svg[data-tool-icon]')).toHaveAttribute('data-tool-icon', tool.icon);
    await expect(row.locator('img')).toHaveCount(0);
  }
  await rows.first().click();
  await expect(account.getByRole('heading', { name: tools[0]!.name })).toBeVisible();
  await expect(account.locator('[data-tool-icon="Car"]')).toHaveCount(2);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await account.getByTestId('tokentosea-services').scrollIntoViewIfNeeded();
    const bounds = await rows.evaluateAll(items => items.map(item => {
      const rect = item.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }));
    expect(bounds.slice(1).every((row, i) => row.top >= bounds[i]!.bottom)).toBe(true);
    await testInfo.attach(`tool-icons-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
  }
});
