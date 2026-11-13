'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// The actions behind the board chrome (spec 03 §3.12–§3.14, §6): one object shared by the bottom toolbar, the
// insert menu, the context bar and the context menus, bound to the engine commands, the host environment, the
// frame registry and the chrome's dialogs. Long-running actions (copy as PNG, export, cover refresh) promote a node
// to live for as long as they need its document.
import { createContext, useContext, useMemo } from 'react';
import {
  boardFramePresetDevice,
  type BoardFramePreset,
} from '@open-design/contracts';

import { useT } from '../../../i18n';
import { revealProjectChat } from '../../chat/project-chat-bridge';
import { toast } from '../../ui/toast';
import { useBoardEngine, useBoardHost } from '../context';
import { stageBoardNodesInChat } from '../sync/capture';
import { copyText, downloadBlob, downloadProjectFile, openExternal } from '../interaction/file-actions';
import { nodeFilePath } from '../model/contract-adapter';
import type { EngineNode, Point } from '../model/types';
import { frameRegistryFor, type FrameHandle, type FrameRegistry } from '../nodes/frame/frame-registry';
import { basenameOf } from '../nodes/frame/project-files';
import { projectMediaUrl } from '../nodes/media/media-url';
import type { BoardEngine } from '../store/board-engine';
import type { ContextBarOps } from './context-bar-model';
import { FRAME_EXPORT_DIR, renderFrameImage, resampleToPng, type FrameExportScale } from './frame-export';

export interface ChromeDialogs {
  openUrlDialog(): void;
  openFilesPicker(): void;
  /** opens the system file picker; picked files are uploaded at `at` (default: the stage centre) */
  openUpload(accept: string, at?: Point): void;
  confirmDeleteFile(nodeId: string): void;
}

export interface ChromeActions extends ContextBarOps, ChromeDialogs {
  exportFrame(nodeId: string, scale: FrameExportScale): void;
  resizeFrame(nodeId: string, preset: BoardFramePreset): void;
  insertGenerator(surface: 'image' | 'video', at?: Point): void;
  openShortcuts(): void;
  stageCenter(): Point;
}

export const BoardChromeContext = createContext<ChromeActions | null>(null);

export function useChromeActions(): ChromeActions {
  const actions = useContext(BoardChromeContext);
  if (!actions) throw new Error('useChromeActions must be used inside <BoardChrome>');
  return actions;
}

/** World point at the centre of the stage. */
export function stageCenterWorld(engine: BoardEngine): Point {
  const cam = engine.camera.get();
  const stage = engine.camera.stageSize();
  return { x: (stage.w / 2 - cam.x) / cam.zoom, y: (stage.h / 2 - cam.y) / cam.zoom };
}

/** Runs `task` with the node's live document, promoting the node to live (pinned) while it runs. */
export async function withLiveFrame<T>(
  engine: BoardEngine,
  registry: FrameRegistry,
  nodeId: string,
  task: (handle: FrameHandle, iframe: HTMLIFrameElement) => Promise<T>,
  timeoutMs = 8_000,
): Promise<T | null> {
  const wasPinned = engine.store.getState().pinnedLiveIds.has(nodeId);
  if (!wasPinned) engine.commands.requestLive(nodeId, true);
  try {
    const started = Date.now();
    let handle = registry.get(nodeId);
    while (!handle && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      handle = registry.get(nodeId);
    }
    if (!handle) return null;
    const iframe = await handle.whenLoaded(Math.max(0, timeoutMs - (Date.now() - started)));
    if (!iframe) return null;
    return await task(handle, iframe);
  } finally {
    if (!wasPinned) engine.commands.requestLive(nodeId, false);
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

async function toPngDataUrl(blob: Blob): Promise<string> {
  if (blob.type === 'image/png') return blobToDataUrl(blob);
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.toDataURL('image/png');
}

/** Builds the chrome's actions (stable for the engine and host values). */
export function useChromeActionsValue(dialogs: ChromeDialogs): ChromeActions {
  const engine = useBoardEngine();
  const host = useBoardHost();
  const t = useT();
  const { env, extensions } = host;
  const registry = frameRegistryFor(engine);
  return useMemo<ChromeActions>(() => {
    const { commands } = engine;
    const nodeOf = (id: string): EngineNode | undefined => engine.store.getState().doc.nodes.get(id);
    const fail = (key: Parameters<typeof t>[0], vars?: Record<string, string | number>) => toast({ title: t(key, vars), tone: 'danger' });

    const copyAsPng = async (nodeId: string): Promise<void> => {
      const node = nodeOf(nodeId);
      if (!node) return;
      const exports = await import('../../../runtime/exports');
      let dataUrl: string | null = null;
      try {
        if (node.kind === 'image') {
          const path = nodeFilePath(node);
          if (path) {
            const response = await fetch(projectMediaUrl(env.projectId, path, undefined, env.workspaceContext));
            if (response.ok) dataUrl = await toPngDataUrl(await response.blob());
          }
        } else if (node.kind === 'frame' || node.kind === 'web') {
          dataUrl = await withLiveFrame(engine, registry, nodeId, async (_handle, iframe) => {
            if (node.kind === 'frame') {
              const snapshot = await exports.requestPreviewSnapshot(iframe, 6_000);
              if (snapshot) return snapshot.dataUrl;
            }
            const rect = iframe.getBoundingClientRect();
            const host = await exports.captureHostRegionSnapshot({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
            return host?.dataUrl ?? null;
          });
        }
      } catch {
        dataUrl = null;
      }
      const result = dataUrl ? await exports.copyImageDataUrlToClipboard(dataUrl) : 'failed';
      if (result === 'copied') toast({ title: t('board.copy.done'), tone: 'success' });
      else fail('board.copy.pngFailed');
    };

    const exportFrame = async (nodeId: string, scale: FrameExportScale): Promise<void> => {
      const node = nodeOf(nodeId);
      if (!node || node.kind !== 'frame' || !node.data.ref) return;
      const path = node.data.ref.path;
      const toastId = `board-export-${nodeId}`;
      toast({ id: toastId, title: t('board.export.image'), busy: true, duration: 0 });
      const exports = await import('../../../runtime/exports');
      const result = await renderFrameImage(
        { projectId: env.projectId, path, w: node.w, h: node.h, scale, deck: env.isDeckProject, workspaceContext: env.workspaceContext },
        {
          renderViaDaemon: (input) =>
            exports.exportProjectImageDataUrl({
              projectId: input.projectId,
              fileName: input.fileName,
              width: input.width,
              height: input.height,
              deck: input.deck,
              workspaceContext: input.workspaceContext,
            }),
          renderViaFrame: () =>
            withLiveFrame(engine, registry, nodeId, async (_handle, iframe) => {
              const snapshot = await exports.requestPreviewSnapshot(iframe, 8_000);
              if (snapshot) return snapshot;
              const rect = iframe.getBoundingClientRect();
              return exports.captureHostRegionSnapshot({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
            }),
          resample: resampleToPng,
        },
      ).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));
      if (!result.ok) {
        toast({ id: toastId, title: t('board.export.failed', { reason: result.reason }), tone: 'danger' });
        return;
      }
      const download = { label: t('board.node.download'), onClick: () => downloadBlob(result.blob, result.name) };
      if (engine.store.getState().readOnly) {
        downloadBlob(result.blob, result.name);
        toast({ id: toastId, title: t('board.export.done', { path: result.name }), tone: 'success' });
        return;
      }
      const { uploadProjectFiles } = await import('../../../providers/registry');
      const uploaded = await uploadProjectFiles(env.projectId, [new File([result.blob], result.name, { type: 'image/png' })], FRAME_EXPORT_DIR, env.workspaceContext)
        .then((response) => response.uploaded[0] ?? null)
        .catch(() => null);
      env.onRefreshFiles?.();
      if (!uploaded) {
        // the project refused the file: hand the image over as a download instead
        downloadBlob(result.blob, result.name);
        toast({ id: toastId, title: t('board.export.done', { path: result.name }), tone: 'success' });
        return;
      }
      toast({ id: toastId, title: t('board.export.done', { path: uploaded.path }), tone: 'success', action: download, duration: 8_000 });
    };

    return {
      ...dialogs,
      openInFiles: (path) => env.onOpenInFiles(path),
      openBrowserTab: (url) => env.onOpenBrowserTab?.(url),
      openExternal: (url) => openExternal(url),
      reload: (nodeId) => registry.get(nodeId)?.reload(),
      toggleMaximize: (nodeId) => commands.toggleMaximize(nodeId),
      refreshCover: (nodeId) => {
        void withLiveFrame(engine, registry, nodeId, (handle) => handle.refreshCover()).then((ok) => {
          if (!ok) fail('board.cover.failed');
        });
      },
      copyPath: (path) => {
        void copyText(path).then((ok) => (ok ? toast({ title: t('board.copy.done'), tone: 'success' }) : fail('board.copy.failed')));
      },
      download: (path) => downloadProjectFile(env.projectId, path, env.workspaceContext),
      addToChat: (nodeIds) => {
        const nodes = nodeIds.map(nodeOf).filter((node): node is EngineNode => !!node).map((node) => node.source);
        const staged = stageBoardNodesInChat(nodes);
        if (staged > 0) {
          revealProjectChat(env.projectId);
          toast({ title: t('board.capture.addedToChat'), tone: 'success' });
        } else fail('board.capture.chatFailed');
      },
      copyAsPng: (nodeId) => void copyAsPng(nodeId),
      remove: (nodeIds) => commands.removeNodes(nodeIds),
      deleteFile: (nodeId) => dialogs.confirmDeleteFile(nodeId),
      duplicate: (nodeIds) => void commands.duplicate(nodeIds),
      rename: (nodeId) => commands.startRename(nodeId),
      group: (nodeIds) => commands.group(nodeIds),
      ungroup: (nodeIds) => commands.ungroup(nodeIds),
      zoomTo: (nodeIds) => void commands.focusNodes(nodeIds, { animate: true, maxZoom: 2 }),
      setLocked: (nodeIds, locked) => commands.setLocked(nodeIds, locked),
      togglePlay: (nodeId) => {
        const playing = engine.store.getState().runtime.get(nodeId)?.playing === true;
        commands.setRuntime(nodeId, { playing: !playing });
      },
      toggleMute: (nodeId) => {
        const node = nodeOf(nodeId);
        if (node?.kind !== 'video') return;
        commands.updateNode(nodeId, { data: { muted: node.data.muted === false } }, { label: 'style' });
      },
      openStudio: (nodeId) => {
        const node = nodeOf(nodeId);
        if (node?.kind !== 'motion') return;
        if (node.data.source.type === 'movie') extensions?.openMotionStudio?.(node.data.source.projectId);
        else env.onOpenInFiles(node.data.source.ref.path);
      },
      openEditor: (path) => {
        if (extensions?.openDesignDocument) extensions.openDesignDocument(path);
        else env.onOpenInFiles(path);
      },
      exportFrame: (nodeId, scale) => void exportFrame(nodeId, scale),
      resizeFrame: (nodeId, preset) => {
        commands.updateNode(nodeId, { w: preset.w, h: preset.h, data: { device: boardFramePresetDevice(preset) } }, { label: 'device' });
      },
      insertGenerator: (surface, at) => {
        const create = extensions?.createGenerator;
        if (!create) {
          toast({ title: t('board.insert.unavailable') });
          return;
        }
        const id = create({ selectedIds: [...engine.store.getState().ui.selection], at: at ?? stageCenterWorld(engine), surface });
        if (id) commands.select([id]);
      },
      openShortcuts: () => engine.store.setUi({ shortcutsOpen: true }),
      stageCenter: () => stageCenterWorld(engine),
    };
  }, [engine, registry, env, extensions, dialogs, t]);
}

/** Label of a node's file for dialogs (delete confirm). */
export function nodeFileLabel(node: EngineNode): string {
  const path = nodeFilePath(node);
  return path ? basenameOf(path) : node.title ?? '';
}
