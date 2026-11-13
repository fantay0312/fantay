// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DESIGN_BRIDGE_PROTOCOL,
  DESIGN_BRIDGE_VERSION,
  DesignBridgeFailure,
  type DesignInitPayload,
} from '@open-design/contracts';

import {
  DesignBridgeSession,
  useDesignBridge,
  type DesignBridgeSessionOptions,
  type DesignBridgeStatus,
} from '../../../src/fantay/design/useDesignBridge';
import { FakeEditor, HELLO, HOLD, connectFakeEditor, settle, type WireMessage } from './helpers/fake-editor';

const INIT: DesignInitPayload = {
  sessionId: '',
  theme: 'dark',
  locale: 'en',
  messages: {},
  forwardShortcuts: [],
  closeOnEscape: false,
};

let iframe: HTMLIFrameElement;
const sessions: DesignBridgeSession[] = [];
const editors: FakeEditor[] = [];

beforeEach(() => {
  iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
});

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const editor of editors.splice(0)) editor.close();
  iframe.remove();
  vi.restoreAllMocks();
});

function makeSession(overrides: Partial<DesignBridgeSessionOptions> = {}) {
  const statuses: Array<{ status: DesignBridgeStatus; code: string | null }> = [];
  const handlers = {
    init: vi.fn((sessionId: string) => ({ ...INIT, sessionId })),
    onEvent: vi.fn(),
    onRequest: vi.fn(async (_type: string, _payload: unknown): Promise<{ payload: never }> => ({ payload: {} as never })),
  };
  const session = new DesignBridgeSession({
    getIframe: () => iframe,
    getHandlers: () => handlers,
    onStatus: (status, error) => statuses.push({ status, code: error?.code ?? null }),
    ...overrides,
  });
  sessions.push(session);
  session.start();
  return { session, statuses, handlers };
}

function hello(data: unknown, init: { origin?: string; source?: unknown } = {}): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data,
      origin: init.origin ?? window.location.origin,
      source: (init.source ?? iframe.contentWindow) as Window,
    }),
  );
}

async function connected(session: DesignBridgeSession): Promise<FakeEditor> {
  const editor = connectFakeEditor(iframe);
  editors.push(editor);
  await settle(() => session.status === 'ready');
  return editor;
}

describe('DesignBridgeSession handshake', () => {
  it('ignores a hello from another origin', () => {
    const post = vi.spyOn(iframe.contentWindow as Window, 'postMessage').mockImplementation(() => undefined);
    const { session } = makeSession();
    hello(HELLO, { origin: 'https://evil.example' });
    expect(session.status).toBe('booting');
    expect(post).not.toHaveBeenCalled();
  });

  it('ignores a hello from another window', () => {
    const other = document.createElement('iframe');
    document.body.appendChild(other);
    const post = vi.spyOn(iframe.contentWindow as Window, 'postMessage').mockImplementation(() => undefined);
    const { session } = makeSession();
    hello(HELLO, { source: other.contentWindow });
    hello(HELLO, { source: window });
    expect(session.status).toBe('booting');
    expect(post).not.toHaveBeenCalled();
    other.remove();
  });

  it('ignores messages that are not a valid hello', () => {
    const post = vi.spyOn(iframe.contentWindow as Window, 'postMessage').mockImplementation(() => undefined);
    const { session } = makeSession();
    hello({ ...HELLO, protocol: 'other' });
    hello({ ...HELLO, kind: 'event', type: 'state', payload: {} });
    hello('hello');
    expect(session.status).toBe('booting');
    expect(post).not.toHaveBeenCalled();
  });

  it('fails with UNSUPPORTED_VERSION on another protocol version, without connecting', () => {
    const post = vi.spyOn(iframe.contentWindow as Window, 'postMessage').mockImplementation(() => undefined);
    const { session, statuses } = makeSession();
    hello({ ...HELLO, v: 2 });
    expect(session.status).toBe('failed');
    expect(session.error?.code).toBe('UNSUPPORTED_VERSION');
    expect(statuses.at(-1)).toEqual({ status: 'failed', code: 'UNSUPPORTED_VERSION' });
    expect(post).not.toHaveBeenCalled();
  });

  it('connects with one transferred port at the window origin, sends init and becomes ready', async () => {
    const post = vi.spyOn(iframe.contentWindow as Window, 'postMessage').mockImplementation(() => undefined);
    const { session, statuses, handlers } = makeSession();
    hello(HELLO);
    expect(post).toHaveBeenCalledTimes(1);
    const [message, targetOrigin, transfer] = post.mock.calls[0] as unknown as [WireMessage, string, Transferable[]];
    expect(message).toMatchObject({ protocol: DESIGN_BRIDGE_PROTOCOL, v: DESIGN_BRIDGE_VERSION, kind: 'connect' });
    expect(message.sessionId).toBe(session.sessionId);
    expect(targetOrigin).toBe(window.location.origin);
    expect(transfer).toHaveLength(1);
    expect(session.status).toBe('handshaking');
    expect(session.capabilities).toContain('document.open');

    const editor = new FakeEditor(transfer[0] as MessagePort);
    editors.push(editor);
    await settle(() => session.status === 'ready');
    expect(handlers.init).toHaveBeenCalledWith(session.sessionId);
    expect(editor.requestsOf('init')[0]?.payload).toEqual({ ...INIT, sessionId: session.sessionId });
    expect(statuses.map((entry) => entry.status)).toEqual(['handshaking', 'ready']);

    // The window listener is gone: a second hello does nothing.
    hello(HELLO);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('fails with ENGINE_LOAD_FAILED when no hello arrives in time', async () => {
    const { session, statuses } = makeSession({ helloTimeoutMs: 20 });
    await settle(() => session.status === 'failed');
    expect(session.error?.code).toBe('ENGINE_LOAD_FAILED');
    expect(statuses.at(-1)?.code).toBe('ENGINE_LOAD_FAILED');
  });

  it('fails when the editor rejects init', async () => {
    const { session } = makeSession();
    const editor = connectFakeEditor(iframe);
    editors.push(editor);
    editor.on('init', () => Promise.reject({ code: 'ENGINE_LOAD_FAILED', message: 'no canvaskit' }));
    await settle(() => session.status === 'failed');
    expect(session.error).toEqual({ code: 'ENGINE_LOAD_FAILED', message: 'no canvaskit' });
  });
});

describe('DesignBridgeSession requests', () => {
  it('correlates responses by request id', async () => {
    const { session } = makeSession();
    const editor = await connected(session);
    const resolvers = new Map<string, (value: unknown) => void>();
    editor.on('selection.set', (payload) => new Promise((resolve) => resolvers.set(String((payload as { nodeIds: string[] }).nodeIds[0]), resolve)));
    const first = session.request('selection.set', { nodeIds: ['a'] });
    const second = session.request('selection.set', { nodeIds: ['b'] });
    await settle(() => resolvers.size === 2);
    resolvers.get('b')?.({ selected: ['b'] });
    resolvers.get('a')?.({ selected: ['a'] });
    await expect(second).resolves.toEqual({ selected: ['b'] });
    await expect(first).resolves.toEqual({ selected: ['a'] });
  });

  it('rejects with the error code of an error response', async () => {
    const { session } = makeSession();
    const editor = await connected(session);
    editor.on('document.exportCover', () => Promise.reject({ code: 'EMPTY_DOCUMENT', message: 'nothing on the page' }));
    const failure = await session.request('document.exportCover', { maxEdge: 1600 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DesignBridgeFailure);
    expect((failure as DesignBridgeFailure).code).toBe('EMPTY_DOCUMENT');
  });

  it('times out an unanswered request with TIMEOUT', async () => {
    const { session } = makeSession();
    const editor = await connected(session);
    editor.on('focus', () => HOLD);
    const failure = await session.request('focus', {}, { timeoutMs: 30 }).catch((error: unknown) => error);
    expect((failure as DesignBridgeFailure).code).toBe('TIMEOUT');
  });

  it('honours the transfer list (the buffer moves to the editor)', async () => {
    const { session } = makeSession();
    const editor = await connected(session);
    let received: unknown = null;
    editor.on('insert', (payload) => {
      received = (payload as { items: Array<{ bytes: ArrayBuffer }> }).items[0]?.bytes;
      return { nodeIds: ['1:1'] };
    });
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const result = session.request('insert', { items: [{ kind: 'image', name: 'a.png', mime: 'image/png', bytes: buffer }] }, { transfer: [buffer] });
    expect(buffer.byteLength).toBe(0); // detached on the host side
    await expect(result).resolves.toEqual({ nodeIds: ['1:1'] });
    expect((received as ArrayBuffer).byteLength).toBe(4);
  });

  it('rejects pending requests with CANCELLED on dispose', async () => {
    const { session } = makeSession();
    const editor = await connected(session);
    editor.on('document.flush', () => HOLD);
    const pending = session.request('document.flush', { reason: 'close' });
    await settle(() => editor.requestsOf('document.flush').length === 1);
    session.dispose();
    const failure = await pending.catch((error: unknown) => error);
    expect((failure as DesignBridgeFailure).code).toBe('CANCELLED');
    await expect(session.request('focus', {})).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('rejects requests before the editor connected with NOT_INITIALIZED', async () => {
    const { session } = makeSession();
    await expect(session.request('focus', {})).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });
  });
});

describe('DesignBridgeSession editor → host traffic', () => {
  it('answers editor requests through onRequest and serializes failures', async () => {
    const { session, handlers } = makeSession();
    const editor = await connected(session);
    handlers.onRequest.mockImplementation(async (type: string) => {
      if (type === 'asset.fetch') return { payload: { bytes: new Uint8Array([7]).buffer, mime: 'image/png' } as never };
      throw new DesignBridgeFailure('CONFLICT', 'changed elsewhere', { currentSha256: 'abc' });
    });
    const asset = await editor.request('asset.fetch', { path: 'img/a.png' });
    expect(asset).toMatchObject({ kind: 'response', ok: true, payload: { mime: 'image/png' } });
    expect(handlers.onRequest).toHaveBeenCalledWith('asset.fetch', { path: 'img/a.png' });

    const save = await editor.request('document.save', { bytes: new ArrayBuffer(2), format: 'fig', baseSha256: 'old', reason: 'autosave' });
    expect(save).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: 'changed elsewhere', details: { currentSha256: 'abc' } } });
  });

  it('answers unknown or malformed requests with INVALID_REQUEST without calling onRequest', async () => {
    const { session, handlers } = makeSession();
    const editor = await connected(session);
    const unknown = await editor.request('agent.tool', { tool: 'x' });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    const malformed = await editor.request('document.save', { bytes: 'not a buffer', format: 'fig', baseSha256: null, reason: 'autosave' });
    expect(malformed).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(handlers.onRequest).not.toHaveBeenCalled();
  });

  it('delivers valid events and drops malformed or unknown ones', async () => {
    const { session, handlers } = makeSession();
    const editor = await connected(session);
    editor.emit('selection', { pageId: '0:1', nodeIds: ['1:2'], nodes: [{ id: '1:2', name: 'Hero', type: 'FRAME', width: 1440, height: 900 }] });
    editor.emit('view', { zoom: 'big', pageId: '0:1', pages: [] });
    editor.emit('mystery', {});
    editor.emit('shortcut', { combo: '$mod+KeyK' });
    await settle(() => handlers.onEvent.mock.calls.length >= 2);
    await settle();
    expect(handlers.onEvent.mock.calls.map((call) => call[0])).toEqual(['selection', 'shortcut']);
    expect(handlers.onEvent.mock.calls[0]?.[1]).toEqual({
      pageId: '0:1',
      nodeIds: ['1:2'],
      nodes: [{ id: '1:2', name: 'Hero', type: 'FRAME', width: 1440, height: 900 }],
    });
  });
});

describe('useDesignBridge', () => {
  it('reports booting → ready and starts over on retry', async () => {
    const iframeRef = { current: iframe };
    const { result } = renderHook(() =>
      useDesignBridge({
        iframe: iframeRef,
        init: (sessionId) => ({ ...INIT, sessionId }),
        onEvent: () => undefined,
        onRequest: async () => ({ payload: {} as never }),
      }),
    );
    expect(result.current.status).toBe('booting');
    expect(result.current.generation).toBe(0);
    const editor = connectFakeEditor(iframe);
    editors.push(editor);
    await settle(() => result.current.status === 'ready');
    await expect(result.current.request('focus', {})).resolves.toEqual({});

    act(() => result.current.retry());
    expect(result.current.status).toBe('booting');
    expect(result.current.generation).toBe(1);
    await expect(result.current.request('focus', {})).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });
  });

  it('has no session while disabled', async () => {
    const iframeRef = { current: iframe };
    const post = vi.spyOn(iframe.contentWindow as Window, 'postMessage').mockImplementation(() => undefined);
    const { result } = renderHook(() =>
      useDesignBridge({
        iframe: iframeRef,
        enabled: false,
        init: (sessionId) => ({ ...INIT, sessionId }),
        onEvent: () => undefined,
        onRequest: async () => ({ payload: {} as never }),
      }),
    );
    hello(HELLO);
    expect(post).not.toHaveBeenCalled();
    expect(result.current.status).toBe('booting');
  });
});
