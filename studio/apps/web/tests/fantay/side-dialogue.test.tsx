// @vitest-environment jsdom
import './helpers/radix-jsdom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { SideDialoguePanel } from '../../src/fantay/chat/SideDialoguePanel';
import { dialogueConfig, dialogueIntent, requiresDialogueReview, selectedDialogueModel } from '../../src/fantay/chat/side-dialogue';
import { dialogueSnapshot } from '../../src/fantay/chat/dialogue-snapshot';
import { typeAndSettle, composerText } from '../helpers/lexical-composer';
import { streamViaDaemon } from '../../src/providers/daemon';
vi.mock('../../src/providers/daemon', async original => ({ ...await original<typeof import('../../src/providers/daemon')>(), streamViaDaemon: vi.fn() }));
import type { AgentInfo, AppConfig, ChatMessage } from '../../src/types';

const dialogueMain = vi.fn();
const relayToDialogueMain = vi.fn();
const fetchMock = vi.fn();
const main = { title: '三轮研究', status: 'running' as const, queued: 0, recent: [] };
const config = { mode: 'daemon', agentId: 'tokentosea', agentModels: { tokentosea: { model: 'a', reasoning: 'high' } } } as unknown as AppConfig;
const agents = [{ id: 'tokentosea', name: 'TokenToSea', available: true, models: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] }] as AgentInfo[];
const target = { projectId: 'p', conversationId: 'c', title: main.title, running: true, readOnly: false };
function view(key = 'session-c', bound = true) {
  return <I18nProvider initial="zh-CN"><SideDialoguePanel key={key} storageKey={key} visible target={bound ? target : null}
    projectChat={{ projectFiles: [], onEnsureProject: async () => 'p', skills: [], currentSkillId: null }}
    config={config} agents={agents} readMain={dialogueMain} relay={relayToDialogueMain} onSettings={()=>{}}/></I18nProvider>;
}
async function enter(text: string) {
  await screen.findByTestId('chat-composer-input');
  await typeAndSettle(text);
  await waitFor(() => expect(screen.getByTestId('chat-send')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('chat-send'));
}
function answer(value: unknown) { return Response.json(value); }
beforeEach(() => {
  localStorage.clear();
  const persisted = new Map<string, ChatMessage>();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/side-dialogue') return fetchMock(url, init);
    if (url.endsWith('/conversations/c/side-dialogue')) return answer({ conversation: {
      id: 'side-c', projectId: 'p', sessionMode: 'chat', executionPermission: 'read-only',
    } });
    if (url.includes('/messages')) {
      if (init.method === 'PUT') {
        const message = JSON.parse(String(init.body)) as ChatMessage;
        persisted.set(message.id, message);
        return answer({ message });
      }
      return answer({ messages: [...persisted.values()] });
    }
    return answer({});
  }));
  vi.mocked(dialogueMain).mockReturnValue({ main, workspaceContext: null });
  vi.mocked(relayToDialogueMain).mockResolvedValue(true);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

it('keeps ordinary and negated requests in the side transcript and restores them on reopen', async () => {
  vi.mocked(streamViaDaemon).mockImplementationOnce(async options => {
    options.handlers.onDelta('好的，先一起聊。');
    options.handlers.onDone('好的，先一起聊。');
  });
  const rendered = render(view('daily'));
  await enter('先不要发给主会话，聊聊思路。');
  await screen.findByText('好的，先一起聊。');
  expect(streamViaDaemon).toHaveBeenCalledWith(expect.objectContaining({ sessionMode: 'chat', agentId: 'tokentosea', model: 'a', reasoning: 'high' }));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(dialogueMain).not.toHaveBeenCalled();
  expect(relayToDialogueMain).not.toHaveBeenCalled();
  rendered.unmount();
  render(view('daily'));
  expect(await screen.findByText('好的，先一起聊。')).toBeTruthy();
});

it('reads a fresh progress snapshot without waking the main chat or consuming the composer', async () => {
  fetchMock.mockResolvedValueOnce(answer({ kind: 'reply', text: '仍在等第二轮记录。' }));
  render(view());
  await screen.findByTestId('chat-composer-input');
  await typeAndSettle('正在写的事');
  fireEvent.click(screen.getByText('跟进进展'));
  await screen.findByText('仍在等第二轮记录。');
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ mode: 'progress', main, projectId: 'p' });
  expect(composerText()).toBe('正在写的事');
  expect(relayToDialogueMain).not.toHaveBeenCalled();
});

it('reads the main conversation to answer a contextual progress question', async () => {
  fetchMock.mockResolvedValueOnce(answer({ kind: 'reply', text: '刚才在等验证。' }));
  render(view());
  await enter('那一轮卡在哪？');
  await screen.findByText('刚才在等验证。');
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toHaveProperty('main', main);
  expect(relayToDialogueMain).not.toHaveBeenCalled();
});

it('reviews a risky request even if the model omits the risk, and delivers the edited text exactly once', async () => {
  fetchMock.mockResolvedValueOnce(answer({ kind: 'draft', text: '请部署预览。', review: false }));
  render(view());
  await enter('发给主会话：请部署预览。');
  const draft = await screen.findByLabelText(/待转达/);
  expect(relayToDialogueMain).not.toHaveBeenCalled();
  fireEvent.change(draft, { target: { value: '仅核对预览版本，先别部署。' } });
  const button = screen.getByText('确认发送');
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(screen.queryByLabelText(/待转达/)).toBeNull());
  expect(relayToDialogueMain).toHaveBeenCalledTimes(1);
  expect(relayToDialogueMain).toHaveBeenCalledWith('p', 'c', '仅核对预览版本，先别部署。', expect.any(String), expect.objectContaining({ attachments: [] }));
});

it('delivers an explicitly authorized ordinary relay without a second confirmation', async () => {
  fetchMock.mockResolvedValueOnce(answer({ kind: 'draft', text: '请核对第三轮的启动条件，保持现状。', review: false }));
  render(view());
  await enter('发给主会话：只查第三轮卡在哪里，先别跑。');
  await waitFor(() => expect(relayToDialogueMain).toHaveBeenCalledTimes(1));
  expect(relayToDialogueMain).toHaveBeenCalledWith('p', 'c', '请核对第三轮的启动条件，保持现状。', expect.any(String), expect.objectContaining({ attachments: [] }));
});

it('restores the pending draft after closing and reopening the tool without sending it', async () => {
  fetchMock.mockResolvedValueOnce(answer({ kind: 'draft', text: '请先展示部署说明。', review: true }));
  const rendered = render(view());
  await enter('发给主会话：先准备部署说明');
  await screen.findByLabelText(/待转达/);
  rendered.unmount();
  render(view());
  expect((await screen.findByLabelText(/待转达/) as HTMLTextAreaElement).value).toBe('请先展示部署说明。');
  expect(relayToDialogueMain).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('keeps the normal composer and sends ordinary turns through the side conversation runtime', async () => {
  render(view());
  await screen.findByTestId('chat-composer');
  expect(screen.getByTestId('chat-composer-input')).toHaveAttribute('contenteditable', 'true');
  expect(screen.getByRole('button', { name: /执行权限/ })).toBeInTheDocument();
  expect(screen.getByTestId('chat-plus-trigger')).toBeInTheDocument();
  await enter('先在这里讨论一下。');
  expect(streamViaDaemon).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'side-c', projectId: 'p',
    model: 'a', reasoning: 'high', sessionMode: 'chat', sideDialogueInstructions: expect.stringContaining('Fantay') }));
  expect(relayToDialogueMain).not.toHaveBeenCalled();
});

it('can clarify and relay repeatedly in one conversation, including identical approved wording', async () => {
  const draft = { kind: 'draft', text: '请只读核对启动条件。', review: false };
  fetchMock.mockResolvedValueOnce(answer({ kind: 'reply', text: '你指哪一轮？' }))
    .mockResolvedValueOnce(answer(draft)).mockResolvedValueOnce(answer(draft));
  render(view());
  await enter('发给主会话：问一下启动条件');
  await screen.findByText('你指哪一轮？');
  expect(relayToDialogueMain).not.toHaveBeenCalled();
  await enter('第三轮，只查已有记录。');
  await waitFor(() => expect(relayToDialogueMain).toHaveBeenCalledTimes(1));
  await enter('再发给主会话：用同样的话再问一次');
  await waitFor(() => expect(relayToDialogueMain).toHaveBeenCalledTimes(2));
  const [first, second] = relayToDialogueMain.mock.calls;
  expect(first?.slice(0, 3)).toEqual(['p', 'c', draft.text]);
  expect(second?.slice(0, 3)).toEqual(first?.slice(0, 3));
  expect(first?.[3]).not.toBe(second?.[3]);
  expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body).mode)).toEqual(['relay', 'relay', 'relay']);
});

it('ignores late completions when switching to another session', async () => {
  let finish!: (value: Response) => void;
  fetchMock.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const rendered = render(view());
  await enter('发给主会话：问一下进度');
  rendered.rerender(view('other', false));
  await act(async () => finish(answer({ kind: 'draft', text: '查看进度', review: false })));
  expect(relayToDialogueMain).not.toHaveBeenCalled();
  expect(screen.queryByText('查看进度')).toBeNull();
});

it('keeps independent model, channel and reasoning choices without persisting credentials', () => {
  const other = { ...config, agentModels: { tokentosea: { model: 'b', reasoning: 'low' } } };
  const selection = selectedDialogueModel(other, agents, {});
  expect(dialogueConfig(config, selection).agentModels).toEqual(other.agentModels);
  expect(config.agentModels?.tokentosea?.model).toBe('a');
  expect(selection).not.toHaveProperty('apiKey');
  expect(dialogueIntent('“发给主会话”是什么意思？')).toBe('chat');
  expect(requiresDialogueReview('先让我看一眼')).toBe(true);
});

it('summarizes recent public activity and omits raw inputs and hidden reasoning', () => {
  const message = { role: 'assistant', content: '', events: [
    { kind: 'thinking', text: 'hidden' }, { kind: 'tool_use', name: 'Read', input: 'private input' },
    { kind: 'text', text: 'Latest public answer' },
  ] } as ChatMessage;
  expect(dialogueSnapshot('title', true, 2, [message]).recent).toEqual([{
    role: 'assistant', text: 'Latest public answer', activity: ['Read'],
  }]);
});
