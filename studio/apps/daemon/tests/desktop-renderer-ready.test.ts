import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopStatusSnapshot } from '@open-design/sidecar-proto';
import { createDesktopFrameRendererReady } from '../src/sidecar/server.js';

afterEach(() => { vi.useRealTimers(); });
it('deduplicates probes and refreshes both positive and negative results after ten seconds', async () => {
  vi.useFakeTimers();
  const status = vi.fn(async () => ({ state:'running',capabilities:{frameRenderer:true} } as DesktopStatusSnapshot));
  const ready = createDesktopFrameRendererReady(status);
  expect(await Promise.all([ready(),ready()])).toEqual([true,true]);
  expect(status).toHaveBeenCalledTimes(1);
  status.mockRejectedValue(new Error('stopped'));
  await vi.advanceTimersByTimeAsync(9999); expect(await ready()).toBe(true);
  await vi.advanceTimersByTimeAsync(1); expect(await ready()).toBe(false);
  expect(status).toHaveBeenCalledTimes(2);
});
it('bounds an unresponsive desktop probe to 1500ms', async () => {
  vi.useFakeTimers();
  const status = vi.fn(() => new Promise<DesktopStatusSnapshot>(() => {}));
  const pending = createDesktopFrameRendererReady(status)();
  await vi.advanceTimersByTimeAsync(1500);
  expect(await pending).toBe(false);
  expect(status).toHaveBeenCalledWith(1500);
});
