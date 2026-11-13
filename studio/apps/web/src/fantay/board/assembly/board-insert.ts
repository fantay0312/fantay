// SPDX-License-Identifier: AGPL-3.0-only
// Workspace bus `board.insert` subscriber, queued insert drainer and `focusRequest` handler (spec 07 §2.1(a),
// plan R8/R21). Translates `FantayNodeDraft` items into contract `BoardOp`s with deduplication by path or
// movie projectId, applies them in a single undoable batch, and selects/flies to the touched nodes.
import { useEffect, useRef, type RefObject } from 'react';
import {
  BOARD_DEFAULT_SIZES,
  defaultBoardNodeSize,
  designFormatForPath,
  deviceForFramePath,
  isSafeBoardUrl,
  stableBoardId,
  type BoardDocument,
  type BoardNode,
  type BoardNodeDraft,
  type BoardOp,
  type BoardPlacement,
  type ProjectPlatform,
} from '@open-design/contracts';

import { motionNodeSize } from '../../motion';
import type { FantayBoardFocusRequest } from '../../workspace/board-host-contract';
import {
  drainQueuedBoardInserts,
  subscribeWorkspaceCommand,
  type FantayNodeDraft,
  type WorkspaceCommandOf,
} from '../../workspace/workspace-bus';
import type { BoardCommands } from '../commands/board-commands';
import { createBoardEntityId } from '../data/client-id';
import type { BoardDataStore } from '../data/types';

export interface ApplyBoardInsertContext {
  store: Pick<BoardDataStore, 'getState' | 'apply'>;
  commands: Pick<BoardCommands, 'camera' | 'select' | 'focusNodes'> | null;
  isDeckProject?: boolean;
  projectPlatform?: ProjectPlatform;
}

const INSERT_STEP_OFFSET = 40;

function trimTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  return trimmed ? trimmed : undefined;
}

function viewportCenterWorld(commands: Pick<BoardCommands, 'camera'> | null, board: BoardDocument): { x: number; y: number } {
  if (commands) {
    const cam = commands.camera.get();
    const stage = commands.camera.stageSize();
    if (stage.w > 0 && stage.h > 0 && cam.zoom > 0) {
      return {
        x: Math.round((stage.w / 2 - cam.x) / cam.zoom),
        y: Math.round((stage.h / 2 - cam.y) / cam.zoom),
      };
    }
  }
  if (board.viewport) {
    return { x: Math.round(board.viewport.centerX), y: Math.round(board.viewport.centerY) };
  }
  return { x: 0, y: 0 };
}

function placementForDraft(
  command: WorkspaceCommandOf<'board.insert'>,
  index: number,
  center: { x: number; y: number },
  size: { w: number; h: number },
): BoardPlacement {
  const offset = index * INSERT_STEP_OFFSET;
  if (command.at) {
    return {
      mode: 'at',
      x: Math.round(command.at.x - size.w / 2 + offset),
      y: Math.round(command.at.y - size.h / 2 + offset),
    };
  }
  return {
    mode: 'viewport',
    centerX: Math.round(center.x + offset),
    centerY: Math.round(center.y + offset),
  };
}

function findExistingFileNode(
  nodes: readonly BoardNode[],
  kind: 'image' | 'video' | 'frame' | 'design',
  path: string,
): BoardNode | undefined {
  return nodes.find((node) => node.kind === kind && 'ref' in node && node.ref?.path === path);
}

function findExistingMotionNode(nodes: readonly BoardNode[], projectId: string): BoardNode | undefined {
  return nodes.find(
    (node) => node.kind === 'motion' && node.source.type === 'movie' && node.source.projectId === projectId,
  );
}

function mapDraftToOps(
  draft: FantayNodeDraft,
  index: number,
  command: WorkspaceCommandOf<'board.insert'>,
  board: BoardDocument,
  center: { x: number; y: number },
  ctx: ApplyBoardInsertContext,
  seenByKey: Map<string, string>,
): { nodeId: string | null; ops: BoardOp[] } {
  const title = trimTitle(draft.title);
  const projectKind = ctx.isDeckProject ? 'deck' : undefined;

  switch (draft.kind) {
    case 'image':
    case 'video':
    case 'frame': {
      const dedupeKey = `${draft.kind}:${draft.path}`;
      const seenId = seenByKey.get(dedupeKey);
      if (seenId) return { nodeId: seenId, ops: [] };
      const existing = findExistingFileNode(board.nodes, draft.kind, draft.path);
      if (existing) {
        seenByKey.set(dedupeKey, existing.id);
        const ops: BoardOp[] = [];
        if (draft.provenance && !existing.provenance) {
          ops.push({ op: 'update', id: existing.id, patch: { provenance: draft.provenance } });
        }
        return { nodeId: existing.id, ops };
      }
      const id = createBoardEntityId('n');
      seenByKey.set(dedupeKey, id);
      if (draft.kind === 'frame') {
        const device = deviceForFramePath(draft.path, ctx.projectPlatform ?? null, projectKind ?? null);
        const size = defaultBoardNodeSize('frame', { device, projectKind });
        const node: BoardNodeDraft = {
          id,
          kind: 'frame',
          w: size.w,
          h: size.h,
          ref: { path: draft.path },
          device: size.device ?? device,
          ...(title ? { title } : {}),
          ...(draft.provenance ? { provenance: draft.provenance } : {}),
        };
        return {
          nodeId: id,
          ops: [{ op: 'add', node, placement: placementForDraft(command, index, center, size) }],
        };
      }
      const size = defaultBoardNodeSize(draft.kind);
      const node: BoardNodeDraft = {
        id,
        kind: draft.kind,
        w: size.w,
        h: size.h,
        ref: { path: draft.path },
        ...(title ? { title } : {}),
        ...(draft.provenance ? { provenance: draft.provenance } : {}),
      };
      return {
        nodeId: id,
        ops: [{ op: 'add', node, placement: placementForDraft(command, index, center, size) }],
      };
    }
    case 'design': {
      const dedupeKey = `design:${draft.path}`;
      const seenId = seenByKey.get(dedupeKey);
      const existing = findExistingFileNode(board.nodes, 'design', draft.path);
      const targetId = seenId ?? existing?.id ?? createBoardEntityId('n');
      seenByKey.set(dedupeKey, targetId);
      const ops: BoardOp[] = [];
      if (!seenId && !existing) {
        const size = defaultBoardNodeSize('design');
        const format = designFormatForPath(draft.path) ?? 'fig';
        const node: BoardNodeDraft = {
          id: targetId,
          kind: 'design',
          w: size.w,
          h: size.h,
          ref: { path: draft.path },
          format,
          ...(title ? { title } : {}),
        };
        ops.push({ op: 'add', node, placement: placementForDraft(command, index, center, size) });
      }
      if (
        draft.sourceNodeId &&
        draft.sourceNodeId !== targetId &&
        board.nodes.some((n) => n.id === draft.sourceNodeId && n.kind !== 'group')
      ) {
        ops.push({
          op: 'connect',
          edge: { id: createBoardEntityId('e'), kind: 'lineage', from: draft.sourceNodeId, to: targetId },
          ifAbsent: true,
        });
      }
      return { nodeId: targetId, ops };
    }
    case 'motion': {
      const dedupeKey = `motion:${draft.projectId}`;
      const seenId = seenByKey.get(dedupeKey);
      if (seenId) return { nodeId: seenId, ops: [] };
      const existing = findExistingMotionNode(board.nodes, draft.projectId);
      if (existing) {
        seenByKey.set(dedupeKey, existing.id);
        return { nodeId: existing.id, ops: [] };
      }
      const id = stableBoardId('n', `movie:${draft.projectId}`);
      seenByKey.set(dedupeKey, id);
      const size = motionNodeSize('16:9');
      const node: BoardNodeDraft = {
        id,
        kind: 'motion',
        w: size.w,
        h: size.h,
        source: { type: 'movie', projectId: draft.projectId },
        aspect: '16:9',
        ...(title ? { title } : {}),
      };
      return {
        nodeId: id,
        ops: [{ op: 'add', node, placement: placementForDraft(command, index, center, size), ifAbsent: true }],
      };
    }
    case 'web': {
      if (!isSafeBoardUrl(draft.url)) return { nodeId: null, ops: [] };
      const dedupeKey = `web:${draft.url}`;
      const seenId = seenByKey.get(dedupeKey);
      if (seenId) return { nodeId: seenId, ops: [] };
      const existing = board.nodes.find((n) => n.kind === 'web' && n.url === draft.url);
      if (existing) {
        seenByKey.set(dedupeKey, existing.id);
        const ops: BoardOp[] = [];
        if (draft.provenance && !existing.provenance) {
          ops.push({ op: 'update', id: existing.id, patch: { provenance: draft.provenance } });
        }
        return { nodeId: existing.id, ops };
      }
      const id = createBoardEntityId('n');
      seenByKey.set(dedupeKey, id);
      const size = defaultBoardNodeSize('web', { device: 'desktop' });
      const node: BoardNodeDraft = {
        id,
        kind: 'web',
        w: size.w,
        h: size.h,
        url: draft.url,
        device: 'desktop',
        ...(title ? { title } : {}),
        ...(draft.provenance ? { provenance: draft.provenance } : {}),
      };
      return {
        nodeId: id,
        ops: [{ op: 'add', node, placement: placementForDraft(command, index, center, size) }],
      };
    }
    case 'note': {
      const id = createBoardEntityId('n');
      const size = BOARD_DEFAULT_SIZES.note;
      const node: BoardNodeDraft = {
        id,
        kind: 'note',
        w: size.w,
        h: size.h,
        text: draft.text,
        color: 'yellow',
        size: 'md',
        ...(title ? { title } : {}),
        ...(draft.provenance ? { provenance: draft.provenance } : {}),
      };
      return {
        nodeId: id,
        ops: [{ op: 'add', node, placement: placementForDraft(command, index, center, size) }],
      };
    }
  }
}

export function applyBoardInsertCommand(
  command: WorkspaceCommandOf<'board.insert'>,
  ctx: ApplyBoardInsertContext,
): string[] {
  const board = ctx.store.getState().board;
  if (!board || command.drafts.length === 0) return [];

  const center = viewportCenterWorld(ctx.commands, board);
  const seenByKey = new Map<string, string>();
  const ops: BoardOp[] = [];
  const touchedIds: string[] = [];

  command.drafts.forEach((draft, index) => {
    const mapped = mapDraftToOps(draft, index, command, board, center, ctx, seenByKey);
    if (mapped.ops.length > 0) ops.push(...mapped.ops);
    if (mapped.nodeId && !touchedIds.includes(mapped.nodeId)) touchedIds.push(mapped.nodeId);
  });

  if (ops.length > 0) {
    void ctx.store.apply(ops, { label: 'create' }).catch(() => undefined);
  }
  if (command.select !== false && touchedIds.length > 0) {
    ctx.commands?.select(touchedIds, { reveal: !command.at });
  }
  return touchedIds;
}

export interface UseBoardInsertBridgeOptions {
  projectId: string;
  boardReady: boolean;
  readOnly: boolean;
  store: BoardDataStore;
  commandsRef: RefObject<BoardCommands | null>;
  isDeckProject?: boolean;
  projectPlatform?: ProjectPlatform;
}

export function useBoardInsertBridge(options: UseBoardInsertBridgeOptions): void {
  const { projectId, boardReady, readOnly, store, commandsRef, isDeckProject, projectPlatform } = options;
  const latestRef = useRef({ projectId, boardReady, readOnly, store, commandsRef, isDeckProject, projectPlatform });
  latestRef.current = { projectId, boardReady, readOnly, store, commandsRef, isDeckProject, projectPlatform };

  useEffect(() => {
    if (!boardReady || readOnly) return undefined;

    const runCommand = (command: WorkspaceCommandOf<'board.insert'>): boolean => {
      const current = latestRef.current;
      if (command.projectId !== current.projectId || current.readOnly || !current.boardReady) return false;
      if (!current.store.getState().board) return false;
      applyBoardInsertCommand(command, {
        store: current.store,
        commands: current.commandsRef.current,
        isDeckProject: current.isDeckProject,
        projectPlatform: current.projectPlatform,
      });
      return true;
    };

    const queued = drainQueuedBoardInserts(projectId);
    for (const command of queued) {
      runCommand(command);
    }

    return subscribeWorkspaceCommand('board.insert', runCommand);
  }, [projectId, boardReady, readOnly, store]);
}

export function useBoardFocusRequest(options: {
  projectId: string;
  boardReady: boolean;
  focusRequest: FantayBoardFocusRequest | null;
  store: BoardDataStore;
  commandsRef: RefObject<BoardCommands | null>;
}): void {
  const { projectId, boardReady, focusRequest, store, commandsRef } = options;
  const handledNonceRef = useRef<number | null>(null);

  useEffect(() => {
    handledNonceRef.current = null;
  }, [projectId]);

  useEffect(() => {
    if (!focusRequest || !boardReady) return;
    if (handledNonceRef.current === focusRequest.nonce) return;
    const board = store.getState().board;
    if (!board) return;
    if (focusRequest.kind === 'motion') {
      const motionNode =
        board.nodes.find(
          (n) => n.kind === 'motion' && n.source.type === 'movie' && n.source.projectId === projectId,
        ) ?? board.nodes.find((n) => n.kind === 'motion');
      if (!motionNode) return;
      handledNonceRef.current = focusRequest.nonce;
      commandsRef.current?.select([motionNode.id]);
      commandsRef.current?.focusNodes([motionNode.id], { animate: true });
    }
  }, [projectId, boardReady, focusRequest, store, commandsRef]);
}
