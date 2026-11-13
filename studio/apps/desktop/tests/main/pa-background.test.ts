import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaControl } from '@open-design/contracts';
import { PaBackgroundController, type PaBackgroundActions } from '../../src/main/pa-background.js';

const base: PaControl = { id: 'control', revision: 1, createdAt: 1, updatedAt: 1, backgroundEnabled: true, paused: false, suspended: false, maxConcurrent: 2, defaultMaxAttempts: 6, defaultTimeoutMs: 300000, waitingExpiryMs: 86400000, activeCount: 1, pendingCount: 0, lastResumeAt: null };
const controllers: PaBackgroundController[] = [];
afterEach(() => { controllers.forEach(controller => controller.dispose()); controllers.length = 0; });
describe('PA desktop background controller', () => {
  it('uses cached close policy and preserves a tray route to reopen/pause/quit', async () => {
    let state = { ...base }, actions!: PaBackgroundActions;
    const show = vi.fn(), quit = vi.fn(), dispose = vi.fn(), update = vi.fn();
    const request = vi.fn<typeof fetch>(async (_url, init) => { if (init?.method === 'PATCH') state = { ...state, ...JSON.parse(String(init.body)) }; return Response.json(state); });
    const controller = new PaBackgroundController({ daemonUrl: async () => 'http://127.0.0.1:17456', fetch: request, show, quit, platform: 'win32', createTray: async value => { actions = value; return { update, dispose }; } });
    controllers.push(controller);
    expect(controller.keepRunningOnClose()).toBe(false);
    await controller.start(); expect(controller.keepRunningOnClose()).toBe(true);
    actions.show(); expect(show).toHaveBeenCalledOnce();
    actions.togglePause(); await vi.waitFor(() => expect(state.paused).toBe(true));
    actions.quit(); expect(quit).toHaveBeenCalledOnce();
    await controller.patch({ backgroundEnabled: false }); expect(controller.keepRunningOnClose()).toBe(false);
    controller.dispose(); expect(dispose).toHaveBeenCalledOnce(); expect(controller.keepRunningOnClose()).toBe(false);
  });
  it('reports suspend and resume independently from manual pause', async () => {
    const bodies: unknown[] = [];
    const request = vi.fn<typeof fetch>(async (_url, init) => { if (init?.body) bodies.push(JSON.parse(String(init.body))); return Response.json({ ...base, paused: true }); });
    const controller = new PaBackgroundController({ daemonUrl: async () => 'http://127.0.0.1:17456', fetch: request, show: vi.fn(), quit: vi.fn(), platform: 'darwin' });
    controllers.push(controller); await controller.start(); await controller.power('suspend'); await controller.power('resume');
    expect(bodies).toEqual([{ state: 'suspend' }, { state: 'resume' }]);
    expect(bodies).not.toContainEqual({ paused: false });
  });
  it('keeps non-macOS window-close quit behavior if the tray cannot be created', async () => {
    const controller = new PaBackgroundController({ daemonUrl: async () => 'http://127.0.0.1:17456', fetch: async () => Response.json(base), show: vi.fn(), quit: vi.fn(), platform: 'win32', createTray: async () => { throw new Error('tray unavailable'); } });
    controllers.push(controller); await controller.start(); expect(controller.keepRunningOnClose()).toBe(false);
  });
  it('retains a power transition across a temporary daemon disconnect', async () => {
    let fail = true;
    const request = vi.fn<typeof fetch>(async () => { if (fail) throw new Error('offline'); return Response.json(base); });
    const controller = new PaBackgroundController({ daemonUrl: async () => 'http://127.0.0.1:17456', fetch: request, show: vi.fn(), quit: vi.fn() });
    controllers.push(controller); await controller.power('resume'); fail = false; await controller.refresh();
    expect(request.mock.lastCall?.[1]?.body).toBe(JSON.stringify({ state: 'resume' }));
  });
});
