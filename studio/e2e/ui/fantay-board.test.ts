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

async function openBoard(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
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
