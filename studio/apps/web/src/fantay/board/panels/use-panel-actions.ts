// SPDX-License-Identifier: AGPL-3.0-only
// What a panel item can do on the canvas: place it, or feed it to the selected generator. Dropping a panel item uses
// the same functions (`placePanelDrop`).
import { useCallback, useMemo } from 'react';
import { isSafeBoardUrl, type WorkspaceCollabContext } from '@open-design/contracts';

import { useT } from '../../../i18n';
import { applyUserAsset } from '../../../providers/user-assets';
import { toast } from '../../ui/toast';
import type { BoardCommands } from '../commands/board-commands';
import { useBoardEngine, useBoardHost, useBoardSelector } from '../context';
import type { Point } from '../model/types';
import type { PanelDragPayload } from './panel-drag';

/** Copies an asset into the project and places its files; resolves the node ids. */
export async function placeUserAsset(
  commands: BoardCommands,
  input: { id: string; projectId: string; workspaceContext: WorkspaceCollabContext | null; at?: Point; refresh?: () => void },
): Promise<string[]> {
  const applied = await applyUserAsset(input.id, { projectId: input.projectId }, input.workspaceContext);
  input.refresh?.();
  return commands.ensureFileNodes(applied.paths, { ...(input.at ? { near: input.at } : {}), select: true, reveal: !input.at });
}

export function placePanelDrop(
  commands: BoardCommands,
  payload: PanelDragPayload,
  at: Point,
  context: { projectId: string; workspaceContext: WorkspaceCollabContext | null; refresh?: () => void; onError(detail: string): void },
): void {
  if (payload.kind === 'file') commands.ensureFileNodes([payload.path], { near: at, select: true, reveal: false });
  else if (payload.kind === 'link' && isSafeBoardUrl(payload.url)) commands.ensureWebNode(payload.url, { near: at });
  else if (payload.kind === 'asset') {
    void placeUserAsset(commands, { ...context, id: payload.id, at }).catch((error: unknown) => {
      context.onError(error instanceof Error ? error.message : String(error));
    });
  }
}

export interface PanelActions {
  /** The single selected generator: items offer 用作生成参考 while there is one. */
  generatorId: string | null;
  placeFile(path: string): string[];
  placeLink(url: string): string | null;
  placeAsset(id: string): Promise<string[]>;
  /** Puts the nodes on this page if needed and connects them to the selected generator. */
  connectToGenerator(ids: readonly string[]): void;
}

export function usePanelActions(): PanelActions {
  const engine = useBoardEngine();
  const { env } = useBoardHost();
  const t = useT();
  const { commands } = engine;
  const generatorId = useBoardSelector((state) => {
    const [id, second] = state.ui.selection;
    return id && !second && state.doc.nodes.get(id)?.kind === 'generator' ? id : null;
  });

  const placeAsset = useCallback(
    (id: string) => placeUserAsset(commands, {
      id,
      projectId: env.projectId,
      workspaceContext: env.workspaceContext,
      ...(env.onRefreshFiles ? { refresh: env.onRefreshFiles } : {}),
    }).catch((error: unknown) => {
      toast({ title: t('board.assets.failed', { detail: error instanceof Error ? error.message : String(error) }), tone: 'danger' });
      return [];
    }),
    [commands, env.projectId, env.workspaceContext, env.onRefreshFiles, t],
  );

  return useMemo<PanelActions>(() => ({
    generatorId,
    placeFile: (path) => commands.ensureFileNodes([path], { select: generatorId === null, reveal: generatorId === null }),
    placeLink: (url) => commands.ensureWebNode(url, {}),
    placeAsset,
    connectToGenerator(ids) {
      if (!generatorId) return;
      for (const id of ids) commands.connect(id, generatorId, 'reference');
      commands.select([generatorId]);
    },
  }), [commands, generatorId, placeAsset]);
}
