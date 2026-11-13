// SPDX-License-Identifier: AGPL-3.0-only
// Image/video node actions for the board's ContextBar (plan R4: 05's tool table renders through
// `BoardExtensions.nodeActions`; no separate MediaNodeToolbar). W3-board-assembly plugs
// `useMediaNodeActions()` (or `buildMediaNodeActions`) into the extensions object; `design` nodes get
// their actions from the design host (C9), so this builder returns none for them.
import { useCallback, useRef } from 'react';
import type { GenerationGraph, GenerationGraphNode } from '@open-design/contracts';

import { useT } from '../../i18n';
import type { BoardNodeAction } from '../board/extensions';
import { revealProjectChat } from '../chat/project-chat-bridge';
import { useGeneration } from '../generation/hooks';
import { getMediaNodeTools, type MediaToolContext } from './node-tools';

export type GenerationApi = ReturnType<typeof useGeneration>;

export interface MediaToolContextExtras {
  /** Reveal the chat column after "send to chat" (default: the project chat bridge). */
  onRevealChat?: (() => void) | undefined;
  ids?: MediaToolContext['ids'];
  now?: MediaToolContext['now'];
  upload?: MediaToolContext['upload'];
}

/** The tool context of one node, built from the generation provider's value. */
export function createMediaToolContext(
  generation: GenerationApi,
  node: GenerationGraphNode,
  graph: GenerationGraph,
  t: MediaToolContext['t'],
  extras: MediaToolContextExtras = {},
): MediaToolContext {
  const projectId = generation.projectId;
  const providerReveal = generation.onRevealChat;
  return {
    node,
    graph,
    projectId,
    workspaceContext: generation.workspaceContext,
    service: generation.service,
    board: generation.board,
    t,
    notify: generation.notify,
    openToolDialog: generation.openToolDialog,
    videoElement: node.kind === 'video' ? generation.videoElementOf(node.id) : null,
    lastActiveGeneratorId: generation.lastActiveGeneratorId,
    onRevealChat: extras.onRevealChat ?? providerReveal ?? (() => void revealProjectChat(projectId)),
    ids: extras.ids,
    now: extras.now,
    upload: extras.upload,
  };
}

export interface MediaNodeActionsDeps extends MediaToolContextExtras {
  generation: GenerationApi;
  t: MediaToolContext['t'];
}

/**
 * `BoardNodeAction[]` for an image or video node, in tool-table order (bar, then more). Disabled tools
 * carry their reason key; "more like this" is left out where it can never apply (no recorded request,
 * or the node already holds the maximum of candidates). Each `run` re-reads the node and re-checks the
 * tool, so a stale ContextBar cannot run it on changed data.
 */
export function buildMediaNodeActions(
  deps: MediaNodeActionsDeps,
  nodeId: string,
  kind: 'image' | 'video' | 'design',
): BoardNodeAction[] {
  if (kind === 'design') return [];
  const contextFor = (): MediaToolContext | null => {
    const graph = deps.generation.board.getGraph();
    const node = graph.nodes.find((entry) => entry.id === nodeId);
    if (!node || (node.kind !== 'image' && node.kind !== 'video')) return null;
    return createMediaToolContext(deps.generation, node, graph, deps.t, deps);
  };
  const ctx = contextFor();
  if (!ctx) return [];
  return getMediaNodeTools(kind).flatMap((tool): BoardNodeAction[] => {
    const availability = tool.enabled(ctx);
    if (tool.id === 'more-like-this' && !availability.enabled) return [];
    const action: BoardNodeAction = {
      id: tool.id,
      labelKey: tool.labelKey,
      icon: tool.icon,
      placement: tool.placement,
      run: async () => {
        const fresh = contextFor();
        if (!fresh || !tool.enabled(fresh).enabled) return;
        try {
          await tool.run(fresh);
        } catch {
          fresh.notify({ tone: 'error', message: fresh.t('fantay.media.toolFailed') });
        }
      },
    };
    if (!availability.enabled) action.disabledReasonKey = availability.reasonKey;
    return [action];
  });
}

/**
 * Hook form for the board assembly: a stable `(nodeId, kind) => BoardNodeAction[]` that always reads the
 * latest provider value. Must be called under `GenerationProvider`.
 */
export function useMediaNodeActions(
  extras: MediaToolContextExtras = {},
): (nodeId: string, kind: 'image' | 'video' | 'design') => BoardNodeAction[] {
  const generation = useGeneration();
  const t = useT();
  const latest = useRef<MediaNodeActionsDeps>({ ...extras, generation, t });
  latest.current = { ...extras, generation, t };
  return useCallback((nodeId, kind) => buildMediaNodeActions(latest.current, nodeId, kind), []);
}
