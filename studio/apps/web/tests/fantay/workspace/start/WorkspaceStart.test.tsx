// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Start page of the side workspace: the structure and test ids the host depends on, browse and search
// content, tracking, and the keyboard model it gets from cmdk (one selection, Enter, Escape, Tab).
import '../../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextItem } from '@open-design/contracts';

import {
  WorkspaceStart,
  type WorkspaceStartAction,
  type WorkspaceStartProps,
  type WorkspaceStartSuggestion,
  type WorkspaceStartTool,
} from '../../../../src/fantay/workspace/start/WorkspaceStart';
import type { ProjectFile } from '../../../../src/types';

const MINUTE = 60_000;

function file(name: string, kind: ProjectFile['kind'], mtime: number, extra: Partial<ProjectFile> = {}): ProjectFile {
  return { name, path: name, type: 'file', size: 64, mtime, kind, mime: 'text/plain', ...extra };
}

function tab(id: string, label: string, extra: Partial<WorkspaceContextItem> = {}): WorkspaceContextItem {
  return { id, kind: 'browser', label, tabId: `__browser__:${id}`, ...extra };
}

function makeTools(): WorkspaceStartTool[] {
  return [
    { id: 'board', iconName: 'layout', label: 'Board', hint: 'Lay out, generate and compare', run: vi.fn() },
    { id: 'files', iconName: 'folder', label: 'Files', hint: 'Browse and manage project files', run: vi.fn() },
    { id: 'code', iconName: 'file-code', label: 'Code', hint: 'File tree, source and changes', run: vi.fn() },
  ];
}

function makeActions(): WorkspaceStartAction[] {
  return [
    { id: 'create-document', iconName: 'file', label: 'New document', run: vi.fn() },
    { id: 'upload', iconName: 'upload', label: 'Upload', run: vi.fn() },
  ];
}

function makeProps(overrides: Partial<WorkspaceStartProps> = {}): WorkspaceStartProps {
  const now = Date.now();
  return {
    tools: makeTools(),
    actions: makeActions(),
    suggestions: [],
    files: [
      file('index.html', 'html', now - 3 * 24 * 60 * MINUTE),
      file('src/pages/pricing.html', 'html', now - 5 * MINUTE - 1_000),
      file('notes.md', 'text', now - 2 * 60 * MINUTE),
      file('assets', 'binary', now, { type: 'dir' }),
    ],
    openTabs: [],
    openTabNames: [],
    onOpenFile: vi.fn(),
    onOpenTab: vi.fn(),
    onShowAllFiles: vi.fn(),
    onTrack: vi.fn(),
    ...overrides,
  };
}

function setup(overrides: Partial<WorkspaceStartProps> = {}) {
  const props = makeProps(overrides);
  const view = render(<WorkspaceStart {...props} />);
  return { props, view };
}

/** Hidden from assistive tech while the field is empty, so it is looked up by its label attribute. */
function clearButton(): HTMLElement {
  return screen.getByLabelText('Clear');
}

function page(): HTMLElement {
  return screen.getByTestId('workspace-start-page');
}

function search(): HTMLInputElement {
  return screen.getByTestId('tab-launcher-search') as HTMLInputElement;
}

function type(value: string) {
  fireEvent.change(search(), { target: { value } });
}

function selected(): Element | null {
  return page().querySelector('[cmdk-item][aria-selected="true"]');
}

function fileRows(): string[] {
  return screen.queryAllByTestId('tab-launcher-result').map((row) => row.getAttribute('aria-label') ?? '');
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WorkspaceStart — structure', () => {
  it('is a named region whose search field is the first input and takes focus on mount', () => {
    const { props } = setup();
    expect(page()).toHaveAttribute('role', 'region');
    expect(page()).toHaveAttribute('aria-label', 'New tab');
    expect(page().querySelector('input')).toBe(search());
    expect(document.activeElement).toBe(search());
    expect(search()).toHaveAttribute('placeholder', 'Search files, tabs or tools…');
    expect(props.onTrack).toHaveBeenCalledTimes(1);
    expect(props.onTrack).toHaveBeenCalledWith({ element: 'open' });
  });

  it('lists the tools with their hints and runs one on click without a tracking event of its own', () => {
    const { props } = setup();
    const board = screen.getByTestId('workspace-tool-board');
    expect(board.tagName).toBe('BUTTON');
    expect(board).toHaveTextContent('Board');
    expect(board).toHaveTextContent('Lay out, generate and compare');
    expect(screen.getByTestId('workspace-tool-code')).toHaveTextContent('Code');

    fireEvent.click(screen.getByTestId('workspace-tool-files'));
    expect(props.tools[1]!.run).toHaveBeenCalledTimes(1);
    expect(props.tools[0]!.run).not.toHaveBeenCalled();
    expect(props.onTrack).toHaveBeenCalledTimes(1);
  });

  it('runs a create action and tracks it; a read-only viewer gets none', () => {
    const { props, view } = setup();
    fireEvent.click(screen.getByTestId('workspace-action-create-document'));
    expect(props.actions[0]!.run).toHaveBeenCalledTimes(1);
    expect(props.onTrack).toHaveBeenLastCalledWith({ element: 'create', action_id: 'create-document' });

    view.rerender(<WorkspaceStart {...props} actions={[]} />);
    expect(screen.queryByTestId('workspace-action-create-document')).toBeNull();
    expect(screen.queryByText('Upload')).toBeNull();
  });

  it('shows the suggested section only when the router picked something', () => {
    const { props, view } = setup();
    expect(screen.queryByText('Suggested')).toBeNull();

    const suggestions: WorkspaceStartSuggestion[] = [
      { id: 'changes', iconName: 'sparkles', label: "Review this turn's changes", meta: '3 files', run: vi.fn() },
    ];
    view.rerender(<WorkspaceStart {...props} suggestions={suggestions} />);
    expect(screen.getByText('Suggested')).toBeInTheDocument();
    const row = screen.getByTestId('workspace-suggestion-changes');
    expect(row).toHaveTextContent("Review this turn's changes");
    expect(row).toHaveTextContent('3 files');
    fireEvent.click(row);
    expect(suggestions[0]!.run).toHaveBeenCalledTimes(1);
  });
});

describe('WorkspaceStart — recent files', () => {
  it('lists files newest first, skips folders, and marks the ones already open', () => {
    const { props } = setup({ openTabNames: ['notes.md'] });
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(fileRows()).toEqual(['src/pages/pricing.html', 'notes.md', 'index.html']);

    const [pricing, notes] = screen.getAllByTestId('tab-launcher-result');
    // base name first, the folder after it, a relative time at the far end
    expect(pricing).toHaveTextContent('pricing.html');
    expect(pricing).toHaveTextContent('src/pages');
    expect(pricing).toHaveTextContent('5m ago');
    expect(notes).toHaveTextContent('Open');
    expect(notes).not.toHaveTextContent('ago');

    fireEvent.click(pricing!);
    expect(props.onOpenFile).toHaveBeenCalledWith('src/pages/pricing.html');
    expect(props.onTrack).toHaveBeenLastCalledWith({ element: 'open_file', file_kind: 'html' });
  });

  it('keeps the eight newest files', () => {
    const files = Array.from({ length: 12 }, (_, index) => file(`page-${index}.html`, 'html', 1_000 + index));
    setup({ files });
    expect(fileRows()).toEqual(['page-11.html', 'page-10.html', 'page-9.html', 'page-8.html', 'page-7.html', 'page-6.html', 'page-5.html', 'page-4.html']);
  });

  it('selects and opens files whose names carry spaces, dots, quotes or non-ASCII text', () => {
    const names = ['dir with space/My File.final.v2.md', '.env', 'quote"s/it\'s.md', '深/文件.md', 'trailing space '];
    const { props } = setup({ files: names.map((name, index) => file(name, 'text', 1_000 - index)) });
    expect(fileRows()).toEqual(names);

    for (const row of screen.getAllByTestId('tab-launcher-result')) {
      fireEvent.pointerMove(row);
      expect(selected()).toBe(row);
      expect(page().querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
      fireEvent.keyDown(search(), { key: 'Enter' });
      expect(props.onOpenFile).toHaveBeenLastCalledWith(row.getAttribute('aria-label'));
    }
    expect(props.onOpenFile).toHaveBeenCalledTimes(names.length);

    type('文件');
    expect(fileRows()).toEqual(['深/文件.md']);
  });

  it('opens the files surface from the header and disappears with the last file', () => {
    const { props, view } = setup();
    fireEvent.click(screen.getByTestId('workspace-start-all-files'));
    expect(props.onShowAllFiles).toHaveBeenCalledTimes(1);

    view.rerender(<WorkspaceStart {...props} files={[]} />);
    expect(screen.queryByText('Recent')).toBeNull();
    expect(screen.queryByTestId('workspace-start-all-files')).toBeNull();
    expect(screen.queryAllByTestId('tab-launcher-result')).toHaveLength(0);
  });
});

describe('WorkspaceStart — search', () => {
  it('replaces the page with one grouped result list', () => {
    const { props } = setup({
      openTabs: [
        tab('1', 'Reference', { url: 'https://example.com/pricing' }),
        { id: 'f1', kind: 'file', label: 'pricing.html', tabId: 'src/pages/pricing.html', path: 'src/pages/pricing.html' },
      ],
      openTabNames: ['__browser__:1', 'src/pages/pricing.html'],
    });
    type('PRICING');

    expect(page()).toHaveAttribute('data-mode', 'search');
    expect(screen.queryByText('Recent')).toBeNull();
    expect(screen.queryByTestId('workspace-tool-board')).toBeNull();
    expect(screen.queryByTestId('workspace-action-upload')).toBeNull();

    // An open tab matches on its address, a file on its path, case-insensitively. The open file is
    // listed once, under Files, so the only tab row is the browser.
    const tabRow = screen.getByTestId('tab-launcher-tab-result');
    expect(tabRow).toHaveTextContent('Reference');
    expect(tabRow).toHaveTextContent('Open');
    expect(screen.getByText('Open tabs')).toBeInTheDocument();
    expect(fileRows()).toEqual(['src/pages/pricing.html']);
    expect(screen.getByTestId('tab-launcher-result')).toHaveTextContent('Open');

    fireEvent.click(tabRow);
    expect(props.onOpenTab).toHaveBeenCalledWith('__browser__:1');
    expect(props.onTrack).toHaveBeenLastCalledWith({ element: 'open_tab', tab_kind: 'browser' });
  });

  it('finds tools by label or hint and create actions by label', () => {
    const { props } = setup();
    type('generate');
    expect(screen.getByTestId('workspace-tool-board')).toHaveTextContent('Board');
    expect(screen.queryByTestId('workspace-tool-files')).toBeNull();

    type('upl');
    fireEvent.click(screen.getByTestId('workspace-action-upload'));
    expect(props.actions[1]!.run).toHaveBeenCalledTimes(1);
    expect(props.onTrack).toHaveBeenLastCalledWith({ element: 'create', action_id: 'upload' });
  });

  it('ranks a file-name match above a folder match and caps files at 50 and tabs at 20', () => {
    const files = [
      file('report/summary.md', 'text', 9_000),
      file('docs/report.md', 'text', 1_000),
      ...Array.from({ length: 60 }, (_, index) => file(`bulk/item-${index}.txt`, 'text', index)),
    ];
    const openTabs = Array.from({ length: 25 }, (_, index) => tab(String(index), `Bulk tab ${index}`));
    setup({ files, openTabs });

    type('report');
    expect(fileRows()).toEqual(['docs/report.md', 'report/summary.md']);

    type('bulk');
    expect(screen.getAllByTestId('tab-launcher-result')).toHaveLength(50);
    expect(screen.getAllByTestId('tab-launcher-tab-result')).toHaveLength(20);
  });

  it('says so when nothing matches, and never lists a folder', () => {
    setup();
    type('assets');
    expect(screen.queryAllByTestId('tab-launcher-result')).toHaveLength(0);
    expect(screen.getByTestId('tab-launcher-empty')).toHaveTextContent('Nothing matches “assets”');

    type('index');
    expect(screen.queryByTestId('tab-launcher-empty')).toBeNull();
  });

  it('follows the file list while searching: a vanished selection moves on, an emptied list says so', () => {
    const { props, view } = setup();
    type('html');
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(selected()).toHaveAttribute('aria-label', 'index.html');

    // the selected file and another one go away in the same update
    view.rerender(<WorkspaceStart {...props} files={[file('late.html', 'html', 5)]} />);
    expect(selected()).toHaveAttribute('aria-label', 'late.html');

    view.rerender(<WorkspaceStart {...props} files={[]} />);
    expect(selected()).toBeNull();
    expect(screen.getByTestId('tab-launcher-empty')).toHaveTextContent('Nothing matches “html”');

    view.rerender(<WorkspaceStart {...props} files={[file('back.html', 'html', 9)]} />);
    expect(screen.queryByTestId('tab-launcher-empty')).toBeNull();
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(props.onOpenFile).toHaveBeenCalledWith('back.html');
  });

  it('offers a clear button only while there is text', () => {
    setup();
    const clear = clearButton();
    expect(clear).toHaveAttribute('data-visible', 'false');
    expect(clear).toHaveAttribute('tabindex', '-1');
    expect(clear).toHaveAttribute('aria-hidden', 'true');

    type('index');
    expect(clear).toHaveAttribute('data-visible', 'true');
    expect(clear).toHaveAttribute('tabindex', '0');
    expect(within(page()).getByRole('button', { name: 'Clear' })).toBe(clear);

    fireEvent.click(clear);
    expect(search().value).toBe('');
    expect(document.activeElement).toBe(search());
    expect(page()).toHaveAttribute('data-mode', 'browse');
  });
});

describe('WorkspaceStart — keyboard', () => {
  it('moves one selection through every item in visual order, wrapping, and runs it on Enter', () => {
    const suggestions: WorkspaceStartSuggestion[] = [
      { id: 'latest', iconName: 'eye', label: 'Open index.html', meta: 'Latest result', run: vi.fn() },
    ];
    const { props } = setup({ suggestions });
    const order = [
      screen.getByTestId('workspace-suggestion-latest'),
      screen.getByTestId('workspace-tool-board'),
      screen.getByTestId('workspace-tool-files'),
      screen.getByTestId('workspace-tool-code'),
      screen.getByTestId('workspace-action-create-document'),
      screen.getByTestId('workspace-action-upload'),
      screen.getByTestId('workspace-start-all-files'),
      ...screen.getAllByTestId('tab-launcher-result'),
    ];

    // cmdk starts on the first item
    expect(selected()).toBe(order[0]);
    for (const next of order.slice(1)) {
      fireEvent.keyDown(search(), { key: 'ArrowDown' });
      expect(selected()).toBe(next);
    }
    expect(page().querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
    expect(search()).toHaveAttribute('aria-activedescendant', order[order.length - 1]!.id);

    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(selected()).toBe(order[0]);
    fireEvent.keyDown(search(), { key: 'ArrowUp' });
    expect(selected()).toBe(order[order.length - 1]);

    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(props.onOpenFile).toHaveBeenCalledTimes(1);
    expect(props.onOpenFile).toHaveBeenCalledWith('index.html');
  });

  it('keeps a selection when the selected row goes away together with others', () => {
    const suggestions: WorkspaceStartSuggestion[] = [
      { id: 'changes', iconName: 'sparkles', label: 'Review changes', run: vi.fn() },
      { id: 'latest', iconName: 'eye', label: 'Open index.html', run: vi.fn() },
    ];
    const { props, view } = setup({ suggestions });
    expect(selected()).toBe(screen.getByTestId('workspace-suggestion-changes'));

    view.rerender(<WorkspaceStart {...props} suggestions={[]} />);
    expect(selected()).toBe(screen.getByTestId('workspace-tool-board'));
  });

  it('selects the first result while searching, so Enter opens it', () => {
    const { props } = setup();
    type('notes');
    expect(selected()).toBe(screen.getByTestId('tab-launcher-result'));
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(props.onOpenFile).toHaveBeenCalledWith('notes.md');
    expect(props.onTrack).toHaveBeenLastCalledWith({ element: 'open_file', file_kind: 'text' });
  });

  it('clears the query on Escape and leaves an empty Escape to the host', () => {
    const onHostKeyDown = vi.fn();
    render(
      <div onKeyDown={onHostKeyDown}>
        <WorkspaceStart {...makeProps()} />
      </div>,
    );
    type('notes');
    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(search().value).toBe('');
    expect(page()).toHaveAttribute('data-mode', 'browse');
    expect(onHostKeyDown).not.toHaveBeenCalled();

    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(onHostKeyDown).toHaveBeenCalledTimes(1);
  });

  it('makes a row focused with Tab the selection, so Enter runs that row once', () => {
    const { props } = setup();
    const code = screen.getByTestId('workspace-tool-code');
    act(() => code.focus());
    expect(selected()).toBe(code);

    fireEvent.keyDown(code, { key: 'Enter' });
    expect(props.tools[2]!.run).toHaveBeenCalledTimes(1);
    expect(props.tools[0]!.run).not.toHaveBeenCalled();
  });

  it('hands focus back to the field when an arrow key is pressed on a focused row', () => {
    setup();
    const files = screen.getByTestId('workspace-tool-files');
    act(() => files.focus());
    fireEvent.keyDown(files, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(search());
    expect(selected()).toBe(screen.getByTestId('workspace-tool-code'));
  });

  it('keeps Enter on the clear button from running the selected row', () => {
    const { props } = setup();
    type('board');
    fireEvent.keyDown(clearButton(), { key: 'Enter' });
    expect(props.tools[0]!.run).not.toHaveBeenCalled();
  });

  it('leaves Home and End to the caret while the field has text', () => {
    setup();
    type('html');
    const first = selected();
    expect(screen.getAllByTestId('tab-launcher-result')).toHaveLength(2);
    // fireEvent returns false when the default was prevented, which is what would pin the caret
    expect(fireEvent.keyDown(search(), { key: 'End' })).toBe(true);
    expect(fireEvent.keyDown(search(), { key: 'Home', shiftKey: true })).toBe(true);
    expect(selected()).toBe(first);

    // with nothing typed there is no caret to move, and cmdk jumps to the last row
    type('');
    expect(fireEvent.keyDown(search(), { key: 'End' })).toBe(false);
    const rows = screen.getAllByTestId('tab-launcher-result');
    expect(selected()).toBe(rows[rows.length - 1]);
  });

  it('runs the focused row on Enter even after the pointer moved the selection elsewhere', () => {
    const { props } = setup();
    const code = screen.getByTestId('workspace-tool-code');
    const board = screen.getByTestId('workspace-tool-board');
    act(() => code.focus());
    // cmdk selects on pointer move; the focus ring stays on Code.
    fireEvent.pointerMove(board);
    expect(selected()).toBe(board);

    fireEvent.keyDown(code, { key: 'Enter' });
    expect(props.tools[2]!.run).toHaveBeenCalledTimes(1);
    expect(props.tools[0]!.run).not.toHaveBeenCalled();
    expect(selected()).toBe(code);
  });

  it('names the selected row to assistive tech from the search field at every step', () => {
    const { props, view } = setup();
    // on mount, before any key or pointer
    expect(search()).toHaveAttribute('aria-activedescendant', screen.getByTestId('workspace-tool-board').id);

    // a row that took focus
    const code = screen.getByTestId('workspace-tool-code');
    act(() => code.focus());
    expect(search()).toHaveAttribute('aria-activedescendant', code.id);

    // the first result of a search, which is a new row
    type('notes');
    expect(search()).toHaveAttribute('aria-activedescendant', screen.getByTestId('tab-launcher-result').id);

    // a selection that survives the query going away: the same value on a row that was remounted
    type('board');
    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(selected()).toBe(screen.getByTestId('workspace-tool-board'));
    expect(search()).toHaveAttribute('aria-activedescendant', screen.getByTestId('workspace-tool-board').id);

    // nothing to select
    view.rerender(<WorkspaceStart {...props} tools={[]} actions={[]} files={[]} />);
    expect(selected()).toBeNull();
    expect(search()).not.toHaveAttribute('aria-activedescendant');
  });
});
