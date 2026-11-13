// SPDX-License-Identifier: Apache-2.0
/**
 * Host <-> design editor bridge protocol (Fantay design documents).
 *
 * The web host (`apps/web/src/fantay/design/`) embeds the design editor
 * (`apps/canvas`, served at DESIGN_EDITOR_ENTRY) in a same-origin iframe. The
 * editor posts `hello` to its parent, the host answers with `connect` plus a
 * transferred MessagePort, and every later request, response and event travels
 * over that port. Both ends validate each message with isDesignBridgeMessage
 * plus their own per-type payload checks, transfer ArrayBuffers instead of
 * copying them, and respect DESIGN_BRIDGE_LIMITS.
 *
 * Pure module with no imports: the canvas imports it through the
 * `@open-design/contracts/runtime/design-editor-bridge` subpath, the web app
 * through the package root.
 */

export const DESIGN_BRIDGE_PROTOCOL = 'fantay.design-editor' as const;
export const DESIGN_BRIDGE_VERSION = 1 as const;
export const DESIGN_EDITOR_ENTRY = '/canvas-editor/index.html' as const;
export const DESIGN_BRIDGE_LIMITS = {
  maxDocumentBytes: 64 * 1024 * 1024,
  maxAssetBytes: 20 * 1024 * 1024,
  maxSelectionNodes: 20,
  maxMessageKeys: 500,
} as const;

export type DesignTheme = 'dark' | 'light';
export type DesignDocumentFormat = 'fig' | 'op';
export type DesignBridgeCapability =
  | 'document.open'
  | 'document.flush'
  | 'document.saveCopy'
  | 'document.forceSave'
  | 'document.exportCover'
  | 'document.exportHtml'
  | 'view.command'
  | 'selection.set'
  | 'insert'
  | 'focus'
  | 'asset.fetch';

interface Envelope {
  protocol: typeof DESIGN_BRIDGE_PROTOCOL;
  v: typeof DESIGN_BRIDGE_VERSION;
}
/**
 * Editor -> parent window, once, before any port exists. `capabilities` may
 * name capabilities this build does not know (a newer editor); hosts test
 * membership instead of rejecting the hello.
 */
export interface DesignHelloMessage extends Envelope {
  kind: 'hello';
  editorVersion: string;
  engines: { openPencil: string; opWebSdk: string };
  capabilities: DesignBridgeCapability[];
}
/** Host -> iframe window, with the editor's end of the channel in `event.ports[0]`. */
export interface DesignConnectMessage extends Envelope {
  kind: 'connect';
  sessionId: string;
}
export interface DesignRequestMessage<T extends string = string, P = unknown> extends Envelope {
  kind: 'request';
  id: string;
  type: T;
  payload: P;
}
export interface DesignResponseOk<P = unknown> extends Envelope {
  kind: 'response';
  replyTo: string;
  ok: true;
  payload: P;
}
export interface DesignResponseErr extends Envelope {
  kind: 'response';
  replyTo: string;
  ok: false;
  error: DesignBridgeError;
}
export interface DesignEventMessage<T extends string = string, P = unknown> extends Envelope {
  kind: 'event';
  type: T;
  payload: P;
}
export type DesignBridgeMessage =
  | DesignHelloMessage
  | DesignConnectMessage
  | DesignRequestMessage
  | DesignResponseOk
  | DesignResponseErr
  | DesignEventMessage;

export type DesignBridgeErrorCode =
  | 'UNSUPPORTED_VERSION'
  | 'NOT_INITIALIZED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'CONFLICT'
  | 'TOO_LARGE'
  | 'READ_ONLY'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'NETWORK'
  | 'PARSE_FAILED'
  | 'ENGINE_LOAD_FAILED'
  | 'EXPORT_FAILED'
  | 'EMPTY_DOCUMENT'
  | 'INVALID_REQUEST'
  | 'INTERNAL';
export interface DesignBridgeError {
  code: DesignBridgeErrorCode;
  message: string;
  /** `CONFLICT` carries the sha256 now on disk (`null` when the file is gone). */
  details?: { currentSha256?: string | null; [key: string]: unknown };
}

export type DesignIdentity =
  | { kind: 'project'; projectId: string; path: string }
  | { kind: 'legacy'; legacyId: string; name: string };
export type DesignProjectIdentity = Extract<DesignIdentity, { kind: 'project' }>;

export interface DesignInitPayload {
  sessionId: string;
  theme: DesignTheme;
  locale: string;
  messages: Record<string, string>;
  forwardShortcuts: string[];
  closeOnEscape: boolean;
}
export type DesignOpenPayload =
  | {
      source: 'bytes';
      identity: DesignIdentity;
      name: string;
      format: DesignDocumentFormat;
      bytes: ArrayBuffer;
      sha256: string | null;
      readOnly: boolean;
    }
  | { source: 'blank'; identity: DesignProjectIdentity; name: string; pageName: string }
  | { source: 'html'; identity: DesignProjectIdentity; name: string; html: string; sourcePath: string | null }
  | { source: 'import'; identity: DesignProjectIdentity; name: string; fileName: string; bytes: ArrayBuffer };
export type DesignOpenWarning = 'foreign-fig' | 'lossy-html' | 'lossy-op-svg' | 'images-skipped' | 'fonts-missing';
export interface DesignOpenResult {
  format: DesignDocumentFormat;
  readOnly: boolean;
  pageCount: number;
  currentPageId: string | null;
  foreign: boolean;
  /** True for blank/html/import opens and `.op` -> `.fig` conversion: the editor saves with `reason: 'convert'` right away. */
  needsSave: boolean;
  warnings: DesignOpenWarning[];
}
export type DesignFlushReason = 'close' | 'switch' | 'navigate' | 'hidden';
export interface DesignFlushResult {
  saved: boolean;
  dirty: boolean;
  sha256: string | null;
  error?: DesignBridgeError;
}
export interface DesignCoverResult {
  png: ArrayBuffer;
  width: number;
  height: number;
  pageId: string;
  sourceSha256: string | null;
}
export type DesignViewCommand =
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomFit'
  | 'zoom100'
  | 'zoomSelection'
  | 'undo'
  | 'redo'
  | 'toggleUi';
export type DesignInsertItem =
  | { kind: 'image'; name: string; mime: string; bytes: ArrayBuffer }
  | { kind: 'svg'; name: string; svg: string }
  | { kind: 'html'; name: string; html: string; sourcePath?: string | null };
export interface DesignSaveRequest {
  bytes: ArrayBuffer;
  format: DesignDocumentFormat;
  /** `null` = create (the file must not exist yet); otherwise the sha256 the edit is based on. */
  baseSha256: string | null;
  reason: 'autosave' | 'manual' | 'flush' | 'convert' | 'copy' | 'force';
  targetPath?: string;
}
export interface DesignSaveResult {
  path: string;
  sha256: string;
  size: number;
  savedAt: number;
}
export interface DesignEditorStatePayload {
  dirty: boolean;
  saving: boolean;
  readOnly: boolean;
  sha256: string | null;
  lastSavedAt: number | null;
  format: DesignDocumentFormat | null;
  error: DesignBridgeError | null;
}
export interface DesignSelectionNode {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
}
export interface DesignSelection {
  pageId: string;
  nodeIds: string[];
  nodes: DesignSelectionNode[];
}
export interface DesignViewState {
  zoom: number;
  pageId: string;
  pages: Array<{ id: string; name: string }>;
}

export interface HostToEditorRequests {
  init: { req: DesignInitPayload; res: { ready: true } };
  'document.open': { req: DesignOpenPayload; res: DesignOpenResult };
  'document.flush': { req: { reason: DesignFlushReason }; res: DesignFlushResult };
  'document.saveCopy': { req: { targetPath: string }; res: DesignSaveResult };
  'document.forceSave': { req: { baseSha256: string | null }; res: DesignSaveResult };
  'document.exportCover': { req: { maxEdge?: number; pageId?: string }; res: DesignCoverResult };
  'document.exportHtml': { req: { scope: 'page' | 'selection' }; res: { html: string } };
  'view.command': { req: { command: DesignViewCommand }; res: Record<string, never> };
  'selection.set': { req: { nodeIds: string[]; reveal?: boolean }; res: { selected: string[] } };
  insert: { req: { items: DesignInsertItem[] }; res: { nodeIds: string[] } };
  focus: { req: Record<string, never>; res: Record<string, never> };
}
export interface EditorToHostRequests {
  'document.save': { req: DesignSaveRequest; res: DesignSaveResult };
  'asset.fetch': { req: { path: string }; res: { bytes: ArrayBuffer; mime: string } };
}
export interface HostToEditorEvents {
  theme: { theme: DesignTheme };
  locale: { locale: string; messages: Record<string, string> };
  visibility: { visible: boolean };
}
export interface EditorToHostEvents {
  state: DesignEditorStatePayload;
  selection: DesignSelection;
  view: DesignViewState;
  error: DesignBridgeError;
  'request-close': Record<string, never>;
  shortcut: { combo: string };
}

type DesignBridgeRequestType = keyof HostToEditorRequests | keyof EditorToHostRequests;

const MESSAGE_KINDS = {
  hello: true,
  connect: true,
  request: true,
  response: true,
  event: true,
} satisfies Record<DesignBridgeMessage['kind'], true>;

const ERROR_CODES = {
  UNSUPPORTED_VERSION: true,
  NOT_INITIALIZED: true,
  TIMEOUT: true,
  CANCELLED: true,
  CONFLICT: true,
  TOO_LARGE: true,
  READ_ONLY: true,
  NOT_FOUND: true,
  FORBIDDEN: true,
  NETWORK: true,
  PARSE_FAILED: true,
  ENGINE_LOAD_FAILED: true,
  EXPORT_FAILED: true,
  EMPTY_DOCUMENT: true,
  INVALID_REQUEST: true,
  INTERNAL: true,
} satisfies Record<DesignBridgeErrorCode, true>;

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = {
  init: 60_000,
  'document.open': 90_000,
  'document.flush': 30_000,
  'document.saveCopy': 60_000,
  'document.forceSave': 60_000,
  'document.exportCover': 20_000,
  'document.exportHtml': 30_000,
  'view.command': DEFAULT_REQUEST_TIMEOUT_MS,
  'selection.set': DEFAULT_REQUEST_TIMEOUT_MS,
  insert: DEFAULT_REQUEST_TIMEOUT_MS,
  focus: DEFAULT_REQUEST_TIMEOUT_MS,
  'document.save': 60_000,
  'asset.fetch': 30_000,
} satisfies Record<DesignBridgeRequestType, number>;

const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

/** Plain data object (also after structured clone across realms); rejects null, arrays, buffers and other built-ins. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.prototype.toString.call(value) === '[object Object]';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isDesignBridgeErrorCode(value: unknown): value is DesignBridgeErrorCode {
  return typeof value === 'string' && hasOwn(ERROR_CODES, value);
}

/** Structural check of a wire error (error responses, the `error` event, `DesignFlushResult.error`, state `error`). */
export function isDesignBridgeError(value: unknown): value is DesignBridgeError {
  if (!isRecord(value) || !isDesignBridgeErrorCode(value.code) || typeof value.message !== 'string') return false;
  if (value.details === undefined) return true;
  if (!isRecord(value.details)) return false;
  const currentSha256 = value.details.currentSha256;
  return currentSha256 === undefined || currentSha256 === null || typeof currentSha256 === 'string';
}

/**
 * Envelope check for every bridge message: protocol tag, version 1, a known
 * kind, the ids that kind needs (`id`, `replyTo`, `sessionId`) and an object
 * payload. Per-type payload shapes are validated by the receiving endpoint.
 */
export function isDesignBridgeMessage(value: unknown): value is DesignBridgeMessage {
  if (!isRecord(value)) return false;
  if (value.protocol !== DESIGN_BRIDGE_PROTOCOL || value.v !== DESIGN_BRIDGE_VERSION) return false;
  if (typeof value.kind !== 'string' || !hasOwn(MESSAGE_KINDS, value.kind)) return false;
  switch (value.kind as DesignBridgeMessage['kind']) {
    case 'hello':
      return (
        typeof value.editorVersion === 'string' &&
        isRecord(value.engines) &&
        typeof value.engines.openPencil === 'string' &&
        typeof value.engines.opWebSdk === 'string' &&
        Array.isArray(value.capabilities) &&
        value.capabilities.every((capability) => typeof capability === 'string')
      );
    case 'connect':
      return isNonEmptyString(value.sessionId);
    case 'request':
      return isNonEmptyString(value.id) && isNonEmptyString(value.type) && isRecord(value.payload);
    case 'response':
      if (!isNonEmptyString(value.replyTo)) return false;
      if (value.ok === true) return isRecord(value.payload);
      if (value.ok === false) return isDesignBridgeError(value.error);
      return false;
    case 'event':
      return isNonEmptyString(value.type) && isRecord(value.payload);
  }
}

/**
 * True when `value` carries this protocol's tag with a version other than
 * DESIGN_BRIDGE_VERSION: a peer from an incompatible build. isDesignBridgeMessage
 * rejects such values; hosts use this to fail with `designEditor.incompatible`
 * instead of waiting for the hello timeout.
 */
export function isDesignBridgeVersionMismatch(value: unknown): boolean {
  return isRecord(value) && value.protocol === DESIGN_BRIDGE_PROTOCOL && value.v !== DESIGN_BRIDGE_VERSION;
}

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/**
 * New request id (a v4 UUID). `crypto.randomUUID` exists only in secure
 * contexts, and the app is also served over plain HTTP on LAN addresses, so
 * this falls back to `crypto.getRandomValues`, then to `Math.random`.
 */
export function createDesignRequestId(): string {
  const cryptoApi = (globalThis as { crypto?: CryptoLike }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Default timeout per request type: init 60 s, document.open 90 s,
 * document.flush 30 s, document.saveCopy / document.forceSave 60 s,
 * document.exportCover 20 s, document.exportHtml 30 s, document.save 60 s,
 * asset.fetch 30 s, everything else 15 s.
 */
export function designBridgeTimeoutMs(type: keyof HostToEditorRequests | keyof EditorToHostRequests): number {
  return hasOwn(REQUEST_TIMEOUT_MS, type) ? REQUEST_TIMEOUT_MS[type] : DEFAULT_REQUEST_TIMEOUT_MS;
}

/** Iframe `src` for the editor, e.g. `/canvas-editor/index.html?embed=1&v=1&theme=dark&locale=zh-CN`. */
export function designEditorUrl(opts: { theme: DesignTheme; locale: string }): string {
  const theme: DesignTheme = opts.theme === 'light' ? 'light' : 'dark';
  return `${DESIGN_EDITOR_ENTRY}?embed=1&v=${DESIGN_BRIDGE_VERSION}&theme=${theme}&locale=${encodeURIComponent(opts.locale)}`;
}

/**
 * Error a request handler throws (or a requester rejects with) on either side
 * of the bridge; serialized into DesignResponseErr with toDesignBridgeError.
 */
export class DesignBridgeFailure extends Error {
  readonly code: DesignBridgeErrorCode;
  declare readonly details?: DesignBridgeError['details'];

  constructor(code: DesignBridgeErrorCode, message: string, details?: DesignBridgeError['details']) {
    super(message);
    this.name = 'DesignBridgeFailure';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Converts anything a handler threw into the wire error of a DesignResponseErr.
 * Values with a bridge error code keep it and their details; they are matched
 * structurally, so wire errors and DesignBridgeFailure copies from another
 * bundle (the package root and the subpath each bundle the class) also count.
 * Everything else becomes `fallbackCode` with its message.
 */
export function toDesignBridgeError(error: unknown, fallbackCode: DesignBridgeErrorCode = 'INTERNAL'): DesignBridgeError {
  if (typeof error === 'string') return { code: fallbackCode, message: error || 'Unknown error' };
  if (typeof error !== 'object' || error === null) return { code: fallbackCode, message: 'Unknown error' };
  const { code, message, name, details } = error as { code?: unknown; message?: unknown; name?: unknown; details?: unknown };
  const text =
    typeof message === 'string' && message ? message : typeof name === 'string' && name ? name : 'Unknown error';
  if (!isDesignBridgeErrorCode(code)) return { code: fallbackCode, message: text };
  const wire = { code, message: text, details };
  if (!isDesignBridgeError(wire) || wire.details === undefined) return { code, message: text };
  return { code, message: text, details: { ...wire.details } };
}
