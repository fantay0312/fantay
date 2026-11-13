// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceCollabContext } from '@open-design/contracts';

const { invalidateProjectFilesCache } = vi.hoisted(() => ({ invalidateProjectFilesCache: vi.fn() }));
vi.mock('../../../src/providers/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/registry')>()),
  invalidateProjectFilesCache,
}));

import {
  DesignApiError,
  designCoverUrl,
  designDirOf,
  fetchProjectAsset,
  isSafeProjectAssetPath,
  listDesigns,
  parseEtag,
  putDesignCover,
  quoteEtag,
  readDesign,
  saveDesign,
  suggestDesignPath,
  writeProjectTextAsFile,
} from '../../../src/fantay/design/design-api';
import { bytes, designSummary, installFetch, jsonResponse } from './helpers/fake-editor';

const CTX: WorkspaceCollabContext = {
  workspaceId: 'ws-1',
  workspaceType: 'team',
  workspaceMemberId: 'member-1',
  role: 'editor',
  lifecycleState: 'active',
  memberStatus: 'active',
  permissions: { canShareProjects: true, canWriteSyncedFiles: true },
} as unknown as WorkspaceCollabContext; // only the identity fields matter to the request headers

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

beforeEach(() => {
  invalidateProjectFilesCache.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saveDesign', () => {
  it('updates with a quoted If-Match, an octet-stream body and the workspace headers', async () => {
    const response = { design: designSummary('p1', 'designs/a.fig', 'sha-2'), created: false, previousSha256: 'sha-1' };
    const { calls } = installFetch([(call) => (call.method === 'PUT' ? jsonResponse(response) : undefined)]);
    const body = bytes('fig');
    const outcome = await saveDesign('p1', 'designs/a.fig', body, { ifMatch: 'sha-1' }, CTX);
    expect(outcome).toEqual({ ok: true, response });
    const call = calls[0]!;
    expect(call.url.pathname).toBe('/api/projects/p1/designs/content');
    expect(call.url.searchParams.get('path')).toBe('designs/a.fig');
    const headers = headersOf(call.init);
    expect(headers.get('if-match')).toBe('"sha-1"');
    expect(headers.get('if-none-match')).toBeNull();
    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('x-od-workspace-id')).toBe('ws-1');
    expect(headers.get('x-od-workspace-member-id')).toBe('member-1');
    expect(call.init?.body).toBe(body);
    expect(invalidateProjectFilesCache).toHaveBeenCalledWith('p1', CTX);
  });

  it('creates with If-None-Match: * and no workspace headers for local projects', async () => {
    const response = { design: designSummary('p1', 'designs/首页.fig', 'sha-1'), created: true, previousSha256: null };
    const { calls } = installFetch([() => jsonResponse(response, 201)]);
    const outcome = await saveDesign('p1', 'designs/首页.fig', bytes('x'), { create: true });
    expect(outcome).toEqual({ ok: true, response });
    const headers = headersOf(calls[0]!.init);
    expect(headers.get('if-none-match')).toBe('*');
    expect(headers.get('if-match')).toBeNull();
    expect(headers.get('x-od-workspace-id')).toBeNull();
    expect(calls[0]!.url.searchParams.get('path')).toBe('designs/首页.fig');
  });

  it('maps 409 to the current sha from the conflict details (null when the file is gone)', async () => {
    installFetch([
      () =>
        jsonResponse(
          { error: { code: 'CONFLICT', message: 'changed', details: { reason: 'DESIGN_REVISION_MISMATCH', currentSha256: 'sha-9', path: 'designs/a.fig' } } },
          409,
        ),
    ]);
    await expect(saveDesign('p1', 'designs/a.fig', bytes('x'), { ifMatch: 'sha-1' })).resolves.toEqual({ ok: false, status: 409, currentSha256: 'sha-9' });
    installFetch([() => jsonResponse({ error: { code: 'CONFLICT', message: 'gone', details: { currentSha256: null } } }, 409)]);
    await expect(saveDesign('p1', 'designs/a.fig', bytes('x'), { ifMatch: 'sha-1' })).resolves.toEqual({ ok: false, status: 409, currentSha256: null });
  });

  it('maps 413 / 403 / 404 / 400, folds 415 and 428 into 400, and anything else (or a network error) into 0', async () => {
    for (const [status, expected] of [
      [413, 413],
      [403, 403],
      [404, 404],
      [400, 400],
      [415, 400],
      [428, 400],
      [500, 0],
    ] as const) {
      installFetch([() => jsonResponse({ error: { code: 'X', message: `failed ${status}` } }, status)]);
      await expect(saveDesign('p1', 'designs/a.fig', bytes('x'), { create: true })).resolves.toEqual({
        ok: false,
        status: expected,
        message: `failed ${status}`,
      });
    }
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(saveDesign('p1', 'designs/a.fig', bytes('x'), { create: true })).resolves.toEqual({ ok: false, status: 0, message: 'Failed to fetch' });
    expect(invalidateProjectFilesCache).not.toHaveBeenCalled();
  });
});

describe('readDesign', () => {
  it('returns bytes, the sha from X-Design-Sha256 and the format; null on 404', async () => {
    installFetch([
      (call) =>
        call.url.searchParams.get('path') === 'designs/a.op'
          ? new Response(bytes('{"op":1}'), { status: 200, headers: { 'X-Design-Sha256': 'sha-op', 'X-Design-Format': 'op', ETag: '"sha-op"' } })
          : undefined,
    ]);
    const read = await readDesign('p1', 'designs/a.op');
    expect(read?.sha256).toBe('sha-op');
    expect(read?.format).toBe('op');
    expect(new TextDecoder().decode(read!.bytes)).toBe('{"op":1}');
    await expect(readDesign('p1', 'designs/missing.fig')).resolves.toBeNull();
  });

  it('falls back to the ETag for the sha and throws a coded error on other failures', async () => {
    installFetch([() => new Response(bytes('PK'), { status: 200, headers: { ETag: '"sha-etag"' } })]);
    await expect(readDesign('p1', 'designs/a.fig')).resolves.toMatchObject({ sha256: 'sha-etag', format: 'fig' });
    installFetch([() => jsonResponse({ error: { code: 'FORBIDDEN', message: 'no access' } }, 403)]);
    const error = await readDesign('p1', 'designs/a.fig').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DesignApiError);
    expect(error).toMatchObject({ status: 403, code: 'FORBIDDEN', apiCode: 'FORBIDDEN', message: 'no access' });
  });
});

describe('putDesignCover', () => {
  it('PUTs the PNG with the document sha and reports stored / stale / failed', async () => {
    const { calls } = installFetch([() => new Response(null, { status: 204 })]);
    await expect(putDesignCover('p1', 'designs/a.fig', bytes('png'), 'sha-3', CTX)).resolves.toBe('stored');
    const headers = headersOf(calls[0]!.init);
    expect(calls[0]!.url.pathname).toBe('/api/projects/p1/designs/cover');
    expect(headers.get('content-type')).toBe('image/png');
    expect(headers.get('x-design-sha256')).toBe('sha-3');
    installFetch([() => jsonResponse({ error: { code: 'CONFLICT', message: 'stale', details: { reason: 'DESIGN_COVER_STALE' } } }, 409)]);
    await expect(putDesignCover('p1', 'designs/a.fig', bytes('png'), 'sha-old')).resolves.toBe('stale');
    installFetch([() => jsonResponse({ error: { code: 'BAD_REQUEST', message: 'bad png' } }, 400)]);
    await expect(putDesignCover('p1', 'designs/a.fig', bytes('png'), 'sha-3')).resolves.toBe('failed');
  });

  it('builds cover URLs with the revision and the workspace authority for <img>', () => {
    expect(designCoverUrl('p 1', 'designs/首页.fig', '3-1')).toBe('/api/projects/p%201/designs/cover?path=designs%2F%E9%A6%96%E9%A1%B5.fig&v=3-1');
    expect(designCoverUrl('p1', 'designs/a.fig', '3-1', CTX)).toBe(
      '/api/projects/p1/designs/cover?path=designs%2Fa.fig&v=3-1&workspaceId=ws-1&workspaceMemberId=member-1',
    );
  });
});

describe('fetchProjectAsset', () => {
  it('reads raw project files with their mime type', async () => {
    const { calls } = installFetch([() => new Response(bytes('img'), { status: 200, headers: { 'Content-Type': 'image/png; charset=binary' } })]);
    const asset = await fetchProjectAsset('p1', './img/hero 1.png', CTX);
    expect(asset.mime).toBe('image/png');
    expect(asset.bytes.byteLength).toBe(3);
    expect(calls[0]!.url.pathname).toBe('/api/projects/p1/raw/img/hero%201.png');
    expect(headersOf(calls[0]!.init).get('x-od-workspace-id')).toBe('ws-1');
  });

  it('refuses paths outside the project and assets over 20 MB', async () => {
    for (const path of ['../secret.png', 'a/../../b.png', '/etc/passwd', 'C:\\x.png', 'https://example.com/a.png', 'a\0b', '']) {
      expect(isSafeProjectAssetPath(path)).toBe(false);
      await expect(fetchProjectAsset('p1', path)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect(isSafeProjectAssetPath('designs/img/a.png')).toBe(true);
    installFetch([() => new Response(bytes('x'), { status: 200, headers: { 'Content-Length': String(25 * 1024 * 1024) } })]);
    await expect(fetchProjectAsset('p1', 'big.png')).rejects.toMatchObject({ code: 'TOO_LARGE', status: 413 });
    installFetch([() => jsonResponse({ error: { code: 'FILE_NOT_FOUND', message: 'missing' } }, 404)]);
    await expect(fetchProjectAsset('p1', 'missing.png')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('lists', () => {
  it('lists project designs', async () => {
    const design = designSummary('p1', 'designs/a.fig', 'sha-1');
    installFetch([(call) => (call.url.pathname === '/api/projects/p1/designs' ? jsonResponse({ designs: [design] }) : undefined)]);
    await expect(listDesigns('p1')).resolves.toEqual([design]);
  });
});

describe('writeProjectTextAsFile', () => {
  it('uploads multipart with the subfolder kept in `name`', async () => {
    const { calls } = installFetch([() => jsonResponse({ file: { name: 'designs/a.html', path: 'designs/a.html', size: 10, mtime: 1, kind: 'html', mime: 'text/html' } })]);
    const file = await writeProjectTextAsFile('p1', 'designs/a.html', '<html></html>', 'text/html');
    expect(file.path).toBe('designs/a.html');
    const form = calls[0]!.init?.body as FormData;
    expect(form.get('name')).toBe('designs/a.html');
    expect((form.get('file') as File).name).toBe('a.html');
    expect(calls[0]!.url.pathname).toBe('/api/projects/p1/files');
  });
});

describe('naming helpers', () => {
  it('suggests canonical, unique design paths', () => {
    expect(suggestDesignPath('首页', [])).toBe('designs/首页.fig');
    expect(suggestDesignPath('My page', ['designs/My-page.fig'])).toBe('designs/My-page-2.fig');
    expect(suggestDesignPath('x', ['designs/x.op'], 'op')).toBe('designs/x-2.op');
    expect(suggestDesignPath('copy', ['art/copy.fig'], 'fig', 'art')).toBe('art/copy-2.fig');
  });

  it('quotes and parses ETags; derives directories', () => {
    expect(quoteEtag('abc')).toBe('"abc"');
    expect(parseEtag('"abc"')).toBe('abc');
    expect(parseEtag('W/"abc"')).toBe('abc');
    expect(parseEtag(null)).toBeNull();
    expect(designDirOf('designs/a.fig')).toBe('designs');
    expect(designDirOf('a.fig')).toBe('');
  });
});
