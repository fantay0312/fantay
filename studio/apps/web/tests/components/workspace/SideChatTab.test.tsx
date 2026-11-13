// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SideChatTab } from '../../../src/components/workspace/SideChatTab';
import type { AppConfig, Conversation } from '../../../src/types';

const chatPaneMock = vi.fn((_: unknown) => <div data-testid="chat-pane" />);
const send = vi.hoisted(()=>vi.fn(()=>true));
const state = vi.hoisted(()=>({loading:false,sendDisabled:true}));

vi.mock('../../../src/i18n', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('../../../src/components/Icon', () => ({
  Icon: () => <span data-testid="icon" />,
}));

vi.mock('../../../src/components/ChatPane', () => ({
  ChatPane: (props: unknown) => chatPaneMock(props),
}));

vi.mock('../../../src/components/workspace/useConversationChat', () => ({
  useConversationChat: () => ({
    messages: [],
    streaming: false,
    loading: state.loading,
    sendDisabled: state.sendDisabled,
    error: null,
    onSend: send,
    onStop: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  chatPaneMock.mockClear();
  send.mockClear();
  state.loading = false;
  state.sendDisabled = true;
});

describe('SideChatTab', () => {
  it('keeps the movie model picker in the real composer toolbar', () => {
    const picker = <button>Current movie model</button>;
    render(<SideChatTab projectId="p" conversationId="c" config={{mode:'daemon'} as AppConfig} agentsById={new Map()} locale="en" projectFiles={[]} conversations={[]} onSelectConversation={vi.fn()} onDeleteConversation={vi.fn()} editorAppearance composerFooterAccessory={picker} />);
    expect(chatPaneMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({composerFooterAccessory:picker}));
  });
  it('waits for history then sends a matching explicit movie task exactly once', ()=>{
    state.loading = true;
    state.sendDisabled = false;
    const settled = vi.fn();
    const props = {projectId:'p',conversationId:'c',config:{mode:'daemon'} as AppConfig,agentsById:new Map(),locale:'en',projectFiles:[],conversations:[],onSelectConversation:vi.fn(),onDeleteConversation:vi.fn(),promptRequest:{id:'request-1',projectId:'p',conversationId:'c',prompt:'Create the storyboard'},onPromptRequestSettled:settled};
    const view = render(<SideChatTab {...props}/>);
    expect(send).not.toHaveBeenCalled();
    state.loading = false;
    view.rerender(<SideChatTab {...props}/>);
    expect(send).toHaveBeenCalledExactlyOnceWith('Create the storyboard',[],[]);
    expect(settled).toHaveBeenCalledWith('request-1',true);
    view.rerender(<SideChatTab {...props}/>);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('rejects a disabled task without sending it to a different conversation', ()=>{
    const settled = vi.fn();
    const props = {projectId:'p',conversationId:'c',config:{mode:'daemon'} as AppConfig,agentsById:new Map(),locale:'en',projectFiles:[],conversations:[],onSelectConversation:vi.fn(),onDeleteConversation:vi.fn(),promptRequest:{id:'request-2',projectId:'p',conversationId:'other',prompt:'Create'},onPromptRequestSettled:settled};
    const view = render(<SideChatTab {...props}/>);
    expect(send).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    view.rerender(<SideChatTab {...props} promptRequest={{...props.promptRequest,conversationId:'c'}}/>);
    expect(send).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith('request-2',false);
  });
  it('passes the live config through to ChatPane', () => {
    const config = {
      mode: 'daemon',
      agentCliEnv: {
        amr: { OPEN_DESIGN_AMR_PROFILE: 'test' },
      },
    } as unknown as AppConfig;
    const conversations = [
      {
        id: 'conv-1',
        title: 'Current',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        projectId: 'project-1',
        messageCount: 0,
        sessionMode: 'design',
      },
    ] as unknown as Conversation[];

    render(
      <SideChatTab
        projectId="project-1"
        conversationId="conv-1"
        config={config}
        agentsById={new Map()}
        locale="en"
        projectFiles={[]}
        conversations={conversations}
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
      />,
    );

    expect(chatPaneMock).toHaveBeenCalled();
    const firstCall = chatPaneMock.mock.calls[0];
    expect(firstCall?.[0]).toEqual(
      expect.objectContaining({
        config,
        sendDisabled: true,
      }),
    );
  });

  it('forwards the file-link routing anchors (projectFileNames + projectResolvedDir) to ChatPane', () => {
    // Without these, absolute managed disk links in side-chat messages
    // cannot be classified and stay inert (#5611 review round 4).
    const config = { mode: 'daemon' } as unknown as AppConfig;
    const conversations = [
      {
        id: 'conv-1',
        title: 'Current',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        projectId: 'project-1',
        messageCount: 0,
        sessionMode: 'design',
      },
    ] as unknown as Conversation[];
    const projectFileNames = new Set(['index.html']);

    render(
      <SideChatTab
        projectId="project-1"
        conversationId="conv-1"
        config={config}
        agentsById={new Map()}
        locale="en"
        projectFiles={[]}
        projectFileNames={projectFileNames}
        projectResolvedDir="/data/projects/project-1"
        conversations={conversations}
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
      />,
    );

    expect(chatPaneMock).toHaveBeenCalled();
    expect(chatPaneMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        projectFileNames,
        projectResolvedDir: '/data/projects/project-1',
      }),
    );
  });
});
