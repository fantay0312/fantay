import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardCoverRef, WorkspaceCollabContext } from '@open-design/contracts';

import {
  BoardRequestError,
  boardCoverSrc,
  fetchBoard,
  isBoardOfflineError,
  patchBoard,
  putBoard,
  putBoardViewport,
  syncBoard,
  uploadBoardCover,
} from '../../../src/fantay/board/data/board-api';

const WORKSPACE = {
  workspaceId: 'ws-1',
  workspaceType: 'team',
  workspaceMemberId: 'm-1',
  role: 'member',
  lifecycleState: 'active',
  memberStatus: 'active',
  permissions: { canShareProjects: true, canWriteSyncedFiles: false },
} as unknown as WorkspaceCollabContext;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** `respond` runs per call: a Response body can be read only once. */
function mockFetch(respond: () => Response | Promise<Response>) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => respond());
  vi.stubGlobal('fetch', fn);
  return fn;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('board api', () => {
  it('GETs the board (optionally with the sync ledger) without workspace headers for local projects', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ board: { revision: 3 } }));
    const response = await fetchBoard('p/1');
    expect(response).toEqual({ board: { revision: 3 } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/p%2F1/board');
    expect(init?.method).toBe('GET');
    expect(init?.cache).toBe('no-store');
    expect(headersOf(init)['x-od-workspace-id']).toBeUndefined();
    await fetchBoard('p1', { includeSync: true });
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/projects/p1/board?include=sync');
  });

  it('sends the workspace identity headers and JSON bodies on writes', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ revision: 1, updatedAt: 1, results: [], changes: {}, inverse: [] }));
    const body = { baseRevision: 0, ops: [], actor: { kind: 'user' as const, clientId: 'c1' } };
    await patchBoard('p1', body, { workspaceContext: WORKSPACE });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/p1/board');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual(body);
    const headers = headersOf(init);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-od-workspace-id']).toBe('ws-1');
    expect(headers['x-od-workspace-member-id']).toBe('m-1');
    expect(init?.keepalive).toBeUndefined();

    await putBoard('p1', { baseRevision: 2, board: { nodes: [], edges: [] } });
    expect(fetchMock.mock.calls[1]![1]?.method).toBe('PUT');
    await syncBoard('p1', { reason: 'open' });
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/projects/p1/board/sync');
    expect(fetchMock.mock.calls[2]![1]?.method).toBe('POST');
  });

  it('PUTs the viewport as {viewport} and supports keepalive', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: true }));
    await putBoardViewport('p1', { centerX: 1, centerY: 2, zoom: 0.5 }, { keepalive: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/p1/board/viewport');
    expect(init?.method).toBe('PUT');
    expect(init?.keepalive).toBe(true);
    expect(JSON.parse(String(init?.body))).toEqual({ viewport: { centerX: 1, centerY: 2, zoom: 0.5 } });
  });

  it('uploads covers as raw bytes with size query parameters', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ cover: { source: 'board-cover', digest: 'abc' }, url: '/x' }));
    const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
    await uploadBoardCover('p1', image, { width: 640.4, height: 360, sourceMtime: 1234.9 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/p1/board/covers?width=640&height=360&sourceMtime=1234');
    expect(init?.method).toBe('PUT');
    expect(headersOf(init)['content-type']).toBe('image/webp');
    expect(init?.body).toBe(image);
  });

  it('maps the daemon error envelope to BoardRequestError', async () => {
    mockFetch(() => jsonResponse({
      error: { code: 'CONFLICT', message: 'board changed since it was read', details: { kind: 'board-conflict', revision: 4, conflicts: [] } },
    }, 409));
    const error = await patchBoard('p1', { baseRevision: 1, ops: [] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BoardRequestError);
    expect(error).toMatchObject({
      code: 'CONFLICT',
      status: 409,
      message: 'board changed since it was read',
      details: { kind: 'board-conflict', revision: 4 },
    });
    expect(isBoardOfflineError(error)).toBe(false);
  });

  it('maps non-JSON failures, network failures and aborts', async () => {
    mockFetch(() => new Response('gateway down', { status: 502 }));
    const gateway = await fetchBoard('p1').catch((caught: unknown) => caught);
    expect(gateway).toMatchObject({ code: 'HTTP_502', status: 502 });
    expect(isBoardOfflineError(gateway)).toBe(true);

    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const network = await fetchBoard('p1').catch((caught: unknown) => caught);
    expect(network).toMatchObject({ code: 'NETWORK_ERROR', status: null });
    expect(isBoardOfflineError(network)).toBe(true);

    const controller = new AbortController();
    controller.abort();
    mockFetch(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const aborted = await fetchBoard('p1', { signal: controller.signal }).catch((caught: unknown) => caught);
    expect(aborted).toMatchObject({ code: 'ABORTED', status: null });
    expect(isBoardOfflineError(aborted)).toBe(false);
  });

  it('builds cover image URLs with the workspace query for both cover sources', () => {
    const digestCover: BoardCoverRef = { source: 'board-cover', digest: 'f'.repeat(64), mime: 'image/webp', width: 10, height: 10, capturedAt: 1 };
    expect(boardCoverSrc('p1', digestCover)).toBe(`/api/projects/p1/board/covers/${'f'.repeat(64)}`);
    expect(boardCoverSrc('p1', digestCover, WORKSPACE))
      .toBe(`/api/projects/p1/board/covers/${'f'.repeat(64)}?workspaceId=ws-1&workspaceMemberId=m-1`);
    expect(boardCoverSrc('p 1', { source: 'chat-artifact-snapshot', snapshotId: 's/1' }, WORKSPACE))
      .toBe('/api/projects/p%201/chat-artifact-snapshots/s%2F1/thumbnail?workspaceId=ws-1&workspaceMemberId=m-1');
  });
});
