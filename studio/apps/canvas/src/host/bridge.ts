// SPDX-License-Identifier: Apache-2.0
/**
 * Editor side of the host bridge (06 §5.1, §5.4).
 *
 * Handshake: the editor posts `hello` to `window.parent` (target origin = its own origin) and
 * accepts exactly one `connect` that comes from the parent window, the same origin, and
 * carries one MessagePort. Every later message travels over that port and is checked with
 * `isDesignBridgeMessage` plus a per-type payload guard: an invalid or unknown request gets an
 * `INVALID_REQUEST` response, an invalid or unknown event is dropped. Handler errors are
 * serialized with `toDesignBridgeError`; rejected requests carry a `DesignBridgeFailure`.
 */
import {
  DESIGN_BRIDGE_LIMITS,
  DESIGN_BRIDGE_PROTOCOL,
  DESIGN_BRIDGE_VERSION,
  DesignBridgeFailure,
  createDesignRequestId,
  designBridgeTimeoutMs,
  isDesignBridgeMessage,
  isDesignBridgeVersionMismatch,
  toDesignBridgeError,
  type DesignBridgeMessage,
  type DesignHelloMessage,
  type EditorToHostEvents,
  type EditorToHostRequests,
  type HostToEditorEvents,
  type HostToEditorRequests,
} from '@open-design/contracts/runtime/design-editor-bridge';

export type HostRequestType = keyof HostToEditorRequests;
export type HostRequestHandler<T extends HostRequestType> = (
  payload: HostToEditorRequests[T]['req'],
) => Promise<{ payload: HostToEditorRequests[T]['res']; transfer?: Transferable[] }>;

export interface EditorBridge {
  readonly sessionId: Promise<string>;
  handle<T extends HostRequestType>(type: T, handler: HostRequestHandler<T>): void;
  on<T extends keyof HostToEditorEvents>(type: T, listener: (payload: HostToEditorEvents[T]) => void): () => void;
  request<T extends keyof EditorToHostRequests>(
    type: T,
    payload: EditorToHostRequests[T]['req'],
    opts?: { transfer?: Transferable[]; timeoutMs?: number },
  ): Promise<EditorToHostRequests[T]['res']>;
  emit<T extends keyof EditorToHostEvents>(type: T, payload: EditorToHostEvents[T]): void;
  dispose(): void;
}

type Guard = (payload: Record<string, unknown>) => boolean;

const isString = (value: unknown): value is string => typeof value === 'string';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.prototype.toString.call(value) === '[object Object]';
const isBuffer = (value: unknown, limit: number): value is ArrayBuffer =>
  value instanceof ArrayBuffer && value.byteLength <= limit;
const isStringArray = (value: unknown, max = Number.POSITIVE_INFINITY): value is string[] =>
  Array.isArray(value) && value.length <= max && value.every(isString);
const isShaOrNull = (value: unknown) => value === null || (isString(value) && /^[0-9a-f]{64}$/i.test(value));

function isMessageMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= DESIGN_BRIDGE_LIMITS.maxMessageKeys && entries.every(([, text]) => isString(text));
}

function isIdentity(value: unknown, projectOnly = false): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'project') return isString(value.projectId) && value.projectId.length > 0 && isString(value.path) && value.path.length > 0;
  if (projectOnly) return false;
  return value.kind === 'legacy' && isString(value.legacyId) && value.legacyId.length > 0 && isString(value.name);
}

const DOCUMENT_BYTES = DESIGN_BRIDGE_LIMITS.maxDocumentBytes;
const ASSET_BYTES = DESIGN_BRIDGE_LIMITS.maxAssetBytes;
const VIEW_COMMANDS = new Set(['zoomIn', 'zoomOut', 'zoomFit', 'zoom100', 'zoomSelection', 'undo', 'redo', 'toggleUi']);
const FLUSH_REASONS = new Set(['close', 'switch', 'navigate', 'hidden']);

function isInsertItem(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.name)) return false;
  if (value.kind === 'image') return isString(value.mime) && isBuffer(value.bytes, ASSET_BYTES);
  if (value.kind === 'svg') return isString(value.svg) && value.svg.length <= ASSET_BYTES;
  if (value.kind === 'html') return isString(value.html) && value.html.length <= ASSET_BYTES && (value.sourcePath === undefined || value.sourcePath === null || isString(value.sourcePath));
  return false;
}

/** Per-type payload guards for host → editor requests (06 §5.1 step 5). */
export const HOST_REQUEST_GUARDS: Readonly<Record<HostRequestType, Guard>> = {
  init: (p) =>
    isString(p.sessionId) && (p.theme === 'dark' || p.theme === 'light') && isString(p.locale) &&
    isMessageMap(p.messages) && isStringArray(p.forwardShortcuts, 200) && isBoolean(p.closeOnEscape),
  'document.open': (p) => {
    if (!isString(p.name)) return false;
    switch (p.source) {
      case 'bytes':
        return isIdentity(p.identity) && (p.format === 'fig' || p.format === 'op') && isBuffer(p.bytes, DOCUMENT_BYTES) && isShaOrNull(p.sha256) && isBoolean(p.readOnly);
      case 'blank':
        return isIdentity(p.identity, true) && isString(p.pageName);
      case 'html':
        return isIdentity(p.identity, true) && isString(p.html) && p.html.length <= DOCUMENT_BYTES && (p.sourcePath === null || isString(p.sourcePath));
      case 'import':
        return isIdentity(p.identity, true) && isString(p.fileName) && p.fileName.length > 0 && isBuffer(p.bytes, DOCUMENT_BYTES);
      default:
        return false;
    }
  },
  'document.flush': (p) => isString(p.reason) && FLUSH_REASONS.has(p.reason),
  'document.saveCopy': (p) => isString(p.targetPath) && p.targetPath.length > 0,
  'document.forceSave': (p) => isShaOrNull(p.baseSha256),
  'document.exportCover': (p) =>
    (p.maxEdge === undefined || (typeof p.maxEdge === 'number' && p.maxEdge > 0 && p.maxEdge <= 4096)) &&
    (p.pageId === undefined || isString(p.pageId)),
  'document.exportHtml': (p) => p.scope === 'page' || p.scope === 'selection',
  'view.command': (p) => isString(p.command) && VIEW_COMMANDS.has(p.command),
  'selection.set': (p) => isStringArray(p.nodeIds, 10_000) && (p.reveal === undefined || isBoolean(p.reveal)),
  insert: (p) => Array.isArray(p.items) && p.items.length > 0 && p.items.length <= 50 && p.items.every(isInsertItem),
  focus: () => true,
};

/** Per-type payload guards for host → editor events. */
export const HOST_EVENT_GUARDS: Readonly<Record<keyof HostToEditorEvents, Guard>> = {
  theme: (p) => p.theme === 'dark' || p.theme === 'light',
  locale: (p) => isString(p.locale) && isMessageMap(p.messages),
  visibility: (p) => isBoolean(p.visible),
};

const HELLO_RETRY_MS = [1000, 3000];

function envelope<K extends DesignBridgeMessage['kind']>(kind: K) {
  return { protocol: DESIGN_BRIDGE_PROTOCOL, v: DESIGN_BRIDGE_VERSION, kind } as const;
}

/** Returns null when the page is not embedded (window.parent === window). */
export function connectEditorBridge(
  win: Window,
  hello: Pick<DesignHelloMessage, 'editorVersion' | 'engines' | 'capabilities'>,
): EditorBridge | null {
  if (win.parent === win || !win.parent) return null;

  const handlers = new Map<string, HostRequestHandler<HostRequestType>>();
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  let port: MessagePort | null = null;
  let disposed = false;
  let resolveSession!: (id: string) => void;
  const sessionId = new Promise<string>((resolve) => {
    resolveSession = resolve;
  });

  const helloMessage: DesignHelloMessage = { ...envelope('hello'), ...hello };
  const postHello = () => {
    if (!port && !disposed) win.parent.postMessage(helloMessage, win.location.origin);
  };
  const helloTimers = HELLO_RETRY_MS.map((delay) => setTimeout(postHello, delay));

  function post(message: DesignBridgeMessage, transfer: Transferable[] = []) {
    if (!port || disposed) return;
    port.postMessage(message, transfer);
  }

  async function onRequest(id: string, type: string, payload: Record<string, unknown>) {
    const handler = handlers.get(type);
    const guard = (HOST_REQUEST_GUARDS as Record<string, Guard | undefined>)[type];
    if (!handler || !guard || !guard(payload)) {
      post({ ...envelope('response'), replyTo: id, ok: false, error: { code: 'INVALID_REQUEST', message: `Invalid request: ${type}` } });
      return;
    }
    try {
      const result = await handler(payload as never);
      post({ ...envelope('response'), replyTo: id, ok: true, payload: result.payload as Record<string, unknown> }, result.transfer);
    } catch (error) {
      post({ ...envelope('response'), replyTo: id, ok: false, error: toDesignBridgeError(error) });
    }
  }

  function onPortMessage(event: MessageEvent) {
    const data: unknown = event.data;
    if (!isDesignBridgeMessage(data)) return;
    if (data.kind === 'request') {
      void onRequest(data.id, data.type, data.payload as Record<string, unknown>);
    } else if (data.kind === 'response') {
      const entry = pending.get(data.replyTo);
      if (!entry) return;
      pending.delete(data.replyTo);
      clearTimeout(entry.timer);
      if (data.ok) entry.resolve(data.payload);
      else entry.reject(new DesignBridgeFailure(data.error.code, data.error.message, data.error.details));
    } else if (data.kind === 'event') {
      const guard = (HOST_EVENT_GUARDS as Record<string, Guard | undefined>)[data.type];
      if (!guard || !guard(data.payload as Record<string, unknown>)) return;
      for (const listener of listeners.get(data.type) ?? []) {
        try {
          listener(data.payload as never);
        } catch (error) {
          console.error('[fantay-design] bridge event listener failed', error);
        }
      }
    }
  }

  function onWindowMessage(event: MessageEvent) {
    if (port || disposed) return;
    if (event.origin !== win.location.origin || event.source !== win.parent) return;
    if (isDesignBridgeVersionMismatch(event.data)) return;
    if (!isDesignBridgeMessage(event.data) || event.data.kind !== 'connect' || event.ports.length !== 1) return;
    port = event.ports[0]!;
    port.onmessage = onPortMessage;
    port.start();
    win.removeEventListener('message', onWindowMessage);
    for (const timer of helloTimers) clearTimeout(timer);
    resolveSession(event.data.sessionId);
  }

  win.addEventListener('message', onWindowMessage);
  postHello();

  return {
    sessionId,
    handle(type, handler) {
      handlers.set(type, handler as unknown as HostRequestHandler<HostRequestType>);
    },
    on(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener as (payload: never) => void);
      listeners.set(type, set);
      return () => set.delete(listener as (payload: never) => void);
    },
    request(type, payload, opts = {}) {
      if (!port || disposed) return Promise.reject(new DesignBridgeFailure('NOT_INITIALIZED', 'The host is not connected'));
      const id = createDesignRequestId();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new DesignBridgeFailure('TIMEOUT', `${type} timed out`));
        }, opts.timeoutMs ?? designBridgeTimeoutMs(type));
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        post({ ...envelope('request'), id, type, payload: payload as unknown as Record<string, unknown> }, opts.transfer);
      });
    },
    emit(type, payload) {
      post({ ...envelope('event'), type, payload: payload as unknown as Record<string, unknown> });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const timer of helloTimers) clearTimeout(timer);
      win.removeEventListener('message', onWindowMessage);
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new DesignBridgeFailure('CANCELLED', 'The editor closed'));
        pending.delete(id);
      }
      handlers.clear();
      listeners.clear();
      if (port) {
        port.onmessage = null;
        port.close();
      }
    },
  };
}
