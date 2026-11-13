import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createMovieDocument, MOVIE_STYLES } from '@open-design/contracts';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { seedFantayShell } from '@/playwright/fantay-shell-flag';
import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';

test('video projects use animation styles while preserving their storyboard', async ({ page }) => {
  test.setTimeout(T.xlong * 3);
  const output = path.resolve(import.meta.dirname, '../../.tmp/desktop-ui-audit-20261029/motion');
  await mkdir(output, { recursive: true });
  await applyStandardMocks(page);
  await seedFantayShell(page, 'on');
  await page.addInitScript(() => {
    localStorage.setItem('open-design:locale', 'zh-CN');
    localStorage.setItem('open-design:locale-source', 'manual');
  });
  const id = `style-workspace-${randomUUID()}`;
  expect((await page.request.post('/api/projects', { data: { id, name: '动画风格检查', skillId: 'fantay-movie',
    metadata: { kind: 'video', intent: 'motion-design', videoModel: 'hyperframes-html' } } })).ok()).toBeTruthy();
  const document = createMovieDocument('动画风格检查'); document.brief = 'A seed grows into a garden.';
  expect((await page.request.put(`/api/projects/${id}/movie`, { data: { expectedRevision: 0, document } })).ok()).toBeTruthy();
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(`/projects/${id}/files/movie-studio.json`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('motion-editor')).toBeVisible({ timeout: T.long });
    await expect(page.getByTestId('motion-editor').getByTestId('movie-inspector')).toBeHidden();
    await page.getByTestId('workspace-add-tab').click();
    const styleTool = page.getByTestId('workspace-tool-design-system');
    await expect(styleTool).toHaveText('动画风格');
    await styleTool.click();
    const workspace = page.getByTestId('motion-style-workspace');
    await expect(workspace.getByTestId('movie-style-catalog')).toBeVisible();
    await expect(workspace.getByTestId('movie-stage-bar')).toHaveCount(0);
    await expect(workspace.getByText('关联设计系统')).toHaveCount(0);
    await expect(workspace.getByTestId('movie-style-preview')).toBeVisible();
    await page.screenshot({ path: path.join(output, 'animation-style-workspace.png'), animations: 'disabled' });
    const style = MOVIE_STYLES.find((candidate) => candidate.id !== document.style.id)!;
    await workspace.getByRole('combobox', { name: '风格库' }).click();
    await page.getByRole('option').filter({ hasText: style.name }).last().click();
    const saved = page.waitForResponse((response) => response.url().endsWith(`/projects/${id}/movie`)
      && response.request().method() === 'PUT');
    await workspace.getByRole('button', { name: '保存', exact: true }).click();
    expect((await saved).ok()).toBeTruthy();
    const result = await (await page.request.get(`/api/projects/${id}/movie`)).json();
    expect(result.document.style.id).toBe(style.id);
    expect(result.document.shots.map((shot: { id: string }) => shot.id)).toEqual(document.shots.map((shot) => shot.id));
    await workspace.getByRole('button', { name: '风格参数', exact: true }).click();
    await expect(workspace.getByTestId('motion-style-fields')).toBeVisible();
    await page.screenshot({ path: path.join(output, 'animation-style-settings.png'), animations: 'disabled' });
    await page.getByRole('tab', { name: 'movie-studio.json' }).click();
    await expect(page.getByTestId('motion-editor')).toBeVisible();
    await expect(page.getByTestId('motion-editor').getByRole('radio', { name: '风格', exact: true })).toHaveCount(0);
    await page.screenshot({ path: path.join(output, 'movie-workspace.png'), animations: 'disabled' });
  } finally { await page.request.delete(`/api/projects/${id}`); }
});
