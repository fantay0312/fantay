// SPDX-License-Identifier: Apache-2.0
/** SVG (Penpot, Figma, Illustrator exports) → a new design with the SVG as editable layers (06 §8.4). */
import { DesignBridgeFailure } from '@open-design/contracts/runtime/design-editor-bridge';

import { createSVGNodes, SceneGraph } from '../engine/op';

export function svgToSceneGraph(svg: string, name: string): SceneGraph {
  const graph = new SceneGraph();
  const page = graph.getPages()[0];
  if (!page) throw new DesignBridgeFailure('INTERNAL', 'A new document has no page');
  const node = createSVGNodes(graph, page.id, svg, { name });
  if (!node) throw new DesignBridgeFailure('PARSE_FAILED', 'The SVG has no drawable layers');
  return graph;
}
