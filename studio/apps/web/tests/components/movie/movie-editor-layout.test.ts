import { describe, expect, it } from 'vitest';
import { createMovieDocument, type MovieDocument, type MovieShot } from '@open-design/contracts';
import { MOVIE_MAX_EDIT_OPERATIONS, movieCutOperations, movieDuplicatePlacement, movieEditPoint, movieLockOperations, movieTargetShot } from '../../../src/components/movie/movie-editor-layout';

function clip(id: string, start: number, duration: number, track = 0, extra: Partial<MovieShot> = {}): MovieShot {
  return { id, title: id, body: '', layout: 'split', duration, placement: { start, track }, clip: { assetId: 'a', in: 0, rate: 1, volume: 1, fit: 'contain' }, ...extra };
}
function film(shots: MovieShot[]): MovieDocument {
  const d = createMovieDocument('Cuts');
  d.shots = shots;
  return d;
}

describe('movieCutOperations', () => {
  const d = film([clip('a', 0, 4), clip('b', 4, 3), clip('c', 7, 2), clip('t', 1, 2, 1, { kind: 'text', clip: undefined })]);
  const a = d.shots[0]!;

  it('splits without touching neighbours', () => {
    expect(movieCutOperations(d, a, 1.5, 'split', { magnet: true, newShotId: 'n' })).toEqual([{ op: 'split-clip', shotId: 'a', at: 1.5, newShotId: 'n' }]);
  });

  it('closes the gap on the main track with 主轨磁吸 for Q and keeps the clip start', () => {
    expect(movieCutOperations(d, a, 1, 'trim-before', { magnet: true })).toEqual([
      { op: 'trim-clip', shotId: 'a', start: 1, end: 4 },
      { op: 'move-clip', shotId: 'a', at: 0, track: 0 },
      { op: 'move-clip', shotId: 'b', at: 3, track: 0 },
      { op: 'move-clip', shotId: 'c', at: 6, track: 0 },
    ]);
  });

  it('closes the gap for W and leaves other tracks alone', () => {
    const ops = movieCutOperations(d, a, 3, 'trim-after', { magnet: true });
    expect(ops[0]).toEqual({ op: 'trim-clip', shotId: 'a', start: 0, end: 3 });
    expect(ops.slice(1)).toEqual([{ op: 'move-clip', shotId: 'b', at: 3, track: 0 }, { op: 'move-clip', shotId: 'c', at: 6, track: 0 }]);
    expect(ops.some(op => 'shotId' in op && op.shotId === 't')).toBe(false);
  });

  it('only trims when 主轨磁吸 is off or the clip is not on the main track', () => {
    expect(movieCutOperations(d, a, 1, 'trim-before', { magnet: false })).toEqual([{ op: 'trim-clip', shotId: 'a', start: 1, end: 4 }]);
    const overlay = film([clip('a', 0, 4), clip('o', 0, 4, 2), clip('p', 4, 2, 2)]);
    expect(movieCutOperations(overlay, overlay.shots[1]!, 1, 'trim-after', { magnet: true })).toEqual([{ op: 'trim-clip', shotId: 'o', start: 0, end: 1 }]);
  });

  it('ripple deletes on the main track with 主轨磁吸 through explicit moves, and plainly deletes elsewhere', () => {
    expect(movieCutOperations(d, a, 0, 'delete', { magnet: true })).toEqual([
      { op: 'remove-shot', shotId: 'a' },
      { op: 'move-clip', shotId: 'b', at: 0, track: 0 },
      { op: 'move-clip', shotId: 'c', at: 3, track: 0 },
    ]);
    expect(movieCutOperations(d, a, 0, 'delete', { magnet: false })).toEqual([{ op: 'remove-shot', shotId: 'a' }]);
    expect(movieCutOperations(d, d.shots[3]!, 0, 'ripple-delete', { magnet: false })).toEqual([{ op: 'remove-shot', shotId: 't' }]);
  });

  it('never shifts a locked follower: the shared edit API would reject the batch', () => {
    const locked = film([clip('a', 0, 4), clip('b', 4, 3, 0, { locked: true })]);
    expect(movieCutOperations(locked, locked.shots[0]!, 1, 'trim-before', { magnet: true })).toEqual([{ op: 'trim-clip', shotId: 'a', start: 1, end: 4 }]);
    expect(movieCutOperations(locked, locked.shots[0]!, 0, 'delete', { magnet: true })).toEqual([{ op: 'remove-shot', shotId: 'a' }]);
  });

  it('relies on sequential layout for legacy films without placements', () => {
    const legacy = film([{ ...clip('a', 0, 4), placement: undefined }, { ...clip('b', 4, 2), placement: undefined }]);
    expect(movieCutOperations(legacy, legacy.shots[0]!, 1, 'trim-before', { magnet: true })).toEqual([{ op: 'trim-clip', shotId: 'a', start: 1, end: 4 }]);
    expect(movieCutOperations(legacy, legacy.shots[0]!, 0, 'delete', { magnet: true })).toEqual([{ op: 'remove-shot', shotId: 'a' }]);
  });
});

describe('targets and edit points', () => {
  const d = film([clip('a', 0, 4), clip('b', 4, 3), clip('o', 1, 2, 2), clip('m', 0, 9, 1, { clip: { assetId: 'm', in: 0, rate: 1, volume: 1, fit: 'contain', audioOnly: true } })]);
  it('targets the selection, else the highest visual clip under the playhead', () => {
    expect(movieTargetShot(d, 1.5, 'b')?.id).toBe('b');
    expect(movieTargetShot(d, 1.5)?.id).toBe('o');
    expect(movieTargetShot(d, 5)?.id).toBe('b');
  });
  it('steps between cut points on any track', () => {
    expect(movieEditPoint(d, 0, 1)).toBe(1);
    expect(movieEditPoint(d, 3.5, -1)).toBe(3);
    expect(movieEditPoint(d, 9, 1)).toBeNull();
  });
});

describe('main-track magnet and detached audio', () => {
  it('moves picture clips only; detached audio on the main track keeps its timing', () => {
    const music: MovieShot = clip('m', 6, 3, 0, { clip: { assetId: 'm', in: 0, rate: 1, volume: 1, fit: 'contain', audioOnly: true } });
    const d = film([clip('a', 0, 4), clip('b', 4, 2), music]);
    const ops = movieCutOperations(d, d.shots[0]!, 1, 'trim-after', { magnet: true });
    expect(ops).toEqual([{ op: 'trim-clip', shotId: 'a', start: 0, end: 1 }, { op: 'move-clip', shotId: 'b', at: 1, track: 0 }]);
  });
});

describe('limits, duplicates and locks', () => {
  it('falls back to a plain trim when closing the gap would exceed the edit API limit', () => {
    const many = film([clip('first', 0, 1), ...Array.from({ length: MOVIE_MAX_EDIT_OPERATIONS }, (_, i) => clip(`f${i}`, 1 + i, 1))]);
    expect(movieCutOperations(many, many.shots[0]!, 0.5, 'trim-after', { magnet: true })).toEqual([{ op: 'trim-clip', shotId: 'first', start: 0, end: 0.5 }]);
  });
  it('ripples detached audio only among detached audio', () => {
    const music: Partial<MovieShot> = { clip: { assetId: 'm', in: 0, rate: 1, volume: 1, fit: 'contain', audioOnly: true } };
    const d = film([clip('m1', 0, 3, 1, music), clip('o', 4, 2, 1), clip('m2', 5, 2, 1, music)]);
    expect(movieCutOperations(d, d.shots[0]!, 0, 'ripple-delete', { magnet: false })).toEqual([{ op: 'remove-shot', shotId: 'm1' }, { op: 'move-clip', shotId: 'm2', at: 2, track: 1 }]);
  });
  it('places a duplicate right after the original when free, else at the film end', () => {
    const d = film([clip('a', 0, 2), clip('b', 2, 2), clip('o', 0, 1, 2)]);
    expect(movieDuplicatePlacement(d, d.shots[1]!)).toEqual({ at: 4, track: 0 });
    expect(movieDuplicatePlacement(d, d.shots[0]!)).toEqual({ at: 4, track: 0 });
    expect(movieDuplicatePlacement(d, d.shots[2]!)).toEqual({ at: 1, track: 2 });
  });
  it('pins placements before locking in a sequential film so later moves are not blocked', () => {
    const legacy = film([{ ...clip('a', 0, 4), placement: undefined }, { ...clip('b', 4, 2), placement: undefined }]);
    expect(movieLockOperations(legacy, [legacy.shots[1]!], true)).toEqual([{ op: 'move-clip', shotId: 'a', at: 0, track: 0 }, { op: 'lock-clip', shotId: 'b', locked: true }]);
    expect(movieLockOperations(legacy, [legacy.shots[1]!], false)).toEqual([]);
    const placed = film([clip('a', 0, 4), clip('b', 4, 2, 0, { locked: true })]);
    expect(movieLockOperations(placed, placed.shots, true)).toEqual([{ op: 'lock-clip', shotId: 'a', locked: true }]);
    expect(movieLockOperations(placed, placed.shots, false)).toEqual([{ op: 'lock-clip', shotId: 'b', locked: false }]);
  });
});
