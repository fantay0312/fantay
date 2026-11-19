import { expect, test } from '@/playwright/suite';
import { seedFantayShell } from '@/playwright/fantay-shell-flag';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { T } from '@/timeouts';
import type { Page } from '@playwright/test';

async function openProjectForWriting(page: Page, id: string) {
  await seedFantayShell(page, 'on');
  await applyStandardMocks(page);
  const created = await page.request.post('/api/projects', { data: { id, name: 'Markdown writing', metadata: { kind: 'prototype' } } });
  expect(created.ok()).toBeTruthy();
  const { conversationId } = await created.json();
  // Empty chats deliberately collapse the workspace. This fixture models a project in use.
  const messageId = id + '-review';
  const note = await page.request.put('/api/projects/' + id + '/conversations/' + conversationId + '/messages/' + messageId, {
    data: { id: messageId, role: 'user', content: 'Update the project notes.', createdAt: Date.now() },
  });
  expect(note.ok()).toBeTruthy();
}

test('large Markdown keeps its tail editable, renders its surrounding syntax and saves original bytes', async ({ page }) => {
  const id = 'large-markdown-' + Date.now();
  await openProjectForWriting(page, id);
  const files = '/api/projects/' + id + '/files';
  // Larger than the JSON write limit; mixed EOLs, non-ASCII text, BOM and a nested file path.
  const line = '正文 with **bold** formatting.\r\n\r\n';
  const original = '\uFEFF' + line.repeat(Math.ceil(8_000_000 / line.length)) + '\n## Document tail\n\n- item';
  expect(Buffer.byteLength(original)).toBeGreaterThan(4 * 1024 * 1024);
  expect((await page.request.post(files, { multipart: {
    name: 'docs/long.md', file: { name: 'long.md', mimeType: 'text/markdown', buffer: Buffer.from(original) },
  } })).ok()).toBeTruthy();
  await page.goto('/projects/' + id + '/files/docs/long.md');
  const editor = page.getByTestId('markdown-live-editor');
  const input = editor.locator('.cm-content');
  await expect(input).toBeVisible({ timeout: T.long });
  await input.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await expect(editor.locator('.md-live-h2')).toHaveText('Document tail', { timeout: T.long });
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'di', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.imeSetComposition', { text: '第二项', selectionStart: 3, selectionEnd: 3 });
  await cdp.send('Input.insertText', { text: '第二项' });
  await cdp.detach();
  const wanted = Buffer.from(original + '\r\n- 第二项');
  const saved = async () => (await (await page.request.get(files + '/docs/long.md')).body()).equals(wanted);
  await expect.poll(saved, { timeout: T.long }).toBe(true);
  await page.reload();
  const panelToggle = page.getByTestId('fantay-workspace-panel-toggle').filter({ visible: true }).first();
  await expect(panelToggle).toBeVisible({ timeout: T.long });
  if (await panelToggle.getAttribute('aria-pressed') === 'false') await panelToggle.click();
  await expect(input).toBeVisible({ timeout: T.long });
  await input.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await expect(editor.locator('.cm-line').last()).toContainText('第二项');
});

test('ordered-list Enter keeps numbering beyond the worker viewport', async ({ page }) => {
  const id = 'md-list-' + Date.now();
  await openProjectForWriting(page, id);
  const files = '/api/projects/' + id + '/files';
  const source = Array.from({ length: 8000 }, (_, i) => (i + 1) + '. list item').join('\n');
  expect((await page.request.post(files, { data: { name: 'list.md', content: '# Outline\n\n' + source } })).ok()).toBeTruthy();
  await page.goto('/projects/' + id + '/files/list.md');
  const editor = page.getByTestId('markdown-live-editor');
  await expect(editor.locator('.md-live-h1')).toHaveText('Outline', { timeout: T.long });
  await editor.getByText('1. list item', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('inserted');
  const expected = '# Outline\n\n1. list item\n2. inserted\n' +
    Array.from({ length: 7999 }, (_, i) => (i + 3) + '. list item').join('\n');
  await expect.poll(async () => (await (await page.request.get(files + '/list.md')).text()) === expected, { timeout: T.long }).toBe(true);
});
