// SPDX-License-Identifier: Apache-2.0
/**
 * Editor side of the host bridge (06 §5.1, §5.4): handshake checks, the request handler
 * registry and its payload guards, error responses, events, editor → host requests.
 */
import {
  DESIGN_BRIDGE_PROTOCOL,
  DESIGN_BRIDGE_VERSION,
  DesignBridgeFailure,
  type DesignBridgeMessage,
} from '@open-design/contracts/runtime/design-editor-bridge';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectEditorBridge, HOST_REQUEST_GUARDS, type EditorBridge } from '../src/host/bridge';

const ORIGIN = 'http://localhost:17573';
const envelope = { protocol: DESIGN_BRIDGE_PROTOCOL, v: DESIGN_BRIDGE_VERSION } as const;
const HELLO = { editorVersion: '0.1.0', engines: { openPencil: '0.16.0', opWebSdk: '0.8.0' }, capabilities: ['document.open' as const] };
const INIT = { sessionId: 's1', theme: 'dark', locale: 'zh-CN', messages: { 'designEditor.panel.layers': '图层' }, forwardShortcuts: ['$mod+KeyK'], closeOnEscape: false };

function fakeWindow() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const posted: Array<{ message: unknown; targetOrigin: string }> = [];
  const parent = { postMessage: (message: unknown, targetOrigin: string) => posted.push({ message, targetOrigin }) };
  const win = {
    parent,
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === 'message') listeners.delete(listener);
    },
  };
  function dispatch(init: { data: unknown; origin?: string; source?: unknown; ports?: MessagePort[] }) {
    const event = { data: init.data, origin: init.origin ?? ORIGIN, source: init.source ?? parent, ports: init.ports ?? [] } as unknown as MessageEvent;
    for (const listener of [...listeners]) listener(event);
  }
  return { win: win as unknown as Window, parent, posted, dispatch, listeners };
}

const open: Array<{ bridge: EditorBridge | null; ports: MessagePort[] }> = [];

afterEach(() => {
  for (const { bridge, ports } of open.splice(0)) {
    bridge?.dispose();
    for (const port of ports) port.close();
  }
  vi.useRealTimers();
});

/** A connected bridge plus the host end of its channel. */
async function connected() {
  const fake = fakeWindow();
  const bridge = connectEditorBridge(fake.win, HELLO)!;
  const channel = new MessageChannel();
  open.push({ bridge, ports: [channel.port1, channel.port2] });
  fake.dispatch({ data: { ...envelope, kind: 'connect', sessionId: 's1' }, ports: [channel.port2] });
  const host = channel.port1;
  const inbox: DesignBridgeMessage[] = [];
  const waiters: Array<(message: DesignBridgeMessage) => void> = [];
  host.onmessage = (event: MessageEvent) => {
    const waiter = waiters.shift();
    if (waiter) waiter(event.data);
    else inbox.push(event.data);
  };
  const next = () =>
    new Promise<DesignBridgeMessage>((resolve) => {
      const queued = inbox.shift();
      if (queued) resolve(queued);
      else waiters.push(resolve);
    });
  return { fake, bridge, host, next };
}

describe('handshake', () => {
  it('returns null when the page is not embedded', () => {
    const fake = fakeWindow();
    (fake.win as unknown as { parent: unknown }).parent = fake.win;
    expect(connectEditorBridge(fake.win, HELLO)).toBeNull();
  });

  it('says hello to the parent window on its own origin', () => {
    const fake = fakeWindow();
    const bridge = connectEditorBridge(fake.win, HELLO);
    open.push({ bridge, ports: [] });
    expect(fake.posted).toEqual([{ message: { ...envelope, kind: 'hello', ...HELLO }, targetOrigin: ORIGIN }]);
  });

  it('repeats the hello until a host connects', () => {
    vi.useFakeTimers();
    const fake = fakeWindow();
    const bridge = connectEditorBridge(fake.win, HELLO);
    open.push({ bridge, ports: [] });
    vi.advanceTimersByTime(3000);
    expect(fake.posted).toHaveLength(3);
    vi.advanceTimersByTime(60_000);
    expect(fake.posted).toHaveLength(3);
  });

  it('accepts only a connect from the parent, on its origin, with one port', async () => {
    const fake = fakeWindow();
    const bridge = connectEditorBridge(fake.win, HELLO)!;
    const channel = new MessageChannel();
    open.push({ bridge, ports: [channel.port1, channel.port2] });
    const connect = { ...envelope, kind: 'connect', sessionId: 'good' };
    fake.dispatch({ data: connect, origin: 'http://evil.test', ports: [channel.port2] });
    fake.dispatch({ data: connect, source: {}, ports: [channel.port2] });
    fake.dispatch({ data: connect, ports: [] });
    fake.dispatch({ data: { ...connect, v: 2 }, ports: [channel.port2] });
    fake.dispatch({ data: { ...envelope, kind: 'event', type: 'theme', payload: { theme: 'dark' } }, ports: [channel.port2] });
    expect(fake.listeners.size).toBe(1);
    fake.dispatch({ data: { ...connect, sessionId: 'session-42' }, ports: [channel.port2] });
    await expect(bridge.sessionId).resolves.toBe('session-42');
    expect(fake.listeners.size).toBe(0);
  });
});

describe('host → editor requests', () => {
  it('answers through the registered handler', async () => {
    const { bridge, host, next } = await connected();
    const handler = vi.fn(async () => ({ payload: { ready: true as const } }));
    bridge.handle('init', handler);
    host.postMessage({ ...envelope, kind: 'request', id: 'r1', type: 'init', payload: INIT });
    expect(await next()).toEqual({ ...envelope, kind: 'response', replyTo: 'r1', ok: true, payload: { ready: true } });
    expect(handler).toHaveBeenCalledWith(INIT);
  });

  it('answers unknown types and invalid payloads with INVALID_REQUEST', async () => {
    const { bridge, host, next } = await connected();
    const open = vi.fn(async () => ({ payload: {} as never }));
    bridge.handle('document.open', open);
    host.postMessage({ ...envelope, kind: 'request', id: 'r1', type: 'agent.tool', payload: {} });
    expect(await next()).toMatchObject({ kind: 'response', replyTo: 'r1', ok: false, error: { code: 'INVALID_REQUEST' } });
    host.postMessage({ ...envelope, kind: 'request', id: 'r2', type: 'document.open', payload: { source: 'url', name: 'x' } });
    expect(await next()).toMatchObject({ replyTo: 'r2', ok: false, error: { code: 'INVALID_REQUEST' } });
    host.postMessage({ ...envelope, kind: 'request', id: 'r3', type: 'init', payload: INIT });
    expect(await next()).toMatchObject({ replyTo: 'r3', ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(open).not.toHaveBeenCalled();
  });

  it('serializes handler failures', async () => {
    const { bridge, host, next } = await connected();
    bridge.handle('document.forceSave', async () => {
      throw new DesignBridgeFailure('CONFLICT', 'changed', { currentSha256: null });
    });
    bridge.handle('focus', async () => {
      throw new Error('boom');
    });
    host.postMessage({ ...envelope, kind: 'request', id: 'r1', type: 'document.forceSave', payload: { baseSha256: null } });
    expect(await next()).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: 'changed', details: { currentSha256: null } } });
    host.postMessage({ ...envelope, kind: 'request', id: 'r2', type: 'focus', payload: {} });
    expect(await next()).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'boom' } });
  });

  it('transfers response buffers', async () => {
    const { bridge, host, next } = await connected();
    const png = new Uint8Array([1, 2, 3]).buffer;
    bridge.handle('document.exportCover', async () => ({ payload: { png, width: 1, height: 1, pageId: 'p', sourceSha256: null }, transfer: [png] }));
    host.postMessage({ ...envelope, kind: 'request', id: 'r1', type: 'document.exportCover', payload: { maxEdge: 1600 } });
    const response = (await next()) as { payload: { png: ArrayBuffer } };
    expect(response.payload.png.byteLength).toBe(3);
    expect(png.byteLength).toBe(0);
  });

  it('guards each request payload', () => {
    const bytes = new ArrayBuffer(4);
    const project = { kind: 'project', projectId: 'p1', path: 'designs/a.fig' };
    expect(HOST_REQUEST_GUARDS['document.open']({ source: 'bytes', identity: project, name: 'a', format: 'fig', bytes, sha256: 'a'.repeat(64), readOnly: false })).toBe(true);
    expect(HOST_REQUEST_GUARDS['document.open']({ source: 'bytes', identity: project, name: 'a', format: 'png', bytes, sha256: null, readOnly: false })).toBe(false);
    expect(HOST_REQUEST_GUARDS['document.open']({ source: 'blank', identity: { kind: 'legacy', legacyId: 'x', name: 'x' }, name: 'a', pageName: 'P' })).toBe(false);
    expect(HOST_REQUEST_GUARDS['document.open']({ source: 'import', identity: project, name: 'a', fileName: 'a.svg', bytes })).toBe(true);
    expect(HOST_REQUEST_GUARDS['view.command']({ command: 'zoomFit' })).toBe(true);
    expect(HOST_REQUEST_GUARDS['view.command']({ command: 'reload' })).toBe(false);
    expect(HOST_REQUEST_GUARDS['document.flush']({ reason: 'close' })).toBe(true);
    expect(HOST_REQUEST_GUARDS['document.flush']({ reason: 'later' })).toBe(false);
    expect(HOST_REQUEST_GUARDS['document.exportCover']({ maxEdge: 9000 })).toBe(false);
    expect(HOST_REQUEST_GUARDS.insert({ items: [{ kind: 'image', name: 'a.png', mime: 'image/png', bytes }] })).toBe(true);
    expect(HOST_REQUEST_GUARDS.insert({ items: [] })).toBe(false);
    expect(HOST_REQUEST_GUARDS['selection.set']({ nodeIds: ['1:2'], reveal: true })).toBe(true);
    const messages = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`k${index}`, 'v']));
    expect(HOST_REQUEST_GUARDS.init({ ...INIT, messages })).toBe(false);
  });
});

describe('events', () => {
  it('delivers valid host events and drops the rest', async () => {
    const { bridge, host } = await connected();
    const themes: string[] = [];
    const stop = bridge.on('theme', ({ theme }) => themes.push(theme));
    host.postMessage({ ...envelope, kind: 'event', type: 'theme', payload: { theme: 'light' } });
    host.postMessage({ ...envelope, kind: 'event', type: 'theme', payload: { theme: 'sepia' } });
    host.postMessage({ ...envelope, kind: 'event', type: 'unknown', payload: {} });
    host.postMessage({ ...envelope, kind: 'event', type: 'theme', payload: { theme: 'dark' } });
    await vi.waitFor(() => expect(themes).toEqual(['light', 'dark']));
    stop();
    host.postMessage({ ...envelope, kind: 'event', type: 'theme', payload: { theme: 'light' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(themes).toEqual(['light', 'dark']);
  });

  it('emits editor events on the port', async () => {
    const { bridge, next } = await connected();
    bridge.emit('request-close', {});
    expect(await next()).toEqual({ ...envelope, kind: 'event', type: 'request-close', payload: {} });
  });
});

describe('editor → host requests', () => {
  it('correlates responses, rejects errors and transfers buffers', async () => {
    const { bridge, host, next } = await connected();
    const bytes = new Uint8Array([7, 7]).buffer;
    const saving = bridge.request('document.save', { bytes, format: 'fig', baseSha256: null, reason: 'convert' }, { transfer: [bytes] });
    const request = (await next()) as { id: string; type: string; payload: { bytes: ArrayBuffer } };
    expect(request).toMatchObject({ kind: 'request', type: 'document.save' });
    expect(request.payload.bytes.byteLength).toBe(2);
    expect(bytes.byteLength).toBe(0);
    host.postMessage({ ...envelope, kind: 'response', replyTo: request.id, ok: true, payload: { path: 'designs/a.fig', sha256: 'f'.repeat(64), size: 2, savedAt: 1 } });
    await expect(saving).resolves.toMatchObject({ path: 'designs/a.fig' });

    const failing = bridge.request('asset.fetch', { path: 'a.png' });
    const second = (await next()) as { id: string };
    host.postMessage({ ...envelope, kind: 'response', replyTo: second.id, ok: false, error: { code: 'NOT_FOUND', message: 'missing' } });
    await expect(failing).rejects.toMatchObject({ name: 'DesignBridgeFailure', code: 'NOT_FOUND' });
  });

  it('times out and cancels on dispose', async () => {
    const { bridge } = await connected();
    await expect(bridge.request('asset.fetch', { path: 'a.png' }, { timeoutMs: 10 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    const pending = bridge.request('asset.fetch', { path: 'b.png' });
    bridge.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(bridge.request('asset.fetch', { path: 'c.png' })).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });
  });
});
