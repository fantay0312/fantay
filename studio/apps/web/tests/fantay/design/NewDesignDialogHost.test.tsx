// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectFile } from '@open-design/contracts';

const { session, fetchProjectFiles } = vi.hoisted(() => ({
  session: { current: null as null | { projectId: string; readOnly: boolean } },
  fetchProjectFiles: vi.fn(),
}));
vi.mock('../../../src/fantay/shell/project-bridge', () => ({ getActiveProjectSession: () => session.current }));
vi.mock('../../../src/providers/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/registry')>()),
  fetchProjectFiles,
}));
vi.mock('../../../src/fantay/design/DesignCreationRunner', () => ({ DesignCreationRunner: () => null }));

import { NewDesignDialogHost, creationSourceFor, projectFileChoices } from '../../../src/fantay/design/NewDesignDialogHost';
import {
  getNewDesignRequest,
  openNewDesignDialog,
  rememberDesignWorkspaceContext,
  resetNewDesignStoreForTests,
  updateDesignCreationJob,
  useDesignCreationJobs,
} from '../../../src/fantay/design/new-design-store';
import { resetFantayCommandsForTests, runFantayCommand } from '../../../src/fantay/shell/commands';

function file(name: string, type: ProjectFile['type'] = 'file'): ProjectFile {
  return { name, path: name, type, size: 1, mtime: 1, kind: 'html', mime: 'text/html' };
}

let jobs: ReturnType<typeof useDesignCreationJobs> = [];
function JobsProbe() {
  jobs = useDesignCreationJobs();
  return null;
}

beforeEach(() => {
  session.current = null;
  fetchProjectFiles.mockResolvedValue([file('index.html'), file('designs/首页.fig'), file('assets', 'dir'), file('notes.md')]);
});

afterEach(() => {
  cleanup();
  resetNewDesignStoreForTests();
  resetFantayCommandsForTests();
  vi.clearAllMocks();
});

describe('NewDesignDialogHost', () => {
  it('registers fantay.design.import for the open project (file source); declines without one', () => {
    render(<NewDesignDialogHost />);
    expect(runFantayCommand('fantay.design.import')).toBe(false);
    session.current = { projectId: 'p1', readOnly: true };
    expect(runFantayCommand('fantay.design.import')).toBe(false);
    session.current = { projectId: 'p1', readOnly: false };
    rememberDesignWorkspaceContext('p1', null);
    let handled = false;
    act(() => {
      handled = runFantayCommand('fantay.design.import');
    });
    expect(handled).toBe(true);
    expect(getNewDesignRequest()).toMatchObject({ projectId: 'p1', initialSource: 'file', origin: 'menu' });
    expect(screen.getByRole('dialog', { name: 'New design' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Import a local file' })).toHaveAttribute('aria-checked', 'true');
  });

  it('loads the project pages and designs, starts a creation job and closes once it is done', async () => {
    render(
      <>
        <NewDesignDialogHost />
        <JobsProbe />
      </>,
    );
    await act(async () => {
      openNewDesignDialog({ projectId: 'p1', origin: 'board', sourceNodeId: 'n9' });
    });
    expect(fetchProjectFiles).toHaveBeenCalledWith('p1', { workspaceContext: null, fresh: true });
    await act(async () => undefined);
    expect(screen.getByTestId('new-design-path')).toHaveTextContent('designs/Untitled-design.fig');
    fireEvent.change(screen.getByTestId('new-design-name'), { target: { value: '首页' } });
    expect(screen.getByTestId('new-design-path')).toHaveTextContent('designs/首页-2.fig');
    fireEvent.click(screen.getByTestId('new-design-create'));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: 'queued',
      input: { projectId: 'p1', title: '首页', path: 'designs/首页-2.fig', source: { kind: 'blank' }, sourceNodeId: 'n9', origin: 'dialog' },
    });
    expect(screen.getByTestId('new-design-create')).toHaveAttribute('aria-busy', 'true');

    act(() => updateDesignCreationJob(jobs[0]!.id, { status: 'failed', error: 'engine down' }));
    expect(screen.getByRole('alert')).toHaveTextContent('engine down');

    fireEvent.click(screen.getByTestId('new-design-create'));
    expect(jobs).toHaveLength(2);
    act(() => updateDesignCreationJob(jobs[1]!.id, { status: 'done', path: 'designs/首页-2.fig' }));
    expect(getNewDesignRequest()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('classifies project files and maps dialog documents onto creation sources', () => {
    expect(projectFileChoices([file('b.html'), file('a.htm'), file('designs/x.op'), file('img.png'), file('dir', 'dir')])).toEqual({
      htmlFiles: [
        { path: 'a.htm', name: 'a.htm' },
        { path: 'b.html', name: 'b.html' },
      ],
      existingDesignPaths: ['designs/x.op'],
    });
    const upload = new File(['x'], 'a.svg');
    expect(creationSourceFor({ kind: 'project', projectId: 'p', path: 'designs/a.fig', createIfMissing: true })).toEqual({ kind: 'blank' });
    expect(creationSourceFor({ kind: 'convert-html', projectId: 'p', path: 'designs/a.fig', sourcePath: 'a.html' })).toEqual({ kind: 'convert-html', sourcePath: 'a.html' });
    expect(creationSourceFor({ kind: 'import-file', projectId: 'p', path: 'designs/a.fig', file: upload })).toEqual({ kind: 'import-file', file: upload });
  });
});
