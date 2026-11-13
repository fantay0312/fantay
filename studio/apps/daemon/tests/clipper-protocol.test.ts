import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const workerSource = readFileSync(new URL('../../../clipper/background.js', import.meta.url), 'utf8');

function worker(identity: unknown) {
  const fetch = vi.fn(async (_url: string, options?: RequestInit) =>
    Response.json(options?.method === 'POST' ? { asset: { id: 'captured' } } : identity));
  const api = runInNewContext(`${workerSource}\n({ probe, ingest });`, {
    fetch,
    URL,
    chrome: {
      storage: { local: { get: async () => ({ daemonUrl: 'http://127.0.0.1:7456' }) } },
      runtime: { onMessage: { addListener: vi.fn() }, onInstalled: { addListener: vi.fn() } },
      contextMenus: { onClicked: { addListener: vi.fn() } },
    },
  }) as { probe(): Promise<boolean>; ingest(body: unknown): Promise<unknown> };
  return { api, fetch };
}

describe('FantayDesign Clipper protocol', () => {
  it.each([{ ok: true, product: 'FantayDesign', protocolVersion: 1 }, { ok: true }])(
    'accepts the current protocol and the legacy response', async (identity) => {
      const { api, fetch } = worker(identity);
      await expect(api.ingest({ kind: 'html', text: 'capture' })).resolves.toEqual({ asset: { id: 'captured' } });
      expect(fetch).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:7456/api/library/clipper-probe', { method: 'GET' });
      expect(fetch.mock.calls[1]?.[1]?.method).toBe('POST');
    },
  );

  it.each([{ ok: true, product: 'OtherProduct' }, { hello: 'world' }, null])(
    'rejects an incompatible endpoint before uploading', async (identity) => {
      const { api, fetch } = worker(identity);
      await expect(api.ingest({ text: 'private capture' })).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});
