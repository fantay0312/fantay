import { randomUUID } from 'node:crypto';
import { createMovieDocument } from '@open-design/contracts';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { seedFantayShell } from '@/playwright/fantay-shell-flag';
import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';

test('live Motion text, comments and external edits share one source before export', async ({ page }, testInfo) => {
  test.setTimeout(T.xlong * 3);
  await applyStandardMocks(page);
  await seedFantayShell(page, 'on');
  await page.addInitScript(() => { localStorage.setItem('open-design:locale', 'zh-CN'); localStorage.setItem('open-design:locale-source', 'manual'); });
  const id = `live-motion-${randomUUID()}`;
  expect((await page.request.post('/api/projects', { data: { id, name: 'Live Motion', skillId: 'fantay-movie', metadata: { kind: 'video', intent: 'motion-design', videoModel: 'hyperframes-html' } } })).ok()).toBe(true);
  const doc = createMovieDocument('Live Motion');
  doc.brief = 'A live source editing test';
  doc.shots = [{ ...doc.shots[0]!, id: 'opening', title: 'Live before export', body: 'Editable source', duration: 12 }];
  expect((await page.request.put(`/api/projects/${id}/movie`, { data: { expectedRevision: 0, document: doc } })).ok()).toBe(true);
  const read = async () => (await (await page.request.get(`/api/projects/${id}/movie`)).json()).document;
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(`/projects/${id}/files/movie-studio.json`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('motion-editor')).toBeVisible({ timeout: T.long });
    await page.getByRole('tab', { name: '剪辑', exact: true }).click();
    await expect(page.getByTestId('movie-live-tools')).toBeVisible();
    const seek = async (value: string) => { const input = page.getByRole('textbox', { name: '播放头时间码' }); await input.fill(value); await input.press('Enter'); };
    await seek('00:02:00');
    const frame = page.frameLocator('[data-testid="movie-preview-frame"] iframe');
    await expect(frame.locator('#shot-0 h1')).toBeVisible();
    await frame.locator('#shot-0 h1').dblclick();
    const content = page.getByRole('textbox', { name: '画面文字内容' });
    await expect(content).toBeVisible();
    await content.fill('Changes while typing');
    await expect(frame.locator('#shot-0 h1')).toHaveText('Changes while typing');
    expect((await read()).shots[0].title).toBe('Live before export');
    const [saved] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith(`/projects/${id}/movie/edits`) && r.request().method() === 'POST', { timeout: T.medium }),
      page.getByRole('button', { name: '保存文字' }).click({ timeout: T.medium }),
    ]);
    expect(saved.ok()).toBe(true);
    expect((await read()).shots[0].title).toBe('Changes while typing');
    await expect(content).toBeHidden();

    await page.getByRole('button', { name: '时间批注', exact: true }).click();
    await page.getByTestId('movie-review-notes').getByRole('textbox').fill('Hold this moment');
    const [noted] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith(`/projects/${id}/movie/actions`) && r.request().method() === 'POST', { timeout: T.medium }),
      page.getByTestId('movie-review-notes').getByRole('button', { name: '添加', exact: true }).click({ timeout: T.medium }),
    ]);
    expect(noted.ok()).toBe(true);
    await expect(page.getByRole('button', { name: '发给主聊天修改（1）' })).toBeVisible();
    const current = await read();
    expect(current.renders).toHaveLength(0);
    expect(current.notes[0]).toMatchObject({ scope: 'time', time: 2, resolved: false });
    const feedback = await page.request.post(`/api/projects/${id}/movie/feedback-prompt`, { data: { expectedRevision: current.revision, noteIds: [current.notes[0].id] } });
    expect(feedback.ok()).toBe(true);
    expect((await feedback.json()).prompt).toContain('Hold this moment');
    expect((await read()).production).toBeUndefined();
    await page.keyboard.press('Escape');

    // An external agent uses the same guarded endpoint. Its complete checkpoint reaches the live iframe.
    const edited = await page.request.post(`/api/projects/${id}/movie/edits`, { data: { expectedRevision: current.revision, operations: [{ op: 'update-shot', shotId: 'opening', changes: { body: 'External checkpoint' } }] } });
    expect(edited.ok()).toBe(true);
    await expect(frame.locator('#shot-0 p')).toHaveText('External checkpoint', { timeout: T.long });
    await expect(page.getByRole('textbox', { name: '播放头时间码' })).toHaveValue('00:00:02:00');
    // Let both real clocks advance before an external checkpoint replaces the iframe.
    await seek('00:04:00');
    await page.getByRole('button', { name: '播放', exact: true }).click();
    const frameTime = () => frame.locator('body').evaluate(() => (window as unknown as { __timelines: { main: { time(): number } } }).__timelines.main.time());
    await expect.poll(frameTime).toBeGreaterThan(5.5);
    const beforeRefresh = await frameTime();
    const latest = await read();
    expect((await page.request.post(`/api/projects/${id}/movie/edits`, { data: { expectedRevision: latest.revision, operations: [{ op: 'update-shot', shotId: 'opening', changes: { body: 'Checkpoint during playback' } }] } })).ok()).toBe(true);
    await expect(frame.locator('#shot-0 p')).toHaveText('Checkpoint during playback', { timeout: T.long });
    expect(await frameTime()).toBeGreaterThanOrEqual(beforeRefresh - 0.15);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('live-motion.png') });
  } finally { await page.request.delete(`/api/projects/${id}`); }
});
