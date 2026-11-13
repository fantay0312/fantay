// SPDX-License-Identifier: AGPL-3.0-only
// Design selection → chat context (spec 06 §6.6, amendment C2). The editor's selection becomes one
// `WorkspaceContextItem` of kind `file` (the existing kind, packages/contracts api/context.ts): it points
// at the design file and lists the selected layers in `title`, so the agent knows what "this" means.
// Node ids are session-scoped in @open-pencil 0.16 (they do not survive a reload).
import type { DesignSelection, WorkspaceContextItem } from '@open-design/contracts';

import type { Dict } from '../../i18n/types';

/** Daemon caps (apps/daemon/src/runtimes/chat-run-context.ts): id/label 240, title 500 characters. */
const MAX_ID = 240;
const MAX_LABEL = 240;
const MAX_TITLE = 500;

type Translate = (key: keyof Dict, vars?: Record<string, string | number>) => string;

export interface DesignSelectionContextOptions {
  projectId: string;
  path: string;
  /** Accepted for API parity with spec 06 §6.1; the item text is locale-neutral (names and sizes). */
  t?: Translate;
  /** The workspace tab the design is open in (FileWorkspace's tab id = the file name). */
  tabId?: string;
}

function baseName(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/');
  return segments[segments.length - 1] || path;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Stable 32-bit FNV-1a hex digest (keeps long selections under the id cap without collisions in practice). */
function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function selectionId(path: string, nodeIds: readonly string[]): string {
  const full = `design:${path}:${nodeIds.join(',')}`;
  if (full.length <= MAX_ID) return full;
  const prefix = `design:${path}:`;
  const suffix = `#${nodeIds.length}-${digest(nodeIds.join(','))}`;
  return `${truncate(prefix, MAX_ID - suffix.length)}${suffix}`;
}

function sizeOf(width: number, height: number): string {
  return `${Math.round(width)}×${Math.round(height)}`;
}

function titleLines(selection: DesignSelection): string {
  const lines: string[] = [];
  let length = 0;
  for (const node of selection.nodes) {
    const line = [node.type, node.name, sizeOf(node.width, node.height)].filter(Boolean).join(' ');
    const extra = (lines.length === 0 ? 0 : 1) + line.length;
    if (length + extra > MAX_TITLE - 2) {
      lines.push('…');
      break;
    }
    lines.push(line);
    length += extra;
  }
  return lines.join('\n');
}

/**
 * `{ id: 'design:<path>:<nodeIds>', kind: 'file', path, label: '<file name> · <first node name> (+N)',
 * title: '<type> <name> <w>×<h>' per line }`; null when nothing is selected (the editor clears its context).
 */
export function designSelectionToWorkspaceItem(
  selection: DesignSelection,
  options: DesignSelectionContextOptions,
): WorkspaceContextItem | null {
  const nodeIds = selection.nodeIds.filter((id) => typeof id === 'string' && id.length > 0);
  if (nodeIds.length === 0) return null;
  const fileName = baseName(options.path);
  const first = selection.nodes.find((node) => node.id === nodeIds[0]) ?? selection.nodes[0];
  const firstName = first?.name || first?.type || nodeIds[0] || '';
  const more = nodeIds.length > 1 ? ` (+${nodeIds.length - 1})` : '';
  const title = titleLines(selection);
  return {
    id: selectionId(options.path, nodeIds),
    kind: 'file',
    label: truncate(`${fileName} · ${firstName}${more}`, MAX_LABEL),
    path: options.path,
    ...(options.tabId ? { tabId: options.tabId } : {}),
    ...(title ? { title } : {}),
  };
}
