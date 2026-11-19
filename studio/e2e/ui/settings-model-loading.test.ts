import { expect, test } from '@/playwright/suite';
import { applyStandardMocks, fulfillAgentsRoute, STORAGE_KEY } from '@/playwright/mock-factory';
import { seedFantayShell } from '@/playwright/fantay-shell-flag';

test('[P1] TokenToSea model loading is aligned and finishes on empty or successful retry', async ({ page }) => {
  await applyStandardMocks(page);
  const config = { mode: 'daemon', agentId: 'tokentosea', enabledAgents: ['tokentosea'], agentModels: {}, onboardingCompleted: true, privacyDecisionAt: 1 };
  await page.addInitScript(({ key, config }) => localStorage.setItem(key, JSON.stringify(config)), { key: STORAGE_KEY, config });
  await page.route('**/api/app-config', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { config } }) : route.fulfill({ json: { ok: true } }));
  await page.route('**/api/agents**', route => fulfillAgentsRoute(route, [{ id: 'tokentosea', name: 'TokenToSea', bin: 'opencode-cli', available: true, supportsCustomModel: false, models: [] }]));
  await page.route('**/api/tokentosea/cloud/status*', route => route.fulfill({ json: { loggedIn: true, profile: 'tokentosea', user: { id: 'fixture-user' } } }));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let ready = false;
  await page.route('**/api/tokentosea/cloud/models', async route => {
    await pending;
    await route.fulfill({ json: { source: 'remote', refreshing: false, models: ready ? [{ id: 'fixture-model', label: 'Compatible Chat' }] : [] } });
  });
  try {
    await page.goto('/settings');
    await page.getByRole('tab', { name: /Local CLI|Local coding agent/i }).click();
    const loading = page.getByTestId('settings-agent-model-loading-tokentosea');
    await expect(loading).toBeVisible();
    const geometry = await loading.evaluate(element => {
      const spinner = element.querySelector('[data-slot=spinner]')!.getBoundingClientRect();
      const text = element.querySelector('span:not([data-slot])')!.getBoundingClientRect();
      return { display: getComputedStyle(element).display, centerDelta: Math.abs(spinner.top + spinner.height / 2 - text.top - text.height / 2), gap: parseFloat(getComputedStyle(element).columnGap) };
    });
    expect(geometry.display).toMatch(/^(inline-)?flex$/);
    expect(geometry.centerDelta).toBeLessThan(1);
    expect(geometry.gap).toBeGreaterThanOrEqual(7);
    release();
    const empty = page.getByTestId('settings-agent-model-empty-tokentosea');
    await expect(empty).toBeVisible();
    await expect(loading).toHaveCount(0);
    ready = true;
    await empty.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByText('Compatible Chat', { exact: true }).first()).toBeVisible();
    await expect(empty).toHaveCount(0);
  } finally { release(); }
});

test('[P1] TokenToSea catalog stays readable and saves the exact searched model across reopening', async ({ page }, testInfo) => {
  await applyStandardMocks(page);
  await seedFantayShell(page, 'on');
  const initialId = 'official:deepseek-v4.1-flash';
  const targetId = 'supplier:suanlizhixuan/global/claude-fable-5.1';
  const models = [
    { id: initialId, label: 'DeepSeek V4.1 Flash' },
    { id: 'supplier:lingzhigongfang/global/claude-fable-5', label: '灵智工坊 · Claude Fable 5' },
    { id: 'supplier:lingzhigongfang/global/claude-fable-5.1', label: '灵智工坊 · Claude Fable 5.1',
      channelOffer: { modelKey: 'anthropic/chat/claude-fable-5.1', modelName: 'Claude Fable 5.1', supplier: '灵智工坊', channel: 'global', inputMultiplier: '0.25', outputMultiplier: '0.25' } },
    { id: targetId, label: '算力智选 · Claude Fable 5.1',
      channelOffer: { modelKey: 'anthropic/chat/claude-fable-5.1', modelName: 'Claude Fable 5.1', supplier: '算力智选', channel: 'global', inputMultiplier: '0.3', outputMultiplier: '0.4' } },
    ...Array.from({ length: 25 }, (_, index) => ({
      id: `supplier:lingzhigongfang/global/model-${index}`,
      label: `灵智工坊 · Model ${index} with a long preview version 2026-11-06`,
    })),
  ];
  const config = { mode: 'daemon', agentId: 'tokentosea', enabledAgents: ['tokentosea'], agentModels: { tokentosea: { model: initialId, reasoning: 'high' } }, onboardingCompleted: true, privacyDecisionAt: 1 };
  await page.addInitScript(({ key, config }) => {
    if (!localStorage.getItem('model-picker-test-seeded')) {
      localStorage.setItem(key, JSON.stringify(config));
      localStorage.setItem('model-picker-test-seeded', '1');
    }
    localStorage.setItem('open-design:locale', 'zh-CN');
    localStorage.setItem('open-design:locale-source', 'manual');
  }, { key: STORAGE_KEY, config });
  await page.unroute('**/api/app-config');
  expect((await page.request.put('/api/app-config', { data: config })).ok()).toBe(true);
  await page.route('**/api/agents**', route => fulfillAgentsRoute(route, [{ id: 'tokentosea', name: 'TokenToSea', bin: 'opencode-cli', available: true, supportsCustomModel: false, models }]));
  await page.route('**/api/tokentosea/cloud/status*', route => route.fulfill({ json: { loggedIn: true, profile: 'tokentosea', user: { id: 'fixture-user' } } }));
  await page.route('**/api/tokentosea/cloud/models', route => route.fulfill({ json: { source: 'remote', refreshing: false, models } }));
  await page.goto('/settings');
  await page.getByRole('tab', { name: '本机 CLI', exact: true }).click();
  const trigger = page.getByRole('combobox', { name: '模型', exact: true });
  const popover = page.getByTestId('settings-agent-model-popover-tokentosea');
  const search = page.getByTestId('settings-agent-model-search-tokentosea');
  await trigger.click();
  await expect(search).toBeFocused();
  await expect(popover.getByText(/Supplier:|Official:/)).toHaveCount(0);
  await popover.getByRole('button', { name: 'Claude Fable 5.1', exact: true }).click();
  await popover.getByRole('button', { name: 'Claude Fable 5', exact: true }).hover();
  await expect(popover.getByRole('option', { name: '灵智工坊 · global', exact: true })).toBeVisible();
  await expect(popover.getByRole('option', { name: '算力智选 · global', exact: true })).toBeVisible();
  await expect(popover.getByRole('option', { name: '灵智工坊 · global', exact: true })).toContainText('0.25×');
  await expect(popover.getByRole('option', { name: '算力智选 · global', exact: true })).toContainText('输入 0.3× · 输出 0.4×');

  for (const width of [1280, 820]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await popover.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const rows = [...element.querySelectorAll('.model-select-searchable__option')];
      const names = [...element.querySelectorAll('.model-select-searchable__company-name')];
      return {
        fits: rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        labelsFit: rows.every(row => {
          const label = row.querySelector('.model-select-searchable__option-label')!;
          return label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= label.clientHeight + 1;
        }),
        countsSeparate: names.every(name => name.getBoundingClientRect().right <= name.nextElementSibling!.getBoundingClientRect().left),
        sourceNamesFit: names.every(name => {
          const label = name.querySelector('span')!;
          return label.scrollWidth <= label.clientWidth + 1;
        }),
      };
    });
    expect(geometry).toEqual({ fits: true, labelsFit: true, countsSeparate: true, sourceNamesFit: true });
    await testInfo.attach(`catalog-${width}`, { body: await page.screenshot(), contentType: 'image/png' });
  }

  const lastModel = popover.getByRole('button', { name: 'Model 24 with a long preview version 2026-11-06', exact: true });
  await lastModel.scrollIntoViewIfNeeded();
  await lastModel.click();
  await popover.getByRole('option', { name: '灵智工坊 · global', exact: true }).click();
  await expect(trigger).toContainText('Model 24');
  await trigger.click();
  await expect(popover.getByRole('option', { selected: true })).toHaveAccessibleName('灵智工坊 · global');

  await search.fill('Claude Fable 5.1');
  await expect(popover.getByRole('option')).toHaveCount(2);
  await expect(popover.getByRole('option').nth(1)).toContainText('算力智选');
  await search.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(popover.getByRole('option').nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(popover).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText('Claude Fable 5.1 · 算力智选 · global');
  await expect.poll(async () => (await (await page.request.get('/api/app-config')).json()).config.agentModels?.tokentosea?.model).toBe(targetId);
  await page.reload();
  // Desktop settings is an overlay; its entry route returns to Home on reload.
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '本机 CLI', exact: true }).click();
  await expect(trigger).toContainText('Claude Fable 5.1 · 算力智选 · global');
  await trigger.click();
  await expect(popover.getByRole('option', { selected: true })).toHaveAccessibleName('算力智选 · global');
  await search.fill('no-such-model');
  await expect(popover.getByRole('option')).toHaveCount(0);
  await expect(popover).toContainText('没有符合条件的模型');
  await search.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(trigger).toContainText('Claude Fable 5.1 · 算力智选 · global');
});
