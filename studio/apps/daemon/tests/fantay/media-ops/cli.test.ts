import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBoardMediaCli as runBoardMedia } from '../../../src/fantay/media-ops/media-ops-cli.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function capture() {
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  return { stdout, stderr };
}
describe('od board media', () => {
  it('provides help and rejects unknown flags and unsafe paths before contacting a daemon', async () => {
    const io = capture(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await runBoardMedia(['--help'])).toEqual({ exitCode: 0 });
    expect(io.stdout.mock.calls[0]![0]).toContain('crop|split|scale');
    expect(await runBoardMedia(['crop', '--unknown'])).toEqual({ exitCode: 2 });
    expect(await runBoardMedia(['scale','--project','p','--input','../secret.png','--factor','2'])).toEqual({ exitCode: 2 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('posts validated parameters, preserves workspace identity and prints JSON', async () => {
    const io = capture();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ op: 'scale', files: [{ path: 'result.png' }] })));
    vi.stubGlobal('fetch', fetch);
    expect(await runBoardMedia(['upscale','--project','p','--input','in.png','--factor','2','--daemon-url','http://127.0.0.1:1234','--workspace','w','--workspace-member','m','--json'])).toEqual({ exitCode: 0 });
    expect(fetch.mock.calls[0]![0]).toBe('http://127.0.0.1:1234/api/projects/p/media/ops');
    const options = fetch.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(options.body))).toEqual({ op:'scale', input:'in.png',params:{factor:2} });
    expect(options.headers).toMatchObject({ 'x-od-workspace-id':'w','x-od-workspace-member-id':'m' });
    expect(JSON.parse(String(io.stdout.mock.calls[0]![0])).files[0].path).toBe('result.png');
  });
  it.each([['FILE_NOT_FOUND',404,67],['PROJECT_NOT_FOUND',404,68],['BAD_REQUEST',400,2]])('maps %s to its documented exit code', async (code, status, exitCode) => {
    capture(); vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error:{code,message:'failure'} }),{status})));
    expect(await runBoardMedia(['scale','--project','p','--input','in.png','--factor','2','--daemon-url','http://127.0.0.1:1234'])).toEqual({ exitCode });
  });
  it('reports daemon transport failures as exit 64', async () => {
    capture(); vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await runBoardMedia(['scale','--project','p','--input','in.png','--factor','2','--daemon-url','http://127.0.0.1:1234'])).toEqual({ exitCode:64 });
  });
});
