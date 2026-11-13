// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesignCreationRunner } from '../../../src/fantay/design/DesignCreationRunner';
import { peekDesignOpenRequest, resetDesignOpenRequestsForTests } from '../../../src/fantay/design/design-open-requests';
import { getDesignCreationJob, resetNewDesignStoreForTests, startDesignCreation } from '../../../src/fantay/design/new-design-store';
import { __resetToastsForTests } from '../../../src/fantay/ui';
import { resetWorkspaceBusForTests, subscribeWorkspaceCommand, type WorkspaceCommand } from '../../../src/fantay/workspace/workspace-bus';
import { FakeEditor, bytes, connectFakeEditor, designSummary, installFetch, jsonResponse, settle, type FetchCall } from './helpers/fake-editor';

const editors: FakeEditor[] = [];
let commands: WorkspaceCommand[] = [];

beforeEach(() => {
  commands = [];
  subscribeWorkspaceCommand('board.insert', (command) => {
    commands.push(command);
    return true;
  });
  subscribeWorkspaceCommand('workspace.openEditor', (command) => {
    commands.push(command);
    return true;
  });
});

afterEach(() => {
  cleanup();
  for (const editor of editors.splice(0)) editor.close();
  resetNewDesignStoreForTests();
  resetDesignOpenRequestsForTests();
  resetWorkspaceBusForTests();
  __resetToastsForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const listRoute = (paths: string[]) => (call: FetchCall) =>
  call.method === 'GET' && call.url.pathname === '/api/projects/p1/designs'
    ? jsonResponse({ designs: paths.map((path) => designSummary('p1', path, 'sha')) })
    : undefined;

describe('DesignCreationRunner', () => {
  it('creates a blank design in a hidden editor, then opens it and puts it on the board', async () => {
    installFetch([
      listRoute(['designs/新页面.fig']),
      (call) =>
        call.method === 'PUT' && call.url.pathname === '/api/projects/p1/designs/content'
          ? jsonResponse({ design: designSummary('p1', call.url.searchParams.get('path') ?? '', 'sha-new'), created: true, previousSha256: null }, 201)
          : undefined,
    ]);
    const jobId = startDesignCreation({ projectId: 'p1', title: '新页面', source: { kind: 'blank' }, sourceNodeId: 'frame-1', origin: 'dialog' });
    render(<DesignCreationRunner />);
    await settle(() => screen.queryByTestId('design-editor-frame') !== null);
    expect(screen.getByTestId('design-creation-runner')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('design-editor-host')).toHaveAttribute('data-mode', 'headless');
    const editor = connectFakeEditor(screen.getByTestId('design-editor-frame') as HTMLIFrameElement);
    editors.push(editor);
    await settle(() => editor.requestsOf('document.open').length === 1);
    expect(editor.requestsOf('document.open')[0]?.payload).toEqual({
      source: 'blank',
      identity: { kind: 'project', projectId: 'p1', path: 'designs/新页面-2.fig' },
      name: '新页面',
      pageName: 'Page 1',
    });
    expect(getDesignCreationJob(jobId)?.status).toBe('running');

    const saved = await editor.request('document.save', { bytes: bytes('PK'), format: 'fig', baseSha256: null, reason: 'convert' });
    expect(saved).toMatchObject({ ok: true, payload: { path: 'designs/新页面-2.fig' } });
    await settle(() => getDesignCreationJob(jobId)?.status === 'done');
    expect(editor.requestsOf('document.flush')[0]?.payload).toEqual({ reason: 'switch' });
    expect(getDesignCreationJob(jobId)?.path).toBe('designs/新页面-2.fig');
    expect(commands).toEqual([
      { type: 'board.insert', projectId: 'p1', select: true, drafts: [{ kind: 'design', path: 'designs/新页面-2.fig', title: '新页面', sourceNodeId: 'frame-1' }] },
      { type: 'workspace.openEditor', projectId: 'p1', fileName: 'designs/新页面-2.fig' },
    ]);
    await settle(() => screen.queryByTestId('design-editor-frame') === null);
  });

  it('stores .fig imports as they are (no editor), moving on to a free name', async () => {
    const puts: string[] = [];
    installFetch([
      listRoute([]),
      (call) => {
        if (call.method !== 'PUT') return undefined;
        const path = call.url.searchParams.get('path') ?? '';
        puts.push(path);
        if (path === 'designs/Landing.fig') return jsonResponse({ error: { code: 'CONFLICT', message: 'exists', details: { currentSha256: 'x' } } }, 409);
        return jsonResponse({ design: designSummary('p1', path, 'sha-imported'), created: true, previousSha256: null }, 201);
      },
    ]);
    const file = new File(['PK-figma'], 'Landing.fig');
    const jobId = startDesignCreation({ projectId: 'p1', title: 'Landing', path: 'designs/Landing.fig', source: { kind: 'import-file', file } });
    render(<DesignCreationRunner />);
    await settle(() => getDesignCreationJob(jobId)?.status === 'done');
    expect(screen.queryByTestId('design-editor-frame')).toBeNull();
    expect(puts).toEqual(['designs/Landing.fig', 'designs/Landing-2.fig']);
    expect(commands).toEqual([
      { type: 'board.insert', projectId: 'p1', select: true, drafts: [{ kind: 'design', path: 'designs/Landing-2.fig', title: 'Landing' }] },
      { type: 'workspace.openEditor', projectId: 'p1', fileName: 'designs/Landing-2.fig' },
    ]);
  });

  it('fails the job with the reason when the editor cannot open the source, and forgets the request', async () => {
    installFetch([listRoute([])]);
    const jobId = startDesignCreation({ projectId: 'p1', title: 'Page', source: { kind: 'blank' } });
    render(<DesignCreationRunner />);
    await settle(() => screen.queryByTestId('design-editor-frame') !== null);
    const editor = connectFakeEditor(screen.getByTestId('design-editor-frame') as HTMLIFrameElement);
    editors.push(editor);
    editor.on('document.open', () => Promise.reject({ code: 'PARSE_FAILED', message: 'cannot build the page' }));
    await settle(() => getDesignCreationJob(jobId)?.status === 'failed');
    expect(getDesignCreationJob(jobId)?.error).toBe("This file couldn't be read");
    expect(peekDesignOpenRequest('p1', 'designs/Page.fig')).toBeNull();
    expect(commands).toEqual([]);
  });

  it('lets only the first mounted runner work the queue', async () => {
    installFetch([listRoute([])]);
    startDesignCreation({ projectId: 'p1', title: 'One', source: { kind: 'blank' } });
    render(
      <>
        <DesignCreationRunner />
        <DesignCreationRunner />
      </>,
    );
    await settle(() => screen.queryAllByTestId('design-creation-runner').length > 0);
    await settle();
    expect(screen.getAllByTestId('design-creation-runner')).toHaveLength(1);
  });
});
