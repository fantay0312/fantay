import { describe, expect, it, vi } from 'vitest';
import { searchTokenToSeaStock } from '../src/stock.js';

describe('TokenToSea stock source', () => {
  it('retains the source license and author with no provider API key', async () => {
    const request = vi.fn(async (_url: RequestInfo | URL) => Response.json({ query: { pages: { '1': { title: 'File:Forest.jpg', imageinfo: [{
      url: 'https://upload.wikimedia.org/forest.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Forest.jpg', mime: 'image/jpeg',
      extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: '<b>Photographer</b>' } },
    }] } } } }));
    const result = await searchTokenToSeaStock({ slots: [{ id: 'cover', query: 'forest' }] }, request as never);
    expect(result.providers).toEqual(['wikimedia']);
    expect(result.slots[0]).toMatchObject({ id: 'cover', status: 'ok', license: 'CC BY-SA 4.0', author: 'Photographer' });
    expect(new URL(String(request.mock.calls[0]?.[0])).hostname).toBe('commons.wikimedia.org');
  });
  it('refuses to return images without licensing metadata', async () => {
    const result = await searchTokenToSeaStock({ slots: [{ id: 'cover', query: 'forest' }] }, (async () => Response.json({ query: { pages: { '1': { title: 'File:Unknown.jpg', imageinfo: [{ url: 'https://upload.wikimedia.org/x', mime: 'image/jpeg' }] } } } })) as never);
    expect(result.slots[0]).toMatchObject({ status: 'not_found' });
  });
  it('reports source failure and rejects malformed requests without a search', async () => {
    const request = vi.fn(async () => new Response('', { status: 429 }));
    const result = await searchTokenToSeaStock({ slots: [{ id: 'cover', query: 'forest' }] }, request as never);
    expect(result.slots[0]).toMatchObject({ status: 'error' });
    await expect(searchTokenToSeaStock({ slots: [] }, request as never)).rejects.toThrow('参数');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
