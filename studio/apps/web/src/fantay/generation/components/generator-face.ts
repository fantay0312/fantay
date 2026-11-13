// SPDX-License-Identifier: AGPL-3.0-only
// What a generator's face shows, read as one small value instead of the full `useGeneratorView`: a board can hold many
// generators and only the selected one needs the compiled prompt and model catalog. The store selector returns a
// string, so a face re-renders only when its own state changes, not on every board edit.
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { generatorRunState, type GenerationGraph, type GenerationSurface } from '@open-design/contracts';

import { useGeneration } from '../hooks';
import { mediaCacheKey } from '../../media-tools/media-url';

/** Results shown in the face: the mosaic stops at a 2 × 2 grid. */
const MAX_FACE_OUTPUTS = 4;

export type GeneratorFaceStatus = 'idle' | 'running' | 'failed' | 'done';

export interface GeneratorFaceOutput {
  id: string;
  path: string;
  cacheKey: string;
  video: boolean;
}

export interface GeneratorFace {
  surface: GenerationSurface;
  status: GeneratorFaceStatus;
  outputs: GeneratorFaceOutput[];
}

function readFace(graph: GenerationGraph, generatorId: string): GeneratorFace {
  const generator = graph.nodes.find((node) => node.id === generatorId && node.kind === 'generator')?.generator;
  const surface = generator?.surface ?? 'image';
  if (!generator) return { surface, status: 'idle', outputs: [] };
  const runState = generatorRunState(graph, generatorId);
  const failed = runState.counts.failed + runState.counts.interrupted + runState.counts.lost;
  const status: GeneratorFaceStatus = runState.active
    ? 'running'
    : runState.total > 0 && failed > 0
      ? 'failed'
      : runState.total > 0 && runState.counts.done === runState.total
        ? 'done'
        : 'idle';
  const run = generator.runs[0];
  const output = run ? graph.nodes.find((node) => node.id === run.outputNodeId) : undefined;
  const outputs = (output?.media?.generation?.candidates ?? [])
    .filter((candidate) => candidate.runId === run?.runId && candidate.status === 'done' && candidate.file)
    .sort((a, b) => a.index - b.index)
    .slice(0, MAX_FACE_OUTPUTS)
    .map((candidate) => ({
      id: candidate.id,
      path: candidate.file!.path,
      cacheKey: mediaCacheKey(candidate.file!),
      video: output?.kind === 'video',
    }));
  return { surface, status, outputs };
}

export function useGeneratorFace(generatorId: string): GeneratorFace {
  const { board } = useGeneration();
  const read = useCallback(() => JSON.stringify(readFace(board.getGraph(), generatorId)), [board, generatorId]);
  const serialized = useSyncExternalStore(board.subscribe, read, read);
  return useMemo(() => JSON.parse(serialized) as GeneratorFace, [serialized]);
}
