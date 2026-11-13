import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveMovieWebUrl, runMovie } from '../../src/movie/movie-cli.js';
import { movieOpenUrl, movieWorkspaceUrl } from '../../src/movie/movie-links.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('Movie CLI browser URLs', () => {
  it('prepares live feedback through the same endpoint without rendering', async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/feedback-prompt')
      ? { prompt: 'Selected feedback', revision: 7, noteIds: ['n1'] }
      : { document: { revision: 7, renders: [] } })));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runMovie(['feedback-prompt', '--project', 'film', '--notes', 'n1', '--daemon-url', 'http://127.0.0.1:7456', '--web-url', 'http://localhost:5190', '--json']);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:7456/api/projects/film/movie/feedback-prompt', expect.objectContaining({ method: 'POST', body: expect.any(String) }));
    const request = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).find(([url]) => url.endsWith('/feedback-prompt'))![1];
    expect(JSON.parse(String(request.body))).toMatchObject({ expectedRevision: 7, noteIds: ['n1'] });
    expect(fetchMock.mock.calls.every(([url]) => !url.includes('/actions'))).toBe(true);
  });
  it('prints sources from the timeline route with a waveform pooled to 600 bins', async () => {
    const peaks = Array.from({ length: 3000 }, (_, i) => (i === 2999 ? 1 : 0.5));
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ sources: [{ assetId: 'a', frames: [], audioPeaks: peaks }] })));
    vi.stubGlobal('fetch', fetchMock);
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    await runMovie(['sources', '--project', 'film', '--daemon-url', 'http://127.0.0.1:7456', '--web-url', 'http://localhost:5190', '--json']);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:7456/api/projects/film/movie/sources', expect.objectContaining({ method: 'GET' }));
    const printed = JSON.parse(out.join(''));
    expect(printed.sources[0]).toMatchObject({ assetId: 'a', frames: [] });
    expect(printed.sources[0].audioPeaks).toHaveLength(600);
    expect(printed.sources[0].audioPeaks.at(-1)).toBe(1);
  });
  it('forwards the optional renderer with the revision-checked render action', async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body) calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ document: { revision: 5, renders: [] } }));
    }));
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runMovie(['render-preview', '--project', 'film-1', '--daemon-url', 'http://127.0.0.1:7456',
      '--web-url', 'http://localhost:5190', '--html-renderer', 'framevelo', '--json']);
    expect(calls).toContainEqual({ action: 'render-preview', htmlRenderer: 'framevelo', expectedRevision: 5 });
  });
  it('uses the web port advertised by the running daemon', async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ webBaseUrl: 'http://127.0.0.1:5173/' })));
    vi.stubGlobal('fetch', fetch);
    expect(await resolveMovieWebUrl('http://127.0.0.1:7456')).toBe('http://127.0.0.1:5173');
    expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:7456/api/mcp/install-info');
  });
  it('honors an explicit web origin without probing', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await resolveMovieWebUrl('http://127.0.0.1:7456', 'http://localhost:5190/')).toBe('http://localhost:5190');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('opens the film inside its project workspace', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    await runMovie([
      'open',
      '--project', 'film 1',
      '--daemon-url', 'http://127.0.0.1:7456',
      '--web-url', 'http://localhost:5190/',
      '--json',
    ]);
    expect(JSON.parse(out.join(''))).toEqual({
      projectId: 'film 1',
      url: 'http://localhost:5190/projects/film%201/files/movie-studio.json',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps the create entry only when no project is known', () => {
    expect(movieWorkspaceUrl('http://w', 'a/b')).toBe('http://w/projects/a%2Fb/files/movie-studio.json');
    expect(movieOpenUrl('http://w', 'p')).toBe('http://w/projects/p/files/movie-studio.json');
    expect(movieOpenUrl('http://w', '')).toBe('http://w/create/animation');
    expect(movieOpenUrl('http://w', null)).toBe('http://w/create/animation');
  });
});
