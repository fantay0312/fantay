// SPDX-License-Identifier: Apache-2.0
// Canvas pages and the docked 参考 / 我的素材 panels. A real tools-dev daemon owns the project and the board; the
// project is set up through the HTTP API.
import type { Page } from '@playwright/test';

import { seedFantayShell } from '@/playwright/fantay-shell-flag';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';

test.describe.configure({ timeout: 90_000 });

const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGPICzsPRAwQCgAqngZNoX+GOwAAAABJRU5ErkJggg==',
  'base64',
);

async function createProject(page: Page, name: string): Promise<string> {
  const projectId = `board-pages-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = await page.request.post('/api/projects', {
    data: { id: projectId, name, skillId: null, designSystemId: null, metadata: { kind: 'prototype' } },
  });
  expect(created.ok(), `create project: ${await created.text()}`).toBeTruthy();
  const written = await page.request.post(`/api/projects/${encodeURIComponent(projectId)}/files`, {
    data: { name: 'index.html', content: '<!doctype html><html><body><h1>Page one</h1></body></html>' },
  });
  expect(written.ok(), `write index.html: ${await written.text()}`).toBeTruthy();
  return projectId;
}

async function openBoard(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('board-root')).toBeVisible({ timeout: T.long });
}

const boardNodes = (page: Page) => page.locator('[data-testid="board-node"]:not([data-kind="group"])');

test.beforeEach(async ({ page }) => {
  await seedFantayShell(page, 'on');
  await applyStandardMocks(page);
});

test('[P1] pages keep their own content, survive a reload and can be removed', async ({ page }) => {
  const projectId = await createProject(page, 'Board pages');
  await openBoard(page, projectId);
  await expect(boardNodes(page)).toHaveCount(1, { timeout: T.long });
  const tabs = page.getByTestId('board-page-tab');
  await expect(tabs).toHaveCount(1);

  await page.getByTestId('board-page-add').click();
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(boardNodes(page)).toHaveCount(0);

  // a note on the new page stays on it
  const stage = page.getByTestId('board-stage');
  const box = await stage.boundingBox();
  if (!box) throw new Error('board stage has no box');
  await page.mouse.click(box.x + box.width - 24, box.y + 24);
  await page.keyboard.press('n');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(boardNodes(page)).toHaveCount(1, { timeout: T.medium });
  await page.keyboard.press('Escape');

  await tabs.first().click();
  await expect(boardNodes(page).first()).toHaveAttribute('data-kind', 'frame', { timeout: T.medium });

  await tabs.nth(1).click();
  await expect.poll(async () => {
    const response = await page.request.get(`/api/projects/${encodeURIComponent(projectId)}/board`);
    const { board } = (await response.json()) as { board: { pages?: unknown[]; activePageId?: string } };
    return { pages: board.pages?.length, active: Boolean(board.activePageId) };
  }, { timeout: T.long }).toEqual({ pages: 2, active: true });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(tabs).toHaveCount(2, { timeout: T.long });
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(boardNodes(page).first()).toHaveAttribute('data-kind', 'note', { timeout: T.long });

  await page.getByTestId('board-page-more').click();
  await page.getByTestId('board-page-delete').click();
  await page.getByRole('button', { name: /delete page/i }).last().click();
  await expect(tabs).toHaveCount(1, { timeout: T.medium });
  await expect(boardNodes(page).first()).toHaveAttribute('data-kind', 'frame', { timeout: T.medium });
});

test('[P1] the references panel lists uploads and places them on the page in view', async ({ page }) => {
  const projectId = await createProject(page, 'Board references');
  await openBoard(page, projectId);
  await page.getByTestId('board-panel-toggle-references').click();
  await expect(page.getByTestId('board-refs-empty')).toBeVisible({ timeout: T.medium });

  await page.getByTestId('board-refs-input').setInputFiles({ name: 'mood.png', mimeType: 'image/png', buffer: FIXTURE_PNG });
  const grid = page.getByTestId('board-refs-grid');
  await expect(grid.getByText('mood.png')).toBeVisible({ timeout: T.long });

  await grid.locator('li').first().hover();
  await page.getByTestId('board-page-add').click();
  await grid.locator('li').first().hover();
  await page.getByTestId('board-refs-place').click();
  await expect(page.locator('[data-testid="board-node"][data-kind="image"]')).toHaveCount(1, { timeout: T.medium });
});

test('[P1] a character created in my assets goes onto the canvas as project files', async ({ page }) => {
  const projectId = await createProject(page, 'Board assets');
  await openBoard(page, projectId);
  await page.getByTestId('board-panel-toggle-assets').click();
  await page.getByTestId('board-assets-tab-character').click();
  await page.getByTestId('board-assets-create-character').click();
  await page.getByTestId('board-asset-editor').getByRole('textbox').first().fill('Mascot');
  await page.getByTestId('board-asset-editor').locator('input[type="file"]').setInputFiles({
    name: 'mascot.png',
    mimeType: 'image/png',
    buffer: FIXTURE_PNG,
  });
  await page.getByTestId('board-asset-save').click();
  const card = page.getByTestId('board-assets-card').filter({ hasText: 'Mascot' });
  await expect(card).toBeVisible({ timeout: T.medium });

  await card.hover();
  await card.getByRole('button').first().click();
  await expect(page.locator('[data-testid="board-node"][data-kind="image"]')).toHaveCount(1, { timeout: T.long });
});
