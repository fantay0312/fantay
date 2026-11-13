// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { forwardRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../../../src/components/ChatPane';
import { I18nProvider } from '../../../src/i18n';

vi.mock('../../../src/components/ChatComposer', () => ({
  ChatComposer: forwardRef(() => <div />),
}));
afterEach(cleanup);
it('keeps history search and selection working in the project toolbar', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const select = vi.fn();
  const newConversation = vi.fn();
  const view = render(<I18nProvider initial="zh-CN"><ChatPane
    historyPortalTarget={host} messages={[]} streaming={false} error={null}
    projectId="p1" projectFiles={[]} onEnsureProject={async () => 'p1'}
    onSend={vi.fn()} onStop={vi.fn()} onSelectConversation={select} onDeleteConversation={vi.fn()}
    onNewConversation={newConversation} activeConversationId="one"
    conversations={[
      { id: 'one', projectId: 'p1', title: 'First conversation', messageCount: 2, createdAt: 1, updatedAt: 1 },
      { id: 'two', projectId: 'p1', title: 'Second conversation', messageCount: 2, createdAt: 2, updatedAt: 2 },
    ]}
  /></I18nProvider>);
  try {
    const trigger = within(host).getByTestId('conversation-history-trigger');
    expect(view.container.contains(trigger)).toBe(false);
    expect(screen.queryByTestId('chat-new-conversation')).toBeNull();
    fireEvent.click(trigger);
    expect(within(screen.getByTestId('conversation-history-menu')).getByTestId('chat-new-conversation')).toBeTruthy();
    fireEvent.change(within(host).getByTestId('conversation-history-search'), { target: { value: 'Second' } });
    expect(screen.queryByTestId('conversation-select-one')).toBeNull();
    fireEvent.click(within(host).getByTestId('conversation-select-two'));
    expect(select).toHaveBeenCalledWith('two');
    expect(screen.queryByTestId('conversation-history-menu')).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByTestId('conversation-history-menu')).getByTestId('chat-new-conversation'));
    expect(newConversation).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('conversation-history-menu')).toBeNull();
  } finally { view.unmount(); host.remove(); }
});

it('keeps new conversation disabled in the history menu when creation is unavailable', () => {
  const newConversation = vi.fn();
  render(<I18nProvider initial="zh-CN"><ChatPane
    messages={[]} streaming={false} error={null} conversations={[]} activeConversationId={null}
    projectId="p1" projectFiles={[]} onEnsureProject={async () => 'p1'}
    onSend={vi.fn()} onStop={vi.fn()} onSelectConversation={vi.fn()} onDeleteConversation={vi.fn()}
    onNewConversation={newConversation} newConversationDisabled
  /></I18nProvider>);
  fireEvent.click(screen.getByTestId('conversation-history-trigger'));
  const button = within(screen.getByTestId('conversation-history-menu')).getByTestId('chat-new-conversation');
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(newConversation).not.toHaveBeenCalled();
  expect(screen.queryByTestId('conversation-history-menu')).not.toBeNull();
});

it('lists only chats something happened in, so an unused new chat never shows as an empty row', () => {
  render(<I18nProvider initial="zh-CN"><ChatPane
    messages={[]} streaming={false} error={null} activeConversationId="fresh"
    conversations={[
      { id: 'fresh', projectId: 'p1', title: null, messageCount: 0, createdAt: 3, updatedAt: 3 },
      { id: 'used', projectId: 'p1', title: 'Used conversation', messageCount: 2, createdAt: 1, updatedAt: 1 },
      { id: 'started', projectId: 'p1', title: null, createdAt: 2, updatedAt: 2, latestRun: { status: 'running' } },
    ]}
    projectId="p1" projectFiles={[]} onEnsureProject={async () => 'p1'}
    onSend={vi.fn()} onStop={vi.fn()} onSelectConversation={vi.fn()} onDeleteConversation={vi.fn()}
    onNewConversation={vi.fn()}
  /></I18nProvider>);
  fireEvent.click(screen.getByTestId('conversation-history-trigger'));
  const menu = screen.getByTestId('conversation-history-menu');
  expect(within(menu).queryByTestId('conversation-select-fresh')).toBeNull();
  expect(within(menu).getByTestId('conversation-select-used')).toBeTruthy();
  expect(within(menu).getByTestId('conversation-select-started')).toBeTruthy();
});
