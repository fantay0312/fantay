// SPDX-License-Identifier: AGPL-3.0-only
// Which file the 代码 surface shows and in which view: requests, the fallback, and what happens when
// the selected file goes away.
import { describe, expect, it } from 'vitest';

import { buildFileTree, collectDirPaths } from '../../../../src/fantay/workspace/code/file-tree';
import {
  INITIAL_SURFACE_STATE,
  firstSelectableChange,
  latestTextFile,
  reconcileSurfaceState,
  revealDir,
  selectFile,
  setView,
  toggleDir,
  type SurfaceInputs,
  type SurfaceState,
} from '../../../../src/fantay/workspace/code/selection';
import type { CodeSurfaceRequest } from '../../../../src/fantay/workspace/surfaces/code-surface-store';
import type { TurnFileChange } from '../../../../src/fantay/workspace/surfaces/surface-types';
import type { ProjectFile } from '../../../../src/types';

function file(name: string, mtime = 1, kind: ProjectFile['kind'] = 'code'): ProjectFile {
  return { name, size: 10, mtime, kind, mime: 'text/plain' };
}

function change(path: string, status: TurnFileChange['status'] = 'modified'): TurnFileChange {
  return { path, status, hunks: [], added: 1, removed: 0 };
}

const NO_CHANGES: readonly TurnFileChange[] = [];

/** The inputs the surface derives from its props, built the same way. */
function inputs(
  files: readonly ProjectFile[],
  turnChanges: readonly TurnFileChange[] = NO_CHANGES,
  request: CodeSurfaceRequest | null = null,
): SurfaceInputs {
  const fileByName = new Map(files.map((entry) => [entry.name, entry]));
  return {
    fileCount: fileByName.size,
    fileByName,
    dirPaths: collectDirPaths(buildFileTree(files)),
    turnChanges,
    firstChange: firstSelectableChange(turnChanges, fileByName),
    latestText: latestTextFile(files),
    request,
  };
}

function settle(state: SurfaceState, input: SurfaceInputs): SurfaceState {
  const next = reconcileSurfaceState(state, input);
  // Settled means stable: running it again must hand back the very same object.
  expect(reconcileSurfaceState(next, input)).toBe(next);
  return next;
}

describe('fallback selection', () => {
  it('shows the first file the turn changed, as changes', () => {
    const files = [file('a.ts', 5), file('src/b.ts', 1), file('c.ts', 9)];
    const state = settle(INITIAL_SURFACE_STATE, inputs(files, [change('gone.ts', 'deleted'), change('src/b.ts')]));
    expect(state.selected).toBe('src/b.ts');
    expect(state.view).toBe('changes');
    expect(state.auto).toBe(true);
    expect(state.reveal?.path).toBe('src/b.ts');
    expect(state.expanded.has('src')).toBe(true);
  });

  it('otherwise shows the most recently modified file that reads as text', () => {
    const files = [file('old.ts', 1), file('photo.png', 99, 'image'), file('new.md', 7, 'text')];
    const state = settle(INITIAL_SURFACE_STATE, inputs(files));
    expect(state.selected).toBe('new.md');
    expect(state.view).toBe('source');
  });

  it('shows nothing when no file reads as text', () => {
    const state = settle(INITIAL_SURFACE_STATE, inputs([file('photo.png', 1, 'image')]));
    expect(state.selected).toBeNull();
    expect(settle(INITIAL_SURFACE_STATE, inputs([])).selected).toBeNull();
  });

  it('falls back the same way when the selected file disappears', () => {
    const before = settle(INITIAL_SURFACE_STATE, inputs([file('a.ts', 2), file('b.ts', 1)]));
    expect(before.selected).toBe('a.ts');
    const after = settle(before, inputs([file('b.ts', 1)]));
    expect(after.selected).toBe('b.ts');
    expect(settle(after, inputs([file('photo.png', 1, 'image')])).selected).toBeNull();
  });

  it('does not chase modification times once a file is shown', () => {
    const first = settle(INITIAL_SURFACE_STATE, inputs([file('a.ts', 2), file('b.ts', 1)]));
    const later = settle(first, inputs([file('a.ts', 2), file('b.ts', 50)]));
    expect(later.selected).toBe('a.ts');
  });
});

describe('following the turn', () => {
  it('moves to the turn’s first change while the surface is still choosing by itself', () => {
    const files = [file('a.ts', 9), file('b.ts', 1)];
    const idle = settle(INITIAL_SURFACE_STATE, inputs(files));
    expect(idle.selected).toBe('a.ts');
    const working = settle(idle, inputs(files, [change('b.ts')]));
    expect(working.selected).toBe('b.ts');
    expect(working.view).toBe('changes');
  });

  it('stays on the file the person picked', () => {
    const files = [file('a.ts', 9), file('b.ts', 1), file('c.ts', 1)];
    const picked = selectFile(settle(INITIAL_SURFACE_STATE, inputs(files)), 'c.ts', { reveal: false });
    const working = settle(picked, inputs(files, [change('b.ts')]));
    expect(working.selected).toBe('c.ts');
    expect(working.auto).toBe(false);
  });
});

describe('requests', () => {
  const files = [file('a.ts', 9), file('src/lib/b.ts', 1)];

  it('selects the requested file, opens its folders and switches the view', () => {
    const state = settle(
      INITIAL_SURFACE_STATE,
      inputs(files, NO_CHANGES, { file: 'src/lib/b.ts', view: 'changes', nonce: 1 }),
    );
    expect(state.selected).toBe('src/lib/b.ts');
    expect(state.view).toBe('changes');
    expect(state.auto).toBe(false);
    expect(state.reveal?.path).toBe('src/lib/b.ts');
    expect([...state.expanded]).toEqual(expect.arrayContaining(['src', 'src/lib']));
  });

  it('acts once per nonce, and again when the same file is asked for anew', () => {
    const request = { file: 'src/lib/b.ts', view: null, nonce: 1 };
    const first = settle(INITIAL_SURFACE_STATE, inputs(files, NO_CHANGES, request));
    const moved = selectFile(first, 'a.ts', { reveal: false });
    // The old request is still the store's latest: it must not pull the selection back.
    expect(settle(moved, inputs(files, NO_CHANGES, request)).selected).toBe('a.ts');
    const again = settle(moved, inputs(files, NO_CHANGES, { ...request, nonce: 2 }));
    expect(again.selected).toBe('src/lib/b.ts');
    expect(again.reveal?.tick).toBeGreaterThan(first.reveal?.tick ?? 0);
  });

  it('keeps the selection for a request without a file, and still applies its view', () => {
    const start = settle(INITIAL_SURFACE_STATE, inputs(files));
    const state = settle(start, inputs(files, NO_CHANGES, { file: null, view: 'changes', nonce: 3 }));
    expect(state.selected).toBe('a.ts');
    expect(state.view).toBe('changes');
  });

  it('waits for a requested file that is not listed yet', () => {
    const request = { file: 'new.ts', view: null, nonce: 4 };
    const waiting = settle(INITIAL_SURFACE_STATE, inputs(files, NO_CHANGES, request));
    expect(waiting.selected).toBe('a.ts');
    expect(waiting.awaited).toBe('new.ts');
    const arrived = settle(waiting, inputs([...files, file('new.ts', 1)], NO_CHANGES, request));
    expect(arrived.selected).toBe('new.ts');
    expect(arrived.awaited).toBeNull();
  });

  it('shows an awaited file in the view its request asked for, whatever the fallback did meanwhile', () => {
    const request = { file: 'new.ts', view: 'source' as const, nonce: 6 };
    // While waiting, the fallback opens the turn's first change, which switches to the changes view.
    const waiting = settle(INITIAL_SURFACE_STATE, inputs(files, [change('a.ts'), change('new.ts')], request));
    expect(waiting.selected).toBe('a.ts');
    expect(waiting.view).toBe('changes');
    const arrived = settle(
      waiting,
      inputs([...files, file('new.ts', 1)], [change('a.ts'), change('new.ts')], request),
    );
    expect(arrived.selected).toBe('new.ts');
    expect(arrived.view).toBe('source');
    expect(arrived.awaitedView).toBeNull();
  });

  it('stops waiting once the person picks another file', () => {
    const request = { file: 'new.ts', view: null, nonce: 5 };
    const waiting = settle(INITIAL_SURFACE_STATE, inputs(files, NO_CHANGES, request));
    const picked = selectFile(waiting, 'src/lib/b.ts', { reveal: false });
    const arrived = settle(picked, inputs([...files, file('new.ts', 1)], NO_CHANGES, request));
    expect(arrived.selected).toBe('src/lib/b.ts');
  });
});

describe('open folders', () => {
  it('opens every folder of a small project, and new folders as they appear', () => {
    const small = [file('src/a.ts'), file('docs/guide/intro.md', 1, 'text')];
    const state = settle(INITIAL_SURFACE_STATE, inputs(small));
    expect([...state.expanded]).toEqual(expect.arrayContaining(['src', 'docs/guide']));
    const grown = settle(state, inputs([...small, file('tests/unit/a.test.ts')]));
    expect(grown.expanded.has('tests/unit')).toBe(true);
  });

  it('leaves a folder the person closed closed when the list refreshes', () => {
    const files = [file('src/a.ts'), file('docs/b.md', 1, 'text')];
    const closed = toggleDir(settle(INITIAL_SURFACE_STATE, inputs(files)), 'docs', false);
    expect(closed.expanded.has('docs')).toBe(false);
    const refreshed = settle(closed, inputs([...files]));
    expect(refreshed.expanded.has('docs')).toBe(false);
  });

  it('opens only the selected file’s folders in a large project', () => {
    const many = Array.from({ length: 80 }, (_, index) => file(`pkg${index}/index.ts`, index));
    const state = settle(INITIAL_SURFACE_STATE, inputs(many));
    expect(state.selected).toBe('pkg79/index.ts');
    expect([...state.expanded]).toEqual(['pkg79']);
  });

  it('toggles a folder, and reveals a folder together with what is above it', () => {
    const base = INITIAL_SURFACE_STATE;
    expect(toggleDir(base, 'src').expanded.has('src')).toBe(true);
    expect(toggleDir(toggleDir(base, 'src'), 'src').expanded.has('src')).toBe(false);
    expect(toggleDir(base, 'src', false)).toBe(base);
    const revealed = revealDir(base, 'src/app/pages');
    expect([...revealed.expanded].sort()).toEqual(['src', 'src/app', 'src/app/pages']);
    expect(revealed.reveal).toEqual({ path: 'src/app/pages', tick: 1 });
  });
});

describe('person actions', () => {
  it('selecting from the tree keeps the tree where it is; from elsewhere it reveals the row', () => {
    const fromTree = selectFile(INITIAL_SURFACE_STATE, 'src/a.ts', { reveal: false });
    expect(fromTree.reveal).toBeNull();
    expect(fromTree.auto).toBe(false);
    const fromList = selectFile(INITIAL_SURFACE_STATE, 'src/a.ts', { reveal: true, view: 'changes' });
    expect(fromList.reveal).toEqual({ path: 'src/a.ts', tick: 1 });
    expect(fromList.view).toBe('changes');
    expect(fromList.expanded.has('src')).toBe(true);
  });

  it('selecting from the changed list opens the file’s folders without asking the tree to scroll', () => {
    const before = revealDir(INITIAL_SURFACE_STATE, 'docs');
    const picked = selectFile(before, 'src/lib/a.ts', { reveal: false, expand: true, view: 'changes' });
    expect(picked.selected).toBe('src/lib/a.ts');
    expect(picked.view).toBe('changes');
    expect([...picked.expanded]).toEqual(expect.arrayContaining(['docs', 'src', 'src/lib']));
    // The reveal request is the one from before: the tree is not asked to move.
    expect(picked.reveal).toBe(before.reveal);
  });

  it('setView returns the same state when nothing changes', () => {
    expect(setView(INITIAL_SURFACE_STATE, 'source')).toBe(INITIAL_SURFACE_STATE);
    expect(setView(INITIAL_SURFACE_STATE, 'changes').view).toBe('changes');
  });
});
