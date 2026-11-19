import { describe, expect, it } from 'vitest';

import {
  collectTurnFileChanges,
  latestTurnFileChanges,
} from '../../../../src/fantay/workspace/surfaces/turn-changes';
import { IN_FLIGHT_TOOL_INPUT_MARKER } from '../../../../src/runtime/tool-events';
import type { AgentEvent } from '../../../../src/types';

const ROOT = '/data/projects/p1';
const FILES = ['index.html', 'src/app.ts', 'src/lib/util.ts', 'docs/util.ts', 'README.md'];

const use = (id: string, name: string, input: unknown): AgentEvent => ({ kind: 'tool_use', id, name, input });
const ok = (id: string): AgentEvent => ({ kind: 'tool_result', toolUseId: id, content: 'ok', isError: false });
const failed = (id: string): AgentEvent => ({ kind: 'tool_result', toolUseId: id, content: 'no', isError: true });

const collect = (events: readonly unknown[], extra: Partial<Parameters<typeof collectTurnFileChanges>[1]> = {}) =>
  collectTurnFileChanges(events, { resolvedDir: ROOT, fileNames: FILES, ...extra });

describe('collectTurnFileChanges · pairing calls with results', () => {
  it('counts a finished call and a call still waiting for its result, and ignores a failed one', () => {
    const changes = collect([
      use('t1', 'Edit', { file_path: `${ROOT}/src/app.ts`, old_string: 'a', new_string: 'b' }),
      ok('t1'),
      use('t2', 'Edit', { file_path: `${ROOT}/README.md`, old_string: 'x', new_string: 'y' }),
      failed('t2'),
      use('t3', 'Write', { file_path: `${ROOT}/index.html`, content: '<html>\n</html>\n' }),
    ]);

    expect(changes.map((change) => change.path)).toEqual(['src/app.ts', 'index.html']);
    expect(changes[0]).toEqual({
      path: 'src/app.ts',
      status: 'modified',
      hunks: [{ before: 'a', after: 'b' }],
      added: 1,
      removed: 1,
    });
    expect(changes[1]).toMatchObject({ hunks: [{ before: null, after: '<html>\n</html>\n' }], added: 2, removed: 0 });
  });

  it('ignores a call whose error result arrives before it in the list, and the older tool_use_id spelling', () => {
    expect(
      collect([
        failed('t1'),
        use('t1', 'Write', { file_path: `${ROOT}/index.html`, content: 'x' }),
        use('t2', 'Write', { file_path: `${ROOT}/README.md`, content: 'x' }),
        { kind: 'tool_result', tool_use_id: 't2', content: 'no', isError: true },
      ]),
    ).toEqual([]);
  });

  it('skips the early form of a streaming call and counts a replayed call once', () => {
    const settled = use('t1', 'Write', { file_path: `${ROOT}/index.html`, content: 'a\nb' });
    const changes = collect([
      use('t1', 'Write', { file_path: `${ROOT}/index.html`, [IN_FLIGHT_TOOL_INPUT_MARKER]: true }),
      settled,
      settled,
      ok('t1'),
    ]);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: 'index.html', added: 2, hunks: [{ before: null, after: 'a\nb' }] });
  });

  it('ignores events that are not tool calls, and malformed entries', () => {
    expect(collect([{ kind: 'text', text: 'hi' }, null, 'x', { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${ROOT}/index.html` } }])).toEqual([]);
  });
});

describe('collectTurnFileChanges · resolving paths', () => {
  it('makes an absolute path under the project directory relative, listed or not', () => {
    const changes = collect([use('t1', 'Write', { file_path: `${ROOT}/src/new/thing.ts`, content: 'x' })]);
    expect(changes.map((change) => change.path)).toEqual(['src/new/thing.ts']);
  });

  it('compares a Windows project directory without regard to case or slash direction', () => {
    const changes = collect([use('t1', 'Write', { file_path: 'c:\\work\\Proj\\src\\App.ts', content: 'x' })], {
      resolvedDir: 'C:\\Work\\proj\\',
    });
    expect(changes.map((change) => change.path)).toEqual(['src/App.ts']);
  });

  it('matches other paths against the file list: exact, or a unique segment-aligned suffix', () => {
    const changes = collect(
      [
        use('t1', 'edit', { path: './src/app.ts', oldText: 'a', newText: 'b' }),
        use('t2', 'edit', { path: '/somewhere/else/src/lib/util.ts', oldText: 'a', newText: 'b' }),
        use('t3', 'edit', { path: 'README.md', oldText: 'a', newText: 'b' }),
      ],
      { resolvedDir: null },
    );
    expect(changes.map((change) => change.path)).toEqual(['src/app.ts', 'src/lib/util.ts', 'README.md']);
  });

  it('takes a listed name as that file even when a shallower file shares its tail', () => {
    // pi and the workspace guard tools send project-relative paths. `index.html` is a suffix of
    // `pages/index.html` too, which the shared suffix rule alone reads as two candidates.
    const fileNames = ['index.html', 'pages/index.html', 'README.md', 'docs/README.md'];
    const changes = collect(
      [
        use('t1', 'write', { path: 'pages/index.html', content: '<html/>' }),
        use('t2', 'edit', { path: './docs/README.md', oldText: 'a', newText: 'b' }),
        use('t3', 'edit', { path: 'README.md', oldText: 'a', newText: 'b' }),
      ],
      { fileNames },
    );
    expect(changes.map((change) => change.path)).toEqual(['pages/index.html', 'docs/README.md', 'README.md']);

    // Without the project directory an absolute path has only its tail to go by, and that stays a guess.
    expect(
      collect([use('t1', 'Write', { file_path: '/elsewhere/p1/pages/index.html', content: 'x' })], {
        resolvedDir: null,
        fileNames,
      }),
    ).toEqual([]);
  });

  it('drops edits outside the project, ambiguous matches, and paths that climb out', () => {
    expect(
      collect([
        // An absolute path that is neither under the project directory nor a suffix match.
        use('t1', 'Write', { file_path: '/Users/me/.claude/plans/plan.md', content: 'x' }),
        // Two listed files are called util.ts (src/lib/ and docs/): picking one would be a guess.
        use('t2', 'Write', { file_path: 'util.ts', content: 'x' }),
        use('t3', 'Write', { file_path: '../p2/index.html', content: 'x' }),
        // A relative path the file list does not hold, and the call is not a delete.
        use('t4', 'Write', { file_path: 'src/not-listed.ts', content: 'x' }),
        // `notsrc/app.ts` is not `src/app.ts`: a suffix has to start at a path segment.
        use('t5', 'Write', { file_path: '/elsewhere/notsrc/app.ts', content: 'x' }),
      ]),
    ).toEqual([]);
  });
});

describe('collectTurnFileChanges · merging calls on one file', () => {
  it('merges in call order and lists files in first-touched order', () => {
    const changes = collect([
      use('t1', 'Write', { file_path: `${ROOT}/src/app.ts`, content: 'one\ntwo\nthree' }),
      use('t2', 'Edit', { file_path: `${ROOT}/index.html`, old_string: '<a>', new_string: '<b>\n<c>' }),
      use('t3', 'MultiEdit', {
        file_path: 'src/app.ts',
        edits: [
          { old_string: 'two', new_string: 'TWO' },
          { old_string: 'three', new_string: '' },
        ],
      }),
    ]);

    expect(changes).toEqual([
      {
        path: 'src/app.ts',
        status: 'modified',
        hunks: [
          { before: null, after: 'one\ntwo\nthree' },
          { before: 'two', after: 'TWO' },
          { before: 'three', after: '' },
        ],
        added: 3 + 1 + 0,
        removed: 0 + 1 + 1,
      },
      { path: 'index.html', status: 'modified', hunks: [{ before: '<a>', after: '<b>\n<c>' }], added: 2, removed: 1 },
    ]);
  });

  it('splits a patch into its files and merges them with other calls', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      '-old',
      '+new',
      '*** Add File: src/fresh.ts',
      '+export {};',
      '*** End Patch',
    ].join('\n');
    const changes = collect(
      [
        use('t1', 'apply_patch', { input: patch }),
        ok('t1'),
        use('t2', 'Edit', { file_path: `${ROOT}/src/fresh.ts`, old_string: 'export {};', new_string: 'export const a = 1;' }),
      ],
      { fileNames: [...FILES, 'src/fresh.ts'] },
    );

    expect(changes).toEqual([
      { path: 'src/app.ts', status: 'modified', hunks: [{ before: 'old\n', after: 'new\n' }], added: 1, removed: 1 },
      {
        path: 'src/fresh.ts',
        status: 'created',
        hunks: [
          { before: null, after: 'export {};\n' },
          { before: 'export {};', after: 'export const a = 1;' },
        ],
        added: 2,
        removed: 1,
      },
    ]);
  });

  it('counts a blank line a patch adds or removes at the end of a chunk', () => {
    const patch = (body: string[]) => ['*** Begin Patch', '*** Update File: src/app.ts', '@@', ...body, '*** End Patch'].join('\n');
    const counts = (body: string[]) => {
      const [change] = collect([use('t1', 'apply_patch', { patchText: patch(body) })]);
      return { added: change?.added, removed: change?.removed };
    };

    expect(counts([' foo', '+'])).toEqual({ added: 1, removed: 0 });
    expect(counts([' foo', '-'])).toEqual({ added: 0, removed: 1 });
    expect(counts(['+bar', '+'])).toEqual({ added: 2, removed: 0 });
  });

  it('uses the line counts the daemon carried when the text itself did not travel', () => {
    const changes = collect([
      use('item_3#0', 'Write', { file_path: `${ROOT}/page.html`, od_diff_stat: { added: 6, removed: 0 } }),
      use('item_3#1', 'Edit', { file_path: `${ROOT}/src/app.ts`, od_diff_stat: { added: 2, removed: 1 } }),
      use('t9', 'Write', {
        file_path: `${ROOT}/index.html`,
        content: 'head\n…[open-design: truncated 9 of 99 bytes, sha256 abc]…\ntail',
        od_diff_stat: { added: 40, removed: 0 },
      }),
    ]);

    expect(changes).toEqual([
      { path: 'page.html', status: 'created', hunks: [], added: 6, removed: 0 },
      { path: 'src/app.ts', status: 'modified', hunks: [], added: 2, removed: 1 },
      expect.objectContaining({ path: 'index.html', added: 40, removed: 0 }),
    ]);
  });
});

describe('collectTurnFileChanges · created, modified, deleted', () => {
  const write = [use('t1', 'Write', { file_path: `${ROOT}/src/app.ts`, content: 'x' })];

  it('calls a whole-file write created only when the pre-turn snapshot lacks the file', () => {
    expect(collect(write, { preTurnFileNames: new Set(['index.html']) })[0]?.status).toBe('created');
    expect(collect(write, { preTurnFileNames: new Set(['src/app.ts']) })[0]?.status).toBe('modified');
    expect(collect(write)[0]?.status).toBe('modified');
    expect(collect(write, { preTurnFileNames: null })[0]?.status).toBe('modified');
  });

  it('never calls a file created when its first call was an edit', () => {
    const edit = [use('t1', 'Edit', { file_path: `${ROOT}/src/app.ts`, old_string: 'a', new_string: 'b' }), ...write];
    expect(collect(edit, { preTurnFileNames: new Set<string>() })[0]?.status).toBe('modified');
  });

  it('trusts a patch that says it added the file, unless the snapshot already had it', () => {
    const add = [use('t1', 'apply_patch', { input: '*** Begin Patch\n*** Add File: src/app.ts\n+x\n*** End Patch' })];
    expect(collect(add)[0]?.status).toBe('created');
    expect(collect(add, { preTurnFileNames: new Set(['src/app.ts']) })[0]?.status).toBe('modified');
  });

  it('marks a file deleted when the last call deleted it, and keeps a deleted file no list holds any more', () => {
    const remove = (path: string) => `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch`;
    const changes = collect([
      use('t1', 'Edit', { file_path: `${ROOT}/src/app.ts`, old_string: 'a', new_string: 'b' }),
      use('t2', 'apply_patch', { input: remove('src/app.ts') }),
      use('t3', 'apply_patch', { input: remove('old/legacy.ts') }),
      use('t4', 'apply_patch', { input: remove(`${ROOT}/old/absolute.ts`) }),
      use('t5', 'apply_patch', { input: remove('/elsewhere/outside.ts') }),
    ]);

    expect(changes).toEqual([
      { path: 'src/app.ts', status: 'deleted', hunks: [{ before: 'a', after: 'b' }], added: 1, removed: 1 },
      { path: 'old/legacy.ts', status: 'deleted', hunks: [], added: 0, removed: 0 },
      { path: 'old/absolute.ts', status: 'deleted', hunks: [], added: 0, removed: 0 },
    ]);
  });

  it('reads a file written again after its deletion as modified', () => {
    const changes = collect([
      use('t1', 'apply_patch', { input: '*** Begin Patch\n*** Delete File: src/app.ts\n*** End Patch' }),
      use('t2', 'Write', { file_path: `${ROOT}/src/app.ts`, content: 'back' }),
    ]);
    expect(changes).toEqual([
      { path: 'src/app.ts', status: 'modified', hunks: [{ before: null, after: 'back' }], added: 1, removed: 0 },
    ]);
  });
});

describe('latestTurnFileChanges', () => {
  const options = { resolvedDir: ROOT, fileNames: FILES };
  const edit = (id: string, file: string) => use(id, 'Edit', { file_path: `${ROOT}/${file}`, old_string: 'a', new_string: 'b' });

  it('returns the changes of the most recent assistant message that has any', () => {
    const changes = latestTurnFileChanges(
      [
        { role: 'user', events: [edit('u1', 'README.md')] },
        { role: 'assistant', events: [edit('t1', 'index.html')] },
        { role: 'user' },
        { role: 'assistant', events: [edit('t2', 'src/app.ts'), ok('t2')] },
        { role: 'user' },
        { role: 'assistant', events: [use('t3', 'Read', { file_path: `${ROOT}/README.md` })] },
        { role: 'assistant', events: null },
      ],
      options,
    );
    expect(changes.map((change) => change.path)).toEqual(['src/app.ts']);
  });

  it('returns [] when no assistant message changed a file', () => {
    expect(latestTurnFileChanges([], options)).toEqual([]);
    expect(
      latestTurnFileChanges(
        [
          { role: 'user', events: [edit('u1', 'README.md')] },
          { role: 'assistant', events: [edit('t1', 'index.html'), failed('t1')] },
          { role: 'assistant' },
        ],
        options,
      ),
    ).toEqual([]);
  });
});
