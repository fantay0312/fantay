// SPDX-License-Identifier: Apache-2.0
// The 画板 board (spec 03 §12 UI automation, plan W2-board-nodes-chrome; executed once the board is assembled, W4).
// A real tools-dev daemon owns the project, its files and the board; the project is set up through the HTTP API
// (3 HTML pages and 1 PNG, seeded onto the board by the daemon's sync planner), and the UI writes the board through
// `PATCH /api/projects/:id/board` (04), never PUT.
import type { Page, Response } from '@playwright/test';

import { seedFantayShell } from '@/playwright/fantay-shell-flag';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';

test.describe.configure({ timeout: 90_000 });

/** 2×2 opaque PNG. */
const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGPICzsPRAwQCgAqngZNoX+GOwAAAABJRU5ErkJggg==',
  'base64',
);

function htmlPage(index: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Page ${index}</title></head><body style="margin:0;font-family:sans-serif"><h1>Board page ${index}</h1></body></html>`;
}

async function createProject(page: Page, name: string, htmlCount: number, withPng: boolean): Promise<string> {
  const projectId = `board-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = await page.request.post('/api/projects', {
    data: { id: projectId, name, skillId: null, designSystemId: null, metadata: { kind: 'prototype' } },
  });
  expect(created.ok(), `create project: ${await created.text()}`).toBeTruthy();
  for (let index = 0; index < htmlCount; index += 1) {
    const written = await page.request.post(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      data: { name: `page-${index}.html`, content: htmlPage(index) },
    });
    expect(written.ok(), `write page-${index}.html: ${await written.text()}`).toBeTruthy();
  }
  if (withPng) {
    const uploaded = await page.request.post(`/api/projects/${encodeURIComponent(projectId)}/upload`, {
      multipart: { files: { name: 'cover.png', mimeType: 'image/png', buffer: FIXTURE_PNG } },
    });
    expect(uploaded.ok(), `upload cover.png: ${await uploaded.text()}`).toBeTruthy();
  }
  return projectId;
}

async function showRightPanel(page: Page): Promise<void> {
  const toggle = page.getByTestId('fantay-workspace-panel-toggle').filter({ visible: true }).first();
  await expect(toggle).toBeVisible({ timeout: T.long });
  if (await toggle.getAttribute('aria-pressed') === 'false') await toggle.click();
}

async function openBoard(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
  await showRightPanel(page);
  await expect(page.getByTestId('board-root')).toBeVisible({ timeout: T.long });
}

function frames(page: Page) {
  return page.locator('[data-testid="board-node"][data-kind="frame"]');
}

function isBoardPatch(projectId: string) {
  return (response: Response) =>
    response.request().method() === 'PATCH' &&
    new URL(response.url()).pathname === `/api/projects/${encodeURIComponent(projectId)}/board` &&
    response.ok();
}

/** A press on empty board so keys reach the board (focus inside the root). */
async function focusBoard(page: Page): Promise<void> {
  const stage = page.getByTestId('board-stage');
  const box = await stage.boundingBox();
  if (!box) throw new Error('board stage has no box');
  await page.mouse.click(box.x + box.width - 24, box.y + 24);
}

test.beforeEach(async ({ page }) => {
  await seedFantayShell(page, 'on');
  await applyStandardMocks(page);
});

test('[P1] freehand strokes use the project board and survive a reload', async ({ page }) => {
  const projectId = await createProject(page, 'Freehand board', 0, false);
  await openBoard(page, projectId);
  await page.getByTestId('board-tool-pen').click();
  const box = await page.getByTestId('board-stage').boundingBox();
  if (!box) throw new Error('board stage has no box');
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const saved = page.waitForResponse(isBoardPatch(projectId));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 26, y - 18, { steps: 8 });
  await page.mouse.move(x + 54, y + 12, { steps: 8 });
  await page.mouse.up();
  await saved;
  const stroke = page.getByTestId('board-pen-stroke').locator('polyline');
  const points = await stroke.getAttribute('points');
  expect(points?.split(' ').length).toBeGreaterThan(3);
  await page.reload();
  await showRightPanel(page);
  await expect(stroke).toHaveAttribute('points', points!);
  const files = await page.request.get('/api/projects/' + projectId + '/files');
  expect((await files.json()).files.map((f: { name: string }) => f.name)).not.toContainEqual(expect.stringMatching(/\.sketch\.json$/));
});

test('[P1] live Markdown edits the original UTF-8 file in place', async ({ page }) => {
  const projectId = await createProject(page, 'Live Markdown', 0, false);
  const source = '\uFEFF# Title\r\n\r\n**Bold** text\r\n\r\n| A | B |\n| --- | --- |\n| 1 | 2 |\n';
  const file = '/api/projects/' + projectId + '/files';
  expect((await page.request.post(file, { data: { name: 'notes.md', content: source } })).ok()).toBeTruthy();
  await page.goto('/projects/' + projectId + '/files/notes.md');
  await showRightPanel(page);
  const editor = page.getByTestId('markdown-live-editor');
  await expect(editor.locator('.md-live-strong')).toHaveText('Bold', { timeout: T.long });
  await expect(editor.getByRole('cell', { name: '2' })).toBeVisible();
  await editor.getByText('Title', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' 中文');
  await editor.getByText('Bold', { exact: true }).click();
  await expect(editor.locator('.md-live-h1')).toHaveText('Title 中文');
  const expected = source.replace('Title', 'Title 中文');
  await expect.poll(async () => (await (await page.request.get(file + '/notes.md')).body()).toString('utf8')).toBe(expected);
  await page.reload();
  await showRightPanel(page);
  await expect(editor.locator('.md-live-h1')).toHaveText('Title 中文');
});

test('[P1] the new tab offers one board and creates a live Markdown document', async ({ page }) => {
  const projectId = await createProject(page, 'Unified workspace', 0, false);
  const seed = await page.request.post('/api/projects/' + projectId + '/files', {
    data: { name: 'readme.md', content: '# Workspace' },
  });
  expect(seed.ok()).toBeTruthy();
  await page.goto('/projects/' + projectId + '/files/readme.md');
  await expect(page.getByTestId('markdown-live-editor')).toBeVisible({ timeout: T.long });
  await page.getByTestId('workspace-add-tab').click();
  await expect(page.getByTestId('workspace-tool-board')).toHaveCount(1);
  await expect(page.getByTestId('workspace-action-new-sketch')).toHaveCount(0);
  await page.getByTestId('workspace-action-create-document').click();
  const editor = page.getByTestId('markdown-live-editor');
  await expect(editor).toBeVisible({ timeout: T.long });
  await expect(editor.locator('.md-live-h1')).toHaveText('Document');
  await editor.locator('.md-live-h1').click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' draft');
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Document draft' })).toBeVisible();
  await expect.poll(async () => (await page.request.get('/api/projects/' + projectId + '/files/document.md')).text()).toContain('# Document draft');
  await page.getByRole('tab', { name: 'Edit', exact: true }).click();
  await editor.locator('.cm-content').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await page.request.get('/api/projects/' + projectId + '/files/document.md')).text()).not.toContain('# Document draft');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await page.request.get('/api/projects/' + projectId + '/files/document.md')).text()).toContain('# Document draft');

  const modes = page.getByRole('tablist', { name: /markdown view mode/i });
  await modes.getByRole('tab', { name: 'Code' }).click();
  const input = editor.locator('.cm-content');
  await input.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.insertText(' shared-buffer');
  await modes.getByRole('tab', { name: 'Split' }).click();
  await expect(page.getByLabel('Markdown preview').getByText(/shared-buffer/)).toBeVisible();
  await modes.getByRole('tab', { name: 'Split' }).press('Home');
  await expect(modes.getByRole('tab', { name: 'Edit' })).toBeFocused();
  await expect(modes.getByRole('tab', { name: 'Edit' })).toHaveAttribute('aria-selected', 'true');
  await input.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await page.request.get('/api/projects/' + projectId + '/files/document.md')).text()).not.toContain('shared-buffer');

});

test('[P1] seeded files appear as labelled nodes and ⇧1 fits the board', async ({ page }) => {
  const projectId = await createProject(page, 'Board nodes', 3, true);
  await openBoard(page, projectId);
  await expect(frames(page)).toHaveCount(3, { timeout: T.long });
  await expect(page.locator('[data-testid="board-node"][data-kind="image"]')).toHaveCount(1, { timeout: T.long });
  const labels = page.getByTestId('board-node-label');
  await expect(labels.filter({ hasText: 'page-0.html' }).first()).toBeVisible({ timeout: T.medium });

  const zoom = page.getByTestId('fantay-board-zoom-trigger');
  await expect(zoom).toHaveText(/\d+%/, { timeout: T.medium });
  await focusBoard(page);
  // zoom in first so the fit has something to change
  await page.keyboard.press('ControlOrMeta+Equal');
  await page.keyboard.press('ControlOrMeta+Equal');
  await expect.poll(async () => zoom.textContent(), { timeout: T.medium }).not.toBe('100%');
  const zoomed = await zoom.textContent();
  await page.keyboard.press('Shift+Digit1');
  await expect.poll(async () => zoom.textContent(), { timeout: T.medium }).not.toBe(zoomed);
});

test('[P1] a note made with N + click persists through PATCH /board and a reload; mod+Z removes it', async ({ page }) => {
  const projectId = await createProject(page, 'Board notes', 3, true);
  await openBoard(page, projectId);
  await expect(frames(page)).toHaveCount(3, { timeout: T.long });
  await focusBoard(page);

  const stage = page.getByTestId('board-stage');
  const box = await stage.boundingBox();
  if (!box) throw new Error('board stage has no box');
  await page.keyboard.press('n');
  await expect(stage).toHaveAttribute('data-tool', 'note');
  const created = page.waitForResponse(isBoardPatch(projectId), { timeout: T.medium });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 160);
  await created;
  const editor = page.getByRole('textbox', { name: 'Note' });
  await expect(editor).toBeFocused({ timeout: T.short });
  const saved = page.waitForResponse(isBoardPatch(projectId), { timeout: T.medium });
  await page.keyboard.type('Ship the hero page');
  await page.keyboard.press('ControlOrMeta+Enter');
  await saved;

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('board-root')).toBeVisible({ timeout: T.long });
  const note = page.getByTestId('board-note').filter({ hasText: 'Ship the hero page' });
  await expect(note).toHaveCount(1, { timeout: T.long });

  // undo after the reload works on this window's own edits only: make one more, then undo it
  await focusBoard(page);
  await page.keyboard.press('n');
  const second = page.waitForResponse(isBoardPatch(projectId), { timeout: T.medium });
  await page.mouse.click(box.x + 120, box.y + box.height - 160);
  await second;
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board-note')).toHaveCount(2, { timeout: T.medium });
  await focusBoard(page);
  const undone = page.waitForResponse(isBoardPatch(projectId), { timeout: T.medium });
  await page.keyboard.press('ControlOrMeta+z');
  await undone;
  await expect(page.getByTestId('board-note')).toHaveCount(1, { timeout: T.medium });
});

test('[P1] a selected frame offers Navigate / Edit / Capture; Navigate lifts the shield and Esc restores it', async ({ page }) => {
  const projectId = await createProject(page, 'Board modes', 3, false);
  await openBoard(page, projectId);
  await expect(frames(page)).toHaveCount(3, { timeout: T.long });
  const live = page.locator('[data-testid="board-node"][data-kind="frame"][data-live="true"]').first();
  await expect(live).toBeVisible({ timeout: T.long });
  await expect(live.getByTestId('board-node-shield')).toHaveCount(1);
  await live.getByTestId('board-node-shield').click();

  const bar = page.getByTestId('board-context-bar');
  await expect(bar).toHaveAttribute('data-state', 'open');
  await expect(bar.getByTestId('board-mode-navigate')).toBeVisible();
  await expect(bar.getByTestId('board-mode-edit')).toBeVisible();
  await expect(bar.getByTestId('board-mode-capture')).toBeVisible();

  await bar.getByTestId('board-mode-navigate').click();
  await expect(live.getByTestId('board-node-shield')).toHaveCount(0);
  await expect(page.getByTestId('board-mode-hint')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(live.getByTestId('board-node-shield')).toHaveCount(1, { timeout: T.short });
});

test('[P1] eight frames on screen keep at most four live iframes', async ({ page }) => {
  const projectId = await createProject(page, 'Board live budget', 8, false);
  await openBoard(page, projectId);
  await expect(frames(page)).toHaveCount(8, { timeout: T.long });
  await focusBoard(page);
  await page.keyboard.press('Shift+Digit1');
  await expect(page.locator('[data-testid="board-node"][data-kind="frame"][data-live="true"]').first()).toBeVisible({ timeout: T.long });
  // give the live set a settle and a dwell cycle, then count
  await page.waitForTimeout(1_000);
  const iframes = await page.getByTestId('board-root').locator('iframe').count();
  expect(iframes).toBeLessThanOrEqual(4);
  expect(iframes).toBeGreaterThan(0);
});

test('[P1] dropping a PNG uploads it and adds an image node', async ({ page }) => {
  const projectId = await createProject(page, 'Board drop', 3, false);
  await openBoard(page, projectId);
  await expect(frames(page)).toHaveCount(3, { timeout: T.long });
  const images = page.locator('[data-testid="board-node"][data-kind="image"]');
  await expect(images).toHaveCount(0);

  const root = page.getByTestId('board-root');
  const box = await root.boundingBox();
  if (!box) throw new Error('board root has no box');
  const transfer = await page.evaluateHandle((bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' }));
    return data;
  }, [...FIXTURE_PNG]);
  const point = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await root.dispatchEvent('dragenter', { dataTransfer: transfer, ...point });
  await expect(page.getByTestId('board-drop-overlay')).toHaveAttribute('data-state', 'open');
  await root.dispatchEvent('dragover', { dataTransfer: transfer, ...point });
  const upload = page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/projects/${encodeURIComponent(projectId)}/upload`,
    { timeout: T.medium },
  );
  const placed = page.waitForResponse(isBoardPatch(projectId), { timeout: T.medium });
  await root.dispatchEvent('drop', { dataTransfer: transfer, ...point });
  await upload;
  await placed;
  await expect(page.getByTestId('board-drop-overlay')).toHaveAttribute('data-state', 'closed');
  await expect(images).toHaveCount(1, { timeout: T.medium });
});
