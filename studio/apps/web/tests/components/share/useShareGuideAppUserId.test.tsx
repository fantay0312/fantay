// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useShareGuideAppUserId } from '../../../src/components/share/useShareGuideAppUserId';
import { TOKENTOSEA_SESSION_EVENT } from '../../../src/lib/tokentosea-events';
const reader = vi.fn<() => Promise<Response>>();
const account = (id: string) => Response.json({ signedIn: true, user: { id, name: 'Test' } });
beforeEach(() => { reader.mockReset(); vi.stubGlobal('fetch', reader); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('TokenToSea share account reader', () => {
  it('uses the authenticated TokenToSea account id', async () => {
    reader.mockResolvedValue(account('tts|user-1')); const { result } = renderHook(useShareGuideAppUserId);
    await waitFor(() => expect(result.current).toBe('tts|user-1'));
  });
  it.each([{ signedIn: true, user: { id: '' } }, { signedIn: false, user: { id: 'expired' } }, null])('keeps missing or expired identity unknown', async status => {
    reader.mockResolvedValue(Response.json(status)); const { result } = renderHook(useShareGuideAppUserId);
    await act(async () => { await Promise.resolve(); }); expect(result.current).toBeNull();
  });
  it('rejects an old account response after a fresh TokenToSea login', async () => {
    let finish!: (response: Response) => void;
    reader.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(useShareGuideAppUserId);
    reader.mockResolvedValue(account('new-user'));
    act(() => { window.dispatchEvent(new Event(TOKENTOSEA_SESSION_EVENT)); });
    await waitFor(() => expect(result.current).toBe('new-user'));
    await act(async () => finish(account('old-user'))); expect(result.current).toBe('new-user');
  });
});
