// SPDX-License-Identifier: AGPL-3.0-only
// What an image/video node shows (spec 05 §6.1/§6.2): the primary candidate of a generated node
// (`primaryCandidateId` → first done → first), else the node's file. Pure helpers shared by the node
// bodies, the candidate fan, the preview dialog and the tool dialogs.
import { useMemo } from 'react';
import type { BoardMediaFile, GenerationCandidate, GenerationGraphNode, MediaNodeGeneration } from '@open-design/contracts';

import { useBoardGraph } from '../generation/hooks';

export function primaryCandidateOf(generation: MediaNodeGeneration | undefined): GenerationCandidate | undefined {
  if (!generation || generation.candidates.length === 0) return undefined;
  const byId = generation.primaryCandidateId
    ? generation.candidates.find((candidate) => candidate.id === generation.primaryCandidateId)
    : undefined;
  return byId ?? generation.candidates.find((candidate) => candidate.status === 'done') ?? generation.candidates[0];
}

/** The file to display for a node (the primary candidate's file when it is done, else the node file). */
export function displayFileOf(node: GenerationGraphNode | null | undefined): BoardMediaFile | null {
  if (!node) return null;
  const generation = node.media?.generation;
  if (generation && generation.candidates.length > 0) {
    const primary = primaryCandidateOf(generation);
    if (primary?.status === 'done') return primary.file ?? node.media?.file ?? null;
    return null;
  }
  return node.media?.file ?? null;
}

/** The candidates other than the primary, in their stored order (the fan-out cards). */
export function secondaryCandidatesOf(generation: MediaNodeGeneration | undefined): GenerationCandidate[] {
  if (!generation) return [];
  const primary = primaryCandidateOf(generation);
  return generation.candidates.filter((candidate) => candidate !== primary);
}

/** `m:ss` for an elapsed duration in ms (never negative). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** The generation graph node with this id (graph node objects keep their identity while unchanged). */
export function useGenerationNode(nodeId: string): GenerationGraphNode | null {
  const graph = useBoardGraph();
  return useMemo(() => graph.nodes.find((node) => node.id === nodeId) ?? null, [graph, nodeId]);
}

/** Overlay controls keep a readable screen size: 1/zoom, clamped. */
export function overlayScaleFor(zoom: number): number {
  const safe = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.min(2.5, Math.max(0.75, 1 / safe));
}

/** Below this zoom, node overlays (pills, badges, hover actions) are hidden (level of detail). */
export const OVERLAY_MIN_ZOOM = 0.3;
