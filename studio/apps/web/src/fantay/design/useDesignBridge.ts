// SPDX-License-Identifier: AGPL-3.0-only
// Host side of the design editor bridge (spec 06 §5.1, §5.3, §5.4). Handshake: the editor iframe posts
// `hello` to this window; the host accepts it only from its own iframe at its own origin with protocol
// version 1 (another version → `failed` UNSUPPORTED_VERSION, shown as designEditor.incompatible), answers
// `connect` with a transferred MessagePort, stops listening on the window and sends `init`. Everything
// after that travels over the port: correlated requests with per-type timeouts, events, and the editor's
// own requests (`document.save`, `asset.fetch`), answered through the host's `onRequest`.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  DESIGN_BRIDGE_PROTOCOL,
  DESIGN_BRIDGE_VERSION,
  DESIGN_EDITOR_ENTRY,
  DesignBridgeFailure,
  createDesignRequestId,
  designBridgeTimeoutMs,
  isDesignBridgeMessage,
  isDesignBridgeVersionMismatch,
  toDesignBridgeError,
  type DesignBridgeError,
  type DesignBridgeMessage,
  type DesignHelloMessage,
  type DesignInitPayload,
  type DesignRequestMessage,
  type EditorToHostEvents,
  type EditorToHostRequests,
  type HostToEditorEvents,
  type HostToEditorRequests,
} from '@open-design/contracts';

import { isEditorEventType, isEditorRequestType, normalizeEditorEvent, normalizeEditorRequest } from './bridge-guards';

export const DESIGN_HELLO_TIMEOUT_MS = 20_000;
/** Non-translated developer hint (spec 06 §5.1 rule 6). */
export const DESIGN_EDITOR_ASSETS_MISSING_HINT = 'Editor assets missing — run `mise x -- pnpm --filter @fantay/canvas build`';

export type DesignBridgeStatus = 'booting' | 'handshaking' | 'ready' | 'failed';

export type DesignRequestHandlerResult<T extends keyof EditorToHostRequests> = {
  payload: EditorToHostRequests[T]['res'];
  transfer?: Transferable[];
};

export interface UseDesignBridgeOptions {
  iframe: RefObject<HTMLIFrameElement | null>;
  init(sessionId: string): DesignInitPayload;
  onEvent<T extends keyof EditorToHostEvents>(type: T, payload: EditorToHostEvents[T]): void;
  onRequest<T extends keyof EditorToHostRequests>(type: T, payload: EditorToHostRequests[T]['req']): Promise<DesignRequestHandlerResult<T>>;
  /** Default 20000. */
  helloTimeoutMs?: number;
  /** Fantay addition: false = no session (the iframe is not mounted, e.g. keep-alive expired). Default true. */
  enabled?: boolean;
}

export interface DesignRequestOptions {
  transfer?: Transferable[];
  timeoutMs?: number;
}

export interface DesignBridgeController {
  status: DesignBridgeStatus;
  error: DesignBridgeError | null;
  request<T extends keyof HostToEditorRequests>(
    type: T,
    payload: HostToEditorRequests[T]['req'],
    opts?: DesignRequestOptions,
  ): Promise<HostToEditorRequests[T]['res']>;
  emit<T extends keyof HostToEditorEvents>(type: T, payload: HostToEditorEvents[T]): void;
  /** Tear the session down; the host recreates its iframe (key it on `generation`). */
  retry(): void;
  /** Fantay addition: bumps on every retry. */
  generation: number;
}

interface PendingRequest {
  type: string;
  resolve(payload: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DesignBridgeSessionOptions {
  getIframe(): HTMLIFrameElement | null;
  getHandlers(): Pick<UseDesignBridgeOptions, 'init' | 'onEvent' | 'onRequest'>;
  onStatus(status: DesignBridgeStatus, error: DesignBridgeError | null): void;
  helloTimeoutMs?: number;
  /** The host window (tests may pass a stub); default `window`. */
  win?: Window;
}

function envelope<T extends object>(message: T): T & { protocol: typeof DESIGN_BRIDGE_PROTOCOL; v: typeof DESIGN_BRIDGE_VERSION } {
  return { protocol: DESIGN_BRIDGE_PROTOCOL, v: DESIGN_BRIDGE_VERSION, ...message };
}

function isDevelopmentBuild(): boolean {
  // Plain member expression: the bundler replaces it statically.
  return process.env.NODE_ENV === 'development';
}

/**
 * One handshake + port lifetime. Framework-free so it can be tested directly; `useDesignBridge` creates
 * one per iframe generation and disposes it on unmount or retry.
 */
export class DesignBridgeSession {
  status: DesignBridgeStatus = 'booting';
  error: DesignBridgeError | null = null;
  sessionId: string | null = null;
  capabilities: readonly string[] = [];
  editorVersion: string | null = null;

  private readonly win: Window;
  private readonly pending = new Map<string, PendingRequest>();
  private port: MessagePort | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private listening = false;
  private disposed = false;

  constructor(private readonly options: DesignBridgeSessionOptions) {
    this.win = options.win ?? window;
  }

  start(): void {
    if (this.disposed || this.listening) return;
    this.listening = true;
    this.win.addEventListener('message', this.onWindowMessage);
    this.helloTimer = setTimeout(this.onHelloTimeout, this.options.helloTimeoutMs ?? DESIGN_HELLO_TIMEOUT_MS);
  }

  request<T extends keyof HostToEditorRequests>(
    type: T,
    payload: HostToEditorRequests[T]['req'],
    opts?: DesignRequestOptions,
  ): Promise<HostToEditorRequests[T]['res']> {
    if (this.disposed) return Promise.reject(new DesignBridgeFailure('CANCELLED', 'The design editor session was closed'));
    const port = this.port;
    if (!port) return Promise.reject(new DesignBridgeFailure('NOT_INITIALIZED', 'The design editor is not connected'));
    const id = createDesignRequestId();
    const timeoutMs = opts?.timeoutMs ?? designBridgeTimeoutMs(type);
    return new Promise<HostToEditorRequests[T]['res']>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new DesignBridgeFailure('TIMEOUT', `${type} got no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { type, resolve: resolve as (payload: unknown) => void, reject, timer });
      const message: DesignRequestMessage = envelope({ kind: 'request' as const, id, type, payload });
      try {
        port.postMessage(message, opts?.transfer ?? []);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new DesignBridgeFailure('INVALID_REQUEST', error instanceof Error ? error.message : `Could not send ${type}`));
      }
    });
  }

  emit<T extends keyof HostToEditorEvents>(type: T, payload: HostToEditorEvents[T]): void {
    if (this.disposed || !this.port) return;
    try {
      this.port.postMessage(envelope({ kind: 'event' as const, type, payload }));
    } catch {
      /* the editor went away; the next request reports it */
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopListening();
    this.rejectPending('CANCELLED', 'The design editor session was closed');
    this.closePort();
  }

  private readonly onWindowMessage = (event: MessageEvent): void => {
    if (this.disposed || this.status !== 'booting') return;
    const target = this.options.getIframe()?.contentWindow;
    if (!target || event.source !== target) return;
    if (event.origin !== this.win.location.origin) return;
    const data: unknown = event.data;
    if (isDesignBridgeVersionMismatch(data)) {
      const version = (data as { v?: unknown }).v;
      this.fail({ code: 'UNSUPPORTED_VERSION', message: `The editor speaks bridge version ${String(version)}, the app ${DESIGN_BRIDGE_VERSION}` });
      return;
    }
    if (!isDesignBridgeMessage(data) || data.kind !== 'hello') return;
    this.connect(target, data);
  };

  private readonly onHelloTimeout = (): void => {
    this.helloTimer = null;
    if (this.disposed || this.status !== 'booting') return;
    const error: DesignBridgeError = { code: 'ENGINE_LOAD_FAILED', message: 'The design editor did not start in time' };
    this.fail(error);
    if (!isDevelopmentBuild()) return;
    void fetch(DESIGN_EDITOR_ENTRY, { method: 'HEAD', cache: 'no-store' })
      .then((resp) => {
        if (resp.status !== 404 || this.disposed || this.status !== 'failed') return;
        this.error = { ...error, details: { hint: DESIGN_EDITOR_ASSETS_MISSING_HINT } };
        this.options.onStatus('failed', this.error);
      })
      .catch(() => undefined);
  };

  private connect(target: Window, hello: DesignHelloMessage): void {
    this.stopListening();
    this.capabilities = [...hello.capabilities];
    this.editorVersion = hello.editorVersion;
    const channel = new MessageChannel();
    const port = channel.port1;
    port.addEventListener('message', this.onPortMessage);
    port.start();
    this.port = port;
    const sessionId = createDesignRequestId();
    this.sessionId = sessionId;
    this.setStatus('handshaking', null);
    try {
      target.postMessage(envelope({ kind: 'connect' as const, sessionId }), this.win.location.origin, [channel.port2]);
    } catch (error) {
      this.fail({ code: 'ENGINE_LOAD_FAILED', message: error instanceof Error ? error.message : 'Could not connect to the editor' });
      return;
    }
    let initPayload: DesignInitPayload;
    try {
      initPayload = this.options.getHandlers().init(sessionId);
    } catch (error) {
      this.fail(toDesignBridgeError(error));
      return;
    }
    this.request('init', initPayload).then(
      () => {
        if (!this.disposed && this.status === 'handshaking') this.setStatus('ready', null);
      },
      (error: unknown) => {
        if (!this.disposed) this.fail(toDesignBridgeError(error, 'ENGINE_LOAD_FAILED'));
      },
    );
  }

  private readonly onPortMessage = (event: MessageEvent): void => {
    if (this.disposed) return;
    const data: unknown = event.data;
    if (!isDesignBridgeMessage(data)) return;
    this.dispatch(data);
  };

  private dispatch(message: DesignBridgeMessage): void {
    switch (message.kind) {
      case 'response': {
        const pending = this.pending.get(message.replyTo);
        if (!pending) return;
        this.pending.delete(message.replyTo);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.payload);
        else pending.reject(new DesignBridgeFailure(message.error.code, message.error.message, message.error.details));
        return;
      }
      case 'request':
        void this.answer(message);
        return;
      case 'event': {
        if (!isEditorEventType(message.type)) return;
        const payload = normalizeEditorEvent(message.type, message.payload);
        if (payload === null) return;
        try {
          this.options.getHandlers().onEvent(message.type, payload);
        } catch {
          /* a listener error must not break the bridge */
        }
        return;
      }
      default:
        return;
    }
  }

  private async answer(message: DesignRequestMessage): Promise<void> {
    const reply = (body: { ok: true; payload: unknown } | { ok: false; error: DesignBridgeError }, transfer: Transferable[] = []): void => {
      if (this.disposed || !this.port) return;
      try {
        this.port.postMessage(envelope({ kind: 'response' as const, replyTo: message.id, ...body }), transfer);
      } catch {
        /* closed port */
      }
    };
    const { type } = message;
    if (!isEditorRequestType(type)) {
      reply({ ok: false, error: { code: 'INVALID_REQUEST', message: `Unknown request type: ${type}` } });
      return;
    }
    const payload = normalizeEditorRequest(type, message.payload);
    if (payload === null) {
      reply({ ok: false, error: { code: 'INVALID_REQUEST', message: `Malformed ${type} payload` } });
      return;
    }
    try {
      const result = await this.options.getHandlers().onRequest(type, payload);
      reply({ ok: true, payload: result.payload }, result.transfer ?? []);
    } catch (error) {
      reply({ ok: false, error: toDesignBridgeError(error) });
    }
  }

  private fail(error: DesignBridgeError): void {
    this.stopListening();
    this.rejectPending('CANCELLED', 'The design editor session failed');
    this.closePort();
    this.setStatus('failed', error);
  }

  private setStatus(status: DesignBridgeStatus, error: DesignBridgeError | null): void {
    this.status = status;
    this.error = error;
    if (!this.disposed) this.options.onStatus(status, error);
  }

  private stopListening(): void {
    if (this.helloTimer !== null) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
    if (this.listening) {
      this.listening = false;
      this.win.removeEventListener('message', this.onWindowMessage);
    }
  }

  private rejectPending(code: 'CANCELLED', message: string): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(new DesignBridgeFailure(code, `${entry.type}: ${message}`));
    }
  }

  private closePort(): void {
    const port = this.port;
    this.port = null;
    if (!port) return;
    port.removeEventListener('message', this.onPortMessage);
    try {
      port.close();
    } catch {
      /* already closed */
    }
  }
}

/** React wrapper: one `DesignBridgeSession` per iframe generation (spec 06 §5.4). */
export function useDesignBridge(opts: UseDesignBridgeOptions): DesignBridgeController {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const enabled = opts.enabled ?? true;
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<{ status: DesignBridgeStatus; error: DesignBridgeError | null }>({ status: 'booting', error: null });
  const sessionRef = useRef<DesignBridgeSession | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    setState((previous) => (previous.status === 'booting' && previous.error === null ? previous : { status: 'booting', error: null }));
    const session = new DesignBridgeSession({
      getIframe: () => optsRef.current.iframe.current,
      getHandlers: () => optsRef.current,
      helloTimeoutMs: optsRef.current.helloTimeoutMs,
      onStatus: (status, error) => {
        if (sessionRef.current === session) setState({ status, error });
      },
    });
    sessionRef.current = session;
    session.start();
    return () => {
      if (sessionRef.current === session) sessionRef.current = null;
      session.dispose();
      // The next session (re-enabled iframe, retry) starts from scratch: never report a stale "ready".
      setState((previous) => (previous.status === 'booting' && previous.error === null ? previous : { status: 'booting', error: null }));
    };
  }, [enabled, generation]);

  const request = useCallback(
    <T extends keyof HostToEditorRequests>(type: T, payload: HostToEditorRequests[T]['req'], requestOpts?: DesignRequestOptions) => {
      const session = sessionRef.current;
      if (!session) return Promise.reject(new DesignBridgeFailure('NOT_INITIALIZED', 'The design editor is not connected'));
      return session.request(type, payload, requestOpts);
    },
    [],
  );
  const emit = useCallback(<T extends keyof HostToEditorEvents>(type: T, payload: HostToEditorEvents[T]) => {
    sessionRef.current?.emit(type, payload);
  }, []);
  const retry = useCallback(() => {
    setState((previous) => (previous.status === 'booting' && previous.error === null ? previous : { status: 'booting', error: null }));
    setGeneration((value) => value + 1);
  }, []);

  const status: DesignBridgeStatus = enabled ? state.status : 'booting';
  const error = enabled ? state.error : null;
  return useMemo(
    () => ({ status, error, request, emit, retry, generation }),
    [status, error, request, emit, retry, generation],
  );
}
