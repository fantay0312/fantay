// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { importProjectFigma } = vi.hoisted(() => ({ importProjectFigma: vi.fn() }));
vi.mock('../../../src/providers/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/registry')>()),
  importProjectFigma,
}));

import { en } from '../../../src/i18n/locales/en';
import type { Dict } from '../../../src/i18n/types';
import { registerProjectChatSender, resetProjectChatBridgeForTests } from '../../../src/fantay/chat/project-chat-bridge';
import { designNodeActions, sendDesignFigmaSnapshotToChat } from '../../../src/fantay/design/design-node-actions';
import { __resetToastsForTests, useToasts } from '../../../src/fantay/ui';
import { resetWorkspaceBusForTests, subscribeWorkspaceCommand, type WorkspaceCommand } from '../../../src/fantay/workspace/workspace-bus';
import { renderHook } from '@testing-library/react';
import { bytes, installFetch } from './helpers/fake-editor';

const t = (key: keyof Dict, vars?: Record<string, string | number>) =>
  (en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? `{${name}}`));

const FIGMA_RESULT = {
  snapshotDir: 'figma',
  files: ['figma/tree.json'],
  inventory: {},
  contextPath: 'figma/DESIGN-context.md',
  suggestedPrompt: 'Reshape the figma/ snapshot of 首页 into a responsive page.',
  label: '首页.fig',
};

function lastToast() {
  const { result } = renderHook(() => useToasts());
  return result.current.at(-1);
}

beforeEach(() => {
  importProjectFigma.mockReset();
  installFetch([
    (call) =>
      call.url.pathname === '/api/projects/p1/designs/content' && call.url.searchParams.get('path') === 'designs/首页.fig'
        ? new Response(bytes('PK-fig'), { status: 200, headers: { 'X-Design-Sha256': 'sha-1', 'X-Design-Format': 'fig' } })
        : undefined,
  ]);
});

afterEach(() => {
  resetProjectChatBridgeForTests();
  resetWorkspaceBusForTests();
  __resetToastsForTests();
  vi.unstubAllGlobals();
});

describe('designNodeActions', () => {
  it('offers open (bar) and the Figma snapshot (more) for .fig, only open for .op', () => {
    const fig = designNodeActions({ projectId: 'p1', path: 'designs/首页.fig', t });
    expect(fig.map((action) => [action.id, action.labelKey, action.placement])).toEqual([
      ['design.open', 'board.node.openEditor', 'bar'],
      ['design.figmaSnapshot', 'designEditor.figmaSnapshot.action', 'more'],
    ]);
    expect(designNodeActions({ projectId: 'p1', path: 'designs/x.op', t }).map((action) => action.id)).toEqual(['design.open']);
    const readOnly = designNodeActions({ projectId: 'p1', path: 'designs/首页.fig', t, readOnly: true });
    expect(readOnly[1]?.disabledReasonKey).toBe('designEditor.figmaSnapshot.readOnly');
  });

  it('opens the design through workspace.openEditor (or the board override)', () => {
    const commands: WorkspaceCommand[] = [];
    subscribeWorkspaceCommand('workspace.openEditor', (command) => {
      commands.push(command);
      return true;
    });
    void designNodeActions({ projectId: 'p1', path: 'designs/首页.fig', t })[0]!.run();
    expect(commands).toEqual([{ type: 'workspace.openEditor', projectId: 'p1', fileName: 'designs/首页.fig' }]);
    const onOpen = vi.fn();
    void designNodeActions({ projectId: 'p1', path: 'designs/首页.fig', t, onOpen })[0]!.run();
    expect(onOpen).toHaveBeenCalledWith('designs/首页.fig');
  });
});

describe('sendDesignFigmaSnapshotToChat (C9)', () => {
  it('imports the design as a Figma snapshot and sends the reshape prompt to the project chat', async () => {
    importProjectFigma.mockResolvedValue({ ok: true, result: FIGMA_RESULT });
    const sender = vi.fn(async () => true);
    const reveal = vi.fn();
    registerProjectChatSender('p1', sender, { busy: () => false, reveal });
    await expect(sendDesignFigmaSnapshotToChat({ projectId: 'p1', path: 'designs/首页.fig', t })).resolves.toBe('sent');
    const [projectId, file, opts] = importProjectFigma.mock.calls[0] as [string, File, unknown];
    expect(projectId).toBe('p1');
    expect(file.name).toBe('首页.fig');
    expect(await file.text()).toBe('PK-fig');
    expect(opts).toBeUndefined();
    expect(sender).toHaveBeenCalledWith(FIGMA_RESULT.suggestedPrompt, { skillIds: [] });
    expect(reveal).toHaveBeenCalled();
    expect(lastToast()).toMatchObject({ title: 'Sent to chat', tone: 'success' });
  });

  it('reports a busy chat, a failed import and a missing file', async () => {
    importProjectFigma.mockResolvedValue({ ok: true, result: FIGMA_RESULT });
    registerProjectChatSender('p1', async () => true, { busy: () => true, reveal: () => undefined });
    await expect(sendDesignFigmaSnapshotToChat({ projectId: 'p1', path: 'designs/首页.fig', t })).resolves.toBe('failed');
    expect(lastToast()).toMatchObject({ title: "Couldn't send: The chat is still working on the previous request", tone: 'danger' });

    importProjectFigma.mockResolvedValue({ ok: false, error: 'not a Figma file' });
    await expect(sendDesignFigmaSnapshotToChat({ projectId: 'p1', path: 'designs/首页.fig', t })).resolves.toBe('failed');
    expect(lastToast()).toMatchObject({ title: "Couldn't send: not a Figma file" });

    await expect(sendDesignFigmaSnapshotToChat({ projectId: 'p1', path: 'designs/gone.fig', t })).resolves.toBe('failed');
    expect(lastToast()?.title).toContain("Couldn't send: The original file was deleted or renamed.");
  });

  it('fails cleanly when no chat is mounted for the project', async () => {
    importProjectFigma.mockResolvedValue({ ok: true, result: FIGMA_RESULT });
    await expect(sendDesignFigmaSnapshotToChat({ projectId: 'p1', path: 'designs/首页.fig', t })).resolves.toBe('failed');
    expect(lastToast()?.title).toBe(`Couldn't send: ${en['motion.editor.chatUnavailable']}`);
  });
});
