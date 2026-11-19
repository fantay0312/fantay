// SPDX-License-Identifier: AGPL-3.0-only
// The context bar's model (spec 03 §6.3): what the floating mode bar offers for the current selection — the
// Navigate / Edit / Capture modes with their disabled reasons, kind controls (frame size and export, note colour and
// size, shape style), icon actions and the overflow menu. Pure: actions call the `ops` the chrome passes in, so the
// per-kind rules are testable without a board.
import { canGroupNodes, type BoardColor, type BoardNodeKind } from '@open-design/contracts';
import type { LucideIcon } from 'lucide-react';

import { FRAME_SOURCE_MAX_BYTES } from '../engine/frame-transport';
import type { BoardExtensions, BoardNodeAction } from '../extensions';
import { nodeFilePath } from '../model/contract-adapter';
import type { BoardUiState, DictKey, EngineNode, NodeRuntime } from '../model/types';
import type { FrameFacts } from '../nodes/frame/frame-registry';
import { MODE_ICONS, ICONS } from './icons';

export interface BoardAction {
  id: string;
  labelKey: DictKey;
  icon: LucideIcon;
  run(): void | Promise<void>;
  disabledReasonKey?: DictKey;
  tone?: 'default' | 'danger';
  /** an on/off action (aria-pressed) */
  pressed?: boolean;
}

export type BoardNodeModeName = 'navigate' | 'edit' | 'capture';

export interface ContextBarMode {
  mode: BoardNodeModeName;
  enabled: boolean;
  reasonKey?: DictKey;
}

export type ContextBarWidget =
  | { type: 'frame-size'; nodeId: string }
  | { type: 'frame-export'; nodeId: string; disabledReasonKey?: DictKey }
  | { type: 'note-color'; nodeId: string }
  | { type: 'note-size'; nodeId: string }
  | { type: 'shape-fill'; nodeId: string }
  | { type: 'shape-stroke'; nodeId: string }
  | { type: 'shape-radius'; nodeId: string }
  | { type: 'text-size'; nodeId: string }
  | { type: 'text-weight'; nodeId: string }
  | { type: 'open-editor'; nodeId: string; path: string; disabledReasonKey?: DictKey }
  | { type: 'align'; nodeIds: string[] };

export interface ContextBarModel {
  kind: 'none' | 'single' | 'single-live' | 'multi' | 'mode-active';
  nodeId?: string;
  nodeKind?: BoardNodeKind;
  modes?: ContextBarMode[];
  activeMode?: BoardNodeModeName;
  widgets: ContextBarWidget[];
  actions: BoardAction[];
  more: BoardAction[];
  countLabel?: { key: DictKey; vars: Record<string, number> };
}

/** What the actions do; the chrome binds them to the engine, the host and the dialogs. */
export interface ContextBarOps {
  openInFiles(path: string): void;
  openBrowserTab(url: string): void;
  openExternal(url: string): void;
  reload(nodeId: string): void;
  toggleMaximize(nodeId: string): void;
  refreshCover(nodeId: string): void;
  copyPath(path: string): void;
  download(path: string): void;
  addToChat(nodeIds: readonly string[]): void;
  copyAsPng(nodeId: string): void;
  remove(nodeIds: readonly string[]): void;
  deleteFile(nodeId: string): void;
  duplicate(nodeIds: readonly string[]): void;
  rename(nodeId: string): void;
  group(nodeIds: readonly string[]): void;
  ungroup(nodeIds: readonly string[]): void;
  zoomTo(nodeIds: readonly string[]): void;
  setLocked(nodeIds: readonly string[], locked: boolean): void;
  togglePlay(nodeId: string): void;
  toggleMute(nodeId: string): void;
  openStudio(nodeId: string): void;
  openEditor(path: string): void;
}

export interface ContextBarInput {
  selection: readonly EngineNode[];
  runtime: ReadonlyMap<string, NodeRuntime>;
  mode: BoardUiState['mode'];
  /** the node filling the stage */
  maximizedNodeId?: string | null;
  readOnly: boolean;
  /** the desktop host (compositor capture) is available */
  hostAvailable: boolean;
  extensions: BoardExtensions | undefined;
  hasBrowserTab: boolean;
  facts?: (nodeId: string) => FrameFacts;
  ops: ContextBarOps;
}

const MODE_ORDER: readonly BoardNodeModeName[] = ['navigate', 'edit', 'capture'];

export const MODE_LABEL_KEYS: Readonly<Record<BoardNodeModeName, DictKey>> = {
  navigate: 'board.mode.navigate',
  edit: 'board.mode.edit',
  capture: 'board.mode.capture',
};

export const MODE_HINT_KEYS: Readonly<Record<BoardNodeModeName, DictKey>> = {
  navigate: 'board.mode.navigateHint',
  edit: 'board.mode.editHint',
  capture: 'board.mode.captureHint',
};

export { MODE_ICONS };

function mode(modeName: BoardNodeModeName, reasonKey?: DictKey): ContextBarMode {
  return reasonKey ? { mode: modeName, enabled: false, reasonKey } : { mode: modeName, enabled: true };
}

/** Navigate / Edit / Capture availability of a frame or web node (03 §5.3 disabled reasons). */
export function modesFor(
  node: EngineNode,
  runtime: NodeRuntime | undefined,
  input: Pick<ContextBarInput, 'readOnly' | 'hostAvailable'> & { facts?: FrameFacts },
): ContextBarMode[] | undefined {
  const missing = runtime?.phase === 'missing' || node.missing;
  if (node.kind === 'web') {
    return [
      mode('navigate', missing ? 'board.node.state.missing' : undefined),
      mode('edit', 'board.mode.reason.webEdit'),
      mode('capture', input.readOnly ? 'board.mode.reason.readOnly' : !input.hostAvailable ? 'board.mode.reason.webCapture' : undefined),
    ];
  }
  if (node.kind !== 'frame') return undefined;
  const hasFile = node.data.ref !== null;
  const hasSource = hasFile || typeof node.data.liveArtifactId === 'string';
  const building = runtime?.phase === 'building';
  const tooLarge = (runtime?.fileSize ?? 0) > FRAME_SOURCE_MAX_BYTES;
  const powered = input.facts?.powered === true;
  const navigateReason: DictKey | undefined = missing || !hasSource ? 'board.node.state.missing' : building ? 'board.mode.reason.building' : undefined;
  const editReason: DictKey | undefined = missing || !hasSource
    ? 'board.node.state.missing'
    : input.readOnly
      ? 'board.mode.reason.readOnly'
      : !hasFile
        ? 'board.insert.unavailable'
        : building
          ? 'board.mode.reason.building'
          : tooLarge
            ? 'board.mode.reason.tooLarge'
            : powered
              ? 'board.mode.reason.powered'
              : undefined;
  const captureReason: DictKey | undefined = missing || !hasSource
    ? 'board.node.state.missing'
    : input.readOnly
      ? 'board.mode.reason.readOnly'
      : tooLarge && !input.hostAvailable
        ? 'board.mode.reason.tooLarge'
        : powered
          ? 'board.mode.reason.powered'
          : undefined;
  return [mode('navigate', navigateReason), mode('edit', editReason), mode('capture', captureReason)];
}

function fromExtension(action: BoardNodeAction): BoardAction {
  return {
    id: action.id,
    labelKey: action.labelKey,
    icon: action.icon,
    run: action.run,
    ...(action.disabledReasonKey ? { disabledReasonKey: action.disabledReasonKey } : {}),
  };
}

function extensionActions(input: ContextBarInput, node: EngineNode, kind: 'image' | 'video' | 'design'): { bar: BoardAction[]; more: BoardAction[] } {
  const list = (() => {
    try {
      return input.extensions?.nodeActions?.(node.id, kind) ?? [];
    } catch {
      return [];
    }
  })();
  return {
    bar: list.filter((action) => action.placement === 'bar').map(fromExtension),
    more: list.filter((action) => action.placement === 'more').map(fromExtension),
  };
}

/** Builds the context bar model of the current selection (03 §6.3 per-kind table). */
export function contextBarModelFor(input: ContextBarInput): ContextBarModel {
  const { selection, ops, readOnly } = input;
  if (selection.length === 0) return { kind: 'none', widgets: [], actions: [], more: [] };

  if (selection.length > 1) {
    const ids = selection.map((node) => node.id);
    const geometry = selection.map((node) => ({ id: node.id, kind: node.kind, x: node.x, y: node.y, w: node.w, h: node.h, parentId: node.parentId ?? undefined }));
    const actions: BoardAction[] = [];
    if (!readOnly && canGroupNodes(ids, geometry)) actions.push({ id: 'group', labelKey: 'board.menu.group', icon: ICONS.group, run: () => ops.group(ids) });
    if (!readOnly) actions.push({ id: 'remove', labelKey: 'board.menu.remove', icon: ICONS.remove, run: () => ops.remove(ids), tone: 'danger' });
    return {
      kind: 'multi',
      widgets: readOnly ? [] : [{ type: 'align', nodeIds: ids }],
      actions,
      more: [],
      countLabel: { key: 'board.selection.count', vars: { count: selection.length } },
    };
  }

  const node = selection[0]!;
  const runtime = input.runtime.get(node.id);
  const path = nodeFilePath(node);
  const widgets: ContextBarWidget[] = [];
  const actions: BoardAction[] = [];
  const more: BoardAction[] = [];
  const remove: BoardAction = { id: 'remove', labelKey: 'board.menu.remove', icon: ICONS.remove, run: () => ops.remove([node.id]) };
  const deleteFile: BoardAction = { id: 'delete-file', labelKey: 'board.menu.deleteFile', icon: ICONS.deleteFile, run: () => ops.deleteFile(node.id), tone: 'danger' };
  const copyPath = (value: string): BoardAction => ({ id: 'copy-path', labelKey: 'board.node.copyPath', icon: ICONS.copy, run: () => ops.copyPath(value) });
  const download = (value: string): BoardAction => ({ id: 'download', labelKey: 'board.node.download', icon: ICONS.download, run: () => ops.download(value) });
  const duplicate: BoardAction = { id: 'duplicate', labelKey: 'board.menu.duplicate', icon: ICONS.duplicate, run: () => ops.duplicate([node.id]) };
  const reload: BoardAction = { id: 'reload', labelKey: 'board.node.reload', icon: ICONS.reload, run: () => ops.reload(node.id) };
  const maximized = input.maximizedNodeId === node.id;
  const maximize: BoardAction = {
    id: 'maximize',
    labelKey: maximized ? 'board.node.restoreView' : 'board.node.maximize',
    icon: maximized ? ICONS.restoreView : ICONS.maximize,
    run: () => ops.toggleMaximize(node.id),
  };
  const playing = runtime?.playing === true;
  const facts = input.facts?.(node.id);
  const modes = modesFor(node, runtime, { readOnly, hostAvailable: input.hostAvailable, ...(facts ? { facts } : {}) });

  switch (node.kind) {
    case 'frame': {
      widgets.push({ type: 'frame-size', nodeId: node.id });
      const exportReason: DictKey | undefined = runtime?.phase === 'missing' || node.missing
        ? 'board.node.state.missing'
        : !path
          ? 'board.export.unavailable'
          : undefined;
      widgets.push({ type: 'frame-export', nodeId: node.id, ...(exportReason ? { disabledReasonKey: exportReason } : {}) });
      if (path) actions.push({ id: 'open-in-files', labelKey: 'board.node.openInFiles', icon: ICONS.openInFiles, run: () => ops.openInFiles(path) });
      actions.push(maximize);
      more.push(reload);
      if (!readOnly) more.push({ id: 'refresh-cover', labelKey: 'board.node.refreshCover', icon: ICONS.refreshCover, run: () => ops.refreshCover(node.id) });
      if (path) {
        more.push(copyPath(path));
        more.push({ id: 'add-to-chat', labelKey: 'board.node.addToChat', icon: ICONS.addToChat, run: () => ops.addToChat([node.id]) });
      }
      more.push({ id: 'copy-png', labelKey: 'board.menu.copyAsPng', icon: ICONS.copy, run: () => ops.copyAsPng(node.id) });
      if (!readOnly) more.push(remove);
      break;
    }
    case 'web': {
      const url = node.data.url;
      actions.push(reload);
      if (input.hasBrowserTab) actions.push({ id: 'open-browser-tab', labelKey: 'board.node.openBrowserTab', icon: ICONS.browserTab, run: () => ops.openBrowserTab(url) });
      actions.push(maximize);
      more.push({ id: 'open-external', labelKey: 'board.node.openExternal', icon: ICONS.external, run: () => ops.openExternal(url) });
      if (!readOnly) {
        more.push({
          id: 'refresh-cover',
          labelKey: 'board.node.refreshCover',
          icon: ICONS.refreshCover,
          run: () => ops.refreshCover(node.id),
          ...(input.hostAvailable ? {} : { disabledReasonKey: 'board.mode.reason.webCapture' as const }),
        });
        more.push(remove);
      }
      break;
    }
    case 'image': {
      const ext = extensionActions(input, node, 'image');
      if (path) {
        actions.push(download(path));
        actions.push({ id: 'attach-to-chat', labelKey: 'board.node.attachToChat', icon: ICONS.addToChat, run: () => ops.addToChat([node.id]) });
      }
      actions.push(...ext.bar);
      if (path) more.push({ id: 'copy-png', labelKey: 'board.menu.copyAsPng', icon: ICONS.copy, run: () => ops.copyAsPng(node.id) }, copyPath(path));
      more.push(...ext.more);
      if (!readOnly) {
        more.push(remove);
        if (path) more.push(deleteFile);
      }
      break;
    }
    case 'video': {
      const ext = extensionActions(input, node, 'video');
      const body = input.extensions?.renderVideoBody !== undefined;
      if (path && !body) {
        actions.push({ id: 'play', labelKey: playing ? 'board.node.pause' : 'board.node.play', icon: playing ? ICONS.pause : ICONS.play, run: () => ops.togglePlay(node.id), pressed: playing });
        const muted = node.data.muted !== false;
        if (!readOnly) actions.push({ id: 'mute', labelKey: muted ? 'board.node.unmute' : 'board.node.mute', icon: muted ? ICONS.mute : ICONS.unmute, run: () => ops.toggleMute(node.id) });
      }
      if (path) actions.push(download(path));
      actions.push(...ext.bar);
      if (path) more.push(copyPath(path));
      more.push(...ext.more);
      if (!readOnly) {
        more.push(remove);
        if (path) more.push(deleteFile);
      }
      break;
    }
    case 'audio': {
      if (path) {
        actions.push({ id: 'play', labelKey: playing ? 'board.node.pause' : 'board.node.play', icon: playing ? ICONS.pause : ICONS.play, run: () => ops.togglePlay(node.id), pressed: playing });
        actions.push(download(path));
        more.push(copyPath(path));
      }
      if (!readOnly) {
        more.push(remove);
        if (path) more.push(deleteFile);
      }
      break;
    }
    case 'note': {
      if (!readOnly) {
        widgets.push({ type: 'note-color', nodeId: node.id }, { type: 'note-size', nodeId: node.id });
        more.push(duplicate, remove);
      }
      break;
    }
    case 'shape': {
      if (!readOnly) {
        if (node.data.shape === 'text') widgets.push({ type: 'text-size', nodeId: node.id }, { type: 'text-weight', nodeId: node.id });
        else if (node.data.shape === 'freehand') widgets.push({ type: 'shape-stroke', nodeId: node.id });
        else {
          widgets.push({ type: 'shape-fill', nodeId: node.id }, { type: 'shape-stroke', nodeId: node.id });
          if (node.data.shape === 'rect') widgets.push({ type: 'shape-radius', nodeId: node.id });
        }
        more.push(duplicate, remove);
      }
      break;
    }
    case 'group': {
      if (!readOnly) {
        actions.push({ id: 'rename', labelKey: 'common.rename', icon: ICONS.rename, run: () => ops.rename(node.id) });
        actions.push({ id: 'ungroup', labelKey: 'board.menu.ungroup', icon: ICONS.ungroup, run: () => ops.ungroup([node.id]) });
      }
      actions.push({ id: 'zoom-to-group', labelKey: 'board.menu.zoomToGroup', icon: ICONS.zoomToGroup, run: () => ops.zoomTo([node.id]) });
      if (!readOnly) {
        more.push(
          node.locked
            ? { id: 'unlock', labelKey: 'board.menu.unlock', icon: ICONS.unlock, run: () => ops.setLocked([node.id], false) }
            : { id: 'lock', labelKey: 'board.menu.lock', icon: ICONS.lock, run: () => ops.setLocked([node.id], true) },
          remove,
        );
      }
      break;
    }
    case 'generator': {
      if (!readOnly) more.push(duplicate, remove);
      break;
    }
    case 'design': {
      const ext = extensionActions(input, node, 'design');
      const designPath = node.data.ref.path;
      const extensionOpens = ext.bar.some((action) => action.id === 'design.open');
      if (!extensionOpens) {
        widgets.push({
          type: 'open-editor',
          nodeId: node.id,
          path: designPath,
          ...(input.extensions?.openDesignDocument ? {} : { disabledReasonKey: 'board.insert.unavailable' as const }),
        });
      }
      actions.push(...ext.bar);
      more.push(copyPath(designPath), ...ext.more);
      if (!readOnly) more.push(remove, deleteFile);
      break;
    }
    case 'motion': {
      // a film plays in its own body (07 MotionNode transport; the fallback face has no player): no bar Play
      if (node.data.source.type !== 'movie') {
        actions.push({ id: 'play', labelKey: playing ? 'board.node.pause' : 'board.node.play', icon: playing ? ICONS.pause : ICONS.play, run: () => ops.togglePlay(node.id), pressed: playing });
      }
      const studio = node.data.source.type === 'movie' && !input.extensions?.openMotionStudio;
      actions.push({
        id: 'open-studio',
        labelKey: 'board.node.openStudio',
        icon: ICONS.animation,
        run: () => ops.openStudio(node.id),
        ...(studio ? { disabledReasonKey: 'board.insert.unavailable' as const } : {}),
      });
      if (path) more.push(copyPath(path));
      if (!readOnly) more.push(remove);
      break;
    }
    default:
      break;
  }

  const activeMode = input.mode && input.mode.nodeId === node.id ? input.mode.mode : undefined;
  if (activeMode) {
    return { kind: 'mode-active', nodeId: node.id, nodeKind: node.kind, ...(modes ? { modes } : {}), activeMode, widgets: [], actions: [reload, maximize], more: [] };
  }
  return {
    kind: modes ? 'single-live' : 'single',
    nodeId: node.id,
    nodeKind: node.kind,
    ...(modes ? { modes } : {}),
    widgets,
    actions,
    more,
  };
}

/** Colours a palette swatch row offers, with the "none" choice for shape fill/stroke. */
export type SwatchValue = BoardColor | 'none';

export { MODE_ORDER };
