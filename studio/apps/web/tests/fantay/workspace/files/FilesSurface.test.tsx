// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// Component tests for `FilesSurface`: empty/loading states, recursive folder counts, folder
// breadcrumb navigation (`onCurrentDirChange`), filter counts unaffected by search, grid/list
// view persistence across remounts, opening files, and read-only (`viewerOnly`) guards.
import '../../helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesSurface, type FilesSurfaceProps } from '../../../../src/fantay/workspace/files/FilesSurface';
import { resetLibraryStoreForTests } from '../../../../src/fantay/workspace/files/library-store';
import { I18nProvider } from '../../../../src/i18n';
import type { ProjectFile, ProjectFolder } from '../../../../src/types';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 760 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 640 });
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ content: '<h1>Landing</h1>', truncated: false }), { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  resetLibraryStoreForTests();
  vi.unstubAllGlobals();
});

function makeFile(name: string, overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    name,
    path: name,
    type: 'file',
    size: 2048,
    mtime: 1_700_000_000_000,
    kind: name.endsWith('.html') ? 'html' : 'binary',
    mime: name.endsWith('.png') ? 'image/png' : 'application/octet-stream',
    ...overrides,
  };
}

const SAMPLE_FILES: ProjectFile[] = [
  makeFile('landing.html', { mtime: 5000 }),
  makeFile('images/poster.png', { size: 0, mtime: 4000 }),
  makeFile('office/report.pdf', { mtime: 3000 }),
  makeFile('office/deep/spec.docx', { mtime: 2000 }),
  makeFile('data/orders.xlsx', { mtime: 1000 }),
];

const SAMPLE_FOLDERS: ProjectFolder[] = [{ name: 'office', path: 'office', type: 'dir', size: 0, mtime: 1000 }];

function renderSurface(overrides: Partial<FilesSurfaceProps> = {}) {
  const props: FilesSurfaceProps = {
    projectId: 'proj-files',
    projectKind: 'prototype',
    files: SAMPLE_FILES,
    folders: SAMPLE_FOLDERS,
    liveArtifacts: [],
    onRefreshFiles: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenLiveArtifact: vi.fn(),
    onRenameFile: vi.fn().mockResolvedValue(true),
    onDeleteFile: vi.fn(),
    onDeleteFiles: vi.fn(),
    onUpload: vi.fn(),
    onUploadFiles: vi.fn(),
    onPaste: vi.fn(),
    onCurrentDirChange: vi.fn(),
    ...overrides,
  };
  const view = render(
    <I18nProvider>
      <FilesSurface {...props} />
    </I18nProvider>,
  );
  return { ...view, props };
}

describe('FilesSurface', () => {
  it('renders loading, syncing and empty states according to workspace authority flags', () => {
    const { unmount } = renderSurface({ files: [], folders: [], filesAuthoritative: false });
    expect(screen.getByTestId('design-files-loading')).toBeTruthy();
    unmount();

    const syncing = renderSurface({ files: [], folders: [], filesAuthoritative: true, downloadPending: true });
    expect(screen.getByTestId('design-files-syncing')).toBeTruthy();
    syncing.unmount();

    renderSurface({ files: [], folders: [], filesAuthoritative: true });
    expect(screen.getByTestId('design-files-empty')).toBeTruthy();
  });

  it('shows recursive folder counts, navigates into folders, and reports currentDir', () => {
    const onCurrentDirChange = vi.fn();
    const onOpenFile = vi.fn();
    renderSurface({ onCurrentDirChange, onOpenFile });

    expect(onCurrentDirChange).toHaveBeenLastCalledWith('');
    // `office` contains both `office/report.pdf` and `office/deep/spec.docx` -> 2 files.
    const officeTile = screen.getByText('office').closest('[data-entry-id="dir:office"]');
    expect(officeTile?.textContent).toContain('2');

    fireEvent.click(officeTile!);
    expect(onCurrentDirChange).toHaveBeenLastCalledWith('office');

    const reportCard = screen.getByText('report.pdf').closest('[data-entry-id="file:office/report.pdf"]');
    fireEvent.click(reportCard!);
    expect(onOpenFile).toHaveBeenCalledWith('office/report.pdf');
  });

  it('keeps filter badge counts stable while searching and clears search from empty results', () => {
    renderSurface();
    const docTab = screen.getByTestId('files-filter-document');
    expect(docTab.textContent).toContain('2');

    const search = screen.getByTestId('files-search') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'poster' } });
    // Filter tab count still reflects all documents in scope.
    expect(screen.getByTestId('files-filter-document').textContent).toContain('2');

    fireEvent.change(search, { target: { value: 'no-such-file-xyz' } });
    expect(screen.getByTestId('files-no-results')).toBeTruthy();
  });

  it('switches between grid and list views and remembers preferences across remount', () => {
    const first = renderSurface();
    expect(screen.getByTestId('files-surface').getAttribute('data-view')).toBe('grid');

    fireEvent.click(screen.getByTestId('files-view-list'));
    expect(screen.getByTestId('files-surface').getAttribute('data-view')).toBe('list');
    first.unmount();

    renderSurface();
    expect(screen.getByTestId('files-surface').getAttribute('data-view')).toBe('list');
  });

  it('disables add actions when viewerOnly is true', () => {
    const onUpload = vi.fn();
    renderSurface({ viewerOnly: true, files: [], folders: [], onUpload });
    const addButton = screen.getByTestId('files-add');
    expect(addButton.getAttribute('aria-disabled')).toBe('true');
    const emptyUpload = screen.getByTestId('design-files-upload-trigger');
    expect(emptyUpload.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(emptyUpload);
    expect(onUpload).not.toHaveBeenCalled();
  });
});
