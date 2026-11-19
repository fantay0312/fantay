// SPDX-License-Identifier: AGPL-3.0-only
// The 代码 surface's tree model: built once from the flat file list, flattened into the rows a
// virtualised list renders.
import { describe, expect, it } from 'vitest';

import {
  ancestorPaths,
  buildFileTree,
  collectDirPaths,
  filterFileTree,
  findDirRowPath,
  flattenFileTree,
  type FileTreeNode,
} from '../../../../src/fantay/workspace/code/file-tree';
import type { ProjectFile } from '../../../../src/types';

function file(name: string, extra: Partial<ProjectFile> = {}): ProjectFile {
  return { name, size: 10, mtime: 1, kind: 'code', mime: 'text/plain', ...extra };
}

/** The tree as indented labels, folders marked with a trailing slash. */
function outline(nodes: readonly FileTreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${'  '.repeat(depth)}${node.label}${node.kind === 'dir' ? '/' : ''}`,
    ...outline(node.children, depth + 1),
  ]);
}

describe('buildFileTree', () => {
  it('puts folders first, then files, each in natural case-insensitive order', () => {
    const tree = buildFileTree([
      file('zeta.ts'),
      file('Beta.ts'),
      file('alpha.ts'),
      file('file10.ts'),
      file('file2.ts'),
      file('lib/b.ts'),
      file('lib/a.ts'),
      file('Assets/logo.svg'),
    ]);
    expect(outline(tree)).toEqual([
      'Assets/',
      '  logo.svg',
      'lib/',
      '  a.ts',
      '  b.ts',
      'alpha.ts',
      'Beta.ts',
      'file2.ts',
      'file10.ts',
      'zeta.ts',
    ]);
  });

  it('folds a chain of single-child folders into one row', () => {
    const tree = buildFileTree([file('src/app/pages/home.tsx'), file('src/app/pages/about.tsx'), file('README.md')]);
    expect(outline(tree)).toEqual(['src/app/pages/', '  about.tsx', '  home.tsx', 'README.md']);
    const chain = tree[0]!;
    expect(chain.path).toBe('src/app/pages');
    expect(chain.headPath).toBe('src');
  });

  it('stops folding where a folder holds a file or more than one folder', () => {
    const tree = buildFileTree([file('src/index.ts'), file('src/app/a/x.ts'), file('src/app/b/y.ts')]);
    expect(outline(tree)).toEqual(['src/', '  app/', '    a/', '      x.ts', '    b/', '      y.ts', '  index.ts']);
  });

  it('keeps the file object and its full path on the leaf', () => {
    const source = file('src/app/page.tsx', { mtime: 42 });
    const leaf = buildFileTree([source])[0]!.children[0]!;
    expect(leaf.kind).toBe('file');
    expect(leaf.path).toBe('src/app/page.tsx');
    expect(leaf.label).toBe('page.tsx');
    expect(leaf.file).toBe(source);
  });

  it('shows an empty folder entry as a folder, not as a file', () => {
    const tree = buildFileTree([file('assets', { type: 'dir' }), file('index.html')]);
    expect(outline(tree)).toEqual(['assets/', 'index.html']);
  });
});

describe('flattenFileTree', () => {
  const tree = buildFileTree([file('a/one.ts'), file('a/sub/two.ts'), file('a/sub/three.ts'), file('b.ts')]);

  it('lists only the rows under open folders', () => {
    expect(flattenFileTree(tree, new Set()).map((row) => row.node.path)).toEqual(['a', 'b.ts']);
    expect(flattenFileTree(tree, new Set(['a'])).map((row) => row.node.path)).toEqual([
      'a',
      'a/sub',
      'a/one.ts',
      'b.ts',
    ]);
  });

  it('opens everything for "all"', () => {
    const rows = flattenFileTree(tree, 'all');
    expect(rows.map((row) => `${row.depth}:${row.node.path}`)).toEqual([
      '0:a',
      '1:a/sub',
      '2:a/sub/three.ts',
      '2:a/sub/two.ts',
      '1:a/one.ts',
      '0:b.ts',
    ]);
    expect(rows.every((row) => row.node.kind === 'file' || row.expanded)).toBe(true);
  });

  it('records each row position among its siblings and its parent row', () => {
    const rows = flattenFileTree(tree, 'all');
    const two = rows.find((row) => row.node.path === 'a/sub/two.ts')!;
    expect([two.posInSet, two.setSize]).toEqual([2, 2]);
    expect(rows[two.parentIndex]!.node.path).toBe('a/sub');
    expect(rows[0]!.parentIndex).toBe(-1);
    expect([rows[0]!.posInSet, rows[0]!.setSize]).toEqual([1, 2]);
  });
});

describe('filterFileTree', () => {
  const tree = buildFileTree([
    file('src/components/Button.tsx'),
    file('src/components/Card.tsx'),
    file('src/pages/index.tsx'),
    file('docs/button-guide.md'),
    file('package.json'),
  ]);

  it('returns the same tree for an empty query', () => {
    expect(filterFileTree(tree, '')).toBe(tree);
    expect(filterFileTree(tree, '   ')).toBe(tree);
  });

  it('keeps the matching files and the folders leading to them, ignoring case', () => {
    expect(outline(filterFileTree(tree, 'BUTTON'))).toEqual([
      'docs/',
      '  button-guide.md',
      'src/',
      '  components/',
      '    Button.tsx',
    ]);
  });

  it('matches on the whole path, so a folder name selects everything inside it', () => {
    expect(outline(filterFileTree(tree, 'components'))).toEqual([
      'src/',
      '  components/',
      '    Button.tsx',
      '    Card.tsx',
    ]);
  });

  it('is empty when nothing matches', () => {
    expect(filterFileTree(tree, 'nope')).toEqual([]);
  });
});

describe('path helpers', () => {
  it('lists the folders above a path', () => {
    expect(ancestorPaths('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(ancestorPaths('c.ts')).toEqual([]);
  });

  it('collects every folder row path in display order', () => {
    const tree = buildFileTree([file('src/app/a/x.ts'), file('src/app/b/y.ts'), file('docs/readme.md')]);
    expect(collectDirPaths(tree)).toEqual(['docs', 'src/app', 'src/app/a', 'src/app/b']);
  });

  it('resolves any folder of a folded chain to the chain row', () => {
    const tree = buildFileTree([file('src/app/a/x.ts'), file('src/app/b/y.ts'), file('docs/readme.md')]);
    expect(findDirRowPath(tree, 'src')).toBe('src/app');
    expect(findDirRowPath(tree, 'src/app')).toBe('src/app');
    expect(findDirRowPath(tree, 'src/app/b')).toBe('src/app/b');
    expect(findDirRowPath(tree, 'docs')).toBe('docs');
    expect(findDirRowPath(tree, 'missing')).toBeNull();
    expect(findDirRowPath(tree, 'src/other')).toBeNull();
  });
});
