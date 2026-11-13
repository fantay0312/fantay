import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const html = readFileSync(new URL('../../../figma-plugin/ui.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../../../figma-plugin/code.js', import.meta.url), 'utf8');
const opened: JSDOM[] = [];

function openPlugin() {
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://plugin.example.test/' });
  opened.push(dom);
  return dom.window;
}

afterEach(() => {
  for (const dom of opened.splice(0)) dom.window.close();
});

it('opens the Fantay window with host theme support', () => {
  const showUI = vi.fn();
  runInNewContext(source, { figma: { showUI, ui: {} }, __html__: html });
  expect(showUI).toHaveBeenCalledWith(html, expect.objectContaining({ title: 'Fantay Figma Import', themeColors: true }));
});

it('clears a previous valid capture when reading its replacement fails', () => {
  const window = openPlugin();
  const json = window.document.getElementById('json') as HTMLTextAreaElement;
  const button = window.document.getElementById('import') as HTMLButtonElement;
  json.value = JSON.stringify({ version: 1, root: { type: 'FRAME', children: [] } });
  json.dispatchEvent(new window.Event('input'));
  expect(button.disabled).toBe(false);

  Object.defineProperty(window, 'FileReader', { value: class {
    onerror?: () => void;
    readAsText() { this.onerror?.(); }
  } });
  const input = window.document.getElementById('file') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [new window.File(['bad'], 'replacement.json')] });
  input.dispatchEvent(new window.Event('change'));
  expect(button.disabled).toBe(true);
  expect(window.document.getElementById('msg')?.textContent).toContain('Could not read this file');
});

it('explains where native fig files belong', () => {
  const window = openPlugin();
  const input = window.document.getElementById('file') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [new window.File(['fig'], 'design.fig')] });
  input.dispatchEvent(new window.Event('change'));
  expect((window.document.getElementById('import') as HTMLButtonElement).disabled).toBe(true);
  expect(window.document.getElementById('msg')?.textContent).toContain('import them into Fantay');
});

it.each(['done', 'error'])('allows another import after a %s response', async (type) => {
  const window = openPlugin();
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  const json = window.document.getElementById('json') as HTMLTextAreaElement;
  const input = window.document.getElementById('file') as HTMLInputElement;
  const button = window.document.getElementById('import') as HTMLButtonElement;
  json.value = JSON.stringify({ version: 1, root: { type: 'FRAME', children: [] } });
  json.dispatchEvent(new window.Event('input'));
  button.click();
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { pluginMessage: { type, name: 'Capture', message: 'Try again' } },
  }));
  expect(button.disabled).toBe(false);
  expect(input.disabled).toBe(false);
  expect(json.disabled).toBe(false);
  button.click();
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
});

it('restores file and JSON entry when image preparation fails', async () => {
  const window = openPlugin();
  const json = window.document.getElementById('json') as HTMLTextAreaElement;
  const button = window.document.getElementById('import') as HTMLButtonElement;
  const input = window.document.getElementById('file') as HTMLInputElement;
  (window as unknown as { normalizeImageFills: () => Promise<never> }).normalizeImageFills = async () => {
    throw new Error('Image preparation failed');
  };
  json.value = JSON.stringify({ version: 1, root: { type: 'FRAME', children: [] } });
  json.dispatchEvent(new window.Event('input'));
  button.click();
  await vi.waitFor(() => expect(window.document.getElementById('msg')?.textContent).toContain('Image preparation failed'));
  expect(button.disabled).toBe(false);
  expect(input.disabled).toBe(false);
  expect(json.disabled).toBe(false);
});
