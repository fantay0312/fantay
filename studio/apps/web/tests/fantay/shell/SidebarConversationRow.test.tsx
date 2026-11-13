// @vitest-environment jsdom
import '../helpers/radix-jsdom';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../src/i18n';
import { SidebarConversationRow } from '../../../src/fantay/shell/sidebar/SidebarConversationRow';

const mocks = vi.hoisted(() => ({ remove: vi.fn(), patch: vi.fn(), command: vi.fn(), messages: vi.fn(), window: vi.fn() }));
vi.mock('../../../src/state/projects', () => ({ deleteConversation: mocks.remove, patchConversation: mocks.patch, listMessages: mocks.messages }));
vi.mock('@open-design/host', async importOriginal => ({
  ...await importOriginal<typeof import('@open-design/host')>(), openHostConversationWindow: mocks.window,
}));
vi.mock('../../../src/collab/useWorkspaceContext', () => ({
  useWorkspaceContext: () => ({ context: null, loading: false, identityChangePending: false }),
}));
vi.mock('../../../src/fantay/shell/project-bridge', () => ({
  useActiveProjectSession: () => null,
  runProjectCommand: mocks.command,
}));
vi.mock('../../../src/fantay/shell/sidebar/use-sidebar-conversations', () => ({
  reconcileSidebarConversation: vi.fn(),
}));

const conversation = {
  id: 'chat',
  projectId: 'project',
  title: 'Original',
  messageCount: 1,
  createdAt: 1,
  updatedAt: 1,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 40, 200, 28));
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1024 });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 768 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openMenu() {
  fireEvent.keyDown(screen.getByTestId('fantay-sidebar-chat-menu-chat'), { key: 'Enter' });
  await screen.findByRole('menu');
}

function setup() {
  const select = vi.fn();
  render(
    <I18nProvider initial="zh-CN">
      <SidebarConversationRow conversation={conversation} active={false} tone={null} onSelect={select} />
    </I18nProvider>,
  );
  return select;
}

it('offers every requested conversation action', async () => {
  setup();
  await openMenu();
  for (const label of ['重命名', '置顶', '标记为未读', '分区', '分享', '复制', '在新窗口中打开', '归档', '删除']) {
    expect(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) })).toBeInTheDocument();
  }
});

it('marks a conversation unread and opens its own desktop window', async () => {
  setup();
  mocks.patch.mockResolvedValue({ ...conversation, unreadAt: 7 });
  mocks.window.mockResolvedValue({ ok: true });
  await openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: /^标记为未读/ }));
  await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('project', 'chat', { unreadAt: expect.any(Number), readAt: expect.any(Number) }, null));
  await openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: '在新窗口中打开' }));
  expect(mocks.window).toHaveBeenCalledWith('project', 'chat');
});

it('previews the selected conversation before any share publication', async () => {
  setup();
  mocks.messages.mockResolvedValue([{ id: 'message', role: 'user', content: 'Visible conversation text' }]);
  await openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: '分享' }));
  expect(await screen.findByText(/Visible conversation text/)).toBeVisible();
  expect(screen.getByRole('button', { name: '生成分享快照' })).toBeEnabled();
});

it('copies the conversation ID from the copy submenu', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  setup();
  await openMenu();
  const copy = screen.getByRole('menuitem', { name: '复制' });
  copy.focus();
  fireEvent.keyDown(copy, { key: 'ArrowRight' });
  fireEvent.click(await screen.findByRole('menuitem', { name: '复制对话 ID' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('chat'));
});

it('opens management without selecting the chat, keeps failed deletes retryable, and sends one pending request', async () => {
  const select = setup();
  mocks.remove.mockResolvedValueOnce(false);
  await openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
  const dialog = await screen.findByRole('dialog');
  expect(select).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
  expect(await within(dialog).findByRole('alert')).toBeVisible();
  expect(mocks.command).not.toHaveBeenCalled();
  let finish!: (ok: boolean) => void;
  mocks.remove.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
  fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
  expect(mocks.remove).toHaveBeenCalledTimes(2);
  await act(async () => finish(true));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(mocks.command).toHaveBeenCalledWith('project', { kind: 'conversationDeleted', conversationId: 'chat' });
});

it('saves a renamed chat only after the daemon accepts it', async () => {
  setup();
  mocks.patch.mockResolvedValue({ ...conversation, title: 'Renamed' });
  await openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: /^重命名/ }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: ' Renamed ' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '确定' }));
  await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('project', 'chat', { title: 'Renamed' }, null));
  expect(mocks.command).toHaveBeenCalledWith('project', {
    kind: 'conversationUpdated',
    conversation: { ...conversation, title: 'Renamed' },
  });
});

it.each([
  { label: '置顶', field: 'pinnedAt' },
  { label: '归档', field: 'archivedAt' },
])('persists $label from the chat menu', async ({ label, field }) => {
  setup();
  mocks.patch.mockResolvedValue({ ...conversation, [field]: 12 });
  await openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) }));
  await waitFor(() =>
    expect(mocks.patch).toHaveBeenCalledWith('project', 'chat', { [field]: expect.any(Number) }, null),
  );
  expect(mocks.command).toHaveBeenCalled();
});
