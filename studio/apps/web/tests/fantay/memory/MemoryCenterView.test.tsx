// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// The 记忆 page (Memory Center) against a fake `/api/memory-center`: the overview and navigator for every
// scope kind, per-scope lists with the kind filter and debounced search, create / edit / pin / archive /
// restore through the real dialogs, the bot's two memory controls, the sidebar badge, the error state, and
// where old /memory/<tab> links land.
import '../helpers/radix-jsdom';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import { MemoryCenterView } from '../../../src/fantay/memory/MemoryCenterView';
import { MemoryNavigationLabel } from '../../../src/fantay/memory/MemoryNavigationLabel';
import { resetMemoryPendingCountForTests } from '../../../src/fantay/memory/memory-badge-store';
import { Toaster, __resetToastsForTests } from '../../../src/fantay/ui';
import type { Project } from '../../../src/types';
import { createMemoryService, failWith, type MemoryService } from './memory-fake-service';

const SCOPE_KEY = 'fantay.memory.scope.v1';

function renderPage(
  service: MemoryService,
  options: { locale?: 'zh-CN' | 'en' | 'ja'; scope?: string; projects?: Project[]; onOpenProject?: (id: string) => void } = {},
) {
  service.install();
  if (options.scope) window.localStorage.setItem(SCOPE_KEY, options.scope);
  return render(
    <I18nProvider initial={options.locale ?? 'zh-CN'}>
      <MemoryNavigationLabel />
      <MemoryCenterView active projects={options.projects ?? []} onOpenProject={options.onOpenProject} />
      <Toaster />
    </I18nProvider>,
  );
}

/** Calls to GET /items, as their query strings. */
function itemQueries(service: MemoryService): URLSearchParams[] {
  return service.callsTo('/items', 'GET').map((call) => call.query);
}

function openRowMenu(id: string) {
  fireEvent.pointerDown(screen.getByTestId(`memory-row-menu-${id}`), { button: 0, ctrlKey: false });
}

async function chooseRowAction(id: string, action: string) {
  openRowMenu(id);
  const entry = await screen.findByTestId(`memory-row-action-${action}`);
  await act(async () => {
    fireEvent.click(entry);
  });
}

function openTab(id: 'items' | 'chunks' | 'archived') {
  const trigger = screen.getByTestId(`memory-tab-${id}`);
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetMemoryPendingCountForTests();
  __resetToastsForTests();
  window.localStorage.clear();
});

describe('Memory Center — overview and navigator', () => {
  it('shows the inventory, the warm inbox action, the sidebar badge and every scope kind', async () => {
    const service = createMemoryService();
    const projects: Project[] = [
      { id: 'proj-new', name: '还没有记忆的项目', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 2 },
    ];
    renderPage(service, { projects });

    expect((await screen.findByTestId('memory-inventory')).textContent).toBe('10 条记忆 · 3 个待你处理');
    const inbox = screen.getByTestId('memory-open-inbox');
    expect(inbox.getAttribute('data-state')).toBe('shown');
    expect(inbox.textContent).toContain('待处理 3');

    // The page reports the inbox counts to the sidebar badge.
    const badge = await screen.findByTestId('fantay-memory-pending');
    expect(badge.textContent).toBe('3');
    expect(badge.getAttribute('aria-label')).toBe('3 项记忆等你处理');

    const nav = screen.getByTestId('memory-navigator');
    for (const id of [
      'memory-nav-profile',
      'memory-nav-persona-persona-1',
      'memory-nav-bot-fantay',
      'memory-nav-bot-moon',
      'memory-nav-group-g1',
      'memory-nav-project-proj1',
      'memory-nav-conversation-conv1',
      'memory-nav-project-proj-new',
    ]) {
      expect(within(nav).getByTestId(id)).toBeTruthy();
    }
    expect(nav.textContent).toContain('我');
    expect(nav.textContent).toContain('角色');
    expect(nav.textContent).toContain('群组');
    expect(nav.textContent).toContain('项目');
    expect(screen.getByTestId('memory-nav-bot-fantay').textContent).toContain('工作助手');
    expect(screen.getByTestId('memory-nav-bot-moon').textContent).toContain('角色卡');
    expect(screen.getByTestId('memory-nav-persona-persona-1').textContent).toContain('默认');
    expect(screen.getByTestId('memory-nav-project-proj-new').textContent).toContain('还没有记忆的项目');

    // A warm dot where something waits: an open disagreement (Fantay) or a proposal (小月, the profile).
    expect(screen.getByTestId('memory-nav-bot-fantay').hasAttribute('data-needs-you')).toBe(true);
    expect(screen.getByTestId('memory-nav-bot-moon').hasAttribute('data-needs-you')).toBe(true);
    expect(screen.getByTestId('memory-nav-profile').hasAttribute('data-needs-you')).toBe(true);
    expect(screen.getByTestId('memory-nav-group-g1').hasAttribute('data-needs-you')).toBe(false);

    // The profile is selected first and its items are read without an empty scope id.
    expect(screen.getByTestId('memory-nav-profile').getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('memory-scope-title').textContent).toBe('个人画像');
    // Project chats read the profile too (and learn into it); groups and channels never do.
    expect(screen.getByTestId('memory-scope-readers').textContent).toBe(
      '项目里的对话，以及允许读取个人画像的角色（一对一聊天时）能读到；群聊和外部渠道读不到。项目对话里了解到的关于你的事也会记在这里。',
    );
    expect(await screen.findByTestId('memory-row-pf1')).toBeTruthy();
    const first = itemQueries(service)[0]!;
    expect(first.get('scopeKind')).toBe('profile');
    expect(first.get('status')).toBe('active');
    expect(first.has('scopeId')).toBe(false);
    expect(screen.getByTestId('memory-scope-needs-you').textContent).toContain('1 条等你确认');
  });

  it('narrows the navigator with its filter and offers to clear a filter that matches nothing', async () => {
    renderPage(createMemoryService());
    const filter = (await screen.findByTestId('memory-nav-filter')) as HTMLInputElement;
    await screen.findByTestId('memory-nav-group-g1');

    fireEvent.change(filter, { target: { value: '协作' } });
    expect(screen.getByTestId('memory-nav-group-g1')).toBeTruthy();
    expect(screen.queryByTestId('memory-nav-bot-moon')).toBeNull();

    // A chat that matches keeps its project in view.
    fireEvent.change(filter, { target: { value: '配色' } });
    expect(screen.getByTestId('memory-nav-project-proj1')).toBeTruthy();
    expect(screen.getByTestId('memory-nav-conversation-conv1')).toBeTruthy();

    fireEvent.change(filter, { target: { value: '没有这个名字' } });
    const empty = screen.getByTestId('memory-nav-no-match');
    fireEvent.click(within(empty).getByRole('button', { name: '清除筛选' }));
    expect(filter.value).toBe('');
    expect(screen.getByTestId('memory-nav-bot-moon')).toBeTruthy();
  });

  it('shows a load error with a retry, and the offline sentence in English', async () => {
    const service = createMemoryService();
    let failures = 1;
    service.override((call) => {
      if (call.path !== '/overview' || failures === 0) return undefined;
      failures -= 1;
      return failWith(500, 'MEMORY_CENTER_REQUEST_FAILED', '服务暂时不可用');
    });
    service.install();
    render(
      <I18nProvider initial="zh-CN">
        <MemoryCenterView active />
      </I18nProvider>,
    );
    const error = await screen.findByTestId('memory-load-error');
    expect(error.textContent).toContain('没能载入记忆。');
    expect(error.textContent).toContain('服务暂时不可用');
    fireEvent.click(screen.getByTestId('memory-retry-overview'));
    expect(await screen.findByTestId('memory-navigator')).toBeTruthy();
    cleanup();

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    render(
      <I18nProvider initial="en">
        <MemoryCenterView active />
      </I18nProvider>,
    );
    expect((await screen.findByTestId('memory-load-error')).textContent).toContain("Can't reach the local Fantay service.");
  });
});

describe('Memory Center — a scope and its lists', () => {
  it('loads the items of each scope kind and says who reads them', async () => {
    const service = createMemoryService();
    const onOpenProject = vi.fn();
    renderPage(service, { onOpenProject });
    await screen.findByTestId('memory-row-pf1');

    const visit = async (testId: string, row: string, readers: string, scope: [string, string]) => {
      fireEvent.click(screen.getByTestId(testId));
      expect(await screen.findByTestId(`memory-row-${row}`)).toBeTruthy();
      expect(screen.getByTestId('memory-scope-readers').textContent).toBe(readers);
      const query = itemQueries(service).at(-1)!;
      expect([query.get('scopeKind'), query.get('scopeId')]).toEqual(scope);
    };

    await visit('memory-nav-persona-persona-1', 'ps1', '使用这个人设聊天的角色能读到。', ['persona', 'persona-1']);
    await visit('memory-nav-bot-moon', 'm1', '只有 小月 自己能读到；它在群里说过和听到的内容也会记在这里。', ['bot', 'moon']);
    await visit('memory-nav-group-g1', 'g1i', '群里每个成员都能读到。', ['group', 'g1']);
    expect(screen.getByTestId('memory-scope-pane').textContent).toContain('成员：Fantay、小月');
    await visit('memory-nav-project-proj1', 'pr1', '这个项目下的每个对话都能读到，和这个项目关联的角色聊天也能读到。', ['project', 'proj1']);
    fireEvent.click(screen.getByTestId('memory-open-project'));
    expect(onOpenProject).toHaveBeenCalledWith('proj1');

    // Selecting the project unfolded its chats.
    expect(screen.getByTestId('memory-nav-project-proj1').getAttribute('aria-expanded')).toBe('true');
    await visit('memory-nav-conversation-conv1', 'cv1', '只在这一个对话里使用。', ['conversation', 'conv1']);
    expect(screen.getByTestId('memory-scope-title').textContent).toBe('配色讨论');
    expect(screen.getByTestId('memory-scope-pane').textContent).toContain('属于项目 学习 Agent 落地页方向');
    expect(window.localStorage.getItem(SCOPE_KEY)).toBe('conversation:conv1');

    // A scope with nothing in it offers to create the first memory there.
    fireEvent.click(screen.getByTestId('memory-nav-project-proj1'));
    fireEvent.click(screen.getByTestId('memory-nav-bot-fantay'));
    await screen.findByTestId('memory-row-i1');
    expect(screen.getByTestId('memory-scope-readers').textContent).toContain('只有 Fantay 自己能读到');
  });

  it('filters by kind family (one request per kind) and searches after a pause', async () => {
    const service = createMemoryService();
    renderPage(service, { scope: 'bot:fantay' });
    const row2 = await screen.findByTestId('memory-row-i2');
    expect(screen.getByTestId('memory-row-i1')).toBeTruthy();
    expect(row2.textContent).toContain('决定');
    expect(row2.textContent).toContain('来自群组 协作工作室');
    expect(row2.textContent).toContain('有分歧');
    expect(row2.hasAttribute('data-conflict')).toBe(true);
    expect(screen.getByTestId('memory-scope-needs-you').textContent).toContain('1 处有分歧');

    // 偏好 = preference, rule, feedback: three requests merged into one list.
    const before = itemQueries(service).length;
    fireEvent.click(screen.getByTestId('memory-kind-preference'));
    await waitFor(() => expect(screen.queryByTestId('memory-row-i2')).toBeNull());
    expect(screen.getByTestId('memory-row-i1')).toBeTruthy();
    expect(screen.getByTestId('memory-row-i3')).toBeTruthy();
    const kinds = itemQueries(service)
      .slice(before)
      .map((query) => query.get('kind'));
    expect(kinds).toEqual(expect.arrayContaining(['preference', 'rule', 'feedback']));

    fireEvent.click(screen.getByTestId('memory-kind-all'));
    expect(await screen.findByTestId('memory-row-i2')).toBeTruthy();

    // Typing waits for a pause: two keystrokes, one search.
    const searched = () => itemQueries(service).filter((query) => query.has('query'));
    fireEvent.change(screen.getByTestId('memory-search'), { target: { value: '主' } });
    fireEvent.change(screen.getByTestId('memory-search'), { target: { value: '主色' } });
    expect(searched()).toHaveLength(0);
    await waitFor(() => expect(searched()).toHaveLength(1));
    expect(searched()[0]!.get('query')).toBe('主色');
    await waitFor(() => expect(screen.queryByTestId('memory-row-i1')).toBeNull());
    expect(screen.getByTestId('memory-row-i4')).toBeTruthy();

    // Clearing shows everything at once.
    fireEvent.change(screen.getByTestId('memory-search'), { target: { value: '' } });
    expect(await screen.findByTestId('memory-row-i1')).toBeTruthy();
  });

  it('keeps every kind label whole in one row (short family names; a segment never shrinks below its label)', async () => {
    renderPage(createMemoryService(), { locale: 'en', scope: 'bot:fantay' });
    await screen.findByTestId('memory-row-i1');
    const segments = ['all', 'fact', 'preference', 'decision', 'promise', 'experience', 'method'].map((id) =>
      screen.getByTestId(`memory-kind-${id}`),
    );
    expect(segments.map((segment) => segment.textContent)).toEqual(['All', 'Facts', 'Prefs', 'Decisions', 'Promises', 'Moments', 'How-tos']);
    // Nothing is cut short and hidden behind a hover title.
    for (const segment of segments) expect(segment.querySelector('[title]')).toBeNull();
    // jsdom has no layout, so the sizing rule itself is pinned: equal shares, never narrower than the label.
    const css = readFileSync(resolve(__dirname, '../../../src/fantay/memory/MemoryCenterView.module.css'), 'utf8');
    const rule = /\.segItem\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/flex:\s*1 1 0/);
    expect(rule).toMatch(/min-width:\s*max-content/);
    expect(rule).not.toMatch(/ellipsis|overflow/);
  });

  it('lists the chat windows a scope can read in 对话片段', async () => {
    renderPage(createMemoryService(), { scope: 'bot:fantay' });
    await screen.findByTestId('memory-row-i1');
    openTab('chunks');
    const chunk = await screen.findByTestId('memory-chunk-pa:conv9:0');
    expect(chunk.textContent).toContain('配色讨论');
    expect(chunk.textContent).toContain('用户、Fantay');
    expect(chunk.textContent).toContain('青绿。');
  });
});

describe('Memory Center — changing memories', () => {
  it('creates a memory in the selected place', async () => {
    const service = createMemoryService();
    renderPage(service, { scope: 'bot:moon' });
    await screen.findByTestId('memory-row-m1');
    fireEvent.click(screen.getByTestId('memory-new'));
    const dialog = await screen.findByTestId('memory-editor-dialog');
    expect(within(dialog).getByTestId('memory-editor-scope').textContent).toContain('小月');
    fireEvent.change(within(dialog).getByTestId('memory-editor-content'), { target: { value: '周会改到周二上午' } });
    fireEvent.click(within(dialog).getByTestId('memory-editor-submit'));

    await waitFor(() => expect(service.callsTo('/items', 'POST')).toHaveLength(1));
    expect(service.callsTo('/items', 'POST')[0]!.body).toEqual({
      scope: { kind: 'bot', id: 'moon' },
      content: '周会改到周二上午',
      kind: 'fact',
    });
    expect(await screen.findByTestId('memory-row-n1')).toBeTruthy();
    expect(await screen.findByText('已记下')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('memory-editor-dialog')).toBeNull());
  });

  it('edits a memory as a new version and keeps the earlier text in its history', async () => {
    const service = createMemoryService();
    renderPage(service, { scope: 'bot:fantay' });
    await screen.findByTestId('memory-row-i1');
    await chooseRowAction('i1', 'edit');

    const dialog = await screen.findByTestId('memory-editor-dialog');
    // Editing never moves a memory: the place is shown, not offered.
    expect(within(dialog).getByTestId('memory-editor-scope-fixed').textContent).toBe('Fantay');
    expect(within(dialog).queryByTestId('memory-editor-scope')).toBeNull();
    // Nothing changed yet, so there is nothing to save.
    expect(within(dialog).getByTestId('memory-editor-submit').getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(within(dialog).getByTestId('memory-editor-content'), { target: { value: '回复用中文，结论先行，少用比喻' } });
    fireEvent.click(within(dialog).getByTestId('memory-editor-submit'));

    await waitFor(() => expect(service.callsTo('/items/i1', 'PATCH')).toHaveLength(1));
    expect(service.callsTo('/items/i1', 'PATCH')[0]!.body).toEqual({ revision: 1, content: '回复用中文，结论先行，少用比喻' });
    expect(await screen.findByText('之前的文字保留在历史里。')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('memory-row-i1').textContent).toContain('少用比喻'));
    await waitFor(() => expect(screen.queryByTestId('memory-editor-dialog')).toBeNull());

    // The detail dialog shows all three versions, newest first, with the change marked.
    fireEvent.click(within(screen.getByTestId('memory-row-i1')).getAllByRole('button')[0]!);
    const versions = await screen.findByTestId('memory-detail-versions');
    expect(versions.textContent).toContain('第 3 版');
    expect(versions.textContent).toContain('第 1 版');
    expect(versions.querySelector('ins')?.textContent).toContain('少用比喻');
  });

  it('pins, archives with an undo, and restores from 已归档; nothing offers to delete', async () => {
    const service = createMemoryService();
    renderPage(service, { scope: 'bot:fantay' });
    await screen.findByTestId('memory-row-i3');

    openRowMenu('i1');
    const menu = await screen.findByRole('menu');
    expect(menu.textContent).not.toMatch(/删除/);
    expect(within(menu).getByTestId('memory-row-action-archive').textContent).toBe('归档');
    fireEvent.keyDown(menu, { key: 'Escape' });

    await chooseRowAction('i3', 'pin');
    await waitFor(() => expect(service.callsTo('/items/i3', 'PATCH')).toHaveLength(1));
    expect(service.callsTo('/items/i3', 'PATCH')[0]!.body).toEqual({ pinned: true, revision: 1 });
    await waitFor(() => expect(screen.getByTestId('memory-row-i3').hasAttribute('data-pinned')).toBe(true));
    expect(screen.getByTestId('memory-row-i3').textContent).toContain('置顶');

    await chooseRowAction('i1', 'archive');
    await waitFor(() => expect(service.callsTo('/items/i1/action', 'POST')).toHaveLength(1));
    expect(service.callsTo('/items/i1/action', 'POST')[0]!.body).toEqual({ action: 'archive', revision: 1 });
    await waitFor(() => expect(screen.queryByTestId('memory-row-i1')).toBeNull());
    // The toast: what happened, where to find it again, and an undo.
    expect(await screen.findByText('不会再被想起，可以在「已归档」里恢复。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '撤销' })).toBeTruthy();

    openTab('archived');
    const archived = await screen.findByTestId('memory-row-a1');
    expect(archived.textContent).toContain('已归档');
    expect(await screen.findByTestId('memory-row-i1')).toBeTruthy();
    // A replaced memory says so in plain words and is not offered back.
    const replaced = screen.getByTestId('memory-row-s1');
    expect(replaced.textContent).toContain('已被取代');
    expect(within(replaced).queryByTestId('memory-row-restore-s1')).toBeNull();

    fireEvent.click(within(archived).getByTestId('memory-row-restore-a1'));
    await waitFor(() => expect(service.callsTo('/items/a1/action', 'POST')).toHaveLength(1));
    expect(service.callsTo('/items/a1/action', 'POST')[0]!.body).toEqual({ action: 'restore', revision: 1 });
    await waitFor(() => expect(screen.queryByTestId('memory-row-a1')).toBeNull());
    expect(await screen.findByText('已恢复')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/删除/);
  });
});

describe('Memory Center — a bot’s memory controls', () => {
  it('turns profile access off (none for an assistant, persona only for a character) and sets 自动记忆', async () => {
    const service = createMemoryService();
    renderPage(service, { scope: 'bot:fantay' });
    const policy = await screen.findByTestId('memory-bot-policy');
    expect(policy.textContent).toContain('让它了解我的个人画像');
    expect(policy.textContent).toContain('自动记忆');
    expect(policy.textContent).not.toMatch(/profileMount|owner_profile|persona_only/);

    const assistantSwitch = screen.getByTestId('memory-bot-profile-switch');
    expect(assistantSwitch.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(assistantSwitch);
    await waitFor(() => expect(service.callsTo('/agents/fantay/policy', 'PATCH')).toHaveLength(1));
    expect(service.callsTo('/agents/fantay/policy', 'PATCH')[0]!.body).toEqual({ profileMount: 'none' });
    await waitFor(() => expect(screen.getByTestId('memory-bot-profile-switch').getAttribute('aria-checked')).toBe('false'));

    const select = screen.getByTestId('memory-bot-auto-select');
    expect(select.textContent).toContain('先问我');
    fireEvent.keyDown(select, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: '直接记下' }));
    await waitFor(() => expect(service.callsTo('/agents/fantay/policy', 'PATCH')).toHaveLength(2));
    expect(service.callsTo('/agents/fantay/policy', 'PATCH')[1]!.body).toEqual({ autoMemoryMode: 'explicit_auto' });

    // A character card keeps its persona when it loses the real profile.
    fireEvent.click(screen.getByTestId('memory-nav-bot-moon'));
    const characterSwitch = await screen.findByTestId('memory-bot-profile-switch');
    expect(characterSwitch.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(characterSwitch);
    await waitFor(() => expect(service.callsTo('/agents/moon/policy', 'PATCH')).toHaveLength(1));
    expect(service.callsTo('/agents/moon/policy', 'PATCH')[0]!.body).toEqual({ profileMount: 'owner_profile' });
    await waitFor(() => expect(screen.getByTestId('memory-bot-profile-switch').getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(screen.getByTestId('memory-bot-profile-switch'));
    await waitFor(() => expect(service.callsTo('/agents/moon/policy', 'PATCH')).toHaveLength(2));
    expect(service.callsTo('/agents/moon/policy', 'PATCH')[1]!.body).toEqual({ profileMount: 'persona_only' });
  });

  it('puts the switch back and says so when saving fails', async () => {
    const service = createMemoryService();
    service.override((call) =>
      call.path === '/agents/fantay/policy' ? failWith(500, 'PA_AGENT_SAVE_FAILED', 'disk full') : undefined,
    );
    renderPage(service, { scope: 'bot:fantay' });
    const toggle = await screen.findByTestId('memory-bot-profile-switch');
    fireEvent.click(toggle);
    expect(await screen.findByText('没能保存这个设置。')).toBeTruthy();
    expect(screen.getByTestId('memory-bot-profile-switch').getAttribute('aria-checked')).toBe('true');
  });
});

describe('Memory Center — header actions', () => {
  it('opens the inbox, recall and engine dialogs', async () => {
    renderPage(createMemoryService(), { scope: 'bot:fantay' });
    await screen.findByTestId('memory-row-i1');
    fireEvent.click(screen.getByTestId('memory-open-inbox'));
    expect(await screen.findByTestId('memory-inbox-dialog')).toBeTruthy();
    expect(await screen.findByTestId('memory-inbox-conflict-k1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('memory-inbox-done'));
    await waitFor(() => expect(screen.queryByTestId('memory-inbox-dialog')).toBeNull());

    fireEvent.click(screen.getByTestId('memory-open-recall'));
    const recall = await screen.findByTestId('memory-recall-dialog');
    // It starts as the bot whose memory is on screen.
    expect(within(recall).getByTestId('memory-recall-as').textContent).toContain('Fantay');
    fireEvent.keyDown(recall, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('memory-recall-dialog')).toBeNull());

    fireEvent.click(screen.getByTestId('memory-open-engine'));
    expect(await screen.findByTestId('memory-engine-level')).toBeTruthy();
  });

  it('renders the page in English', async () => {
    renderPage(createMemoryService(), { locale: 'en' });
    expect((await screen.findByTestId('memory-inventory')).textContent).toBe('10 memories · 3 need you');
    expect(screen.getByTestId('memory-new').textContent).toContain('New memory');
    expect(screen.getByTestId('memory-scope-title').textContent).toBe('My profile');
    expect(screen.getByTestId('memory-tab-archived').textContent).toContain('Archived');
  });
});

describe('Memory Center — old /memory/<tab> links', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it.each([
    ['/memory/project', 'project:proj1', '学习 Agent 落地页方向'],
    ['/memory/group', 'group:g1', '协作工作室'],
    ['/memory/agent', 'bot:fantay', 'Fantay'],
    ['/memory/private', 'profile:', '个人画像'],
  ])('%s opens the first place of its kind', async (path, key, title) => {
    window.history.replaceState(null, '', path);
    renderPage(createMemoryService(), { scope: 'bot:moon' });
    await waitFor(() => expect(screen.getByTestId('memory-scope-pane').getAttribute('data-scope')).toBe(key));
    expect(screen.getByTestId('memory-scope-title').textContent).toBe(title);
    // Followed once: choosing another place afterwards sticks.
    fireEvent.click(screen.getByTestId('memory-nav-bot-moon'));
    await screen.findByTestId('memory-row-m1');
    expect(screen.getByTestId('memory-scope-pane').getAttribute('data-scope')).toBe('bot:moon');
  });

  it('keeps the remembered place for a bare /memory, and opens 试试回忆 for the old inspector link', async () => {
    window.history.replaceState(null, '', '/memory');
    const { unmount } = renderPage(createMemoryService(), { scope: 'bot:moon' });
    await screen.findByTestId('memory-row-m1');
    expect(screen.getByTestId('memory-scope-pane').getAttribute('data-scope')).toBe('bot:moon');
    unmount();

    window.history.replaceState(null, '', '/memory/inspector');
    renderPage(createMemoryService(), { scope: 'bot:moon' });
    expect(await screen.findByTestId('memory-recall-dialog')).toBeTruthy();
    expect(screen.getByTestId('memory-scope-pane').getAttribute('data-scope')).toBe('bot:moon');
  });
});
