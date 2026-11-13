// SPDX-License-Identifier: AGPL-3.0-only
// Assembles the full `BoardExtensions` object inside `GenerationProvider` (spec 03 §2, plan §3.2):
// generation bodies/panel/actions/createGenerator + C9 design actions & covers + 07 motion body & actions +
// 07 materials picker & external drag/drop.
import { useCallback, useMemo, useRef, type RefObject } from 'react';
import { designRevision, type WorkspaceCollabContext } from '@open-design/contracts';

import { useI18n } from '../../../i18n';
import type { ProjectFile } from '../../../types';
import {
  designCoverUrl,
  designNodeActions,
  openDesignDocument as openDesignInWorkspace,
  openNewDesignDialog,
} from '../../design';
import { hasMaterialDrag, readMaterialDrag } from '../../materials/material-drag';
import { insertMaterialToBoard } from '../../materials/material-insert';
import { openMaterialsDrawer } from '../../materials/materials-drawer-store';
import { useGenerationBoardExtensions } from '../../media-nodes/board-extensions';
import { MotionNodeBody, insertMotionFromBoard, openMotionEditor } from '../../motion';
import { toast } from '../../ui';
import type { BoardCommands } from '../commands/board-commands';
import type { BoardExtensions, BoardMotionBodyProps, BoardNodeAction } from '../extensions';
import type { BoardDataStore } from '../data/types';
import { hasPanelDrag, readPanelDrag } from '../panels/panel-drag';
import { placePanelDrop } from '../panels/use-panel-actions';

export interface UseAssembledBoardExtensionsInput {
  projectId: string;
  files: readonly ProjectFile[];
  readOnly: boolean;
  workspaceContext: WorkspaceCollabContext | null;
  store: BoardDataStore;
  commandsRef: RefObject<BoardCommands | null>;
  onRefreshFiles(): void;
}

export function useAssembledBoardExtensions(input: UseAssembledBoardExtensionsInput): BoardExtensions {
  const { projectId, files, readOnly, workspaceContext, store, commandsRef, onRefreshFiles } = input;
  const { t } = useI18n();
  const generationExtensions = useGenerationBoardExtensions();

  const latestRef = useRef({ projectId, files, readOnly, workspaceContext, store, commandsRef, onRefreshFiles, t, generationExtensions });
  latestRef.current = { projectId, files, readOnly, workspaceContext, store, commandsRef, onRefreshFiles, t, generationExtensions };

  const renderMotionBody = useCallback((props: BoardMotionBodyProps) => <MotionNodeBody {...props} />, []);

  const nodeActions = useCallback((nodeId: string, kind: 'image' | 'video' | 'design'): BoardNodeAction[] => {
    const current = latestRef.current;
    if (kind === 'design') {
      const node = current.store.getState().board?.nodes.find((entry) => entry.id === nodeId);
      if (!node || node.kind !== 'design') return [];
      return designNodeActions({
        projectId: current.projectId,
        path: node.ref.path,
        t: current.t,
        workspaceContext: current.workspaceContext,
        readOnly: current.readOnly,
        onOpen: (path) => openDesignInWorkspace(current.projectId, path),
      });
    }
    return current.generationExtensions.nodeActions(nodeId, kind);
  }, []);

  const resolveDesignCover = useCallback((path: string): string | null => {
    const current = latestRef.current;
    const file = current.files.find((entry) => entry.name === path);
    const rev =
      file && typeof file.size === 'number' && typeof file.mtime === 'number'
        ? designRevision(file.size, file.mtime)
        : undefined;
    return designCoverUrl(current.projectId, path, rev ?? '', current.workspaceContext);
  }, []);

  const createDesignDocument = useCallback(() => {
    const current = latestRef.current;
    if (current.readOnly) return;
    openNewDesignDialog({
      projectId: current.projectId,
      workspaceContext: current.workspaceContext,
      origin: 'board',
    });
  }, []);

  const openDesignDocument = useCallback((path: string) => {
    openDesignInWorkspace(latestRef.current.projectId, path);
  }, []);

  const createMotion = useCallback((kind: 'animation' | 'video-edit') => {
    const current = latestRef.current;
    if (current.readOnly) return;
    const result = insertMotionFromBoard({
      projectId: current.projectId,
      kind: kind === 'animation' ? 'code' : 'footage',
      files: current.files,
    });
    if (result.status === 'opened-editor') {
      toast({ title: current.t(result.statusKey) });
    }
  }, []);

  const openMotionStudio = useCallback((targetProjectId: string) => {
    openMotionEditor(targetProjectId || latestRef.current.projectId);
  }, []);

  const openMaterialsPicker = useCallback(() => {
    openMaterialsDrawer();
  }, []);

  const acceptsExternalDrag = useCallback((dataTransfer: DataTransfer): boolean => {
    if (latestRef.current.readOnly) return false;
    return hasMaterialDrag(dataTransfer) || hasPanelDrag(dataTransfer);
  }, []);

  const onExternalDrop = useCallback((dataTransfer: DataTransfer, world: { x: number; y: number }): boolean => {
    const current = latestRef.current;
    if (current.readOnly) return false;
    const panelItem = readPanelDrag(dataTransfer);
    const commands = current.commandsRef.current;
    if (panelItem && commands) {
      placePanelDrop(commands, panelItem, world, {
        projectId: current.projectId,
        workspaceContext: current.workspaceContext,
        refresh: current.onRefreshFiles,
        onError: (detail) => toast({ title: current.t('board.assets.failed', { detail }), tone: 'danger' }),
      });
      return true;
    }
    const payload = readMaterialDrag(dataTransfer);
    if (!payload) return false;
    void insertMaterialToBoard({
      item: payload.item,
      projectId: current.projectId,
      at: world,
      workspaceContext: current.workspaceContext,
    }).catch((error: unknown) => {
      const detail = error instanceof Error && error.message ? error.message : '';
      toast({ title: current.t('materials.drawer.insertFailed', { detail }), tone: 'danger' });
    });
    return true;
  }, []);

  return useMemo<BoardExtensions>(
    () => ({
      ...generationExtensions,
      renderMotionBody,
      nodeActions,
      resolveDesignCover,
      createDesignDocument,
      openDesignDocument,
      createMotion,
      openMotionStudio,
      openMaterialsPicker,
      acceptsExternalDrag,
      onExternalDrop,
    }),
    [
      generationExtensions,
      renderMotionBody,
      nodeActions,
      resolveDesignCover,
      createDesignDocument,
      openDesignDocument,
      createMotion,
      openMotionStudio,
      openMaterialsPicker,
      acceptsExternalDrag,
      onExternalDrop,
    ],
  );
}
