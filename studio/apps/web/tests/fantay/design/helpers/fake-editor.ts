// SPDX-License-Identifier: Apache-2.0
// Test double for the design editor iframe (spec 06 §5): it says `hello` to the host window, takes the
// transferred MessagePort from the host's `connect`, answers host requests with canned handlers and can
// send its own requests (`document.save`, `asset.fetch`) and events. jsdom has no MessageChannel; the
// Node one is used (structured clone + real transfer).
import { act } from '@testing-library/react';
import { vi } from 'vitest';
import {
  DESIGN_BRIDGE_PROTOCOL,
  DESIGN_BRIDGE_VERSION,
  type DesignBridgeError,
  type DesignHelloMessage,
  type DesignOpenResult,
} from '@open-design/contracts';

export const ORIGIN = 'http://localhost:3000';

export const HELLO: DesignHelloMessage = {
  protocol: DESIGN_BRIDGE_PROTOCOL,
  v: DESIGN_BRIDGE_VERSION,
  kind: 'hello',
  editorVersion: 'test',
  engines: { openPencil: '0.16.0', opWebSdk: '0.8.0' },
  capabilities: ['document.open', 'document.flush', 'document.saveCopy', 'document.forceSave', 'document.exportCover', 'document.exportHtml', 'insert'],
};

export const OPEN_RESULT: DesignOpenResult = {
  format: 'fig',
  readOnly: false,
  pageCount: 1,
  currentPageId: '0:1',
  foreign: false,
  needsSave: false,
  warnings: [],
};

export interface WireMessage {
  protocol: string;
  v: number;
  kind: string;
  id?: string;
  replyTo?: string;
  type?: string;
  ok?: boolean;
  payload?: unknown;
  error?: DesignBridgeError;
  sessionId?: string;
}

/** Return HOLD from a handler to leave the request unanswered. */
export const HOLD = Symbol('hold');

type Handler = (payload: unknown) => unknown;

/**
 * Polls `predicate`; each wait runs inside its own act() so React updates driven by port messages are
 * flushed (and rendered) before the next check, without act warnings.
 */
export async function settle(predicate: () => boolean = () => true, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  for (;;) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error('settle: condition not reached');
  }
}

export class FakeEditor {
  readonly requests: WireMessage[] = [];
  readonly events: WireMessage[] = [];
  private readonly handlers = new Map<string, Handler>();
  private readonly waiting = new Map<string, (message: WireMessage) => void>();
  private sequence = 0;

  constructor(readonly port: MessagePort) {
    this.handlers.set('init', () => ({ ready: true }));
    this.handlers.set('document.open', () => OPEN_RESULT);
    this.handlers.set('document.flush', () => ({ saved: false, dirty: false, sha256: null }));
    port.addEventListener('message', this.onMessage as EventListener);
    port.start();
  }

  on(type: string, handler: Handler): this {
    this.handlers.set(type, handler);
    return this;
  }

  requestsOf(type: string): WireMessage[] {
    return this.requests.filter((message) => message.type === type);
  }

  eventsOf(type: string): WireMessage[] {
    return this.events.filter((message) => message.type === type);
  }

  /** Sends an editor → host request and resolves with the host's response message. */
  request(type: string, payload: unknown, transfer: Transferable[] = []): Promise<WireMessage> {
    this.sequence += 1;
    const id = `editor-${this.sequence}`;
    return new Promise<WireMessage>((resolve) => {
      this.waiting.set(id, resolve);
      this.port.postMessage({ protocol: DESIGN_BRIDGE_PROTOCOL, v: DESIGN_BRIDGE_VERSION, kind: 'request', id, type, payload }, transfer);
    });
  }

  emit(type: string, payload: unknown): void {
    this.port.postMessage({ protocol: DESIGN_BRIDGE_PROTOCOL, v: DESIGN_BRIDGE_VERSION, kind: 'event', type, payload });
  }

  close(): void {
    this.port.removeEventListener('message', this.onMessage as EventListener);
    this.port.close();
  }

  private readonly onMessage = (event: MessageEvent<WireMessage>): void => {
    const message = event.data;
    if (message.kind === 'response' && message.replyTo) {
      const resolve = this.waiting.get(message.replyTo);
      this.waiting.delete(message.replyTo);
      resolve?.(message);
      return;
    }
    if (message.kind === 'event') {
      this.events.push(message);
      return;
    }
    if (message.kind !== 'request' || !message.id || !message.type) return;
    this.requests.push(message);
    const handler = this.handlers.get(message.type);
    const replyTo = message.id;
    void Promise.resolve()
      .then(() => (handler ? handler(message.payload) : {}))
      .then(
        (payload) => {
          if (payload === HOLD) return;
          this.port.postMessage({ protocol: DESIGN_BRIDGE_PROTOCOL, v: DESIGN_BRIDGE_VERSION, kind: 'response', replyTo, ok: true, payload: payload ?? {} });
        },
        (error: DesignBridgeError) => {
          this.port.postMessage({ protocol: DESIGN_BRIDGE_PROTOCOL, v: DESIGN_BRIDGE_VERSION, kind: 'response', replyTo, ok: false, error });
        },
      );
  };
}

/** Plays the editor's `hello` from `iframe` and returns the editor end of the connected port. */
export function connectFakeEditor(iframe: HTMLIFrameElement, hello: unknown = HELLO): FakeEditor {
  const target = iframe.contentWindow;
  if (!target) throw new Error('iframe has no contentWindow');
  const post = vi.spyOn(target, 'postMessage').mockImplementation(() => undefined);
  window.dispatchEvent(new MessageEvent('message', { data: hello, origin: window.location.origin, source: target }));
  const call = (post.mock.calls as unknown[][]).find((args) => (args[0] as WireMessage | undefined)?.kind === 'connect');
  post.mockRestore();
  if (!call) throw new Error('host did not answer hello with connect');
  const transfer = call[2] as Transferable[] | undefined;
  const port = transfer?.[0] as MessagePort | undefined;
  if (!port || typeof port.postMessage !== 'function') throw new Error('connect carried no MessagePort');
  return new FakeEditor(port);
}

/** Minimal fetch router for host tests: `routes` match `METHOD path` (query ignored) in order. */
export interface FetchCall {
  method: string;
  url: URL;
  init: RequestInit | undefined;
}

export type FetchRoute = (call: FetchCall) => Response | Promise<Response> | undefined;

export function installFetch(routes: FetchRoute[]): { calls: FetchCall[]; fetch: ReturnType<typeof vi.fn> } {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: FetchCall = { method: (init?.method ?? 'GET').toUpperCase(), url: new URL(raw, ORIGIN), init };
    calls.push(call);
    for (const route of routes) {
      const response = await route(call);
      if (response) return response;
    }
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `no route for ${call.method} ${call.url.pathname}` } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetch: fetchMock };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

export function designSummary(projectId: string, path: string, sha256: string, size = 3) {
  return {
    projectId,
    path,
    name: path.split('/').pop() ?? path,
    format: path.endsWith('.op') ? 'op' : 'fig',
    size,
    mtime: 1,
    revision: `${size.toString(16)}-1`,
    coverUrl: `/api/projects/${projectId}/designs/cover?path=${encodeURIComponent(path)}`,
    sha256,
  };
}
