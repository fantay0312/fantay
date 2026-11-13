import { describe, expect, it } from 'vitest';
import type { PersistedAgentEvent } from '@open-design/contracts';
import { buildTurnBlocks } from '../../../src/runtime/chat/build-turn-blocks';
import type { ExecutionShell, ToolRow, TurnBlock } from '../../../src/runtime/chat/contract';
import { diffStat } from '../../../src/runtime/chat/format';
import {
  commandOf,
  fileOf,
  isCommandTool,
  isRawCommandTitle,
  isSnapshotTool,
  searchPattern,
  toolKind,
  toolTitle,
} from '../../../src/runtime/chat/tool-kind';

/*
 * The built-in TokenToSea / BYOK agent runs on pi (`--mode rpc`). The daemon forwards pi's
 * native tool names (lowercase) and argument shapes untouched, so the chat has to read
 * them the same way it reads Claude's `Read` / `Edit` and OpenCode's `filePath` forms:
 *
 *   read   { path, offset?, limit? }
 *   write  { path, content }
 *   edit   { path, edits: [{ oldText, newText }] }   ← several replacements in one call
 *   bash   { command, timeout? }
 *   grep / find / ls   { pattern?, path? }
 *   todowrite  { todos: [{ content, status }] }
 */

describe('pi tools · classification', () => {
  it.each([
    ['read', { path: 'index.html' }, 'read'],
    ['write', { path: 'index.html', content: '<html/>' }, 'write'],
    ['edit', { path: 'index.html', edits: [{ oldText: 'a', newText: 'b' }] }, 'edit'],
    ['grep', { pattern: 'hero', path: 'src' }, 'search'],
    ['find', { pattern: '*.html', path: '.' }, 'search'],
    ['ls', { path: 'assets' }, 'search'],
    ['bash', { command: 'npm run build', timeout: 60 }, 'exec'],
  ] as const)('%s → %s', (name, input, kind) => {
    expect(toolKind(name, input)).toBe(kind);
  });

  it('bash is a command tool whose command is read from `command`', () => {
    expect(isCommandTool('bash')).toBe(true);
    expect(commandOf({ command: 'npm run build', timeout: 60 })).toBe('npm run build');
  });

  it('bash still looks inside the command, so a pi `cat` is a read and a redirect is a write', () => {
    expect(toolKind('bash', { command: 'cat index.html' })).toBe('read');
    expect(toolKind('bash', { command: "cat > card.html <<'EOF'\n<div/>\nEOF" })).toBe('write');
  });

  it('todowrite is a snapshot tool; an MCP todo tool is too, other MCP tools are not classified', () => {
    expect(isSnapshotTool('todowrite')).toBe(true);
    expect(isSnapshotTool('mcp__fantay__todo_write')).toBe(true);
    expect(toolKind('mcp__fantay__fetch_page', { url: 'https://example.com' })).toBe('other');
  });
});

describe('pi tools · file target', () => {
  it('takes the file from `path`', () => {
    expect(fileOf({ path: '/work/proj/index.html', offset: 10, limit: 40 })).toEqual({
      path: '/work/proj/index.html',
      label: 'index.html',
    });
    expect(fileOf({ path: 'src/hero.css', edits: [] })).toEqual({ path: 'src/hero.css', label: 'hero.css' });
  });

  it('a bash call has no file field', () => {
    expect(fileOf({ command: 'ls', timeout: 5 })).toBeNull();
  });
});

describe('pi tools · edit diff stat sums every entry of edits[]', () => {
  it('adds the lines across entries', () => {
    expect(
      diffStat('edit', {
        path: 'index.html',
        edits: [
          { oldText: 'a', newText: 'b' },
          { oldText: 'one\ntwo\nthree', newText: 'x\ny' },
        ],
      }),
    ).toEqual({ added: 1 + 2, removed: 1 + 3 });
  });

  it('a single-entry edit counts like a Claude Edit', () => {
    expect(diffStat('edit', { path: 'a.md', edits: [{ oldText: 'a\nb', newText: 'x\ny\nz' }] })).toEqual(
      diffStat('Edit', { file_path: 'a.md', old_string: 'a\nb', new_string: 'x\ny\nz' }),
    );
  });

  it('an entry with an empty replacement is a deletion-shaped edit, not a skipped one', () => {
    expect(diffStat('edit', { path: 'a.md', edits: [{ oldText: 'a\nb', newText: '' }] })).toEqual({
      added: 1,
      removed: 2,
    });
  });

  it('skips entries that carry no old text, and gives up when none do', () => {
    expect(
      diffStat('edit', {
        path: 'a.md',
        edits: [{ newText: 'orphan' }, { oldText: 'a', newText: 'b' }, null, 'x'],
      }),
    ).toEqual({ added: 1, removed: 1 });
    expect(diffStat('edit', { path: 'a.md', edits: [{ newText: 'orphan' }] })).toBeNull();
    expect(diffStat('edit', { path: 'a.md', edits: [] })).toBeNull();
    expect(diffStat('edit', { path: 'a.md' })).toBeNull();
  });

  it('reads a top-level oldText / newText pair when there is no edits[]', () => {
    expect(diffStat('edit', { path: 'a.md', oldText: 'a', newText: 'b\nc' })).toEqual({ added: 2, removed: 1 });
  });

  it('write counts its content lines', () => {
    expect(diffStat('write', { path: 'a.md', content: 'a\nb\nc' })).toEqual({ added: 3, removed: 0 });
  });

  it("OpenCode's oldString / newString is read the same way", () => {
    expect(diffStat('edit', { filePath: '/p/a.md', oldString: 'a', newString: 'b\nc' })).toEqual({
      added: 2,
      removed: 1,
    });
  });

  it("Claude's old_string / new_string is unchanged", () => {
    expect(diffStat('Edit', { file_path: '/p/a.md', old_string: 'a\nb', new_string: 'x\ny\nz' })).toEqual({
      added: 3,
      removed: 2,
    });
  });
});

describe('pi tools · search row text', () => {
  it('grep and find answer with their pattern', () => {
    expect(searchPattern('grep', { pattern: 'hero-title', path: 'src' })).toBe('hero-title');
    expect(searchPattern('find', { pattern: '*.html', path: '.' })).toBe('*.html');
  });

  it('ls answers with a real directory, but not with the current one', () => {
    expect(searchPattern('ls', { path: 'assets' })).toBe('assets');
    expect(searchPattern('ls', { path: '.' })).toBeNull();
    expect(searchPattern('ls', { path: './' })).toBeNull();
    expect(searchPattern('ls', { limit: 50 })).toBeNull();
    expect(searchPattern('ls', {})).toBeNull();
  });

  it('a bash `ls docs` is unchanged', () => {
    expect(searchPattern('bash', { command: 'ls docs' })).toBe('docs');
  });
});

describe('pi tools · bash title', () => {
  it('has no description, so the command is the title and is shown raw', () => {
    const input = { command: 'npm run build', timeout: 120 };
    expect(toolTitle('bash', input)).toBe('npm run build');
    expect(isRawCommandTitle('bash', input)).toBe(true);
  });
});

/* ── through the turn builder: what the chat would actually draw ───────────── */

function call(
  id: string,
  name: string,
  input: unknown,
  content = 'ok',
  isError = false,
): PersistedAgentEvent[] {
  return [
    { kind: 'tool_use', id, name, input },
    { kind: 'tool_result', toolUseId: id, content, isError },
  ];
}

const shells = (blocks: TurnBlock[]): ExecutionShell[] =>
  blocks.filter((b): b is ExecutionShell => b.kind === 'shell');
const toolRows = (shell: ExecutionShell | undefined): ToolRow[] =>
  (shell?.items ?? []).filter((i): i is ToolRow => i.kind === 'tool');

describe('pi tools · execution record rows', () => {
  const events: PersistedAgentEvent[] = [
    ...call('t-read', 'read', { path: '/work/p/index.html', offset: 20, limit: 40 }, '<!doctype html>'),
    ...call('t-write', 'write', { path: '/work/p/hello.txt', content: 'a\nb' }, 'Successfully wrote to hello.txt'),
    ...call(
      't-edit',
      'edit',
      {
        path: '/work/p/index.html',
        edits: [
          { oldText: 'font-size: 28px;', newText: 'font-size: 40px;' },
          { oldText: '.cta {\n}', newText: '.cta {\n  color: red;\n}' },
        ],
      },
      'Successfully replaced 2 block(s) in index.html.',
    ),
    ...call('t-bash', 'bash', { command: 'npm run build', timeout: 120 }, 'built'),
    ...call('t-grep', 'grep', { pattern: 'hero', path: 'src' }, 'src/a.css:1:.hero\nsrc/b.css:9:.hero'),
    ...call('t-find', 'find', { pattern: '*.html' }, 'index.html\nabout.html\ncontact.html'),
    ...call('t-ls', 'ls', { path: 'assets' }, 'logo.svg\nhero.png'),
  ];
  const rows = toolRows(shells(buildTurnBlocks({ events, runStatus: 'succeeded' }))[0]);
  const row = (id: string): ToolRow => {
    const found = rows.find((r) => r.id === id);
    if (!found) throw new Error(`row ${id} missing`);
    return found;
  };

  it('draws one row per call, in order', () => {
    expect(rows.map((r) => r.id)).toEqual([
      't-read', 't-write', 't-edit', 't-bash', 't-grep', 't-find', 't-ls',
    ]);
  });

  it('read → the file and the requested range', () => {
    const r = row('t-read');
    expect(r.tool).toBe('read');
    expect(r.file).toEqual({ path: '/work/p/index.html', label: 'index.html' });
    expect(r.readRange).toEqual({ offset: 20, limit: 40 });
  });

  it('write → the file and +N −0', () => {
    const r = row('t-write');
    expect(r.tool).toBe('write');
    expect(r.file).toEqual({ path: '/work/p/hello.txt', label: 'hello.txt' });
    expect(r.delta).toEqual({ added: 2, removed: 0 });
  });

  it('edit → the file and the diff summed over edits[]', () => {
    const r = row('t-edit');
    expect(r.tool).toBe('edit');
    expect(r.file).toEqual({ path: '/work/p/index.html', label: 'index.html' });
    expect(r.delta).toEqual({ added: 1 + 3, removed: 1 + 2 });
  });

  it('bash → an exec row that carries its command and output', () => {
    const r = row('t-bash');
    expect(r.tool).toBe('exec');
    expect(r.command).toBe('npm run build');
    expect(r.rawTitle).toBe(true);
    expect(r.terminal).toBe('built');
    expect(r.file).toBeNull();
  });

  it('grep / find / ls → search rows with their pattern and hit count', () => {
    expect(row('t-grep')).toMatchObject({ tool: 'search', pattern: 'hero', hits: 2 });
    expect(row('t-find')).toMatchObject({ tool: 'search', pattern: '*.html', hits: 3 });
    expect(row('t-ls')).toMatchObject({ tool: 'search', pattern: 'assets', hits: 2 });
  });

  it('a failed edit keeps its file and reason', () => {
    const failed = toolRows(
      shells(
        buildTurnBlocks({
          events: call('t-bad', 'edit', { path: 'a.md', edits: [{ oldText: 'x', newText: 'y' }] }, 'Could not find the text', true),
          runStatus: 'failed',
        }),
      )[0],
    );
    expect(failed[0]).toMatchObject({
      tool: 'edit',
      failed: true,
      failReason: 'Could not find the text',
      file: { path: 'a.md', label: 'a.md' },
    });
  });
});

describe('pi tools · todowrite', () => {
  it('lands as the execution plan, with each step in its status', () => {
    const blocks = buildTurnBlocks({
      events: [
        {
          kind: 'tool_use',
          id: 'plan-1',
          name: 'todowrite',
          input: {
            todos: [
              { content: '读现有首屏', status: 'completed' },
              { content: '改标题层级', status: 'in_progress' },
              { content: '调按钮对比度', status: 'pending' },
            ],
          },
        },
        { kind: 'tool_result', toolUseId: 'plan-1', content: 'Plan updated: 1/3 completed.', isError: false },
      ],
      runStatus: 'running',
    });
    const todos = (shells(blocks)[0]?.items ?? []).flatMap((item) =>
      item.kind === 'todo' ? [[item.segment.content, item.segment.status]] : [],
    );
    expect(todos).toEqual([
      ['读现有首屏', 'completed'],
      ['改标题层级', 'in_progress'],
      ['调按钮对比度', 'pending'],
    ]);
  });
});
