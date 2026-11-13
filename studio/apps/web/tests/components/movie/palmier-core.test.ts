import { expect, it } from 'vitest';
import { collectTargets, findSnap, formatTimecode, parseTimecode, type SnapState } from '../../../src/components/movie/palmier/palmier-core';

it('holds an acquired edge until 1.5 times its capture distance and drops removed targets', () => {
  const state: SnapState = { currentProbeOffset: 0 }, targets = [{ frame: 100, kind: 'clipEdge' as const }];
  expect(findSnap(108, [0], targets, state, 8, 1)?.frame).toBe(100);
  expect(findSnap(112, [0], targets, state, 8, 1)?.frame).toBe(100);
  expect(findSnap(113, [0], targets, state, 8, 1)).toBeNull();
  findSnap(100, [0], targets, state, 8, 1);
  expect(findSnap(100, [0], [], state, 8, 1)).toBeNull();
  expect(state.currentlySnappedTo).toBeUndefined();
});
it('retains the source playhead priority, probe offset and excluded-clip behavior', () => {
  const targets = collectTargets([{ clips: [{ id: 'moving', startFrame: 5, endFrame: 15 }, { id: 'other', startFrame: 30, endFrame: 40 }] }], 10, new Set(['moving']), true);
  expect(targets).toEqual([{ frame: 10, kind: 'playhead' }, { frame: 30, kind: 'clipEdge' }, { frame: 40, kind: 'clipEdge' }]);
  expect(findSnap(0, [0], targets, { currentProbeOffset: 0 }, 8, 1)?.frame).toBe(10);
  expect(findSnap(20, [10], targets, { currentProbeOffset: 0 }, 8, 1)).toEqual({ frame: 30, probeOffset: 10, x: 30 });
  expect(findSnap(11, [0], [{ frame: 10, kind: 'playhead' }, { frame: 12, kind: 'clipEdge' }], { currentProbeOffset: 0 }, 8, 1)?.frame).toBe(10);
});
it('formats and parses frame timecodes with source bounds', () => {
  expect(formatTimecode(172, 30)).toBe('00:00:05:22');
  expect(formatTimecode(-172, 30)).toBe('-00:00:05:22');
  expect(parseTimecode('00:00:05:22', 30)).toBe(172);
  expect(parseTimecode('00:00:05:30', 30)).toBeNull();
  expect(parseTimecode('00:60:00:00', 30)).toBeNull();
  expect(parseTimecode('-00:00:05:22', 30)).toBeNull();
});
