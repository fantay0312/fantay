// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useConversationChat } from '../../../src/components/workspace/useConversationChat';
import { streamViaDaemon } from '../../../src/providers/daemon';
import { listMessages, saveMessage } from '../../../src/state/projects';
import type { AppConfig, ChatMessage } from '../../../src/types';

vi.mock('../../../src/providers/daemon', async () => {
  const actual = await vi.importActual<typeof import('../../../src/providers/daemon')>(
    '../../../src/providers/daemon',
  );
  return { ...actual, streamViaDaemon: vi.fn() };
});

vi.mock('../../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../../src/state/projects')>(
    '../../../src/state/projects',
  );
  return {
    ...actual,
    listMessages: vi.fn(),
    saveMessage: vi.fn(),
  };
});

const mockedListMessages = vi.mocked(listMessages);
const mockedSaveMessage = vi.mocked(saveMessage);
const mockedStreamViaDaemon = vi.mocked(streamViaDaemon);

const config = {
  mode: 'daemon',
  agentId: 'codex',
  agentModels: {},
} as AppConfig;

describe('useConversationChat authoritative message loading', () => {
  beforeEach(() => {
    mockedListMessages.mockRejectedValue(new Error('workspace directory unavailable'));
    mockedSaveMessage.mockResolvedValue(null);
    mockedStreamViaDaemon.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps send and retry disabled when the persisted transcript cannot be loaded', async () => {
    const hook = renderHook(() =>
      useConversationChat('project-1', 'conversation-1', {
        config,
        agentsById: new Map(),
        locale: 'en',
        sessionMode: 'design',
      }),
    );

    await waitFor(() => {
      expect(hook.result.current.loading).toBe(false);
      expect(hook.result.current.error).toBe('workspace directory unavailable');
      expect(hook.result.current.sendDisabled).toBe(true);
    });

    act(() => {
      hook.result.current.onSend('must not send without history', [], []);
      hook.result.current.onRetry({
        id: 'failed-assistant',
        role: 'assistant',
        content: '',
        createdAt: 1,
        runStatus: 'failed',
      });
    });

    expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
    expect(mockedSaveMessage).not.toHaveBeenCalled();
  });

  it('forwards an embedded movie workbench skill through the existing run path', async () => {
    mockedListMessages.mockResolvedValue([]);
    const hook = renderHook(() => useConversationChat('movie-project', 'movie-conversation', {
      config, agentsById: new Map(), locale: 'zh-CN', sessionMode: 'design', skillId: 'fantay-movie',
    }));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => hook.result.current.onSend('Make the closing shot slower', [], []));
    expect(mockedStreamViaDaemon).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'movie-project', skillId: 'fantay-movie', skillIds: ['fantay-movie'],
    }));
  });
  it('uses the newly selected model for the next movie edit request', async () => {
    mockedListMessages.mockResolvedValue([]);
    const hook = renderHook(({currentConfig}) => useConversationChat('movie-project', 'movie-conversation', {
      config:currentConfig, agentsById:new Map(), locale:'en', sessionMode:'design', skillId:'fantay-movie',
    }), {initialProps:{currentConfig:config}});
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    hook.rerender({currentConfig:{...config,agentModels:{codex:{model:'selected-movie-model'}}}});
    act(() => hook.result.current.onSend('Trim the opening',[],[]));
    expect(mockedStreamViaDaemon).toHaveBeenCalledWith(expect.objectContaining({agentId:'codex',model:'selected-movie-model',skillId:'fantay-movie'}));
  });
  it('runs an API channel through the tool-capable daemon runtime', async()=>{
    mockedListMessages.mockResolvedValue([]);
    const apiConfig={...config,mode:'api',apiProtocol:'openai',apiKey:'sk-test-only-not-a-real-key',baseUrl:'https://channel.example/v1',model:'channel-model'} as AppConfig;
    const hook=renderHook(()=>useConversationChat('movie','chat',{config:apiConfig,agentsById:new Map(),locale:'en',sessionMode:'design',skillId:'fantay-movie'}));
    await waitFor(()=>expect(hook.result.current.loading).toBe(false));
    act(()=>expect(hook.result.current.onSend('Trim the clip',[],[])).toBe(true));
    expect(mockedStreamViaDaemon).toHaveBeenCalledWith(expect.objectContaining({agentId:'byok',model:'channel-model',skillId:'fantay-movie',byokProvider:expect.objectContaining({protocol:'openai',baseUrl:'https://channel.example/v1',model:'channel-model'})}));
  });
  it('refreshes a reopened active run and refuses a duplicate generation', async()=>{
    const active: ChatMessage = {id:'active',role:'assistant',content:'',createdAt:1,runId:'run-1',runStatus:'running'};
    mockedListMessages.mockResolvedValueOnce([active]).mockResolvedValue([{...active,content:'Finished',runStatus:'succeeded'}]);
    const hook=renderHook(()=>useConversationChat('movie','chat',{config,agentsById:new Map(),locale:'zh-CN',sessionMode:'design'}));
    await waitFor(()=>expect(hook.result.current.loading).toBe(false));
    act(()=>expect(hook.result.current.onSend('duplicate',[],[])).toBe(false));
    expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
    await waitFor(()=>expect(hook.result.current.messages[0]?.content).toBe('Finished'),{timeout:4000});
  });
});

describe('useConversationChat run failures', () => {
  beforeEach(() => {
    mockedListMessages.mockResolvedValue([]);
    mockedSaveMessage.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // Side chat runs through the same failure card, so it needs the same original
  // error under 「view details」 as the main chat panel.
  it('threads the captured stderr tail onto the failed assistant message', async () => {
    const stderrTail =
      'Error: dsh: plugin tree failed to load: credentials-local: the value for "version" in /Users/tester/.dsh/.credentials.yaml must be a string';
    mockedStreamViaDaemon.mockImplementation(async (options: any) => {
      const err = new Error('DeepSeek Harness profile exited without a terminal result.') as Error & {
        code?: string;
        stderrTail?: string;
      };
      err.code = 'DSH_PROFILE_MISSING_RESULT';
      err.stderrTail = stderrTail;
      options.handlers.onError(err);
    });

    const hook = renderHook(() =>
      useConversationChat('project-1', 'conversation-1', {
        config,
        agentsById: new Map(),
        locale: 'en',
        sessionMode: 'design',
      }),
    );

    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    await act(async () => {
      await hook.result.current.onSend('do the thing', [], []);
    });

    await waitFor(() => {
      const failed = hook.result.current.messages.find(
        (m) => m.role === 'assistant' && m.runStatus === 'failed',
      );
      const errorEvent = failed?.events?.find(
        (event) => event.kind === 'status' && event.label === 'error',
      ) as { stderrTail?: string } | undefined;
      expect(errorEvent?.stderrTail).toBe(stderrTail);
    });
  });
});

it('sends composer attachments, skills, research and workspace context to the bound side run', async () => {
  mockedListMessages.mockResolvedValue([]);
  mockedSaveMessage.mockResolvedValue(null);
  mockedStreamViaDaemon.mockClear().mockResolvedValue(undefined);
  const hook = renderHook(() => useConversationChat('project-1', 'side-id', {
    config, agentsById: new Map(), locale: 'zh-CN', sessionMode: 'chat', sideDialogueInstructions: 'Fantay',
  }));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  const file = { name: 'brief.txt', path: 'brief.txt', kind: 'file' as const };
  const scope = { skillIds: ['review'] };
  act(() => expect(hook.result.current.onSend('Review the attached brief', [file], [], {
    clientRequestId: 'request-1', context: scope, skillIds: ['review'],
    research: { enabled: true, query: 'references' }, appliedPluginSnapshotId: 'side-plugin',
  })).toBe(true));
  expect(mockedStreamViaDaemon).toHaveBeenCalledWith(expect.objectContaining({
    projectId: 'project-1', conversationId: 'side-id', clientRequestId: 'request-1',
    attachments: ['brief.txt'], context: scope, skillIds: ['review'], sideDialogueInstructions: 'Fantay',
    research: { enabled: true, query: 'references' }, appliedPluginSnapshotId: 'side-plugin',
  }));
  expect(mockedSaveMessage).toHaveBeenCalledWith('project-1', 'side-id',
    expect.objectContaining({ role: 'user', attachments: [file], runContext: scope }), expect.anything());
  hook.unmount();
});

it('restores the original side transcript if an edited turn is stopped before its branch is admitted', async () => {
  const initial: ChatMessage[] = [
    { id: 'q1', role: 'user', content: 'First wording', createdAt: 1 },
    { id: 'a1', role: 'assistant', content: 'First answer', runId: 'r1', runStatus: 'succeeded', createdAt: 2 },
  ];
  mockedListMessages.mockResolvedValue(initial);
  mockedSaveMessage.mockClear();
  mockedStreamViaDaemon.mockClear().mockResolvedValue(undefined);
  const hook = renderHook(() => useConversationChat('p', 'side-id', { config, agentsById: new Map(), locale: 'en', sessionMode: 'chat' }));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => { expect(await hook.result.current.versionActions.edit('q1', 'New wording')).toBe(true); });
  expect(mockedStreamViaDaemon.mock.calls[0]?.[0].messageBranch).toEqual({ action: 'edit', messageId: 'q1', expectedLeafId: 'a1' });
  act(() => hook.result.current.onStop());
  expect(hook.result.current.messages).toEqual(initial);
  expect(mockedSaveMessage).not.toHaveBeenCalled();
  hook.unmount();
});

describe('G9 side-chat retries preserve the persisted failed turn', () => {
  const projectId = 'retry-history-project';
  const conversationId = 'non-active-side-conversation';
  const originalUser: ChatMessage = {
    id: 'original-user', role: 'user', content: 'Retry this original side prompt', createdAt: 1000,
    attachments: [{ name: 'source.txt', path: 'source.txt', kind: 'file', size: 12 }],
  };
  const originalFailure: ChatMessage = {
    id: 'original-failure', role: 'assistant', agentId: 'amr',
    content: 'Original partial answer must remain in history', createdAt: 1001, endedAt: 2000,
    runId: 'original-run', runStatus: 'failed',
    events: [{ kind: 'status', label: 'error', code: 'AGENT_EXECUTION_FAILED',
      detail: 'Original diagnostic must remain exportable', failureDetail: 'process_crashed' }],
  };
  let persisted: Map<string, ChatMessage>;

  beforeEach(() => {
    persisted = new Map([originalUser, originalFailure].map((message) => [message.id, structuredClone(message)]));
    mockedListMessages.mockReset().mockImplementation(async () => [...persisted.values()].map((message) => structuredClone(message)));
    mockedSaveMessage.mockReset().mockImplementation(async (_project, _conversation, message) => {
      persisted.set(message.id, structuredClone(message));
      return null;
    });
    mockedStreamViaDaemon.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  async function loadSideChat() {
    const hook = renderHook(() => useConversationChat(projectId, conversationId, {
      config: { ...config, agentId: 'amr' }, agentsById: new Map(), locale: 'en', sessionMode: 'chat',
    }));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.messages).toEqual([originalUser, originalFailure]);
    return hook;
  }

  function expectOriginalHistoryIntact() {
    expect(persisted.get(originalFailure.id)).toEqual(originalFailure);
    expect(persisted.get(originalUser.id)).toEqual(originalUser);
    expect([...persisted.values()].filter((message) => message.role === 'user')).toEqual([originalUser]);
    expect(mockedSaveMessage.mock.calls.filter((call) => call[2].id === originalFailure.id)).toEqual([]);
  }

  it.each(['succeeded', 'failed'] as const)('keeps the original saved diagnostic when the retry %s', async (terminal) => {
    const hook = await loadSideChat();
    act(() => hook.result.current.onRetry(originalFailure));
    expect(mockedStreamViaDaemon).toHaveBeenCalledOnce();
    const request = mockedStreamViaDaemon.mock.calls[0]![0];
    await act(async () => { request.onRunCreated?.('replacement-run'); });
    if (terminal === 'failed') {
      await act(async () => {
        request.onRunStatus?.('failed');
        request.handlers.onError(new Error('Replacement run failed'));
      });
    } else {
      await act(async () => { request.handlers.onDelta('Replacement answer'); });
      await act(async () => {
        request.onRunStatus?.('succeeded');
        request.handlers.onDone('Replacement answer');
      });
    }

    // Observe real saveMessage writes before checking IDs: the old hook writes
    // the new run and its terminal payload under original-failure, losing the
    // diagnostic in storage even though the original input object is untouched.
    expectOriginalHistoryIntact();
    expect(request.assistantMessageId).not.toBe(originalFailure.id);
    expect(request).toEqual(expect.objectContaining({ projectId, conversationId, agentId: 'amr',
      userMessageId: originalUser.id, attachments: ['source.txt'] }));
    const replacement = persisted.get(request.assistantMessageId!);
    expect(replacement).toEqual(expect.objectContaining({ runId: 'replacement-run', runStatus: terminal }));
    expect(hook.result.current.messages.find((message) => message.id === originalFailure.id)).toEqual(originalFailure);
    expect(hook.result.current.messages.filter((message) => message.role === 'user')).toEqual([originalUser]);
  });

  it('keeps the original failed message while the accepted retry is pending', async () => {
    const hook = await loadSideChat();
    act(() => hook.result.current.onRetry(originalFailure));
    expect(hook.result.current.streaming).toBe(true);
    expect(hook.result.current.messages.find((message) => message.id === originalFailure.id)).toEqual(originalFailure);
    const replacement = hook.result.current.messages.find((message) => message.role === 'assistant' && message.id !== originalFailure.id);
    expect(replacement).toEqual(expect.objectContaining({ content: '', events: [], runStatus: 'running' }));
    expectOriginalHistoryIntact();
  });

  it('records a pre-run rejection on a new failed message without overwriting the old failure', async () => {
    const hook = await loadSideChat();
    act(() => hook.result.current.onRetry(originalFailure));
    const request = mockedStreamViaDaemon.mock.calls[0]![0];
    // HTTP/create-run failure: onRunCreated never happened.
    await act(async () => {
      request.onRunStatus?.('failed');
      request.handlers.onError(new Error('Run admission rejected'));
    });
    expect(hook.result.current.streaming).toBe(false);
    expectOriginalHistoryIntact();
    expect(request.assistantMessageId).not.toBe(originalFailure.id);
    expect(persisted.get(request.assistantMessageId!)).toEqual(expect.objectContaining({ runStatus: 'failed' }));
    expect(persisted.get(request.assistantMessageId!)?.runId).toBeUndefined();
  });

  it('admits only one retry when the same failed card is activated twice before React paints', async () => {
    const hook = await loadSideChat();
    act(() => {
      hook.result.current.onRetry(originalFailure);
      hook.result.current.onRetry(originalFailure);
    });
    expect(mockedStreamViaDaemon).toHaveBeenCalledOnce();
    expectOriginalHistoryIntact();
  });

  it('cancels only the replacement run and leaves the original failure exportable', async () => {
    const hook = await loadSideChat();
    act(() => hook.result.current.onRetry(originalFailure));
    const request = mockedStreamViaDaemon.mock.calls[0]![0];
    await act(async () => {
      request.onRunCreated?.('canceled-replacement-run');
      request.onRunStatus?.('running');
    });
    act(() => hook.result.current.onStop());
    expect(request.cancelSignal?.aborted).toBe(true);
    expect(request.signal.aborted).toBe(true);
    expect(hook.result.current.streaming).toBe(false);
    expectOriginalHistoryIntact();
    expect(persisted.get(request.assistantMessageId!)).toEqual(expect.objectContaining({
      runId: 'canceled-replacement-run', runStatus: 'canceled',
    }));
    expect(hook.result.current.messages.find((message) => message.id === originalFailure.id)).toEqual(originalFailure);

    // A user stop releases admission for a genuinely new composer send.
    // streamViaDaemon's AbortError path returns silently; do not invent a
    // post-abort error callback to manufacture another failed card.
    act(() => hook.result.current.onSend('A new turn after stopping', [], []));
    expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(2);
    expect(mockedStreamViaDaemon.mock.calls[1]![0].assistantMessageId).not.toBe(request.assistantMessageId);
    expect(persisted.get(originalFailure.id)).toEqual(originalFailure);
    expect(persisted.get(originalUser.id)).toEqual(originalUser);
    expect([...persisted.values()].filter((message) => message.role === 'user').map((message) => message.content))
      .toEqual([originalUser.content, 'A new turn after stopping']);
  });

  it.each(['succeeded', 'failed'] as const)('isolates a late %s callback from the previous conversation', async (terminal) => {
    const nextConversationId = 'another-side-conversation';
    const nextUser: ChatMessage = {
      id: 'another-user', role: 'user', content: 'The second conversation original prompt', createdAt: 3000,
    };
    const nextFailure: ChatMessage = {
      ...structuredClone(originalFailure), id: 'another-failure', runId: 'another-old-run',
      content: 'Second conversation original failed answer', createdAt: 3001, endedAt: 4000,
    };
    const nextPersisted = new Map([nextUser, nextFailure].map((message) => [message.id, structuredClone(message)]));
    const stores = new Map([[conversationId, persisted], [nextConversationId, nextPersisted]]);
    mockedListMessages.mockImplementation(async (_project, scope) =>
      [...stores.get(scope)!.values()].map((message) => structuredClone(message)));
    mockedSaveMessage.mockImplementation(async (_project, scope, message) => {
      stores.get(scope)!.set(message.id, structuredClone(message));
      return null;
    });
    const hook = renderHook(({ scope }) => useConversationChat(projectId, scope, {
      config: { ...config, agentId: 'amr' }, agentsById: new Map(), locale: 'en', sessionMode: 'chat',
    }), { initialProps: { scope: conversationId } });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => hook.result.current.onRetry(originalFailure));
    const previousRequest = mockedStreamViaDaemon.mock.calls[0]![0];
    await act(async () => {
      previousRequest.onRunCreated?.('previous-conversation-run');
      previousRequest.onRunStatus?.('running');
    });

    hook.rerender({ scope: nextConversationId });
    await waitFor(() => {
      expect(hook.result.current.loading).toBe(false);
      expect(hook.result.current.messages).toEqual([nextUser, nextFailure]);
    });
    act(() => hook.result.current.onRetry(nextFailure));
    expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(2);
    const currentRequest = mockedStreamViaDaemon.mock.calls[1]![0];
    await act(async () => {
      currentRequest.onRunCreated?.('current-conversation-run');
      currentRequest.onRunStatus?.('running');
    });
    expect(hook.result.current.streaming).toBe(true);
    const currentMessages = structuredClone(hook.result.current.messages);
    const currentSavedRows = structuredClone([...nextPersisted.values()]);

    // A callback already in flight can finish after navigation. Match the
    // daemon terminal order (onRunStatus, then onDone/onError); do not call
    // both terminal handlers for one provider response.
    await act(async () => {
      previousRequest.onRunStatus?.(terminal);
      if (terminal === 'failed') previousRequest.handlers.onError(new Error('Late failure in the first conversation'));
      else previousRequest.handlers.onDone('');
    });
    expect(hook.result.current.streaming).toBe(true);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.messages).toEqual(currentMessages);
    expect([...nextPersisted.values()]).toEqual(currentSavedRows);
    expect(currentRequest.signal.aborted).toBe(false);
    expect(currentRequest.cancelSignal?.aborted).toBe(false);

    // The new run must still receive and save its own later output, proving
    // the old callback did not clear the shared text buffer or running refs.
    await act(async () => { currentRequest.handlers.onDelta('Second conversation replacement answer'); });
    await act(async () => {
      currentRequest.onRunStatus?.('succeeded');
      currentRequest.handlers.onDone('Second conversation replacement answer');
    });
    expect(nextPersisted.get(currentRequest.assistantMessageId!)).toEqual(expect.objectContaining({
      content: 'Second conversation replacement answer', runId: 'current-conversation-run', runStatus: 'succeeded',
    }));
    expect(persisted.get(originalFailure.id)).toEqual(originalFailure);
    expect(nextPersisted.get(nextFailure.id)).toEqual(nextFailure);
    expect(hook.result.current.streaming).toBe(false);
  });
});

describe('useConversationChat BYOK and executionPermission parity', () => {
  beforeEach(() => {
    mockedListMessages.mockResolvedValue([]);
    mockedSaveMessage.mockResolvedValue(null);
    mockedStreamViaDaemon.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('allows BYOK API-mode runs when executionPermission is set on a supported protocol', async () => {
    const apiConfig = {
      ...config,
      mode: 'api',
      apiProtocol: 'anthropic',
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
    } as AppConfig;

    const hook = renderHook(() =>
      useConversationChat('project-1', 'conversation-1', {
        config: apiConfig,
        agentsById: new Map(),
        locale: 'zh-CN',
        sessionMode: 'design',
        executionPermission: 'read-only',
      }),
    );

    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => expect(hook.result.current.onSend('Inspect workspace', [], [])).toBe(true));

    expect(mockedStreamViaDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'byok',
        model: 'claude-sonnet-4-5',
        byokProvider: expect.objectContaining({
          protocol: 'anthropic',
          apiKey: 'sk-ant-test',
          model: 'claude-sonnet-4-5',
        }),
      }),
    );
  });

  it('blocks sends on Bedrock BYOK where bundled-pi execution permissions are unsupported', async () => {
    const bedrockConfig = {
      ...config,
      mode: 'api',
      apiProtocol: 'bedrock',
      apiKey: '',
      model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    } as AppConfig;

    const hook = renderHook(() =>
      useConversationChat('project-1', 'conversation-1', {
        config: bedrockConfig,
        agentsById: new Map(),
        locale: 'en',
        sessionMode: 'design',
        executionPermission: 'workspace-write',
      }),
    );

    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => expect(hook.result.current.onSend('Blocked send', [], [])).toBe(false));
    expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
    expect(hook.result.current.error).toContain('AWS Bedrock BYOK chat');
  });
});
