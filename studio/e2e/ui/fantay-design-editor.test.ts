// SPDX-License-Identifier: Apache-2.0
// Fantaydesign design documents end to end (spec 06 §11.1 e2e, plan W2-design-host): a design is created
// from the board "+" ▸ 设计文档, opens in place in the 文件 root (no separate page, dark by default),
// saves as a project file through the CAS API, survives a reload, serves a cover, follows the app theme
// without reloading the editor, resolves a save conflict with "Load latest version", picks tools with
// V / R / T / F and undoes with mod+Z. Runs with the canvas build present and the board assembled (W3); executed in W4.
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Frame, Page } from '@playwright/test';

import { seedFantayShell } from '@/playwright/fantay-shell-flag';
import { seedFantayTheme } from '@/playwright/fantay-theme';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';

const EDITOR_ENTRY = new URL('../../apps/web/public/canvas-editor/index.html', import.meta.url);

test.describe.configure({ timeout: T.xlong * 3 });

test.beforeAll(() => {
  if (!existsSync(EDITOR_ENTRY)) {
    throw new Error('The design editor build is missing (apps/web/public/canvas-editor) — run `pnpm --filter @fantay/canvas build`');
  }
});

test.beforeEach(async ({ page }) => {
  await applyStandardMocks(page);
  await seedFantayShell(page, 'on');
  await seedFantayTheme(page, 'dark');
});

async function createProject(page: Page, name: string): Promise<string> {
  const config = await page.request.put('/api/app-config', {
    data: { onboardingCompleted: true, agentId: 'mock', agentModels: {}, agentCliEnv: {}, skillId: null, designSystemId: null, odNextStrategyMode: 'off' },
  });
  expect(config.ok(), await config.text()).toBe(true);
  const id = randomUUID();
  const created = await page.request.post('/api/projects', { data: { id, name } });
  expect(created.ok(), await created.text()).toBe(true);
  return id;
}

function contentUrl(projectId: string, path: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/designs/content?path=${encodeURIComponent(path)}`;
}

function editorFrame(page: Page): Frame {
  const frame = page.frames().find((candidate) => candidate.url().includes('/canvas-editor/index.html'));
  if (!frame) throw new Error('design editor iframe not found');
  return frame;
}

async function waitForEditing(page: Page): Promise<void> {
  await expect(page.getByTestId('design-editor-host')).toHaveAttribute('data-phase', 'editing', { timeout: T.xlong });
}

/** Board "+" ▸ 设计文档 ▸ name ▸ 创建; returns once the design is open in the 文件 root. */
async function createDesignFromBoard(page: Page, projectId: string, name: string): Promise<void> {
  await page.goto(`/projects/${projectId}`);
  await page.getByTestId('fantay-workspace-root-board').click({ timeout: T.long });
  await page.getByTestId('board-tool-insert').click({ timeout: T.long });
  await page.getByRole('menuitem', { name: /Design document/ }).click();
  const dialog = page.getByTestId('new-design-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('new-design-name').fill(name);
  await expect(dialog.getByTestId('new-design-path')).toHaveText(`designs/${name}.fig`);
  await dialog.getByTestId('new-design-create').click();
  await expect(dialog).toBeHidden({ timeout: T.xlong });
  await waitForEditing(page);
  await expect(page.getByTestId('design-editor-header')).toContainText(`${name}.fig`);
}

/** Draws a rectangle with the R tool in the middle of the editor viewport. */
async function drawRectangle(page: Page, offset = 0): Promise<void> {
  const box = await page.getByTestId('design-editor-frame').boundingBox();
  if (!box) throw new Error('editor frame has no box');
  const x = box.x + box.width / 2 + offset;
  const y = box.y + box.height / 2 + offset;
  await page.mouse.click(x - 120, y - 120);
  await page.keyboard.press('r');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 80, { steps: 6 });
  await page.mouse.up();
}

async function currentSha(page: Page, projectId: string, path: string): Promise<string> {
  const head = await page.request.fetch(contentUrl(projectId, path), { method: 'HEAD' });
  expect(head.ok()).toBe(true);
  return (head.headers()['etag'] ?? '').replace(/"/g, '');
}

test('[P1] a new design from the board opens in place in the 文件 root, dark by default', async ({ page }) => {
  const projectId = await createProject(page, `Design editor ${randomUUID().slice(0, 8)}`);
  await createDesignFromBoard(page, projectId, '首页');
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/`));
  await expect(page.getByRole('tab', { name: 'designs/首页.fig' })).toHaveAttribute('aria-selected', 'true');
  // The iframe holds only the editor: dark theme, no app header of its own.
  await expect.poll(() => editorFrame(page).evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  const content = await page.request.get(contentUrl(projectId, 'designs/首页.fig'));
  expect(content.status()).toBe(200);
  expect(content.headers()['etag']).toMatch(/^"[0-9a-f]{64}"$/);
});

test('[P1] edits autosave to the project, survive a reload and produce a cover', async ({ page }) => {
  const projectId = await createProject(page, `Design save ${randomUUID().slice(0, 8)}`);
  await createDesignFromBoard(page, projectId, 'Landing');
  const before = await currentSha(page, projectId, 'designs/Landing.fig');
  await drawRectangle(page);
  await expect(page.getByTestId('design-save-status')).toHaveAttribute('data-status', 'saved', { timeout: T.medium });
  await expect.poll(() => currentSha(page, projectId, 'designs/Landing.fig'), { timeout: T.medium }).not.toBe(before);

  await expect
    .poll(
      async () => {
        const cover = await page.request.get(`/api/projects/${projectId}/designs/cover?path=${encodeURIComponent('designs/Landing.fig')}`);
        return cover.ok() ? cover.headers()['content-type'] : `status ${cover.status()}`;
      },
      { timeout: T.long },
    )
    .toContain('image/png');

  await page.goto(`/projects/${projectId}/files/designs/Landing.fig`);
  await waitForEditing(page);
  await expect(page.frameLocator('[data-testid="design-editor-frame"]').getByText(/Rectangle/).first()).toBeVisible({ timeout: T.long });
});

test('[P1] switching the app theme restyles the editor without reloading it', async ({ page }) => {
  const projectId = await createProject(page, `Design theme ${randomUUID().slice(0, 8)}`);
  await createDesignFromBoard(page, projectId, 'Theme');
  const src = await page.getByTestId('design-editor-frame').getAttribute('src');
  const bootedAt = await editorFrame(page).evaluate(() => performance.timeOrigin);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await expect.poll(() => editorFrame(page).evaluate(() => document.documentElement.dataset.theme)).toBe('light');
  expect(await page.getByTestId('design-editor-frame').getAttribute('src')).toBe(src);
  expect(await editorFrame(page).evaluate(() => performance.timeOrigin)).toBe(bootedAt);
});

test('[P1] a write from elsewhere raises the conflict banner; "Load latest version" shows it', async ({ page }) => {
  const projectId = await createProject(page, `Design conflict ${randomUUID().slice(0, 8)}`);
  await createDesignFromBoard(page, projectId, 'Conflict');
  const blank = await (await page.request.get(contentUrl(projectId, 'designs/Conflict.fig'))).body();
  await drawRectangle(page);
  await expect(page.getByTestId('design-save-status')).toHaveAttribute('data-status', 'saved', { timeout: T.medium });
  const withRectangle = await currentSha(page, projectId, 'designs/Conflict.fig');

  // Another writer puts the blank version back (CAS on the current sha).
  const external = await page.request.put(contentUrl(projectId, 'designs/Conflict.fig'), {
    headers: { 'Content-Type': 'application/octet-stream', 'If-Match': `"${withRectangle}"` },
    data: blank,
  });
  expect(external.status(), await external.text()).toBe(200);

  await drawRectangle(page, 60);
  await expect(page.getByTestId('design-conflict-banner')).toBeVisible({ timeout: T.long });
  await page.getByRole('button', { name: 'Load latest version' }).click();
  await expect(page.getByTestId('design-conflict-banner')).toBeHidden({ timeout: T.long });
  await expect(page.frameLocator('[data-testid="design-editor-frame"]').getByText(/Rectangle/)).toHaveCount(0, { timeout: T.long });
});

test('[P1] keyboard: V / R / T / F pick the tool and mod+Z undoes a drawn rectangle', async ({ page }) => {
  const projectId = await createProject(page, `Design keys ${randomUUID().slice(0, 8)}`);
  await createDesignFromBoard(page, projectId, 'Keys');
  const editor = page.frameLocator('[data-testid="design-editor-frame"]');
  const box = await page.getByTestId('design-editor-frame').boundingBox();
  if (!box) throw new Error('editor frame has no box');
  // Focus the canvas, then switch tools; the toolbar marks the active one with aria-pressed (06 §11.1 case 7).
  await page.mouse.click(box.x + box.width / 2 - 120, box.y + box.height / 2 - 120);
  for (const [key, tool] of [['r', 'rectangle'], ['t', 'text'], ['f', 'frame'], ['v', 'select']] as const) {
    await page.keyboard.press(key);
    await expect(editor.locator(`[data-test-id="toolbar-tool-${tool}"]`)).toHaveAttribute('aria-pressed', 'true');
  }
  await drawRectangle(page);
  await expect(editor.getByText(/Rectangle/).first()).toBeVisible({ timeout: T.long });
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor.getByText(/Rectangle/)).toHaveCount(0, { timeout: T.long });
});
