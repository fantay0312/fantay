import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TokenToSeaRuntime, isLocalCliRequest } from '../../src/integrations/tokentosea-runtime.js';

const folders: string[] = [];
const runtimes: TokenToSeaRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.usage.close();
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

const users: Record<string, { id: string; name: string }> = {
  ['a'.repeat(43)]: { id: 'issuer|alice', name: 'Alice' },
  ['b'.repeat(43)]: { id: 'issuer|bob', name: 'Bob' },
};

async function setup() {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'tts-cli-session-'));
  folders.push(folder);
  const runtime = new TokenToSeaRuntime(folder, { session: async (raw: string) => users[raw] ?? null } as never);
  runtimes.push(runtime);
  const through = (headers: Record<string, string>, remoteAddress = '127.0.0.1') =>
    new Promise<{ raw: string; user: unknown } | null>((resolve) => {
      runtime.middleware({ headers: { host: '127.0.0.1:7456', ...headers }, originalUrl: '/api/workspace/billing', socket: { remoteAddress } } as never, {} as never, () => resolve(runtime.current() as never));
    });
  return { runtime, through };
}

const cli = {} as Record<string, string>;
const cookie = (raw: string) => ({ cookie: `fantay_session=${raw}` });

describe('local CLI requests and the TokenToSea session', () => {
  it('recognises only cookie-less, browser-header-free loopback requests as the local CLI', () => {
    const at = (headers: Record<string, string>, remoteAddress = '127.0.0.1') => isLocalCliRequest({ headers: { host: '127.0.0.1:7456', ...headers }, socket: { remoteAddress } } as never);
    expect(at({})).toBe(true);
    expect(at({}, '::1')).toBe(true);
    expect(at({}, '192.168.1.20')).toBe(false);
    expect(at({ origin: 'https://evil.example' })).toBe(false);
    expect(at({ 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(at({ 'sec-fetch-mode': 'no-cors' })).toBe(false);
    // Node's fetch (the od CLI) adds Sec-Fetch-Mode: cors and no other fetch metadata.
    expect(at({ accept: '*/*', 'accept-language': '*', 'sec-fetch-mode': 'cors', 'user-agent': 'node' })).toBe(true);
    expect(at({ 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' })).toBe(false);
    expect(at({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).toBe(false);
    expect(at({ referer: 'https://evil.example/page' })).toBe(false);
    expect(at({ cookie: 'other=1' })).toBe(false);
    // DNS rebinding: a page on a rebound domain reaches loopback with its own Host.
    expect(at({ host: 'evil.example:7456' })).toBe(false);
    expect(at({ host: 'localhost:7456' })).toBe(true);
    // A browser too old to send Fetch Metadata still identifies as Mozilla.
    expect(at({ 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15' })).toBe(false);
    expect(at({ 'user-agent': 'curl/8.7.1' })).toBe(true);
  });

  it('runs a CLI request as the one signed-in account', async () => {
    const { through } = await setup();
    await through(cookie('a'.repeat(43)));
    expect(await through(cli)).toMatchObject({ raw: 'a'.repeat(43), user: { id: 'issuer|alice' } });
  });

  it('keeps a CLI request signed out when no account or several accounts are signed in', async () => {
    const { through } = await setup();
    expect(await through(cli)).toMatchObject({ raw: '', user: null });
    await through(cookie('a'.repeat(43)));
    await through(cookie('b'.repeat(43)));
    expect(await through(cli)).toMatchObject({ raw: '', user: null });
  });

  it('never lends the account to a browser request without a cookie', async () => {
    const { through } = await setup();
    await through(cookie('a'.repeat(43)));
    expect(await through({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' })).toMatchObject({ raw: '', user: null });
    expect(await through({ origin: 'http://127.0.0.1:5173' })).toMatchObject({ raw: '', user: null });
    expect(await through(cli, '10.0.0.8')).toMatchObject({ raw: '', user: null });
  });
});
