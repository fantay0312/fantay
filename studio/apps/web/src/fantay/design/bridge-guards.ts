// SPDX-License-Identifier: AGPL-3.0-only
// Per-type payload checks for editor → host traffic (spec 06 §5.1 rule 5). `isDesignBridgeMessage` only
// validates the envelope; these validate each request/event payload before the host acts on it.
// Requests that fail a check are answered with INVALID_REQUEST; events that fail are dropped.
import {
  DESIGN_BRIDGE_LIMITS,
  isDesignBridgeError,
  type DesignEditorStatePayload,
  type DesignSaveRequest,
  type DesignSelection,
  type DesignSelectionNode,
  type DesignViewState,
  type EditorToHostEvents,
  type EditorToHostRequests,
} from '@open-design/contracts';

const SAVE_REASONS = new Set<DesignSaveRequest['reason']>(['autosave', 'manual', 'flush', 'convert', 'copy', 'force']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.prototype.toString.call(value) === '[object Object]';
}

/** ArrayBuffer check that also holds across realms (structured clone from the iframe). */
export function isArrayBufferValue(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export type EditorRequestType = keyof EditorToHostRequests;

export function isEditorRequestType(type: string): type is EditorRequestType {
  return type === 'document.save' || type === 'asset.fetch';
}

export function isDesignSaveRequest(value: unknown): value is DesignSaveRequest {
  if (!isRecord(value)) return false;
  return (
    isArrayBufferValue(value.bytes) &&
    (value.format === 'fig' || value.format === 'op') &&
    isNullableString(value.baseSha256) &&
    typeof value.reason === 'string' &&
    SAVE_REASONS.has(value.reason as DesignSaveRequest['reason']) &&
    (value.targetPath === undefined || (typeof value.targetPath === 'string' && value.targetPath.length > 0))
  );
}

export function isAssetFetchRequest(value: unknown): value is EditorToHostRequests['asset.fetch']['req'] {
  return isRecord(value) && typeof value.path === 'string' && value.path.length > 0;
}

/** Validates the request payload for `type`; null when it does not match. */
export function normalizeEditorRequest<T extends EditorRequestType>(
  type: T,
  payload: unknown,
): EditorToHostRequests[T]['req'] | null {
  if (type === 'document.save') return isDesignSaveRequest(payload) ? (payload as EditorToHostRequests[T]['req']) : null;
  return isAssetFetchRequest(payload) ? (payload as EditorToHostRequests[T]['req']) : null;
}

function normalizeState(value: Record<string, unknown>): DesignEditorStatePayload | null {
  if (typeof value.dirty !== 'boolean' || typeof value.saving !== 'boolean' || typeof value.readOnly !== 'boolean') return null;
  if (!isNullableString(value.sha256)) return null;
  if (value.lastSavedAt !== null && !isFiniteNumber(value.lastSavedAt)) return null;
  if (value.format !== null && value.format !== 'fig' && value.format !== 'op') return null;
  if (value.error !== null && !isDesignBridgeError(value.error)) return null;
  return {
    dirty: value.dirty,
    saving: value.saving,
    readOnly: value.readOnly,
    sha256: value.sha256,
    lastSavedAt: value.lastSavedAt as number | null,
    format: value.format as DesignEditorStatePayload['format'],
    error: value.error as DesignEditorStatePayload['error'],
  };
}

function normalizeSelectionNode(value: unknown): DesignSelectionNode | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null;
  return {
    id: value.id,
    name: typeof value.name === 'string' ? value.name : '',
    type: typeof value.type === 'string' ? value.type : '',
    width: isFiniteNumber(value.width) ? value.width : 0,
    height: isFiniteNumber(value.height) ? value.height : 0,
  };
}

/** Selection with at most DESIGN_BRIDGE_LIMITS.maxSelectionNodes node summaries. */
function normalizeSelection(value: Record<string, unknown>): DesignSelection | null {
  if (typeof value.pageId !== 'string' || !Array.isArray(value.nodeIds) || !Array.isArray(value.nodes)) return null;
  if (value.nodeIds.length > DESIGN_BRIDGE_LIMITS.maxMessageKeys) return null;
  const nodeIds = value.nodeIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  const nodes = value.nodes
    .slice(0, DESIGN_BRIDGE_LIMITS.maxSelectionNodes)
    .map(normalizeSelectionNode)
    .filter((node): node is DesignSelectionNode => node !== null);
  return { pageId: value.pageId, nodeIds, nodes };
}

function normalizeView(value: Record<string, unknown>): DesignViewState | null {
  if (!isFiniteNumber(value.zoom) || value.zoom <= 0 || typeof value.pageId !== 'string' || !Array.isArray(value.pages)) return null;
  const pages = value.pages
    .slice(0, DESIGN_BRIDGE_LIMITS.maxMessageKeys)
    .filter((page): page is { id: string; name: string } => isRecord(page) && typeof page.id === 'string' && typeof page.name === 'string')
    .map((page) => ({ id: page.id, name: page.name }));
  return { zoom: value.zoom, pageId: value.pageId, pages };
}

export type EditorEventType = keyof EditorToHostEvents;

const EVENT_TYPES = new Set<string>(['state', 'selection', 'view', 'error', 'request-close', 'shortcut']);

export function isEditorEventType(type: string): type is EditorEventType {
  return EVENT_TYPES.has(type);
}

/** Validates (and trims) an event payload; null drops the event. */
export function normalizeEditorEvent<T extends EditorEventType>(type: T, payload: unknown): EditorToHostEvents[T] | null {
  if (!isRecord(payload)) return null;
  switch (type) {
    case 'state':
      return normalizeState(payload) as EditorToHostEvents[T] | null;
    case 'selection':
      return normalizeSelection(payload) as EditorToHostEvents[T] | null;
    case 'view':
      return normalizeView(payload) as EditorToHostEvents[T] | null;
    case 'error':
      return (isDesignBridgeError(payload) ? payload : null) as EditorToHostEvents[T] | null;
    case 'request-close':
      return {} as EditorToHostEvents[T];
    case 'shortcut':
      return (typeof payload.combo === 'string' && payload.combo ? { combo: payload.combo } : null) as EditorToHostEvents[T] | null;
    default:
      return null;
  }
}
