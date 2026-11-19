// SPDX-License-Identifier: AGPL-3.0-only
// The name of each kind of diagram pele can tell apart, for the bar ("流程图 · 1.2 KB") and the
// stage's accessible name. The kind always comes from pele's own detection, never from a guess of
// ours; a kind added in a later pele release reads as the quiet "图表" until it is named here.
import type { Dict } from '../../../../i18n/types';

const KIND_KEYS: Readonly<Record<string, keyof Dict>> = {
  flowchart: 'artifact.diagram.kind.flowchart',
  sequence: 'artifact.diagram.kind.sequence',
  class: 'artifact.diagram.kind.class',
  state: 'artifact.diagram.kind.state',
  er: 'artifact.diagram.kind.er',
  pie: 'artifact.diagram.kind.pie',
  gantt: 'artifact.diagram.kind.gantt',
  gitGraph: 'artifact.diagram.kind.gitGraph',
  mindmap: 'artifact.diagram.kind.mindmap',
  timeline: 'artifact.diagram.kind.timeline',
  journey: 'artifact.diagram.kind.journey',
  xychart: 'artifact.diagram.kind.xychart',
  quadrantChart: 'artifact.diagram.kind.quadrantChart',
  requirement: 'artifact.diagram.kind.requirement',
  c4: 'artifact.diagram.kind.c4',
  sankey: 'artifact.diagram.kind.sankey',
  block: 'artifact.diagram.kind.block',
  packet: 'artifact.diagram.kind.packet',
  kanban: 'artifact.diagram.kind.kanban',
  architecture: 'artifact.diagram.kind.architecture',
  radar: 'artifact.diagram.kind.radar',
  treemap: 'artifact.diagram.kind.treemap',
  info: 'artifact.diagram.kind.info',
  agentflow: 'artifact.diagram.kind.agentflow',
  usecase: 'artifact.diagram.kind.usecase',
  railroad: 'artifact.diagram.kind.railroad',
  treeView: 'artifact.diagram.kind.treeView',
  venn: 'artifact.diagram.kind.venn',
  cynefin: 'artifact.diagram.kind.cynefin',
  wardley: 'artifact.diagram.kind.wardley',
  swimlane: 'artifact.diagram.kind.swimlane',
  ishikawa: 'artifact.diagram.kind.ishikawa',
  eventmodeling: 'artifact.diagram.kind.eventmodeling',
};

/** The dictionary key naming a kind detected by pele (`DiagramType`); unknown kinds get "图表". */
export function diagramKindKey(type: string | null | undefined): keyof Dict {
  return (type && Object.prototype.hasOwnProperty.call(KIND_KEYS, type) ? KIND_KEYS[type] : undefined) ?? 'artifact.diagram.kind.other';
}

/** Every kind with a name, for tests. */
export const NAMED_DIAGRAM_KINDS: readonly string[] = Object.keys(KIND_KEYS);
