import { describe, expect, it } from 'vitest';

import {
  deriveFileOps,
  hasFileMutationToolUse,
  isFileWriteOrEditToolName,
} from '../../src/runtime/file-ops';
import { runProgressSteps } from '../../src/runtime/run-progress';
import type { AgentEvent, ChatMessage } from '../../src/types';

/*
 * pi (the built-in TokenToSea / BYOK agent) and OpenCode name their tools in lowercase
 * (`read` / `write` / `edit` / `bash`) and put the file in `path` / `filePath`. Claude's
 * names are PascalCase with `file_path`. Every consumer that keys off the tool name has to
 * treat both spellings as the same family.
 */

type ToolUse = Extract<AgentEvent, { kind: 'tool_use' }>;
type ToolResult = Extract<AgentEvent, { kind: 'tool_result' }>;

const use = (name: string, input: unknown, id: string): ToolUse => ({ kind: 'tool_use', id, name, input });
const ok = (id: string): ToolResult => ({ kind: 'tool_result', toolUseId: id, content: '', isError: false });

describe('isFileWriteOrEditToolName', () => {
  it.each(['Write', 'write', 'create_file', 'Edit', 'edit', 'MultiEdit', 'multiedit', 'multi_edit', 'str_replace_edit'])(
    '%s is a write/edit',
    (name) => {
      expect(isFileWriteOrEditToolName(name)).toBe(true);
    },
  );

  it.each(['read', 'Read', 'bash', 'Bash', 'grep', 'find', 'ls', 'delete', 'todowrite', '', undefined, null, 7])(
    '%s is not',
    (name) => {
      expect(isFileWriteOrEditToolName(name)).toBe(false);
    },
  );
});

describe('deriveFileOps · pi tool names', () => {
  it('aggregates lowercase read / write / edit by their `path`', () => {
    const events: AgentEvent[] = [
      use('read', { path: '/repo/index.html', offset: 1, limit: 80 }, 't1'),
      ok('t1'),
      use('write', { path: '/repo/notes.md', content: 'hi' }, 't2'),
      ok('t2'),
      use('edit', { path: '/repo/index.html', edits: [{ oldText: 'a', newText: 'b' }] }, 't3'),
      ok('t3'),
    ];
    const rows = deriveFileOps(events);
    expect(rows.map((row) => [row.fullPath, row.ops])).toEqual([
      ['/repo/index.html', ['read', 'edit']],
      ['/repo/notes.md', ['write']],
    ]);
    expect(rows[0]?.readRanges).toEqual([{ offset: 1, limit: 80 }]);
    expect(rows.every((row) => row.status === 'done')).toBe(true);
  });

  it('keeps a failed pi edit as an error', () => {
    const events: AgentEvent[] = [
      use('edit', { path: '/repo/index.html', edits: [{ oldText: 'a', newText: 'b' }] }, 't1'),
      { kind: 'tool_result', toolUseId: 't1', content: 'no match', isError: true },
    ];
    expect(deriveFileOps(events)[0]).toMatchObject({ ops: ['edit'], status: 'error' });
  });

  it('a bash that deletes a file is a delete op, whichever way `bash` is capitalised', () => {
    for (const name of ['bash', 'Bash']) {
      const rows = deriveFileOps([use(name, { command: 'rm old.html' }, 't1'), ok('t1')]);
      expect(rows.map((row) => [row.fullPath, row.ops])).toEqual([['old.html', ['delete']]]);
    }
  });

  it('claude PascalCase names classify exactly as before', () => {
    const rows = deriveFileOps([
      use('Read', { file_path: '/repo/a.ts' }, 't1'),
      ok('t1'),
      use('Write', { file_path: '/repo/b.ts', content: 'x' }, 't2'),
      ok('t2'),
      use('Edit', { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' }, 't3'),
      ok('t3'),
    ]);
    expect(rows.map((row) => [row.fullPath, row.ops])).toEqual([
      ['/repo/a.ts', ['read', 'edit']],
      ['/repo/b.ts', ['write']],
    ]);
  });
});

describe('hasFileMutationToolUse · pi tool names', () => {
  it('counts pi write and edit', () => {
    expect(hasFileMutationToolUse([use('write', { path: 'a.md', content: 'x' }, 't1')])).toBe(true);
    expect(hasFileMutationToolUse([use('edit', { path: 'a.md', edits: [] }, 't1')])).toBe(true);
  });

  it('does not count reads, searches or a plain bash', () => {
    expect(
      hasFileMutationToolUse([
        use('read', { path: 'a.md' }, 't1'),
        use('grep', { pattern: 'x' }, 't2'),
        use('bash', { command: 'npm test' }, 't3'),
      ]),
    ).toBe(false);
  });
});

describe('runProgressSteps · pi tool shapes', () => {
  const assistant = (events: AgentEvent[]): ChatMessage => ({ id: 'a1', role: 'assistant', content: '', events });

  it('names the file from `path` and files `ls` / `find` under search', () => {
    const steps = runProgressSteps([
      assistant([
        use('read', { path: '/work/p/index.html' }, '1'),
        use('edit', { path: '/work/p/styles/site.css', edits: [{ oldText: 'a', newText: 'b' }] }, '2'),
        use('find', { pattern: '*.png' }, '3'),
        use('ls', { path: 'assets' }, '4'),
        use('bash', { command: 'pnpm build' }, '5'),
      ]),
    ]);
    expect(steps.map((step) => [step.category, step.target])).toEqual([
      ['run', 'pnpm build'],
      ['search', 'assets'],
      ['search', '*.png'],
      ['edit', 'site.css'],
      ['read', 'index.html'],
    ]);
  });

  it('takes the anchor from the last edits[] replacement of an html edit', () => {
    const [step] = runProgressSteps([
      assistant([
        use(
          'edit',
          {
            path: 'index.html',
            edits: [
              { oldText: '<h1>Old</h1>', newText: '<h1>First heading goes here</h1>' },
              { oldText: '<p>Old</p>', newText: '<p>Second paragraph is the deepest point</p>' },
            ],
          },
          '1',
        ),
      ]),
    ]);
    expect(step?.anchor).toBe('Second paragraph is the deepest point');
  });
});
