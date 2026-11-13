// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// The DeepSeek Harness slots Fantay draws outside plugin pages, and the session props their entries get.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginInputDock, PluginSidebarFooterActions } from '../../../src/fantay/plugins/HarnessSlots';
import type { HarnessSessionListState, HarnessSessionSnapshot, HarnessSessionStatus } from '../../../src/fantay/plugins/harness-session';
import { toolPluginRuntime } from '../../../src/fantay/plugins/runtime';
import {
  NO_RUNNING_CONVERSATIONS,
  resetFantayProjectBridgeForTests,
  useFantayProjectBridge,
  type FantayProjectBridgeInput,
} from '../../../src/fantay/shell/project-bridge';
import type { Conversation } from '../../../src/types';

const host = vi.hoisted(() => ({
  toolPlugins: { list: async () => [], setEnabled: async () => ({ ok: true as const, plugins: [] }) },
}));
vi.mock('@open-design/host', async (original) => ({
  ...(await original<typeof import('@open-design/host')>()),
  getOpenDesignHost: () => host,
}));

function conversation(id: string, updatedAt: number, extra: Partial<Conversation> = {}): Conversation {
  return { id, updatedAt, messageCount: 2, ...extra } as Conversation;
}

function bridgeInput(overrides: Partial<FantayProjectBridgeInput> = {}): FantayProjectBridgeInput {
  return {
    projectId: 'p1',
    projectName: 'Landing',
    designSystemId: null,
    designSystems: [],
    conversations: [conversation('c1', 20), conversation('c2', 10, { messageCount: 0 })],
    activeConversationId: 'c1',
    runningConversationIds: NO_RUNNING_CONVERSATIONS,
    readOnly: false,
    projectMetadata: null,
    mediaProviders: undefined,
    onNewConversation: vi.fn(),
    onSelectConversation: vi.fn(),
    onChangeDesignSystem: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
}

function Bridge({ input }: { input: FantayProjectBridgeInput }) {
  useFantayProjectBridge(input);
  return null;
}

interface DockProps {
  sessionId?: string;
  session?: HarnessSessionSnapshot;
  input?: { draft: string };
  useSessionStatus(select: (status: ReadonlyMap<string, HarnessSessionStatus>) => HarnessSessionStatus | undefined): HarnessSessionStatus | undefined;
  useSessions(): HarnessSessionListState;
  useSession(): HarnessSessionSnapshot | undefined;
}

// Reads the session the way a Harness plugin does: its own status out of the status map.
function DockEntry({ sessionId, session, input, useSessionStatus, useSessions, useSession }: DockProps) {
  const status = useSessionStatus(snapshot => (sessionId ? snapshot.get(sessionId) : undefined));
  const list = useSessions();
  const bound = useSession();
  return (
    <output data-testid="dock-entry">
      {JSON.stringify({
        sessionId,
        running: status?.running,
        ownerRunning: session?.running,
        boundRunning: bound?.running,
        ids: list.ids,
        blank: list.byId.c2?.blank,
        draft: input?.draft,
      })}
    </output>
  );
}

function entryState(): Record<string, unknown> {
  return JSON.parse(screen.getByTestId('dock-entry').textContent ?? '{}') as Record<string, unknown>;
}

describe('Harness slots in Fantay', () => {
  const disposers: (() => void)[] = [];

  beforeEach(() => {
    window.localStorage.clear();
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    // Declares the slots; a second start on the shared runtime is a no-op.
    toolPluginRuntime.start({ openPage: vi.fn(), runCommand: vi.fn(() => false) });
  });

  afterEach(() => {
    cleanup();
    for (const dispose of disposers.splice(0)) dispose();
    resetFantayProjectBridgeForTests();
    vi.unstubAllEnvs();
  });

  it('draws dock entries above the composer with the running state of their conversation', async () => {
    disposers.push(toolPluginRuntime.slots.add({ name: 'conversation.input.dock', id: 'recommend', order: 30 }, DockEntry, 'dsh-sample'));
    const view = render(
      <>
        <Bridge input={bridgeInput()} />
        <PluginInputDock sessionId="c1" />
      </>,
    );
    await vi.waitFor(() => expect(screen.getByTestId('chat-plugin-dock').hidden).toBe(false));
    expect(entryState()).toEqual({
      sessionId: 'c1', running: false, ownerRunning: false, boundRunning: false, ids: ['c1', 'c2'], blank: true, draft: '',
    });

    view.rerender(
      <>
        <Bridge input={bridgeInput({ runningConversationIds: ['c1'] })} />
        <PluginInputDock sessionId="c1" />
      </>,
    );
    await vi.waitFor(() => expect(entryState()).toMatchObject({ running: true, ownerRunning: true, boundRunning: true }));
  });

  it('keeps the dock mounted but hidden without entries or without a conversation', async () => {
    const view = render(<PluginInputDock sessionId="c1" />);
    expect(screen.getByTestId('chat-plugin-dock').hidden).toBe(true);

    await act(async () => {
      disposers.push(toolPluginRuntime.slots.add({ name: 'conversation.input.dock', id: 'recommend' }, DockEntry, 'dsh-sample'));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(screen.getByTestId('chat-plugin-dock').hidden).toBe(false));

    view.rerender(<PluginInputDock sessionId={null} />);
    expect(screen.getByTestId('chat-plugin-dock').hidden).toBe(true);
    expect(screen.queryByTestId('dock-entry')).toBeNull();
  });

  it('draws sidebar foot actions with the column state, and survives one that throws', async () => {
    expect(render(<PluginSidebarFooterActions />).container.firstChild).toBeNull();
    cleanup();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    disposers.push(toolPluginRuntime.slots.add(
      { name: 'sidebar.footer.action', id: 'open', order: 10 },
      ({ wide }: { wide: boolean }) => <button type="button">{wide ? 'Open theatre' : 'T'}</button>,
      'dsh-sample',
    ));
    disposers.push(toolPluginRuntime.slots.add(
      { name: 'sidebar.footer.action', id: 'broken', order: 20 },
      () => { throw new Error('broken action'); },
      'dsh-broken',
    ));
    try {
      render(<PluginSidebarFooterActions />);
      await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Open theatre' })).toBeTruthy());
      expect(screen.getByTestId('fantay-sidebar-plugin-actions').querySelectorAll('button')).toHaveLength(1);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
