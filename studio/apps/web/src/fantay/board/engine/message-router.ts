// SPDX-License-Identifier: AGPL-3.0-only
// One window `message` listener for every board iframe (spec 03 §3.17). Messages are dispatched by `ev.source`
// identity (the repo's "receive filters use isOurIframe(ev.source)" rule), so a frame only ever hears its own
// document. `requestPreviewSnapshot` keeps its own per-call listener and is not routed here.
import {
  parsePreviewObservabilityMessage,
  type PreviewObservabilityMessage,
} from '@open-design/contracts/runtime/preview-observability';

import type { ManualEditBridgeMessage } from '../../../edit-mode/types';
import type { PreviewAnnotationStyle } from '../../../types';

/** Selection-bridge payload of `od:comment-hover` / `od:comment-target` (daemon URL bridge and srcdoc bridge). */
export interface FrameCommentTarget {
  elementId: string;
  selector: string;
  label: string;
  text: string;
  /** iframe viewport CSS px (= world px inside the frame node) */
  position: { x: number; y: number; width: number; height: number };
  htmlHint?: string;
  freePin?: boolean;
  /** computed style summary of the element (string values only; comments persist it) */
  style?: PreviewAnnotationStyle;
  /** click point in iframe viewport CSS px */
  hoverPoint?: { x: number; y: number };
  /** zero-based deck slide the element sits on */
  slideIndex?: number;
}

export interface FrameMessageHandlers {
  onCommentHover?(target: FrameCommentTarget): void;
  onCommentLeave?(): void;
  onCommentTarget?(target: FrameCommentTarget): void;
  onEdit?(message: ManualEditBridgeMessage): void;
  onObservability?(message: PreviewObservabilityMessage): void;
  /** `od:url-selection-bridge-ready` carries the document's href (prototype navigation) */
  onBridgeReady?(href: string): void;
  /** a same-project link was clicked inside the frame (`od:preview-open-file`) */
  onOpenFile?(fileName: string): void;
}

const EDIT_TYPES: ReadonlySet<string> = new Set([
  'od-edit-targets',
  'od-edit-select',
  'od-edit-hover',
  'od-edit-inspect-hover',
  'od-edit-inspect-select',
  'od-edit-background',
  'od-edit-preview-style-applied',
  'od-edit-text-commit',
  'od-edit-text-session',
  'od-edit-drag-commit',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * A page link the board may open next to its frame: a project-relative `.html` path without empty, `.` or `..`
 * segments (the checks FileViewer applies to the same message; the frame document is untrusted).
 */
export function isPreviewOpenFileName(fileName: string): boolean {
  return (
    fileName.length > 0 &&
    fileName.length <= 4096 &&
    /\.html?$/i.test(fileName) &&
    !fileName.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

function asCommentTarget(data: Record<string, unknown>): FrameCommentTarget | null {
  const position = data.position;
  if (!isRecord(position)) return null;
  const x = Number(position.x);
  const y = Number(position.y);
  const width = Number(position.width);
  const height = Number(position.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  const hover = isRecord(data.hoverPoint) ? { x: Number(data.hoverPoint.x), y: Number(data.hoverPoint.y) } : null;
  const style = asAnnotationStyle(data.style);
  return {
    elementId: typeof data.elementId === 'string' ? data.elementId : '',
    selector: typeof data.selector === 'string' ? data.selector : '',
    label: typeof data.label === 'string' ? data.label : '',
    text: typeof data.text === 'string' ? data.text : '',
    position: { x, y, width, height },
    ...(typeof data.htmlHint === 'string' ? { htmlHint: data.htmlHint } : {}),
    ...(data.freePin === true ? { freePin: true } : {}),
    ...(style ? { style } : {}),
    ...(hover && Number.isFinite(hover.x) && Number.isFinite(hover.y) ? { hoverPoint: hover } : {}),
    ...(typeof data.slideIndex === 'number' && Number.isInteger(data.slideIndex) && data.slideIndex >= 0
      ? { slideIndex: data.slideIndex }
      : {}),
  };
}

/** String-valued style entries only (the document is untrusted; the comment helpers normalize the keys). */
function asAnnotationStyle(value: unknown): PreviewAnnotationStyle | undefined {
  if (!isRecord(value)) return undefined;
  const style: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.length <= 200) style[key] = entry;
  }
  return Object.keys(style).length > 0 ? (style as PreviewAnnotationStyle) : undefined;
}

/** Dispatches one message to the handlers of its source window (pure; exported for tests). */
export function dispatchFrameMessage(handlers: FrameMessageHandlers, data: unknown): boolean {
  const observability = parsePreviewObservabilityMessage(data);
  if (observability) {
    handlers.onObservability?.(observability);
    return true;
  }
  if (!isRecord(data) || typeof data.type !== 'string') return false;
  switch (data.type) {
    case 'od:url-selection-bridge-ready':
      if (typeof data.href === 'string') handlers.onBridgeReady?.(data.href);
      return true;
    case 'od:comment-hover': {
      const target = asCommentTarget(data);
      if (target) handlers.onCommentHover?.(target);
      return true;
    }
    case 'od:comment-leave':
      handlers.onCommentLeave?.();
      return true;
    case 'od:comment-target': {
      const target = asCommentTarget(data);
      if (target) handlers.onCommentTarget?.(target);
      return true;
    }
    case 'od:preview-open-file':
      if (typeof data.fileName === 'string' && isPreviewOpenFileName(data.fileName)) handlers.onOpenFile?.(data.fileName);
      return true;
    default:
      if (EDIT_TYPES.has(data.type)) {
        handlers.onEdit?.(data as unknown as ManualEditBridgeMessage);
        return true;
      }
      return false;
  }
}

const routes = new Map<MessageEventSource, Set<FrameMessageHandlers>>();
let installed = false;

function onMessage(event: MessageEvent): void {
  const source = event.source;
  if (!source) return;
  const handlers = routes.get(source);
  if (!handlers) return;
  for (const entry of [...handlers]) {
    try {
      dispatchFrameMessage(entry, event.data);
    } catch {
      /* a face's handler must not break the other frames */
    }
  }
}

function ensureInstalled(): void {
  if (installed || typeof window === 'undefined') return;
  window.addEventListener('message', onMessage);
  installed = true;
}

function maybeUninstall(): void {
  if (!installed || routes.size > 0 || typeof window === 'undefined') return;
  window.removeEventListener('message', onMessage);
  installed = false;
}

/** Routes the messages of `win` (an iframe's contentWindow) to `handlers` until the returned function is called. */
export function registerFrameWindow(win: Window, handlers: FrameMessageHandlers): () => void {
  ensureInstalled();
  let set = routes.get(win);
  if (!set) {
    set = new Set();
    routes.set(win, set);
  }
  set.add(handlers);
  return () => {
    const current = routes.get(win);
    if (!current) return;
    current.delete(handlers);
    if (current.size === 0) routes.delete(win);
    maybeUninstall();
  };
}

/** Test helper. */
export function routedFrameWindowCount(): number {
  return routes.size;
}
