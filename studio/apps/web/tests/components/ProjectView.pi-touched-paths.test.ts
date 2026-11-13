// Auto-open parity for pi's `write` / `edit` (the built-in TokenToSea / BYOK agent).
//
// The auto-open path starts from the successful write/edit `tool_use` events of a turn
// (`extractTouchedFilePathsFromEvents`), then asks `decideAutoOpenAfterWrite` whether the
// path is a project file. pi names its tools in lowercase and passes the file as `path`;
// OpenCode's are `write` / `edit` with `filePath`; Claude's are `Write` / `Edit` with
// `file_path`. All three must reach the same decision.
import { describe, expect, it } from 'vitest';
import { extractTouchedFilePathsFromEvents } from '../../src/components/ProjectView';
import { decideAutoOpenAfterWrite } from '../../src/components/auto-open-file';

const done = (id: string) => ({ kind: 'tool_result', toolUseId: id, content: 'ok', isError: false });
const failed = (id: string) => ({ kind: 'tool_result', toolUseId: id, content: 'boom', isError: true });

describe('extractTouchedFilePathsFromEvents · pi', () => {
  it('recovers lowercase write and edit with `path`', () => {
    const touched = extractTouchedFilePathsFromEvents([
      { kind: 'tool_use', id: 't1', name: 'write', input: { path: 'index.html', content: '<html/>' } },
      done('t1'),
      {
        kind: 'tool_use',
        id: 't2',
        name: 'edit',
        input: { path: 'styles/site.css', edits: [{ oldText: 'a', newText: 'b' }] },
      },
      done('t2'),
    ] as never);

    expect(touched).toEqual(['index.html', 'styles/site.css']);
  });

  it('drops a failed pi edit and ignores read / bash / grep', () => {
    const touched = extractTouchedFilePathsFromEvents([
      { kind: 'tool_use', id: 't1', name: 'edit', input: { path: 'broken.html', edits: [] } },
      failed('t1'),
      { kind: 'tool_use', id: 't2', name: 'read', input: { path: 'index.html' } },
      done('t2'),
      { kind: 'tool_use', id: 't3', name: 'bash', input: { command: 'cat > x.html' } },
      done('t3'),
      { kind: 'tool_use', id: 't4', name: 'grep', input: { pattern: 'x', path: 'src' } },
      done('t4'),
    ] as never);

    expect(touched).toEqual([]);
  });

  it("reads OpenCode's `filePath` and Claude's `file_path` the same way", () => {
    const touched = extractTouchedFilePathsFromEvents([
      { kind: 'tool_use', id: 't1', name: 'edit', input: { filePath: 'a.html', oldString: 'x', newString: 'y' } },
      done('t1'),
      { kind: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'b.html', old_string: 'x', new_string: 'y' } },
      done('t2'),
    ] as never);

    expect(touched).toEqual(['a.html', 'b.html']);
  });
});

describe('decideAutoOpenAfterWrite · a pi-written path', () => {
  const files = [
    { name: 'index.html', path: 'index.html' },
    { name: 'prototype/App.jsx', path: 'prototype/App.jsx' },
  ];

  it('opens a relative path the project has', () => {
    expect(decideAutoOpenAfterWrite('index.html', files)).toEqual({ shouldOpen: true, fileName: 'index.html' });
  });

  it('opens an absolute path by suffix match against the project file', () => {
    expect(decideAutoOpenAfterWrite('/work/projects/p1/prototype/App.jsx', files)).toEqual({
      shouldOpen: true,
      fileName: 'prototype/App.jsx',
    });
  });

  it('declines a path outside the project instead of opening a placeholder tab', () => {
    expect(decideAutoOpenAfterWrite('/home/user/elsewhere/notes.md', files)).toEqual({
      shouldOpen: false,
      fileName: null,
    });
  });
});
