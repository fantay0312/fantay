// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { forwardRef, useImperativeHandle, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignSelection, ProjectFile, WorkspaceContextItem } from '@open-design/contracts';

const { hostProps, exportHtml, share } = vi.hoisted(() => ({
  hostProps: { current: null as null | Record<string, unknown> },
  exportHtml: vi.fn(async () => '<h1>x</h1>'),
  share: vi.fn(),
}));

vi.mock('../../../src/fantay/design/DesignEditorHost', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/fantay/design/DesignEditorHost')>();
  const Stub = forwardRef<unknown, Record<string, unknown>>(function Stub(props, ref) {
    hostProps.current = props;
    useImperativeHandle(ref, () => ({ exportHtml, flush: vi.fn(), exportCover: vi.fn(), command: vi.fn(), select: vi.fn(), insert: vi.fn(), focus: vi.fn() }));
    return <div data-testid="host-stub">{props.headerEnd as ReactNode}</div>;
  });
  return { ...original, DesignEditorHost: Stub };
});
vi.mock('../../../src/fantay/design/share', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/fantay/design/share')>()),
  shareDesignAsWebPage: share,
}));
vi.mock('../../../src/components/share/TokenToSeaSharePanel', () => ({
  TokenToSeaSharePanel: (props: { projectId: string; fileName: string }) => (
    <div data-testid="share-panel">{`${props.projectId}:${props.fileName}`}</div>
  ),
}));

import { DesignDocumentViewer } from '../../../src/fantay/design/DesignDocumentViewer';
import { registerFantayCommand, resetFantayCommandsForTests } from '../../../src/fantay/shell/commands';
import { getEditorContext, resetEditorContextsForTests } from '../../../src/fantay/editors/editor-context-store';
import { resetWorkspaceBusForTests, subscribeWorkspaceCommand, type WorkspaceCommand } from '../../../src/fantay/workspace/workspace-bus';

const FILE: ProjectFile = { name: 'designs/首页.fig', path: 'designs/首页.fig', type: 'file', size: 9, mtime: 1, kind: 'binary', mime: 'application/octet-stream' };
const SELECTION: DesignSelection = { pageId: '0:1', nodeIds: ['1:2'], nodes: [{ id: '1:2', name: 'Hero', type: 'FRAME', width: 1440, height: 900 }] };

function props(): Record<string, (...args: unknown[]) => unknown> {
  if (!hostProps.current) throw new Error('host not rendered');
  return hostProps.current as Record<string, (...args: unknown[]) => unknown>;
}

function ready(): void {
  act(() => {
    props().onStateChange?.({ phase: 'editing', readOnly: false, dirty: false, saving: false, lastSavedAt: null, sha256: 's', conflict: null, error: null, zoom: 1 });
  });
}

beforeEach(() => {
  hostProps.current = null;
  share.mockReset();
  exportHtml.mockClear();
});

afterEach(() => {
  cleanup();
  resetEditorContextsForTests();
  resetWorkspaceBusForTests();
  document.getElementById('app-chrome-file-actions')?.remove();
  resetFantayCommandsForTests();
});

describe('DesignDocumentViewer', () => {
  it('opens the file as a project document (read-only for viewers)', () => {
    const { rerender } = render(<DesignDocumentViewer projectId="p1" file={FILE} />);
    expect(hostProps.current?.document).toEqual({ kind: 'project', projectId: 'p1', path: 'designs/首页.fig', readOnly: false });
    expect(hostProps.current?.active).toBe(true);
    rerender(<DesignDocumentViewer projectId="p1" file={FILE} viewerOnly active={false} />);
    expect(hostProps.current?.document).toEqual({ kind: 'project', projectId: 'p1', path: 'designs/首页.fig', readOnly: true });
    expect(hostProps.current?.active).toBe(false);
  });

  it('reports the selection as chat context (C2) and clears it when emptied or unmounted', () => {
    const onActiveContextChange = vi.fn();
    const view = render(<DesignDocumentViewer projectId="p1" file={FILE} onActiveContextChange={onActiveContextChange} />);
    act(() => {
      props().onSelectionChange?.({ ...SELECTION, projectId: 'p1', path: 'designs/首页.fig' });
    });
    const item = getEditorContext('p1', 'designs/首页.fig') as WorkspaceContextItem;
    expect(item).toMatchObject({ kind: 'file', path: 'designs/首页.fig', label: '首页.fig · Hero', tabId: 'designs/首页.fig' });
    expect(onActiveContextChange).toHaveBeenLastCalledWith(item);

    act(() => {
      props().onSelectionChange?.({ pageId: '0:1', nodeIds: [], nodes: [], projectId: 'p1', path: 'designs/首页.fig' });
    });
    expect(getEditorContext('p1', 'designs/首页.fig')).toBeNull();
    expect(onActiveContextChange).toHaveBeenLastCalledWith(null);

    act(() => {
      props().onSelectionChange?.({ ...SELECTION, projectId: 'p1', path: 'designs/首页.fig' });
    });
    view.unmount();
    expect(getEditorContext('p1', 'designs/首页.fig')).toBeNull();
    expect(onActiveContextChange).toHaveBeenLastCalledWith(null);
  });

  it('forwards app shortcuts from the editor to the shell commands', () => {
    const search = vi.fn();
    registerFantayCommand('fantay.search', search);
    render(<DesignDocumentViewer projectId="p1" file={FILE} />);
    expect(hostProps.current?.forwardShortcuts).toEqual(['$mod+KeyK', '$mod+Comma']);
    props().onShortcut?.('$mod+KeyK');
    props().onShortcut?.('$mod+KeyZ');
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('follows a replaced document (save as copy) to its new tab', () => {
    const commands: WorkspaceCommand[] = [];
    subscribeWorkspaceCommand('workspace.openEditor', (command) => {
      commands.push(command);
      return true;
    });
    render(<DesignDocumentViewer projectId="p1" file={FILE} />);
    props().onDocumentReplaced?.({ projectId: 'p1', path: 'designs/首页-2.fig' });
    expect(commands).toEqual([{ type: 'workspace.openEditor', projectId: 'p1', fileName: 'designs/首页-2.fig' }]);
  });

  it('puts Share into the workspace file-actions slot: save as web page, then the project share panel', async () => {
    const slot = document.createElement('div');
    slot.id = 'app-chrome-file-actions';
    slot.dataset.appChromeFileActions = 'true';
    document.body.appendChild(slot);
    share.mockResolvedValue({ htmlPath: 'designs/首页.html', created: false });
    render(<DesignDocumentViewer projectId="p1" file={FILE} />);
    const button = screen.getByTestId('design-share');
    expect(slot.contains(button)).toBe(true);
    expect(button).toHaveAttribute('aria-disabled', 'true'); // still opening
    ready();
    expect(screen.getByTestId('design-share')).not.toHaveAttribute('aria-disabled');
    await act(async () => {
      fireEvent.click(screen.getByTestId('design-share'));
    });
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ exportHtml: expect.any(Function) }), {
      projectId: 'p1',
      path: 'designs/首页.fig',
      workspaceContext: null,
    });
    expect(screen.getByTestId('share-panel')).toHaveTextContent('p1:designs/首页.html');
    expect(screen.getByTestId('share-panel').closest('[data-fx-legacy]')).not.toBeNull();
  });

  it('explains why Share is unavailable for viewers and while a run streams', () => {
    const { rerender } = render(<DesignDocumentViewer projectId="p1" file={FILE} viewerOnly />);
    ready();
    expect(screen.getByTestId('design-share')).toHaveAttribute('aria-disabled', 'true');
    rerender(<DesignDocumentViewer projectId="p1" file={FILE} runInFlight />);
    expect(screen.getByTestId('design-share')).toHaveAttribute('aria-disabled', 'true');
    rerender(<DesignDocumentViewer projectId="p1" file={FILE} active={false} />);
    expect(screen.queryByTestId('design-share')).toBeNull();
  });
});
