// SPDX-License-Identifier: Apache-2.0
// Video & animation folded into the workspace (spec 07 §11 e2e, plan W2-motion-studio): a legacy film link
// opens the in-workspace film editor (history replaced, not pushed); at 1440×900 the editor chrome and its
// controls are on screen without overlaps; at 390×844 the page never scrolls sideways; the folded pages
// land on their surfaces; the MCP Apps surface stays chrome-free; the home 动画/代码视频 chip opens the
// create dialog and cancelling keeps the home draft. Films are seeded only through the HTTP API.
// Runs once the W3 wiring is in (redirects, editor registry, hosts); executed in W4.
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { createMovieDocument } from '@open-design/contracts';

import { seedFantayShell } from '@/playwright/fantay-shell-flag';
import { seedFantayTheme } from '@/playwright/fantay-theme';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';

test.beforeEach(async ({ page }) => {
  await applyStandardMocks(page);
  await seedFantayShell(page, 'on');
  await seedFantayTheme(page, 'dark');
});

/** A fantay-movie project with a film whose brief puts the editor on the storyboard stage. */
async function createFilm(page: Page, name: string): Promise<string> {
  const id = `fantay-motion-${randomUUID()}`;
  const created = await page.request.post('/api/projects', {
    data: {
      id,
      name,
      skillId: 'fantay-movie',
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'video', intent: 'motion-design', videoModel: 'hyperframes-html' },
    },
  });
  expect(created.ok(), `create project: ${await created.text()}`).toBeTruthy();
  const document = createMovieDocument(name);
  document.brief = 'A seed grows into a garden in twelve seconds.';
  const saved = await page.request.put(`/api/projects/${encodeURIComponent(id)}/movie`, {
    data: { expectedRevision: 0, document },
  });
  expect(saved.ok(), `save film: ${await saved.text()}`).toBeTruthy();
  return id;
}

const editorUrl = (id: string) => new RegExp(`/projects/${id}(/conversations/[^/]+)?/files/movie-studio\\.json$`);

async function openEditor(page: Page, id: string): Promise<Locator> {
  await page.goto(`/projects/${id}/files/movie-studio.json`, { waitUntil: 'domcontentloaded' });
  const editor = page.getByTestId('motion-editor');
  await expect(editor.getByTestId('movie-editor-toolbar')).toBeVisible({ timeout: T.xlong });
  return editor;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function visibleBoxes(scope: Locator): Promise<Array<{ name: string; box: Box }>> {
  const controls = scope.locator('button:visible, a[data-slot="button"]:visible, [role="tab"]:visible, [role="radio"]:visible');
  const boxes: Array<{ name: string; box: Box }> = [];
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    if (!box || box.width === 0 || box.height === 0) continue;
    const name = (await control.getAttribute('aria-label')) ?? ((await control.textContent()) ?? '').trim();
    boxes.push({ name, box });
  }
  return boxes;
}

function inside(box: Box, width: number, height: number): boolean {
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 0.5 && box.y + box.height <= height + 0.5;
}

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

test.describe('Fantay video & animation folding', () => {
  // The product copy is asserted in zh-CN (the editor's primary language).
  test.use({ locale: 'zh-CN' });

  test('[P1] a legacy /movies/<id> link opens the film editor in the workspace, replacing the history entry', async ({ page }) => {
    const id = await createFilm(page, `Folding film ${randomUUID().slice(0, 6)}`);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('fantay-shell')).toBeVisible({ timeout: T.long });
    const entries = await page.evaluate(() => window.history.length);
    await page.goto(`/movies/${id}`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(editorUrl(id), { timeout: T.long });
    await expect(page.getByTestId('motion-editor')).toBeVisible({ timeout: T.xlong });
    // one entry for the visit itself; the redirect replaced it instead of pushing another
    expect(await page.evaluate(() => window.history.length)).toBe(entries + 1);
  });

  test('[P1] at 1440×900 the editor chrome and every control in it are on screen and never overlap', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const id = await createFilm(page, `Layout film ${randomUUID().slice(0, 6)}`);
    const editor = await openEditor(page, id);
    const regions = [
      editor.getByTestId('movie-editor-toolbar'),
      editor.getByTestId('movie-stage-bar'),
      editor.getByTestId('movie-stage-footer'),
      editor.getByTestId('movie-inspector').getByRole('tablist'),
    ];
    for (const region of regions) {
      const box = await region.boundingBox();
      expect(box, 'region is laid out').not.toBeNull();
      expect(inside(box!, 1440, 900), `region inside the viewport: ${JSON.stringify(box)}`).toBe(true);
    }
    const controls = (await Promise.all(regions.map((region) => visibleBoxes(region)))).flat();
    expect(controls.length).toBeGreaterThan(8);
    for (const { name, box } of controls) expect(inside(box, 1440, 900), `${name} inside the viewport`).toBe(true);
    for (let i = 0; i < controls.length; i += 1) {
      for (let j = i + 1; j < controls.length; j += 1) {
        expect(overlap(controls[i]!.box, controls[j]!.box), `${controls[i]!.name} overlaps ${controls[j]!.name}`).toBeLessThan(1);
      }
    }
    // exactly one primary action in the stage footer
    await expect(editor.getByTestId('movie-stage-footer').locator('[data-slot="button"][data-variant="primary"]')).toHaveCount(1);

    // The style stage keeps its preview transport on screen too.
    await editor.getByRole('radio', { name: '风格' }).click();
    await expect(editor.getByTestId('movie-style-preview')).toBeVisible();
    const play = editor.getByRole('button', { name: '播放', exact: true });
    await expect(play).toBeVisible();
    const playBox = await play.boundingBox();
    expect(playBox && inside(playBox, 1440, 900)).toBe(true);
    const scrubber = editor.getByRole('slider', { name: '预览进度' });
    const scrubberBox = await scrubber.boundingBox();
    expect(scrubberBox && inside(scrubberBox, 1440, 900)).toBe(true);
  });

  test('[P1] at 390×844 the film editor page never scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const id = await createFilm(page, `Phone film ${randomUUID().slice(0, 6)}`);
    await page.goto(`/projects/${id}/files/movie-studio.json`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('fantay-shell')).toBeVisible({ timeout: T.long });
    // Measure once the film editor has rendered, so the oracle cannot pass on an empty page.
    await expect(page.getByTestId('movie-editor-toolbar')).toBeAttached({ timeout: T.xlong });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), {
        timeout: T.medium,
      })
      .toBeLessThanOrEqual(0);
  });

  test('[P1] the folded pages land on their surfaces and /movie-app stays chrome-free', async ({ page }) => {
    await page.goto('/tokentosea', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-account')).toBeVisible({ timeout: T.long });
    await page.goto('/materials', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('materials-drawer')).toBeVisible({ timeout: T.long });

    const id = await createFilm(page, `MCP film ${randomUUID().slice(0, 6)}`);
    await page.goto(`/movie-app/${id}`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(new RegExp(`/movie-app/${id}$`));
    await expect(page.getByTestId('movie-embedded-app')).toBeVisible({ timeout: T.long });
    await expect(page.getByTestId('movie-editor-toolbar')).toBeVisible({ timeout: T.xlong });
    await expect(page.getByTestId('fantay-shell')).toHaveCount(0);
    await expect(page.getByTestId('workspace-tabs-dropdown')).toHaveCount(0);
  });

  test('[P1] the home 动画/代码视频 chip opens the create dialog and cancelling keeps the home draft', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const input = page.getByTestId('home-hero-input');
    await expect(input).toBeVisible({ timeout: T.long });
    await input.click();
    await page.keyboard.type('A paper city folds itself up');
    const chip = page.getByTestId('fantay-home-chip-motion-design');
    await expect(chip).toBeEnabled({ timeout: T.long });
    await chip.click();
    const dialog = page.getByTestId('motion-create-dialog');
    await expect(dialog).toBeVisible({ timeout: T.medium });
    await expect(dialog.getByLabel('创作想法')).toHaveValue('A paper city folds itself up');
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toBeHidden({ timeout: T.medium });
    await expect(input).toContainText('A paper city folds itself up');
  });
});
