// SPDX-License-Identifier: AGPL-3.0-only
// The generation part of `BoardExtensions` (plan §3.2, R4): node bodies for `generator` / `image` /
// `video`, the generator panel, the image/video ContextBar actions (incl. amendment C5 "剪辑视频") and
// `createGenerator` for the G tool, the insert menu and the connection-create menu. W3-board-assembly
// spreads `useGenerationBoardExtensions()` into the extensions object it builds under
// `GenerationProvider` and merges the design (C9) node actions for `design` nodes.
import { useMemo } from 'react';

import type { BoardExtensions, BoardNodeBodyProps } from '../board/extensions';
import { useGeneration } from '../generation/hooks';
import { createGeneratorOnBoard } from '../generation/components/create-generator';
import { GeneratorNodeBody } from '../generation/components/GeneratorNodeBody';
import { GeneratorPanel } from '../generation/components/GeneratorPanel';
import { createIdSource } from '../media-tools/ids';
import { ImageNodeBody } from './ImageNodeBody';
import { useMediaNodeActions, type MediaToolContextExtras } from './node-actions';
import { VideoNodeBody } from './VideoNodeBody';

export function renderGeneratorBody(props: BoardNodeBodyProps) {
  return <GeneratorNodeBody nodeId={props.nodeId} selected={props.selected} zoom={props.zoom} width={props.width} height={props.height} />;
}

export function renderGeneratorPanel(props: { nodeId: string; onClose(): void }) {
  // Keyed by node: switching the selected generator starts a fresh prompt draft (the old one is flushed).
  return <GeneratorPanel key={props.nodeId} nodeId={props.nodeId} onClose={props.onClose} />;
}

export function renderImageBody(props: BoardNodeBodyProps) {
  return <ImageNodeBody nodeId={props.nodeId} selected={props.selected} zoom={props.zoom} width={props.width} height={props.height} />;
}

export function renderVideoBody(props: BoardNodeBodyProps) {
  return (
    <VideoNodeBody
      nodeId={props.nodeId}
      selected={props.selected}
      zoom={props.zoom}
      width={props.width}
      height={props.height}
      live={props.live}
      requestLive={props.requestLive}
    />
  );
}

export type GenerationBoardExtensions = Required<
  Pick<BoardExtensions, 'renderGeneratorBody' | 'renderGeneratorPanel' | 'renderImageBody' | 'renderVideoBody' | 'nodeActions' | 'createGenerator'>
>;

/** Stateless render functions (no hooks): usable outside the provider when actions are not needed. */
export const GENERATION_BODY_EXTENSIONS = Object.freeze({
  renderGeneratorBody,
  renderGeneratorPanel,
  renderImageBody,
  renderVideoBody,
}) satisfies Pick<BoardExtensions, 'renderGeneratorBody' | 'renderGeneratorPanel' | 'renderImageBody' | 'renderVideoBody'>;

/**
 * The generation extensions, stable across renders. Must be called under `GenerationProvider`.
 * `nodeActions` returns [] for `design` nodes.
 */
export function useGenerationBoardExtensions(extras: MediaToolContextExtras = {}): GenerationBoardExtensions {
  const { board } = useGeneration();
  const nodeActions = useMediaNodeActions(extras);
  return useMemo<GenerationBoardExtensions>(() => {
    const ids = extras.ids ?? createIdSource();
    return {
      ...GENERATION_BODY_EXTENSIONS,
      nodeActions,
      createGenerator: (input) =>
        createGeneratorOnBoard(
          board,
          {
            selectedIds: input.selectedIds,
            at: input.at,
            ...(input.surface ? { surface: input.surface } : {}),
            ...(input.connectFrom ? { connectFrom: input.connectFrom } : {}),
          },
          ids,
        ),
    };
    // `extras.ids` is a test seam; the board port and the actions callback are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, nodeActions]);
}
