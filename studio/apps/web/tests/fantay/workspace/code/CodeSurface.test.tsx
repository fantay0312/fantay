// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// The 代码 surface end to end in jsdom: which file it shows, the changes view and its fallback, the
// states for files that are not text or fail to load, and the file tree.
import '../../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeSurface, type CodeSurfaceProps } from '../../../../src/fantay/workspace/code/CodeSurface';
import {
  requestCodeSurface,
  resetCodeSurfaceStoreForTests,
} from '../../../../src/fantay/workspace/surfaces/code-surface-store';
import type { TurnFileChange } from '../../../../src/fantay/workspace/surfaces/surface-types';
import { fetchProjectFileText } from '../../../../src/providers/registry';
import type { ProjectFile } from '../../../../src/types';

vi.mock('../../../../src/providers/registry', () => ({ fetchProjectFileText: vi.fn() }));

const fetchText = vi.mocked(fetchProjectFileText);

function file(name: string, extra: Partial<ProjectFile> = {}): ProjectFile {
  return { name, size: 20, mtime: 1, kind: 'code', mime: 'text/plain', ...extra };
}

const FILES: readonly ProjectFile[] = [
  file('README.md', { kind: 'text', mtime: 9 }),
  file('src/app.ts', { mtime: 3 }),
  file('src/lib/util.ts', { mtime: 2 }),
  file('assets/logo.png', { kind: 'image', mime: 'image/png' }),
];
const NO_CHANGES: readonly TurnFileChange[] = [];

/** Text by file name; a name missing here fails to load. */
let texts: Record<string, string> = {};

function renderSurface(overrides: Partial<CodeSurfaceProps> = {}) {
  const props: CodeSurfaceProps = {
    projectId: 'p1',
    files: FILES,
    resolvedDir: '/work/site',
    turnChanges: NO_CHANGES,
    streaming: false,
    onOpenPreview: vi.fn(),
    onActiveFileChange: vi.fn(),
    ...overrides,
  };
  const view = render(<CodeSurface {...props} />);
  return { ...view, props };
}

function editorText(container: HTMLElement): string {
  return container.querySelector('.cm-content')?.textContent ?? '';
}

function currentCrumb(container: HTMLElement): string | null {
  return container.querySelector('[aria-current="page"]')?.textContent ?? null;
}

const sizes = {
  clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight'),
  clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth'),
};

beforeAll(() => {
  // jsdom lays nothing out; the virtualised tree needs a viewport to decide which rows to render.
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 800 });
});

afterAll(() => {
  if (sizes.clientHeight) Object.defineProperty(Element.prototype, 'clientHeight', sizes.clientHeight);
  if (sizes.clientWidth) Object.defineProperty(Element.prototype, 'clientWidth', sizes.clientWidth);
});

beforeEach(() => {
  texts = {
    'README.md': '# Site\n',
    'src/app.ts': 'export const app = 1;\nexport const mode = "new";\n',
    'src/lib/util.ts': 'export const util = true;\n',
  };
  fetchText.mockReset();
  fetchText.mockImplementation(async (_projectId, name) => texts[name] ?? null);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  resetCodeSurfaceStoreForTests();
});

describe('what the surface shows', () => {
  it('says so when the project has no files', () => {
    const { props } = renderSurface({ files: [] });
    expect(screen.getByText('No files in this project yet')).toBeTruthy();
    expect(props.onActiveFileChange).toHaveBeenLastCalledWith(null);
    expect(fetchText).not.toHaveBeenCalled();
  });

  it('opens the most recently modified text file when the turn changed nothing', async () => {
    const { container, props } = renderSurface();
    expect(currentCrumb(container)).toBe('README.md');
    await waitFor(() => expect(editorText(container)).toContain('# Site'));
    expect(props.onActiveFileChange).toHaveBeenLastCalledWith(FILES[0]);
    // Only the file being read is loaded, at the version the list names.
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(fetchText).toHaveBeenCalledWith('p1', 'README.md', expect.objectContaining({ cacheBustKey: 9 }));
  });

  it('opens the turn’s first changed file as changes, and toggles to its source', async () => {
    const turnChanges: TurnFileChange[] = [
      {
        path: 'src/app.ts',
        status: 'modified',
        hunks: [{ before: 'mode = "old"', after: 'mode = "new"' }],
        added: 1,
        removed: 1,
      },
    ];
    const { container } = renderSurface({ turnChanges });
    expect(currentCrumb(container)).toBe('app.ts');
    const toggle = screen.getByRole('button', { name: 'Show source' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(container.querySelector('.cm-deletedChunk')?.textContent).toContain('mode = "old"'));

    fireEvent.click(toggle);
    const back = screen.getByRole('button', { name: /Show changes/ });
    expect(back.getAttribute('aria-pressed')).toBe('false');
    expect(back.textContent).toContain('+1');
    expect(back.textContent).toContain('−1');
    await waitFor(() => expect(container.querySelector('.cm-deletedChunk')).toBeNull());
    expect(editorText(container)).toContain('mode = "new"');
  });

  it('offers no changes toggle for a file the turn did not touch', async () => {
    const { container } = renderSurface();
    await waitFor(() => expect(editorText(container)).toContain('# Site'));
    expect(screen.queryByRole('button', { name: /Show changes|Show source/ })).toBeNull();
  });

  it('tags a file the turn created', () => {
    renderSurface({
      turnChanges: [{ path: 'src/app.ts', status: 'created', hunks: [{ before: null, after: 'x' }], added: 1, removed: 0 }],
    });
    expect(screen.getByText('New file')).toBeTruthy();
  });

  it('lists each edit on its own when the edits cannot be undone into one text', async () => {
    // The edit's result appears twice in the file, so undoing it would be a guess.
    texts['src/app.ts'] = 'same\nsame\n';
    const { container } = renderSurface({
      turnChanges: [
        { path: 'src/app.ts', status: 'modified', hunks: [{ before: 'other', after: 'same' }], added: 1, removed: 1 },
      ],
    });
    await waitFor(() => expect(container.querySelector('[data-type="remove"]')?.textContent).toContain('other'));
    expect(container.querySelector('[data-type="add"]')?.textContent).toContain('same');
    expect(container.querySelector('.cm-editor')).toBeNull();
  });

  it('follows a request for a file and a view', async () => {
    const { container, props } = renderSurface();
    await waitFor(() => expect(editorText(container)).toContain('# Site'));
    act(() => requestCodeSurface('p1', { file: 'src/lib/util.ts', view: 'source' }));
    expect(currentCrumb(container)).toBe('util.ts');
    await waitFor(() => expect(editorText(container)).toContain('export const util'));
    expect(props.onActiveFileChange).toHaveBeenLastCalledWith(FILES[2]);
    // A request for another project is not this surface's business.
    act(() => requestCodeSurface('p2', { file: 'README.md' }));
    expect(currentCrumb(container)).toBe('util.ts');
  });

  it('honours a request made before the surface mounted', () => {
    requestCodeSurface('p1', { file: 'src/app.ts' });
    const { container } = renderSurface();
    expect(currentCrumb(container)).toBe('app.ts');
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(fetchText).toHaveBeenCalledWith('p1', 'src/app.ts', expect.anything());
  });

  it('shows a notice and a preview action for a file that is not text', () => {
    requestCodeSurface('p1', { file: 'assets/logo.png' });
    const { props } = renderSurface();
    expect(screen.getByText("This file can't be shown as text")).toBeTruthy();
    expect(fetchText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(props.onOpenPreview).toHaveBeenCalledWith('assets/logo.png');
  });

  it('reports a failed load and loads again on request', async () => {
    delete texts['README.md'];
    const { container } = renderSurface();
    await screen.findByText("Couldn't load this file");
    texts['README.md'] = '# Back\n';
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(editorText(container)).toContain('# Back'));
    expect(screen.queryByText("Couldn't load this file")).toBeNull();
  });

  it('says a file is loading when it is picked again after a file that is not text', async () => {
    const { container } = renderSurface();
    await waitFor(() => expect(editorText(container)).toContain('# Site'));
    act(() => requestCodeSurface('p1', { file: 'assets/logo.png' }));
    expect(screen.getByText("This file can't be shown as text")).toBeTruthy();
    // Back to the first file, over a load that does not come back.
    fetchText.mockImplementation(() => new Promise<string | null>(() => {}));
    act(() => requestCodeSurface('p1', { file: 'README.md' }));
    expect(currentCrumb(container)).toBe('README.md');
    await waitFor(() => expect(container.querySelector('[class*="skeleton"]')).not.toBeNull());
  });

  it('reloads when the file’s modification time changes, without dropping the text', async () => {
    const { container, rerender, props } = renderSurface();
    await waitFor(() => expect(editorText(container)).toContain('# Site'));
    texts['README.md'] = '# Site\nmore\n';
    const newer = FILES.map((entry) => (entry.name === 'README.md' ? { ...entry, mtime: 10 } : entry));
    rerender(<CodeSurface {...props} files={newer} />);
    // The old text stays up until the new one arrives.
    expect(editorText(container)).toContain('# Site');
    await waitFor(() => expect(editorText(container)).toContain('more'));
    expect(fetchText).toHaveBeenLastCalledWith('p1', 'README.md', expect.objectContaining({ cacheBustKey: 10 }));
  });

  it('falls back when the file being read is removed', async () => {
    const { container, rerender, props } = renderSurface();
    await waitFor(() => expect(editorText(container)).toContain('# Site'));
    rerender(<CodeSurface {...props} files={FILES.filter((entry) => entry.name !== 'README.md')} />);
    expect(currentCrumb(container)).toBe('app.ts');
  });
});

describe('header actions', () => {
  it('remembers the wrap switch', async () => {
    const { container, unmount } = renderSurface();
    await waitFor(() => expect(editorText(container)).toContain('# Site'));
    const wrap = screen.getByRole('button', { name: 'Wrap lines' });
    expect(wrap.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(wrap);
    expect(wrap.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.cm-content')?.classList.contains('cm-lineWrapping')).toBe(true);
    expect(window.localStorage.getItem('fantay:code-surface:wrap')).toBe('1');

    unmount();
    renderSurface();
    expect(screen.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('copies the file as served', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    texts['README.md'] = '# Site\r\nwindows\r\n';
    const { container } = renderSurface();
    await waitFor(() => expect(editorText(container)).toContain('windows'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy file contents' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Site\r\nwindows\r\n'));
  });

  it('opens the preview and copies the absolute path from the more menu', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { props } = renderSurface();
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    // No desktop host in jsdom, so the folder item is left out.
    expect(screen.queryByRole('menuitem', { name: 'Open project folder' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/work/site/README.md'));

    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Preview' }));
    expect(props.onOpenPreview).toHaveBeenCalledWith('README.md');
  });

  it('hides and shows the tree, and remembers it', () => {
    const { container } = renderSurface();
    const root = container.querySelector('[data-testid="code-surface"]')!;
    const toggle = screen.getByRole('button', { name: 'File tree' });
    expect(root.getAttribute('data-tree-open')).toBe('true');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(root.getAttribute('data-tree-open')).toBe('false');
    expect(window.localStorage.getItem('fantay:code-surface:tree')).toBe('0');
  });
});

describe('file tree', () => {
  it('lists folders first with every folder of a small project open, and marks the selection', () => {
    renderSurface();
    const rows = screen.getAllByRole('treeitem').map((row) => row.textContent);
    expect(rows).toEqual(['assets', 'logo.png', 'src', 'lib', 'util.ts', 'app.ts', 'README.md']);
    expect(screen.getByRole('treeitem', { name: 'README.md' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('treeitem', { name: 'src' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('treeitem', { name: 'util.ts' }).getAttribute('aria-level')).toBe('3');
  });

  it('opens a file on click and closes a folder on click', () => {
    const { container } = renderSurface();
    fireEvent.click(screen.getByRole('treeitem', { name: 'app.ts' }));
    expect(currentCrumb(container)).toBe('app.ts');
    fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
    expect(screen.getByRole('treeitem', { name: 'src' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('treeitem', { name: 'app.ts' })).toBeNull();
  });

  it('is one tab stop that the arrow keys move through', () => {
    renderSurface();
    const tabStops = () => screen.getAllByRole('treeitem').filter((row) => row.tabIndex === 0);
    expect(tabStops().map((row) => row.textContent)).toEqual(['README.md']);

    const tree = screen.getByRole('tree');
    act(() => screen.getByRole('treeitem', { name: 'README.md' }).focus());
    fireEvent.keyDown(tree, { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toBe('app.ts');
    expect(tabStops().map((row) => row.textContent)).toEqual(['app.ts']);

    fireEvent.keyDown(tree, { key: 'Home' });
    expect(document.activeElement?.textContent).toBe('assets');
    // Left closes an open folder; Right opens it again, then steps inside.
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(screen.getByRole('treeitem', { name: 'assets' }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(screen.getByRole('treeitem', { name: 'assets' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(document.activeElement?.textContent).toBe('logo.png');
    // Left on a file goes to its folder.
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(document.activeElement?.textContent).toBe('assets');
  });

  it('opens the focused file with Enter', () => {
    const { container } = renderSurface();
    const tree = screen.getByRole('tree');
    act(() => screen.getByRole('treeitem', { name: 'README.md' }).focus());
    fireEvent.keyDown(tree, { key: 'ArrowUp' });
    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(currentCrumb(container)).toBe('app.ts');
  });

  it('filters by path, keeps the folders above a match, and says when nothing matches', () => {
    renderSurface();
    const filter = screen.getByRole('textbox', { name: 'Filter files…' });
    fireEvent.change(filter, { target: { value: 'LIB' } });
    expect(screen.getAllByRole('treeitem').map((row) => row.textContent)).toEqual(['src', 'lib', 'util.ts']);

    fireEvent.change(filter, { target: { value: 'nothing-like-this' } });
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.getByText('No matching files')).toBeTruthy();

    fireEvent.keyDown(filter, { key: 'Escape' });
    expect((filter as HTMLInputElement).value).toBe('');
    expect(screen.getAllByRole('treeitem')).toHaveLength(7);
  });

  it('comes back on the file being read after a filter that matched nothing', () => {
    renderSurface();
    // README.md was revealed on arrival; the person has since picked another file.
    fireEvent.click(screen.getByRole('treeitem', { name: 'app.ts' }));
    const filter = screen.getByRole('textbox', { name: 'Filter files…' });
    fireEvent.change(filter, { target: { value: 'nothing-like-this' } });
    expect(screen.queryByRole('tree')).toBeNull();
    fireEvent.change(filter, { target: { value: '' } });
    const tabStops = screen.getAllByRole('treeitem').filter((row) => row.tabIndex === 0);
    expect(tabStops.map((row) => row.textContent)).toEqual(['app.ts']);
  });

  it('lists what the turn changed; a deleted file cannot be opened', () => {
    const { container } = renderSurface({
      turnChanges: [
        { path: 'src/app.ts', status: 'modified', hunks: [], added: 12, removed: 3 },
        { path: 'old/gone.ts', status: 'deleted', hunks: [], added: 0, removed: 8 },
        { path: 'src/lib/util.ts', status: 'modified', hunks: [], added: 1, removed: 0 },
      ],
    });
    expect(screen.getByText('Changed this turn')).toBeTruthy();
    expect(screen.getByText('All files')).toBeTruthy();
    const changed = screen.getByRole('button', { name: /app\.ts/ });
    expect(changed.textContent).toContain('+12');
    expect(changed.textContent).toContain('−3');
    expect((screen.getByRole('button', { name: /gone\.ts/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /util\.ts/ }));
    expect(currentCrumb(container)).toBe('util.ts');
    // The tree follows the pick: its one tab stop is the file now being read.
    const tabStops = screen.getAllByRole('treeitem').filter((row) => row.tabIndex === 0);
    expect(tabStops.map((row) => row.textContent)).toEqual(['util.ts']);
  });

  it('reveals a folder from the breadcrumb', () => {
    requestCodeSurface('p1', { file: 'src/lib/util.ts' });
    renderSurface();
    // Close the folder first, then ask for it from the path.
    fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
    expect(screen.queryByRole('treeitem', { name: 'lib' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'lib' }));
    expect(screen.getByRole('treeitem', { name: 'lib' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('treeitem', { name: 'lib' }).tabIndex).toBe(0);
  });
});

describe('narrow surface', () => {
  // Under 560px the tree leaves the flow and opens over the viewer.
  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 420 });
  });
  afterEach(() => {
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  });

  it('keeps the tree closed until asked, then puts the caret in the filter', () => {
    const { container } = renderSurface();
    const root = container.querySelector('[data-testid="code-surface"]')!;
    expect(root.hasAttribute('data-narrow')).toBe(true);
    expect(root.getAttribute('data-tree-open')).toBe('false');
    // The wide layout's remembered choice is a different switch and stays untouched.
    fireEvent.click(screen.getByRole('button', { name: 'File tree' }));
    expect(root.getAttribute('data-tree-open')).toBe('true');
    expect(window.localStorage.getItem('fantay:code-surface:tree')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Filter files…' }));
  });

  it('closes on picking a file', () => {
    const { container } = renderSurface();
    const root = container.querySelector('[data-testid="code-surface"]')!;
    fireEvent.click(screen.getByRole('button', { name: 'File tree' }));
    fireEvent.click(screen.getByRole('treeitem', { name: 'app.ts' }));
    expect(currentCrumb(container)).toBe('app.ts');
    expect(root.getAttribute('data-tree-open')).toBe('false');
  });

  it('hands the focus back when a file is picked with the keyboard', () => {
    const { container } = renderSurface();
    const root = container.querySelector('[data-testid="code-surface"]')!;
    const toggle = screen.getByRole('button', { name: 'File tree' });
    fireEvent.click(toggle);
    // From the filter, Down enters the tree on the file being read; Up moves to the one above.
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Filter files…' }), { key: 'ArrowDown' });
    const tree = screen.getByRole('tree');
    expect(tree.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(tree, { key: 'ArrowUp' });
    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(currentCrumb(container)).toBe('app.ts');
    expect(root.getAttribute('data-tree-open')).toBe('false');
    // The panel is gone; focus must not stay inside it.
    expect(document.activeElement).toBe(toggle);
  });

  it('closes on Escape and hands the focus back; a filled filter is cleared first', () => {
    const { container } = renderSurface();
    const root = container.querySelector('[data-testid="code-surface"]')!;
    const toggle = screen.getByRole('button', { name: 'File tree' });
    fireEvent.click(toggle);
    const filter = screen.getByRole('textbox', { name: 'Filter files…' }) as HTMLInputElement;
    fireEvent.change(filter, { target: { value: 'app' } });

    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(filter.value).toBe('');
    expect(root.getAttribute('data-tree-open')).toBe('true');

    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(root.getAttribute('data-tree-open')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  it('closes on a click outside the panel', () => {
    const { container } = renderSurface();
    const root = container.querySelector('[data-testid="code-surface"]')!;
    fireEvent.click(screen.getByRole('button', { name: 'File tree' }));
    const scrim = root.querySelector('[aria-hidden="true"][class*="scrim"]');
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim!);
    expect(root.getAttribute('data-tree-open')).toBe('false');
  });
});

describe('a surface whose tab is hidden', () => {
  // The workspace keeps the surface mounted under `display: none` while another tab shows; a hidden
  // element measures 0 wide and its resize observers fire.
  const resized: Array<() => void> = [];
  const originalObserver = globalThis.ResizeObserver;

  class RecordingResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resized.push(() => callback([], this as unknown as ResizeObserver));
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  function setWidth(width: number): void {
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => width });
  }
  function setHeight(height: number): void {
    Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => height });
  }

  // The virtualised tree takes its observer from the document's own window object.
  const view = document.defaultView as unknown as { ResizeObserver?: unknown };
  const originalViewObserver = view.ResizeObserver;

  beforeEach(() => {
    resized.length = 0;
    globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;
    view.ResizeObserver = RecordingResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = originalObserver;
    view.ResizeObserver = originalViewObserver;
    setWidth(800);
    setHeight(600);
  });

  it('keeps the tree rows it had, so they are there when it shows again', () => {
    const many = Array.from({ length: 50 }, (_, index) => file(`file${index}.ts`, { mtime: index }));
    renderSurface({ files: many });
    const shown = screen.getAllByRole('treeitem').length;
    // A 600px viewport of 28px rows, plus overscan.
    expect(shown).toBeGreaterThan(20);

    setWidth(0);
    setHeight(0);
    act(() => resized.forEach((notify) => notify()));
    expect(screen.getAllByRole('treeitem')).toHaveLength(shown);
  });

  it('carries out a reveal asked for while hidden once it shows again', () => {
    const scrollTo = vi.fn();
    const originalScrollTo = Element.prototype.scrollTo;
    const originalScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
    Element.prototype.scrollTo = scrollTo as unknown as typeof Element.prototype.scrollTo;
    // 50 rows of 28px: without a content height jsdom leaves nowhere to scroll to.
    Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get: () => 1400 });
    try {
      // The first file is the newest, so the surface opens at the top of a tree taller than its rail.
      const many = Array.from({ length: 50 }, (_, index) =>
        file(`file${String(index).padStart(2, '0')}.ts`, { mtime: 100 - index }),
      );
      const { container } = renderSurface({ files: many });
      expect(currentCrumb(container)).toBe('file00.ts');

      setWidth(0);
      setHeight(0);
      act(() => resized.forEach((notify) => notify()));
      scrollTo.mockClear();
      // The agent's choice arrives while the person is on another tab: a hidden tree cannot scroll.
      act(() => requestCodeSurface('p1', { file: 'file49.ts' }));
      expect(currentCrumb(container)).toBe('file49.ts');
      expect(scrollTo).not.toHaveBeenCalled();

      setWidth(800);
      setHeight(600);
      act(() => resized.forEach((notify) => notify()));
      // The last row, brought to the bottom edge of the 600px rail.
      expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 800 }));
    } finally {
      Element.prototype.scrollTo = originalScrollTo;
      if (originalScrollHeight) Object.defineProperty(Element.prototype, 'scrollHeight', originalScrollHeight);
    }
  });

  it('keeps the layout it had, and knows its layout once it has a width', () => {
    setWidth(420);
    const { container } = renderSurface();
    const root = container.querySelector('[data-testid="code-surface"]')!;
    expect(root.hasAttribute('data-narrow')).toBe(true);
    expect(root.hasAttribute('data-unmeasured')).toBe(false);

    setWidth(0);
    act(() => resized.forEach((notify) => notify()));
    expect(root.hasAttribute('data-narrow')).toBe(true);
    expect(root.getAttribute('data-tree-open')).toBe('false');

    // Shown again, wider this time: now it is a real resize.
    setWidth(800);
    act(() => resized.forEach((notify) => notify()));
    expect(root.hasAttribute('data-narrow')).toBe(false);
  });

  it('holds the tree back until it has been measured', () => {
    setWidth(0);
    const { container } = renderSurface();
    const root = container.querySelector('[data-testid="code-surface"]')!;
    expect(root.hasAttribute('data-unmeasured')).toBe(true);
    setWidth(420);
    act(() => resized.forEach((notify) => notify()));
    expect(root.hasAttribute('data-unmeasured')).toBe(false);
    expect(root.hasAttribute('data-narrow')).toBe(true);
  });
});
