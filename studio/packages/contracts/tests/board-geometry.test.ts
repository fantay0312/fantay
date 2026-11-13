import { describe, expect, it } from 'vitest';

import { BOARD_NODE_KINDS, type BoardEdgeKind, type BoardNodeKind } from '../src/api/board.js';
import {
  BOARD_OUTPUT_TARGET_KINDS,
  BOARD_REFERENCE_SOURCE_KINDS,
  boardNodeRect,
  boardNodesBounds,
  canGroupNodes,
  canUngroupNodes,
  containsCenter,
  descendantIds,
  edgeEndpointError,
  findContainingGroupId,
  findGroupDropTarget,
  groupDepth,
  groupWrapRect,
  rectsOverlap,
  snapNodesIntoGroup,
  topLevelAncestorId,
  type BoardGeometryNode,
} from '../src/board/index.js';

function node(id: string, kind: BoardNodeKind, x: number, y: number, w: number, h: number, parentId?: string): BoardGeometryNode {
  return { id, kind, x, y, w, h, ...(parentId ? { parentId } : {}) };
}

function index(nodes: BoardGeometryNode[]): Map<string, BoardGeometryNode> {
  return new Map(nodes.map((entry) => [entry.id, entry]));
}

describe('rect helpers', () => {
  it('bounds, overlap and centre containment', () => {
    expect(boardNodesBounds([])).toBeNull();
    expect(boardNodesBounds([{ x: 10, y: 20, w: 30, h: 40 }, { x: -5, y: 50, w: 10, h: 10 }])).toEqual({ x: -5, y: 20, w: 45, h: 40 });
    expect(boardNodeRect(node('aaa', 'note', 1, 2, 3, 4))).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    const a = { x: 0, y: 0, w: 100, h: 100 };
    expect(rectsOverlap(a, { x: 100, y: 0, w: 50, h: 50 })).toBe(false);
    expect(rectsOverlap(a, { x: 100, y: 0, w: 50, h: 50 }, 1)).toBe(true);
    expect(rectsOverlap(a, { x: 99, y: 99, w: 50, h: 50 })).toBe(true);
    expect(containsCenter(a, { x: 90, y: 90, w: 20, h: 20 })).toBe(true);
    expect(containsCenter(a, { x: 91, y: 0, w: 20, h: 20 })).toBe(false);
  });
});

describe('findGroupDropTarget (infinite-canvas port)', () => {
  const group = node('gr1', 'group', 0, 0, 500, 500);
  const moving = node('nt1', 'note', 100, 100, 50, 50);

  it('returns the group under a dragged node centre', () => {
    expect(findGroupDropTarget(['nt1'], [group, moving])).toBe(group);
    expect(findGroupDropTarget(new Set(['nt1']), [group, moving])).toBe(group);
    expect(findGroupDropTarget(['nt1'], [group, node('nt1', 'note', 600, 600, 50, 50)])).toBeNull();
    expect(findGroupDropTarget([], [group, moving])).toBeNull();
  });

  it('never drops a group into a group', () => {
    expect(findGroupDropTarget(['nt1', 'gr2'], [group, moving, node('gr2', 'group', 10, 10, 50, 50)])).toBeNull();
  });

  it('prefers the deepest containing group, then the topmost', () => {
    const outer = node('out', 'group', 0, 0, 1000, 1000);
    const inner = node('inn', 'group', 100, 100, 400, 400, 'out');
    const dragged = node('nt1', 'note', 180, 180, 40, 40);
    expect(findGroupDropTarget(['nt1'], [outer, inner, dragged])?.id).toBe('inn');
    expect(findGroupDropTarget(['nt1'], [inner, outer, dragged])?.id).toBe('inn');
    const twin = node('twn', 'group', 0, 0, 500, 500);
    expect(findGroupDropTarget(['nt1'], [group, twin, moving])?.id).toBe('twn');
  });
});

describe('findContainingGroupId', () => {
  it('excludes the node itself and its descendants', () => {
    const outer = node('out', 'group', 0, 0, 1000, 1000);
    const inner = node('inn', 'group', 100, 100, 400, 400, 'out');
    const kid = node('kid', 'group', 150, 150, 300, 300, 'inn');
    expect(findContainingGroupId(node('nt1', 'note', 180, 180, 40, 40), [outer, inner, kid])).toBe('kid');
    expect(findContainingGroupId(inner, [outer, inner, kid])).toBe('out');
    expect(findContainingGroupId(node('nt1', 'note', 5000, 0, 1, 1), [outer])).toBeNull();
  });
});

describe('group wrapping and snapping', () => {
  it('groupWrapRect pads 24 px on three sides and 52 px on top', () => {
    expect(groupWrapRect([{ x: 0, y: 0, w: 400, h: 300 }, { x: 500, y: 0, w: 400, h: 300 }])).toEqual({ x: -24, y: -52, w: 948, h: 376 });
    expect(groupWrapRect([])).toEqual({ x: 0, y: 0, w: 48, h: 76 });
  });

  it('snapNodesIntoGroup shifts moved nodes inside the 24 px inset and parents them', () => {
    const group = node('gr1', 'group', 0, 0, 500, 400);
    const overflow = node('nt1', 'note', 480, 380, 100, 100);
    const other = node('nt2', 'note', 2000, 0, 10, 10);
    const result = snapNodesIntoGroup(['nt1', 'gr1'], [group, overflow, other], group);
    expect(result[0]).toBe(group);
    expect(result[1]).toEqual({ ...overflow, x: 376, y: 276, parentId: 'gr1' });
    expect(result[2]).toBe(other);
    const tooBig = node('nt3', 'note', -50, -50, 600, 600);
    expect(snapNodesIntoGroup(['nt3'], [tooBig], group)[0]).toMatchObject({ x: 24, y: 24, parentId: 'gr1' });
    expect(snapNodesIntoGroup(['zzz'], [other], group)).toEqual([other]);
  });
});

describe('group / ungroup predicates and tree helpers', () => {
  const top = node('top', 'group', 0, 0, 2000, 2000);
  const nested = node('nst', 'group', 100, 100, 1000, 1000, 'top');
  const a = node('aaa', 'note', 200, 200, 10, 10, 'nst');
  const b = node('bbb', 'note', 300, 300, 10, 10, 'nst');
  const c = node('ccc', 'note', 1500, 1500, 10, 10, 'top');
  const d = node('ddd', 'note', 5000, 0, 10, 10);
  const e = node('eee', 'note', 6000, 0, 10, 10);
  const lone = node('lon', 'group', 7000, 0, 100, 100);
  const nodes = [top, nested, a, b, c, d, e, lone];

  it('canGroupNodes needs ≥ 2 siblings and must keep group depth ≤ 2', () => {
    expect(canGroupNodes(['ddd', 'eee'], nodes)).toBe(true);
    expect(canGroupNodes(['ddd'], nodes)).toBe(false);
    expect(canGroupNodes(['ddd', 'ccc'], nodes)).toBe(false);
    expect(canGroupNodes(['ccc', 'nst'], nodes)).toBe(false);
    expect(canGroupNodes(['aaa', 'bbb'], nodes)).toBe(false);
    expect(canGroupNodes(['top', 'ddd'], nodes)).toBe(false);
    expect(canGroupNodes(['lon', 'ddd'], nodes)).toBe(true);
    expect(canGroupNodes(['ccc', 'zzz'], [...nodes, node('zzz', 'note', 0, 0, 10, 10, 'top')])).toBe(true);
  });

  it('canUngroupNodes applies to groups and grouped nodes', () => {
    expect(canUngroupNodes(['top'], nodes)).toBe(true);
    expect(canUngroupNodes(['aaa'], nodes)).toBe(true);
    expect(canUngroupNodes(['ddd'], nodes)).toBe(false);
  });

  it('groupDepth counts ancestors plus the group itself', () => {
    const byId = index(nodes);
    expect(groupDepth('top', byId)).toBe(1);
    expect(groupDepth('nst', byId)).toBe(2);
    expect(groupDepth('aaa', byId)).toBe(2);
    expect(groupDepth('ccc', byId)).toBe(1);
    expect(groupDepth('ddd', byId)).toBe(0);
    expect(groupDepth('nope', byId)).toBe(0);
  });

  it('descendantIds and topLevelAncestorId (cycle-safe)', () => {
    expect(descendantIds('top', nodes)).toEqual(['nst', 'aaa', 'bbb', 'ccc']);
    expect(descendantIds('ddd', nodes)).toEqual([]);
    expect(topLevelAncestorId('aaa', index(nodes))).toBe('top');
    expect(topLevelAncestorId('ddd', index(nodes))).toBe('ddd');
    const loop = [node('lp1', 'group', 0, 0, 1, 1, 'lp2'), node('lp2', 'group', 0, 0, 1, 1, 'lp1')];
    expect(['lp1', 'lp2']).toContain(topLevelAncestorId('lp1', index(loop)));
    expect(descendantIds('lp1', loop)).toEqual(['lp2']);
  });
});

describe('edgeEndpointError (plan R3e)', () => {
  const of = (kind: BoardNodeKind, id = `${kind}-1`) => ({ id, kind });

  it('reference: image|note|frame|web|design → generator', () => {
    expect([...BOARD_REFERENCE_SOURCE_KINDS]).toEqual(['image', 'note', 'frame', 'web', 'design']);
    for (const kind of BOARD_NODE_KINDS) {
      const expected = kind === 'group'
        ? 'group-endpoint'
        : (BOARD_REFERENCE_SOURCE_KINDS as readonly string[]).includes(kind) ? null : 'reference-source-invalid';
      expect(edgeEndpointError('reference', of(kind, 'src'), of('generator', 'dst')), kind).toBe(expected);
    }
    expect(edgeEndpointError('reference', of('image'), of('frame'))).toBe('reference-target-not-generator');
  });

  it('output: generator → image|video|audio', () => {
    expect([...BOARD_OUTPUT_TARGET_KINDS]).toEqual(['image', 'video', 'audio']);
    for (const kind of BOARD_NODE_KINDS) {
      const expected = kind === 'group'
        ? 'group-endpoint'
        : (BOARD_OUTPUT_TARGET_KINDS as readonly string[]).includes(kind) ? null : 'output-target-not-media';
      expect(edgeEndpointError('output', of('generator', 'src'), of(kind, 'dst')), kind).toBe(expected);
    }
    expect(edgeEndpointError('output', of('image'), of('video'))).toBe('output-source-not-generator');
  });

  it('lineage: any non-group → any non-group; never self loops', () => {
    const kinds: BoardEdgeKind[] = ['reference', 'output', 'lineage'];
    for (const from of BOARD_NODE_KINDS) {
      for (const to of BOARD_NODE_KINDS) {
        const expected = from === 'group' || to === 'group' ? 'group-endpoint' : null;
        expect(edgeEndpointError('lineage', of(from, 'aaa'), of(to, 'bbb'))).toBe(expected);
      }
    }
    for (const kind of kinds) expect(edgeEndpointError(kind, of('note', 'same'), of('generator', 'same'))).toBe('self-loop');
  });
});
