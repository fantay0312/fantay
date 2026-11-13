// SPDX-License-Identifier: AGPL-3.0-only
// Creates generator nodes through the generation board port: the `BoardExtensions.createGenerator`
// contract (G tool, "+" insert menu, connection-create menu; plan §3.2) and "use as reference"
// (spec 05 §6.5). Phase-1 surfaces are image | video (amendment C8: no audio generator).
import {
  GENERATION_LIMITS,
  GENERATOR_DEFAULT_SIZE,
  canConnectToGenerator,
  createGeneratorForSelection,
  createGeneratorNodeInput,
  findFreePlacement,
  type GenerationBoardOp,
  type GenerationSurface,
} from '@open-design/contracts';

import type { GenerationBoardPort } from '../board-adapter';
import { requestGeneratorPanelFocus } from './generator-ui-store';

export interface CreateGeneratorInput {
  selectedIds: string[];
  /** World point: the centre of the new generator (stage centre, drop point). */
  at: { x: number; y: number };
  surface?: 'image' | 'video';
  /** Connection-create menu: the node the connector was dragged from. */
  connectFrom?: string;
}

/**
 * Adds a generator and its reference edges in one undoable, flushed batch, selects it and asks its
 * panel to focus the prompt. With `connectFrom` the generator sits at `at` and references that node
 * (when it is a valid reference source); with a selection it is placed right of the selection
 * bbox and references the eligible selected nodes (contracts `createGeneratorForSelection`);
 * otherwise it is centred on `at`, moved down until free. Returns the generator id.
 */
export function createGeneratorOnBoard(
  board: GenerationBoardPort,
  input: CreateGeneratorInput,
  ids: { next(): string },
): string | null {
  const surface: GenerationSurface = input.surface === 'video' ? 'video' : 'image';
  const graph = board.getGraph();
  let ops: GenerationBoardOp[];
  let generatorId: string;
  const source = input.connectFrom ? graph.nodes.find((node) => node.id === input.connectFrom) : undefined;
  if (!source && input.selectedIds.length > 0) {
    const planned = createGeneratorForSelection(graph, input.selectedIds, ids, surface);
    ops = planned.ops;
    generatorId = planned.generatorId;
  } else {
    generatorId = ids.next();
    const node = createGeneratorNodeInput({ id: generatorId, x: 0, y: 0, surface });
    const at = findFreePlacement(graph, {
      x: Math.round(input.at.x - node.w / 2),
      y: Math.round(input.at.y - node.h / 2),
      w: node.w,
      h: node.h,
    });
    ops = [{ type: 'node.add', node: { ...node, x: at.x, y: at.y } }];
    if (source && canConnectToGenerator(source, graph)) {
      ops.push({ type: 'edge.add', edge: { id: ids.next(), from: source.id, to: generatorId, role: 'reference' } });
    }
  }
  board.apply(ops, { label: 'generation.generator.create', undoable: true, flush: true });
  board.select([generatorId]);
  requestGeneratorPanelFocus(generatorId, 'prompt');
  return generatorId;
}

/** Where a generator created for `node` goes: right of it (`outputGapX`), moved down until free. */
export function generatorPlacementRightOf(
  board: GenerationBoardPort,
  node: { x: number; y: number; w: number },
): { x: number; y: number } {
  return findFreePlacement(board.getGraph(), {
    x: node.x + node.w + GENERATION_LIMITS.outputGapX,
    y: node.y,
    w: GENERATOR_DEFAULT_SIZE.w,
    h: GENERATOR_DEFAULT_SIZE.h,
  });
}
