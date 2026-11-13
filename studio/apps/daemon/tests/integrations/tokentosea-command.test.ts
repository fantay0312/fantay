import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { TokenToSeaRuntime, configureTokenToSeaRuntime } from '../../src/integrations/tokentosea-runtime.js';
import { runTokenToSeaCommand } from '../../src/integrations/tokentosea-command.js';

const folders: string[] = [];
const runtimes: TokenToSeaRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) runtime.usage.close(); configureTokenToSeaRuntime(undefined); await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
async function setup() {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'tts-command-runtime-'));
  folders.push(folder);
  const runtime = new TokenToSeaRuntime(folder, { session: async () => ({ id: 'user', name: 'User' }) } as never);
  runtimes.push(runtime);
  configureTokenToSeaRuntime(runtime);
  const asUser = <T>(fn: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    runtime.middleware({ headers: { cookie: `fantay_session=${'a'.repeat(43)}` }, originalUrl: '/api/test' } as never, {} as never, () => { void fn().then(resolve, reject); });
  });
  return { runtime, asUser };
}
it('passes an operation deadline through to the TokenToSea request', async () => {
  const { runtime, asUser } = await setup();
  vi.spyOn(runtime, 'collaboration').mockImplementation((_body, signal) => new Promise((_resolve, reject) => {
    expect(signal).toBeDefined(); signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }));
  await expect(asUser(() => runTokenToSeaCommand(['resource', 'head', 'r'], { timeoutMs: 10 }))).rejects.toMatchObject({ name: 'TimeoutError' });
});
it('does not write downloaded files when cancellation arrives before materialization', async () => {
  const { runtime, asUser } = await setup(), folder = await mkdtemp(path.join(os.tmpdir(), 'tts-abort-')); folders.push(folder);
  vi.spyOn(runtime, 'collaboration').mockImplementation(async () => { await delay(20); return { files: [{ path: 'index.html', sha256: 'ignored', contentBase64: '' }] } as never; });
  const controller = new AbortController();
  const operation = asUser(() => runTokenToSeaCommand(['resource', 'pull', 'project', 'r', folder], { signal: controller.signal }));
  controller.abort();
  await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  expect(await readdir(folder)).toEqual([]);
});
