import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { seedFantayShell } from '@/playwright/fantay-shell-flag';
import { applyStandardMocks, routeAgents } from '@/playwright/mock-factory';
import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';

test('[P1] ordinary folders are indexed into a full-width materials page', async ({ page }, testInfo) => {
  const root = await mkdtemp(path.join(tmpdir(), 'fantay-material-ui-'));
  const first = path.join(root, '旅行素材');
  const second = path.join(root, '品牌素材');
  const prefix = `material-${randomUUID()}`;
  const connected: string[] = [];
  await mkdir(first); await mkdir(second);
  await writeFile(path.join(first, `${prefix}-海报.svg`), '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#c7d5c4"/><circle cx="300" cy="200" r="100" fill="#334438"/></svg>');
  await writeFile(path.join(first, `${prefix}-说明.md`), '# 素材说明');
  await writeFile(path.join(second, `${prefix}-品牌.svg`), '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#e1d6c5"/></svg>');
  try {
    await applyStandardMocks(page);
    await seedFantayShell(page, 'on');
    await page.addInitScript(() => {
      localStorage.setItem('open-design:locale', 'zh-CN');
      localStorage.setItem('open-design:locale-source', 'manual');
    });
    let pickedFolder = first;
    await page.route('**/api/dialog/open-folder', (route) => route.fulfill({ json: { path: pickedFolder } }));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('fantay-sidebar-materials').click();
    await expect(page).toHaveURL(/\/resources$/);
    await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
    await expect(page.getByTestId('resource-module-materials')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('materials-view')).toBeVisible();
    await expect(page.getByTestId('materials-drawer')).toBeHidden();

    async function addFolder() {
      const saved = page.waitForResponse((response) => response.url().endsWith('/api/materials/libraries') && response.request().method() === 'POST');
      await page.getByRole('button', { name: /^(Add library|添加素材库)$/ }).click();
      const response = await saved;
      expect(response.ok()).toBeTruthy();
      const body = await response.json();
      connected.push(body.library.id);
      return body.library;
    }
    // The scope picker is the custom select: its trigger is a button, so open it and click the option.
    async function chooseScope(name: string | RegExp) {
      await page.getByTestId('materials-library-scope').click();
      await page.getByRole('option', { name }).click();
    }
    const a = await addFolder();
    expect(a.kind).toBe('folder');
    expect(a.total).toBe(2);
    await expect(page.getByTestId('materials-library-scope')).toHaveAttribute('value', a.id);
    await expect(page.getByTestId('material-card')).toHaveCount(2);
    const main = await page.getByTestId('fantay-shell-main').boundingBox();
    const materials = await page.getByTestId('materials-view').boundingBox();
    expect(materials!.width).toBeGreaterThan(main!.width * 0.85);
    await page.screenshot({ path: testInfo.outputPath('materials-wide.png') });

    pickedFolder = second;
    const b = await addFolder();
    expect(b.total).toBe(1);
    await expect(page.getByTestId('material-card')).toHaveCount(1);
    await chooseScope(/^(All libraries|全部素材库)$/);
    await page.getByTestId('materials-search').fill(prefix);
    await expect(page.getByTestId('material-card')).toHaveCount(3, { timeout: T.long });

    await page.getByTestId('resource-module-skills').click();
    await expect(page.getByTestId('skills-new')).toBeVisible();
    await page.getByTestId('resource-module-mcp').click();
    await expect(page.getByTestId('resource-module-mcp')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.mcp-add-btn')).toBeVisible();
    await page.getByTestId('resource-module-tutorials').click();
    await expect(page.getByTestId('use-everywhere-section-overview')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('resource-module-mcp')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('resource-module-materials').click();
    await expect(page.getByTestId('materials-search')).toHaveValue(prefix);

    await chooseScope(a.name);
    await page.getByTestId('materials-search').fill('');
    await writeFile(path.join(first, '新增文件.txt'), 'new file');
    await page.getByRole('button', { name: /^(Manage|管理)$/ }).click();
    const rescanned = page.waitForResponse((response) => response.url().endsWith(`/libraries/${a.id}/scan`));
    await page.getByRole('button', { name: /^(Rescan folder|重新扫描)$/ }).first().click();
    expect((await rescanned).ok()).toBeTruthy();
    await expect(page.getByTestId('material-card')).toHaveCount(3);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/resources$/);
    await expect(page.getByTestId('materials-library-scope')).toHaveAttribute('value', a.id);
    await expect(page.getByTestId('material-card')).toHaveCount(3);

    await page.setViewportSize({ width: 820, height: 900 });
    const smallMain = await page.getByTestId('fantay-shell-main').boundingBox();
    const smallMaterials = await page.getByTestId('materials-view').boundingBox();
    expect(smallMaterials!.width).toBeGreaterThan(smallMain!.width * 0.85);
    await expect(page.getByTestId('materials-drawer')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('materials-narrow.png') });
  } finally {
    for (const id of connected) await page.request.delete(`/api/materials/libraries/${id}`);
    await rm(root, { recursive: true, force: true });
  }
});

test('[P1] reasoning strength has one non-repeating chevron in both themes', async ({ page }, testInfo) => {
  await applyStandardMocks(page);
  await seedFantayShell(page, 'on');
  await routeAgents(page, [{ id: 'codex', name: 'Codex', bin: 'codex', available: true,
    version: 'test', models: [{ id: 'default', label: 'Default' }],
    reasoningOptions: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }] }]);
  await page.addInitScript(() => {
    localStorage.setItem('open-design:locale', 'zh-CN');
    localStorage.setItem('open-design:locale-source', 'manual');
  });
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('settings-nav-execution').click();
  await page.getByTestId('settings-agent-select-codex').click();
  const select = page.getByTestId('reasoning-select');
  await expect(select).toBeVisible();
  await select.click();
  await page.getByRole('option', { name: '高', exact: true }).click();
  await expect(select).toContainText('高');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    const height = await select.evaluate((element) => element.getBoundingClientRect().height);
    expect(height).toBe(32);
    await select.locator('..').screenshot({ path: testInfo.outputPath(`reasoning-${theme}.png`) });
  }
});
