import { describe, expect, it } from 'vitest';

import { fileToolShape } from '../../../../src/fantay/workspace/surfaces/tool-shape';
import { IN_FLIGHT_TOOL_INPUT_MARKER } from '../../../../src/runtime/tool-events';

const PATCH = [
  '*** Begin Patch',
  '*** Add File: src/new.ts',
  '+export const a = 1;',
  '+export const b = 2;',
  '*** Update File: src/app.ts',
  '@@ function main() {',
  ' const keep = true;',
  '-const old = 1;',
  '+const next = 2;',
  '+const more = 3;',
  '@@',
  '-tail();',
  '+end();',
  '*** End of File',
  '*** Delete File: src/gone.ts',
  '*** End Patch',
].join('\n');

const PATCH_FILES = [
  { path: 'src/new.ts', status: 'created', hunks: [{ before: null, after: 'export const a = 1;\nexport const b = 2;\n' }] },
  {
    path: 'src/app.ts',
    status: 'modified',
    hunks: [
      { before: 'const keep = true;\nconst old = 1;\n', after: 'const keep = true;\nconst next = 2;\nconst more = 3;\n' },
      { before: 'tail();\n', after: 'end();\n' },
    ],
  },
  { path: 'src/gone.ts', status: 'deleted', hunks: [] },
];

describe('fileToolShape · Claude Code', () => {
  it('Write is a whole-file write', () => {
    expect(fileToolShape('Write', { file_path: '/repo/index.html', content: '<html/>' })).toEqual({
      kind: 'write',
      path: '/repo/index.html',
      content: '<html/>',
    });
  });

  it('Edit is one replacement', () => {
    expect(fileToolShape('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b', replace_all: false })).toEqual({
      kind: 'edit',
      path: '/repo/a.ts',
      edits: [{ before: 'a', after: 'b' }],
    });
  });

  it('MultiEdit is several replacements in call order', () => {
    expect(
      fileToolShape('MultiEdit', {
        file_path: '/repo/a.ts',
        edits: [
          { old_string: 'one', new_string: 'ONE' },
          { old_string: 'two', new_string: '' },
        ],
      }),
    ).toEqual({
      kind: 'edit',
      path: '/repo/a.ts',
      edits: [
        { before: 'one', after: 'ONE' },
        { before: 'two', after: '' },
      ],
    });
  });

  it('NotebookEdit carries only the new cell source', () => {
    expect(
      fileToolShape('NotebookEdit', { notebook_path: '/repo/nb.ipynb', cell_id: 'c1', new_source: 'print(1)' }),
    ).toEqual({ kind: 'edit', path: '/repo/nb.ipynb', edits: [{ before: '', after: 'print(1)' }] });
  });
});

describe('fileToolShape · opencode and pi', () => {
  it('opencode write / edit use filePath and oldString / newString', () => {
    expect(fileToolShape('write', { filePath: 'src/a.ts', content: 'x' })).toEqual({
      kind: 'write',
      path: 'src/a.ts',
      content: 'x',
    });
    expect(fileToolShape('edit', { filePath: 'src/a.ts', oldString: 'x', newString: 'y' })).toEqual({
      kind: 'edit',
      path: 'src/a.ts',
      edits: [{ before: 'x', after: 'y' }],
    });
  });

  it('pi write uses path, and pi edit an edits[] of oldText / newText', () => {
    expect(fileToolShape('write', { path: 'notes.txt', content: 'hi' })).toEqual({
      kind: 'write',
      path: 'notes.txt',
      content: 'hi',
    });
    expect(
      fileToolShape('edit', {
        path: 'index.ts',
        edits: [{ oldText: 'a', newText: 'b' }, { newText: 'orphan' }, null, { oldText: 'c', newText: 'd' }],
      }),
    ).toEqual({
      kind: 'edit',
      path: 'index.ts',
      edits: [
        { before: 'a', after: 'b' },
        { before: 'c', after: 'd' },
      ],
    });
  });

  it('reads the shape, not the name: the workspace guard tools and Gemini are the same calls', () => {
    expect(fileToolShape('fantay_workspace_write', { path: 'a.css', content: 'a{}' })).toEqual({
      kind: 'write',
      path: 'a.css',
      content: 'a{}',
    });
    expect(fileToolShape('fantay_workspace_edit', { path: 'a.css', oldText: 'a{}', newText: 'b{}' })).toEqual({
      kind: 'edit',
      path: 'a.css',
      edits: [{ before: 'a{}', after: 'b{}' }],
    });
    expect(fileToolShape('write_file', { file_path: 'index.html', content: '<!doctype html>' })?.kind).toBe('write');
    expect(fileToolShape('replace', { file_path: 'index.html', old_string: 'a', new_string: 'b' })?.kind).toBe('edit');
  });
});

describe('fileToolShape · Codex apply_patch', () => {
  it('parses add, update and delete sections of a function-call patch', () => {
    expect(fileToolShape('apply_patch', { input: PATCH })).toEqual({ kind: 'patch', files: PATCH_FILES });
    expect(fileToolShape('apply_patch', { patch: PATCH })).toEqual({ kind: 'patch', files: PATCH_FILES });
    expect(fileToolShape('apply_patch', { patchText: PATCH })).toEqual({ kind: 'patch', files: PATCH_FILES });
  });

  it('parses a freeform body and arguments that are still JSON text', () => {
    expect(fileToolShape('apply_patch', PATCH)).toEqual({ kind: 'patch', files: PATCH_FILES });
    expect(fileToolShape('apply_patch', JSON.stringify({ input: PATCH }))).toEqual({ kind: 'patch', files: PATCH_FILES });
  });

  it('parses the shell forms and skips the text around the envelope', () => {
    expect(fileToolShape('shell', { command: ['apply_patch', PATCH] })).toEqual({ kind: 'patch', files: PATCH_FILES });
    expect(fileToolShape('Bash', { command: `apply_patch <<'EOF'\n${PATCH}\nEOF` })).toEqual({
      kind: 'patch',
      files: PATCH_FILES,
    });
  });

  it('reads an update without the envelope, a leading chunk without @@, and CRLF lines', () => {
    expect(fileToolShape('apply_patch', { patch: '*** Update File: /tmp/v.html\r\n-<h1>A</h1>\r\n+<h1>B</h1>\r\n' })).toEqual({
      kind: 'patch',
      files: [{ path: '/tmp/v.html', status: 'modified', hunks: [{ before: '<h1>A</h1>\n', after: '<h1>B</h1>\n' }] }],
    });
  });

  it('treats a move as the old path going away and the new one appearing', () => {
    const moved = ['*** Begin Patch', '*** Update File: src/old.ts', '*** Move to: src/new.ts', '@@', '-a', '+b', '*** End Patch'];
    expect(fileToolShape('apply_patch', { input: moved.join('\n') })).toEqual({
      kind: 'patch',
      files: [
        { path: 'src/old.ts', status: 'deleted', hunks: [] },
        { path: 'src/new.ts', status: 'created', hunks: [{ before: 'a\n', after: 'b\n' }] },
      ],
    });
  });

  it('keeps a blank last line of a chunk, and of an added file, as a line', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+x',
      '+',
      '*** Update File: src/app.ts',
      '@@',
      ' foo',
      '+',
      '*** End Patch',
    ].join('\n');
    // Joined without the closing newline these read `x\n` and `foo\n`: one line each, the blank one gone.
    expect(fileToolShape('apply_patch', { patchText: patch })).toEqual({
      kind: 'patch',
      files: [
        { path: 'src/new.ts', status: 'created', hunks: [{ before: null, after: 'x\n\n' }] },
        { path: 'src/app.ts', status: 'modified', hunks: [{ before: 'foo\n', after: 'foo\n\n' }] },
      ],
    });
  });

  it('does not read a shell command that only mentions a patch', () => {
    expect(fileToolShape('Bash', { command: `cat > notes.md <<'EOF'\n${PATCH}\nEOF` })).toBeNull();
    expect(fileToolShape('Bash', { command: 'apply_patch --help' })).toBeNull();
  });
});

describe('fileToolShape · Codex fileChange', () => {
  it('reads the app-server changes list, unified diff included', () => {
    expect(
      fileToolShape('fileChange', {
        changes: [
          { path: '/repo/new.md', kind: { type: 'add' }, diff: 'alpha\nbeta\n' },
          {
            path: '/repo/note.md',
            kind: { type: 'update', move_path: null },
            diff: '@@ -2,3 +2,4 @@\n beta\n-gamma\n+GAMMA-1\n+GAMMA-2\n delta\n',
          },
          { path: '/repo/gone.md', kind: { type: 'delete' } },
          { path: '/repo/odd.md', kind: { type: 'chmod' } },
        ],
      }),
    ).toEqual({
      kind: 'patch',
      files: [
        { path: '/repo/new.md', status: 'created', hunks: [{ before: null, after: 'alpha\nbeta\n' }] },
        {
          path: '/repo/note.md',
          status: 'modified',
          hunks: [{ before: 'beta\ngamma\ndelta\n', after: 'beta\nGAMMA-1\nGAMMA-2\ndelta\n' }],
        },
        { path: '/repo/gone.md', status: 'deleted', hunks: [] },
      ],
    });
  });

  it('reads the exec --json string kinds, a map keyed by path, and a rename', () => {
    expect(fileToolShape('file_change', { changes: [{ path: 'page.html', kind: 'add' }] })).toEqual({
      kind: 'patch',
      files: [{ path: 'page.html', status: 'created', hunks: [] }],
    });
    expect(
      fileToolShape('file_change', {
        changes: { 'a.ts': { kind: { type: 'update', move_path: 'b.ts' }, unified_diff: '@@ -1 +1 @@\n-x\n+y\n' } },
      }),
    ).toEqual({
      kind: 'patch',
      files: [
        { path: 'a.ts', status: 'deleted', hunks: [] },
        { path: 'b.ts', status: 'created', hunks: [{ before: 'x\n', after: 'y\n' }] },
      ],
    });
  });

  it('reads the path-keyed wire, which tags the change itself, and changes sent as JSON text', () => {
    // Shapes of Codex's `FileChange` (see t3code effect-codex-app-server schema.gen.ts).
    const changes = {
      '/repo/new.md': { type: 'add', content: 'alpha\n' },
      '/repo/note.md': { type: 'update', unified_diff: '@@ -1 +1 @@\n-x\n+y\n', move_path: null },
      '/repo/gone.md': { type: 'delete', content: 'old\n' },
    };
    const files = [
      { path: '/repo/new.md', status: 'created', hunks: [{ before: null, after: 'alpha\n' }] },
      { path: '/repo/note.md', status: 'modified', hunks: [{ before: 'x\n', after: 'y\n' }] },
      { path: '/repo/gone.md', status: 'deleted', hunks: [] },
    ];
    expect(fileToolShape('fileChange', { changes })).toEqual({ kind: 'patch', files });
    expect(fileToolShape('fileChange', { changes: JSON.stringify(changes) })).toEqual({ kind: 'patch', files });
    expect(fileToolShape('fileChange', { input: JSON.stringify(changes) })).toEqual({ kind: 'patch', files });
  });

  it('does not take a tagged object without a change body for a file change', () => {
    expect(fileToolShape('update_task', { input: JSON.stringify({ task: { type: 'delete' } }) })).toBeNull();
    expect(fileToolShape('update_task', { changes: { status: { type: 'update', note: 'done' } } })).toBeNull();
    expect(fileToolShape('update_task', { changes: 'none' })).toBeNull();
  });

  it('still reads an update whose hunk header jsdiff rejects', () => {
    expect(
      fileToolShape('fileChange', { changes: [{ path: 'a.ts', kind: 'update', diff: '@@ -1,9 +1,9 @@\n-x\n+y\n' }] }),
    ).toEqual({ kind: 'patch', files: [{ path: 'a.ts', status: 'modified', hunks: [{ before: 'x\n', after: 'y\n' }] }] });
  });

  it('reads what this daemon makes of a Codex change: a Write or Edit that carries only its path', () => {
    expect(fileToolShape('Write', { file_path: '/repo/page.html', od_diff_stat: { added: 6, removed: 0 } })).toEqual({
      kind: 'patch',
      files: [{ path: '/repo/page.html', status: 'created', hunks: [] }],
    });
    expect(fileToolShape('Edit', { file_path: '/repo/note.md' })).toEqual({
      kind: 'patch',
      files: [{ path: '/repo/note.md', status: 'modified', hunks: [] }],
    });
  });
});

describe('fileToolShape · everything else', () => {
  it('reads an MCP-prefixed name, a base64 body and a delete', () => {
    expect(fileToolShape('mcp__fantay__write_file', { path: 'a.txt', content: 'hi' })?.kind).toBe('write');
    expect(fileToolShape('mcp__fantay__write_file', { path: 'a.png', content: 'iVBORw0KGgo=', encoding: 'base64' })).toEqual({
      kind: 'patch',
      files: [{ path: 'a.png', status: 'modified', hunks: [] }],
    });
    expect(fileToolShape('mcp__fantay__delete_file', { path: 'old/index.html' })).toEqual({
      kind: 'patch',
      files: [{ path: 'old/index.html', status: 'deleted', hunks: [] }],
    });
  });

  it('passes over an empty path field beside a real one', () => {
    expect(fileToolShape('write', { file_path: '', path: ' src/a.ts ', content: 'x' })).toEqual({
      kind: 'write',
      path: 'src/a.ts',
      content: 'x',
    });
    expect(fileToolShape('write', { file_path: '  ', content: 'x' })).toBeNull();
  });

  it('ignores the early form of a call whose input is still streaming', () => {
    expect(fileToolShape('Write', { file_path: '/repo/index.html', [IN_FLIGHT_TOOL_INPUT_MARKER]: true })).toBeNull();
  });

  it.each([
    ['Read', { file_path: '/repo/a.ts', offset: 1, limit: 20 }],
    ['read', { path: 'a.ts' }],
    ['Grep', { pattern: 'hero', path: 'src' }],
    ['Bash', { command: 'npm run build', description: 'Build' }],
    ['TodoWrite', { todos: [{ content: 'Ship', status: 'pending' }] }],
    ['str_replace_editor', { command: 'view', path: '/repo/a.ts' }],
    ['Write', { content: 'no path' }],
    ['Edit', null],
    ['Write', 'just text'],
    [undefined, { file_path: 'a.ts' }],
  ])('%s %j is not a file change', (name, input) => {
    expect(fileToolShape(name, input)).toBeNull();
  });
});
