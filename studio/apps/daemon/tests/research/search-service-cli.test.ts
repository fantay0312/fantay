import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runSearchServiceCli } from '../../src/research/search-service-cli.js';

const roots: string[] = [];
const initialExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = initialExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('reads long search prompts from files and calls the same native API', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-search-cli-'));
  roots.push(root);
  const file = path.join(root, 'prompt.txt');
  const query = '搜索问题\n第二行';
  await writeFile(file, query);
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ query, sources: [] }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await runSearchServiceCli(['query', '--prompt-file', file, '--daemon-url', 'http://127.0.0.1:7456', '--json']);
  expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:7456/api/search/search');
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ query });
});

it('does not echo credentials in a malformed configuration file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-search-cli-'));
  roots.push(root);
  const file = path.join(root, 'config.json');
  await writeFile(file, '{"values":{"XAI_API_KEY":"private-fixture-secret",invalid');
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await runSearchServiceCli(['configure', '--config-file', file, '--daemon-url', 'http://127.0.0.1:7456']);
  expect(error).toHaveBeenCalledWith('The input file must contain valid JSON.');
  expect(JSON.stringify(error.mock.calls)).not.toContain('private-fixture-secret');
});
