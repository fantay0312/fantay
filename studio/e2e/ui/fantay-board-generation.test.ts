// SPDX-License-Identifier: Apache-2.0
// Board generation (spec 05 §11 UI automation, plan W2-gen-ui; executed in W4 once the board is assembled).
// A real tools-dev daemon owns the project and the board; only the media provider endpoints are mocked:
// /api/media/config (OpenAI configured), media/generate (202 with task ids), media/tasks/:id/wait
// (running → done with the requested output name) and the raw gen-*.png files (fixture PNG).
import type { Page, Request, Route } from '@playwright/test';

import { settingsSurface } from '@/playwright/amr';
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

interface GenerateBody {
  surface?: string;
  model?: string;
  prompt?: string;
  output?: string;
  aspect?: string;
}

interface MediaMock {
  generateBodies: GenerateBody[];
  waits: number;
}

type WaitOutcome = 'done' | 'open-settings-failure';

async function routeMediaProviders(page: Page, outcome: WaitOutcome): Promise<MediaMock> {
  const mock: MediaMock = { generateBodies: [], waits: 0 };
  const tasks = new Map<string, { projectId: string; output: string; startedAt: number; polls: number }>();

  await page.route('**/api/media/config', async (route: Route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: { providers: { openai: { configured: true, apiKeyTail: 'e2e1' } } } });
  });

  await page.route('**/api/projects/*/media/generate', async (route: Route) => {
    const request: Request = route.request();
    if (request.method() !== 'POST') {
      await route.fallback();
      return;
    }
    const projectId = decodeURIComponent(new URL(request.url()).pathname.split('/')[3] ?? '');
    const body = (request.postDataJSON() ?? {}) as GenerateBody;
    mock.generateBodies.push(body);
    const taskId = `e2e-task-${mock.generateBodies.length}`;
    const startedAt = Date.now();
    tasks.set(taskId, { projectId, output: body.output ?? `gen-${taskId}.png`, startedAt, polls: 0 });
    await route.fulfill({ status: 202, json: { taskId, status: 'queued', startedAt } });
  });

  await page.route('**/api/media/tasks/*/wait', async (route: Route) => {
    const taskId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').slice(-2)[0] ?? '');
    const task = tasks.get(taskId);
    mock.waits += 1;
    if (!task) {
      await route.fulfill({ status: 404, json: { error: { code: 'TASK_NOT_FOUND', message: 'gone' } } });
      return;
    }
    task.polls += 1;
    const base = { taskId, startedAt: task.startedAt, nextSince: task.polls };
    if (task.polls === 1) {
      await route.fulfill({ json: { ...base, status: 'running', endedAt: null, progress: ['rendering'] } });
      return;
    }
    if (outcome === 'open-settings-failure') {
      await route.fulfill({
        json: {
          ...base,
          status: 'failed',
          endedAt: Date.now(),
          progress: [],
          error: { code: 'MEDIA_PROVIDER_KEY_MISSING', message: 'OpenAI API key is missing', status: 401, nextStep: 'open-settings' },
        },
      });
      return;
    }
    if (task.projectId) {
      await page.request.post(`/api/projects/${encodeURIComponent(task.projectId)}/upload`, {
        multipart: { files: { name: task.output, mimeType: 'image/png', buffer: FIXTURE_PNG } },
      });
    }
    await route.fulfill({
      json: {
        ...base,
        status: 'done',
        endedAt: Date.now(),
        progress: [],
        file: { name: task.output, size: FIXTURE_PNG.length, mtime: Date.now(), kind: 'image', mime: 'image/png', model: 'gpt-image-2', surface: 'image' },
      },
    });
  });

  await page.route('**/api/projects/*/raw/gen-*.png*', async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: FIXTURE_PNG });
  });

  return mock;
}

async function createBoardProject(page: Page, name: string): Promise<string> {
  const projectId = `board-gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await page.request.post('/api/projects', {
    data: { id: projectId, name, skillId: null, designSystemId: null, metadata: { kind: 'prototype' } },
  });
  expect(response.ok(), `create project: ${await response.text()}`).toBeTruthy();
  return projectId;
}

interface StoredBoardNode {
  kind?: string;
  generation?: { candidates?: Array<{ status?: string }> };
}

/** Image nodes of the board as the daemon stores it (the UI writes through PATCH /board). */
async function storedImageNodes(page: Page, projectId: string): Promise<StoredBoardNode[]> {
  const response = await page.request.get(`/api/projects/${encodeURIComponent(projectId)}/board`);
  if (!response.ok()) return [];
  const payload = (await response.json()) as { board?: { nodes?: StoredBoardNode[] } };
  return (payload.board?.nodes ?? []).filter((node) => node.kind === 'image');
}

async function openBoard(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('board-root')).toBeVisible({ timeout: T.long });
}

/** G creates a generator (with the Generate tool armed, a click on the empty board places it). */
async function addGenerator(page: Page): Promise<void> {
  const stage = page.getByTestId('board-stage');
  await stage.click({ position: { x: 40, y: 40 } });
  await page.keyboard.press('g');
  const node = page.getByTestId('fx-gen-node');
  const appeared = await node.first().isVisible({ timeout: T.short }).catch(() => false);
  if (!appeared) {
    const box = await stage.boundingBox();
    if (!box) throw new Error('board stage has no box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await expect(node).toHaveCount(1, { timeout: T.medium });
}

async function openGeneratorPanel(page: Page): Promise<void> {
  const panel = page.getByTestId('fx-gen-panel');
  if (!(await panel.isVisible().catch(() => false))) {
    await page.getByTestId('fx-gen-node').first().click({ position: { x: 60, y: 14 } });
  }
  await expect(panel).toBeVisible({ timeout: T.medium });
}

async function chooseOpenAiImageModel(page: Page): Promise<void> {
  const trigger = page.getByTestId('fx-gen-model-trigger');
  if ((await trigger.getAttribute('data-model')) === 'gpt-image-2') return;
  await trigger.click();
  await page.getByTestId('fx-gen-model-option-gpt-image-2').click();
  await expect(trigger).toHaveAttribute('data-model', 'gpt-image-2');
}

async function writePromptAndRun(page: Page, prompt: string, count: 1 | 2): Promise<void> {
  const editor = page.getByTestId('fx-gen-prompt');
  await editor.click();
  await page.keyboard.type(prompt);
  await chooseOpenAiImageModel(page);
  await page.getByTestId('fx-gen-params-trigger').click();
  await page.getByTestId(`fx-gen-param-count-${count}`).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('fx-gen-params-popover')).toBeHidden();
  const run = page.getByTestId('fx-gen-run');
  await expect(run).not.toHaveAttribute('aria-disabled', 'true');
  await run.click();
}

test.beforeEach(async ({ page }) => {
  await seedFantayShell(page, 'on');
  await applyStandardMocks(page);
});

test('[P1] a generator runs N parallel tasks, fills an output node and survives a reload', async ({ page }) => {
  const media = await routeMediaProviders(page, 'done');
  const projectId = await createBoardProject(page, 'Board generation');
  await openBoard(page, projectId);
  await addGenerator(page);
  await openGeneratorPanel(page);
  await writePromptAndRun(page, 'a neon fox poster', 2);

  await expect.poll(() => media.generateBodies.length, { timeout: T.medium }).toBe(2);
  const [first, second] = media.generateBodies;
  expect(first?.model).toBe('gpt-image-2');
  expect(second?.model).toBe('gpt-image-2');
  expect(first?.surface).toBe('image');
  expect(first?.prompt).toContain('a neon fox poster');
  expect(first?.output).toMatch(/^gen-[0-9a-z]{6}-[0-9a-z]{6}-1\.png$/);
  expect(second?.output).toMatch(/^gen-[0-9a-z]{6}-[0-9a-z]{6}-2\.png$/);
  expect(first?.output).not.toBe(second?.output);

  const output = page.locator('[data-testid="fx-media-node"][data-kind="image"]');
  await expect(output).toHaveCount(1, { timeout: T.long });
  const pill = output.getByTestId('fx-media-count-pill');
  await expect(pill).toBeVisible({ timeout: T.long });
  await expect(output.locator('img').first()).toBeVisible({ timeout: T.long });

  // Fan out the second candidate, make it the cover, then promote it to its own node.
  await pill.click();
  const fanned = output.locator('[data-testid^="fx-media-candidate-"][data-state="open"]');
  await expect(fanned).toHaveCount(1);
  await fanned.hover();
  await fanned.getByTestId('fx-media-set-primary').click();
  await expect(output.locator('[data-primary]')).toHaveAttribute('data-testid', 'fx-media-candidate-1');
  await pill.click();
  await expect(fanned).toHaveCount(0);
  await pill.click();
  const promoteCard = output.locator('[data-testid^="fx-media-candidate-"][data-state="open"]');
  await promoteCard.hover();
  await promoteCard.getByTestId('fx-media-promote').click();
  await expect(page.locator('[data-testid="fx-media-node"][data-kind="image"]')).toHaveCount(2, { timeout: T.medium });

  // The board lives in the daemon: a reload restores both nodes and starts no new generation.
  await expect
    .poll(
      async () => {
        const nodes = await storedImageNodes(page, projectId);
        const done = nodes.flatMap((node) => node.generation?.candidates ?? []).filter((candidate) => candidate.status === 'done');
        return `${nodes.length}:${done.length}`;
      },
      { timeout: T.medium },
    )
    .toBe('2:2');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('board-root')).toBeVisible({ timeout: T.long });
  await expect(page.locator('[data-testid="fx-media-node"][data-kind="image"]')).toHaveCount(2, { timeout: T.long });
  await expect(page.getByTestId('fx-media-count-pill')).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(media.generateBodies).toHaveLength(2);
});

test('[P1] a failed run shows the next-step action that opens Settings ▸ Media providers', async ({ page }) => {
  const media = await routeMediaProviders(page, 'open-settings-failure');
  const projectId = await createBoardProject(page, 'Board generation failure');
  await openBoard(page, projectId);
  await addGenerator(page);
  await openGeneratorPanel(page);
  await writePromptAndRun(page, 'a paper boat', 1);
  await expect.poll(() => media.generateBodies.length, { timeout: T.medium }).toBe(1);

  const panel = page.getByTestId('fx-gen-panel');
  if (!(await panel.isVisible().catch(() => false))) await openGeneratorPanel(page);
  const action = panel.getByTestId('fx-gen-error-action');
  await expect(action).toBeVisible({ timeout: T.long });
  await expect(action).toHaveAttribute('data-next-step', 'open-settings');
  await action.click();
  const dialog = settingsSurface(page).filter({ has: page.getByRole('tab', { name: 'Media providers', selected: true }) });
  await expect(dialog).toBeVisible({ timeout: T.medium });
});
