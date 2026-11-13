// @vitest-environment jsdom
import { renderToString } from 'react-dom/server';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NO_RUNNING_CONVERSATIONS,
  getActiveProjectSession,
  resetFantayProjectBridgeForTests,
  runProjectCommand,
  useActiveProjectSession,
  useFantayProjectBridge,
  type FantayProjectBridgeInput,
} from '../../../src/fantay/shell/project-bridge';
import type {
  Conversation,
  DesignSystemSummary,
  MediaProviderCredentials,
  ProjectMetadata,
} from '../../../src/types';

const CONVERSATIONS = [{ id: 'c1' }, { id: 'c2' }] as unknown as Conversation[];
const DESIGN_SYSTEMS = [{ id: 'ds-1' }] as unknown as DesignSystemSummary[];
const METADATA: ProjectMetadata = { kind: 'prototype' };
const MEDIA_PROVIDERS: Record<string, MediaProviderCredentials> = { openai: { apiKey: '', baseUrl: '' } };

function bridgeInput(overrides: Partial<FantayProjectBridgeInput> = {}): FantayProjectBridgeInput {
  return {
    projectId: 'p1',
    projectName: 'Landing',
    designSystemId: 'ds-1',
    designSystems: DESIGN_SYSTEMS,
    conversations: CONVERSATIONS,
    activeConversationId: 'c1',
    runningConversationIds: NO_RUNNING_CONVERSATIONS,
    readOnly: false,
    projectMetadata: METADATA,
    mediaProviders: MEDIA_PROVIDERS,
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

describe('fantay project bridge', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
  });

  afterEach(() => {
    cleanup();
    resetFantayProjectBridgeForTests();
    vi.unstubAllEnvs();
  });

  it('exposes a frozen empty running list', () => {
    expect(NO_RUNNING_CONVERSATIONS).toEqual([]);
    expect(Object.isFrozen(NO_RUNNING_CONVERSATIONS)).toBe(true);
  });

  it('publishes the session so useActiveProjectSession sees it', () => {
    const session = renderHook(() => useActiveProjectSession());
    expect(session.result.current).toBeNull();

    render(<Bridge input={bridgeInput({ runningConversationIds: ['c2'] })} />);

    expect(session.result.current).toMatchObject({
      projectId: 'p1',
      projectName: 'Landing',
      designSystemId: 'ds-1',
      activeConversationId: 'c1',
      runningConversationIds: ['c2'],
      readOnly: false,
    });
    expect(session.result.current?.conversations).toBe(CONVERSATIONS);
    expect(session.result.current?.designSystems).toBe(DESIGN_SYSTEMS);
    expect(session.result.current?.projectMetadata).toBe(METADATA);
    expect(session.result.current?.mediaProviders).toBe(MEDIA_PROVIDERS);
    expect(getActiveProjectSession()?.projectId).toBe('p1');
  });

  it('filters by project id', () => {
    render(<Bridge input={bridgeInput()} />);
    expect(renderHook(() => useActiveProjectSession('p1')).result.current?.projectId).toBe('p1');
    expect(renderHook(() => useActiveProjectSession('other')).result.current).toBeNull();
  });

  it('republishes when a published field changes', () => {
    const session = renderHook(() => useActiveProjectSession('p1'));
    const view = render(<Bridge input={bridgeInput()} />);
    const first = session.result.current;

    view.rerender(<Bridge input={bridgeInput({ activeConversationId: 'c2', runningConversationIds: ['c2'] })} />);
    expect(session.result.current).not.toBe(first);
    expect(session.result.current?.activeConversationId).toBe('c2');
    expect(session.result.current?.runningConversationIds).toEqual(['c2']);
  });

  it('keeps the same session object when nothing published changed', () => {
    const session = renderHook(() => useActiveProjectSession('p1'));
    const view = render(<Bridge input={bridgeInput()} />);
    const first = session.result.current;

    // New handler identities and an equal running list do not republish.
    view.rerender(<Bridge input={bridgeInput({ runningConversationIds: [] })} />);
    expect(session.result.current).toBe(first);
  });

  it("runs commands through ProjectView's handlers", () => {
    const input = bridgeInput();
    render(<Bridge input={input} />);

    expect(runProjectCommand('p1', { kind: 'newConversation' })).toBe(true);
    expect(runProjectCommand('p1', { kind: 'selectConversation', conversationId: 'c2' })).toBe(true);
    expect(runProjectCommand('p1', { kind: 'changeDesignSystem', designSystemId: null })).toBe(true);
    expect(runProjectCommand('p1', { kind: 'openSettings', section: 'account' })).toBe(true);

    expect(input.onNewConversation).toHaveBeenCalledTimes(1);
    expect(input.onSelectConversation).toHaveBeenCalledWith('c2');
    expect(input.onChangeDesignSystem).toHaveBeenCalledWith(null);
    expect(input.onOpenSettings).toHaveBeenCalledWith('account');
  });

  it('returns false for a project without a live session', () => {
    render(<Bridge input={bridgeInput()} />);
    expect(runProjectCommand('p2', { kind: 'newConversation' })).toBe(false);
    resetFantayProjectBridgeForTests();
    expect(runProjectCommand('p1', { kind: 'newConversation' })).toBe(false);
  });

  it('always calls the handlers of the latest render', () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const view = render(<Bridge input={bridgeInput({ onSelectConversation: stale })} />);
    view.rerender(<Bridge input={bridgeInput({ onSelectConversation: fresh })} />);

    runProjectCommand('p1', { kind: 'selectConversation', conversationId: 'c1' });
    expect(fresh).toHaveBeenCalledWith('c1');
    expect(stale).not.toHaveBeenCalled();
  });

  it('clears only its own session on unmount', () => {
    const session = renderHook(() => useActiveProjectSession());
    const first = render(<Bridge input={bridgeInput({ projectId: 'p1' })} />);
    const second = render(<Bridge input={bridgeInput({ projectId: 'p2' })} />);
    expect(session.result.current?.projectId).toBe('p2');

    first.unmount();
    expect(session.result.current?.projectId).toBe('p2');

    second.unmount();
    expect(session.result.current).toBeNull();
  });

  it('is a no-op while the shell is off', () => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '0');
    const input = bridgeInput();
    render(<Bridge input={input} />);

    expect(getActiveProjectSession()).toBeNull();
    expect(runProjectCommand('p1', { kind: 'newConversation' })).toBe(false);
    expect(input.onNewConversation).not.toHaveBeenCalled();
  });

  it('notifies subscribers on reset', () => {
    const session = renderHook(() => useActiveProjectSession());
    render(<Bridge input={bridgeInput()} />);
    act(() => resetFantayProjectBridgeForTests());
    expect(session.result.current).toBeNull();
  });

  it('server-renders without a session (B2 getServerSnapshot)', () => {
    render(<Bridge input={bridgeInput()} />);
    function Probe() {
      const session = useActiveProjectSession();
      return <span>{session ? session.projectId : 'none'}</span>;
    }
    expect(renderToString(<Probe />)).toBe('<span>none</span>');
  });
});
