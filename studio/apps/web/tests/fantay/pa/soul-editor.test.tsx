// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// W3-5 (Soul UI spec 7.1, 7.4–7.8, 6.4): the profile editor and its sections, the state-fields rules, the appearance
// picker's layer rule and scope, chat settings with 先开口 (W6) and its tag on the 例行 pane, the built-in style, the
// memory modal's 约定 date and the memory page additions. Mounted over the lab fixtures and the fixture transport, with
// every request recorded.
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaRoutine } from '@open-design/contracts';

import { I18nProvider } from '../../../src/i18n';
import { createFixtureTransport } from '../../../src/fantay/pa/lab/fixture-transport';
import { buildFixture, type PaFixture, type PaScenarioId } from '../../../src/fantay/pa/lab/fixtures';
import { PaTransportProvider } from '../../../src/fantay/pa/pa-transport';
import type { PaModalState, PaTransport, PaUiState } from '../../../src/fantay/pa/pa-types';
import { PersonalAgentWorkspace } from '../../../src/fantay/pa/PersonalAgentWorkspace';
import { withTheme } from '../../../src/fantay/pa/soul/SoulAppearancePicker';
import {
  REACHOUT_PROMPT,
  chatSettingsPatch,
  reachForm,
  reachQuiet,
  reachoutWrite,
} from '../../../src/fantay/pa/soul/SoulChatSettingsModal';
import { characterPatch, sameJson } from '../../../src/fantay/pa/soul/SoulProfileModal';
import { stateFieldIssues, suggestStateKey } from '../../../src/fantay/pa/soul/SoulStateFieldsEditor';

interface Call {
  path: string;
  method: string;
  body: unknown;
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

function mount(id: PaScenarioId, ui: Partial<PaUiState> = {}, locale: 'zh-CN' | 'en' = 'zh-CN', prepare?: (fixture: PaFixture) => void) {
  const fixture = buildFixture(id);
  prepare?.(fixture);
  const base = createFixtureTransport(fixture, { latency: 0 });
  const calls: Call[] = [];
  const transport = (<T,>(path?: string, method?: string, body?: unknown, signal?: AbortSignal) => {
    calls.push({ path: path ?? '', method: method ?? 'GET', body });
    return base<T>(path, method, body, signal);
  }) as PaTransport;
  render(
    <I18nProvider initial={locale}>
      <PaTransportProvider transport={transport}>
        <PersonalAgentWorkspace active onOpenProject={vi.fn()} projects={fixture.projects} initialState={{ ...fixture.ui, ...ui }} />
      </PaTransportProvider>
    </I18nProvider>,
  );
  return { calls, fixture };
}

function withModal(id: PaScenarioId, modal: PaModalState, locale: 'zh-CN' | 'en' = 'zh-CN') {
  return mount(id, { modal }, locale);
}

const writes = (calls: Call[], method: string, path: RegExp) => calls.filter((call) => call.method === method && path.test(call.path));

/** A 先开口 routine of 小月's chat, as the daemon stores it (last run skipped by the daily cap). */
function reachRoutine(extra: Partial<PaRoutine> = {}): PaRoutine {
  return {
    id: 'rt-reach',
    createdAt: 1,
    updatedAt: 1,
    revision: 3,
    name: '小月 先开口',
    prompt: '问问海报做完没有',
    conversationId: 'conv-xiaoyue',
    time: '20:30',
    timezone: 'Asia/Shanghai',
    enabled: true,
    soul: { kind: 'reachout' },
    nextRunAt: Date.now() + 3_600_000,
    lastTaskId: null,
    lastError: '今天已经主动开口两次了',
    ...extra,
  };
}

/* ── pure rules ───────────────────────────────────────────────────────────────────────────── */

describe('editor rules', () => {
  it('sends only the changed character keys and compares layers by value', () => {
    const base = { tagline: 'a', tags: ['x'], appearance: { theme: 'sakura' as const, font: 'kai' as const } };
    const next = { tagline: 'b', tags: ['x'], appearance: { font: 'kai' as const, theme: 'sakura' as const } };
    expect(characterPatch(base as never, next as never)).toEqual({ tagline: 'b' });
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
  });

  it('prefills state keys from ASCII names and never reuses a reserved or taken key', () => {
    expect(suggestStateKey('Gold coins', new Set())).toBe('goldCoins');
    expect(suggestStateKey('生命', new Set(['field1']))).toBe('field2');
    expect(suggestStateKey('mood', new Set())).toBe('field1');
    expect(suggestStateKey('HP', new Set(['hp']))).toBe('hp2');
  });

  it('flags duplicate keys and labels, bad ranges and an enum value outside its options', () => {
    const issues = stateFieldIssues([
      { kind: 'number', key: 'hp', label: '生命', initial: 12, min: 0, max: 10, hint: '', writable: 'model' },
      { kind: 'number', key: 'hp', label: '生命', initial: 0, min: 5, max: 1, hint: '', writable: 'model' },
      { kind: 'enum', key: 'place', label: '位置', initial: '码头', options: ['旅店'], hint: '', writable: 'model' },
      { kind: 'text', key: '9bad', label: '', initial: '', hint: '', writable: 'user' },
    ]);
    expect(issues[0]).toMatchObject({ key: 'pa.soul.editor.play.error.keyTaken', label: 'pa.soul.editor.play.error.labelTaken', initial: 'pa.soul.editor.play.error.initial' });
    expect(issues[1]?.range).toBe('pa.soul.editor.play.error.range');
    expect(issues[2]?.initial).toBe('pa.soul.editor.play.error.option');
    expect(issues[3]).toMatchObject({ key: 'pa.soul.editor.play.error.key', label: 'invalid' });
  });

  it('drops font, pattern and frame with a new theme and keeps the stage 2 keys', () => {
    expect(withTheme({ theme: 'sakura', font: 'kai', pattern: 'dots', avatarFrame: 'polaroid', shape: 'round', layout: 'journal', accent: null }, 'ink')).toEqual({
      theme: 'ink',
      shape: 'round',
      layout: 'journal',
      accent: null,
    });
  });
});

/* ── profile editor ───────────────────────────────────────────────────────────────────────── */

describe('profile editor', () => {
  it('shows all ten sections for a character, the import record and the export menu', async () => {
    withModal('library', { kind: 'agent', agentId: 'ag-linqi' });
    const modal = await screen.findByTestId('pa-profile-modal');
    expect(await within(modal).findByTestId('pa-profile-export')).toBeTruthy();
    for (const section of ['basic', 'persona', 'greeting', 'examples', 'lore', 'style', 'look', 'play', 'work', 'advanced'])
      expect(within(modal).getByTestId(`pa-profile-nav-${section}`)).toBeTruthy();
    fireEvent.click(within(modal).getByTestId('pa-profile-nav-advanced'));
    expect(await within(modal).findByText('导入记录')).toBeTruthy();
    expect(within(modal).getByTestId('pa-profile-review')).toBeTruthy();
    expect(within(modal).getByText('用角色卡覆盖…')).toBeTruthy();
  });

  it('shows only 基础, 文风与模型 and 工作 for Fantay', async () => {
    withModal('library', { kind: 'agent', agentId: 'ag-fantay' });
    const modal = await screen.findByTestId('pa-profile-modal');
    const nav = () =>
      within(modal)
        .getAllByRole('button')
        .filter((button) => button.dataset.testid?.startsWith('pa-profile-nav-'))
        .map((button) => button.dataset.testid);
    await waitFor(() => expect(nav()).toEqual(['pa-profile-nav-basic', 'pa-profile-nav-style', 'pa-profile-nav-work']));
    expect((within(modal).getByLabelText('名字') as HTMLInputElement).value).toBe('Fantay');
    expect(within(modal).queryByTestId('pa-profile-export')).toBeNull();
  });

  it('saves only the changed character key and leaves the agent alone', async () => {
    const { calls } = withModal('library', { kind: 'agent', agentId: 'ag-linqi' });
    const modal = await screen.findByTestId('pa-profile-modal');
    await within(modal).findByTestId('pa-profile-export');
    fireEvent.change(within(modal).getByLabelText('一句话介绍'), { target: { value: '山里的民宿' } });
    fireEvent.click(within(modal).getByTestId('pa-profile-save'));
    await waitFor(() => expect(writes(calls, 'PUT', /^\/soul\/characters\/ag-linqi$/)).toHaveLength(1));
    const body = writes(calls, 'PUT', /^\/soul\/characters\/ag-linqi$/)[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).filter((key) => key !== 'revision')).toEqual(['tagline']);
    expect(writes(calls, 'PATCH', /^\/agents\//)).toHaveLength(0);
  });

  it('creates a new character: the agent with a derived role, then its card', async () => {
    const { calls } = withModal('library', { kind: 'agent', agentId: null });
    const modal = await screen.findByTestId('pa-profile-modal');
    expect(within(modal).getByText('新建角色')).toBeTruthy();
    await waitFor(() => expect(calls.some((call) => call.method === 'GET' && call.path === '/soul')).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    fireEvent.change(within(modal).getByLabelText('名字'), { target: { value: '林小满' } });
    fireEvent.change(within(modal).getByLabelText('一句话介绍'), { target: { value: '巷口花店的店主' } });
    fireEvent.click(within(modal).getByTestId('pa-profile-save'));
    await waitFor(() => expect(writes(calls, 'POST', /^\/agents$/)).toHaveLength(1));
    expect((writes(calls, 'POST', /^\/agents$/)[0]!.body as { role: string }).role).toBe('角色扮演：林小满。巷口花店的店主');
    await waitFor(() => expect(writes(calls, 'PUT', /^\/soul\/characters\//)).toHaveLength(1));
    expect(writes(calls, 'PUT', /^\/soul\/characters\//)[0]!.body).toMatchObject({ tagline: '巷口花店的店主' });
  });

  it('marks a section with a field over its limit and holds 保存', async () => {
    withModal('library', { kind: 'agent', agentId: 'ag-linqi' });
    const modal = await screen.findByTestId('pa-profile-modal');
    await within(modal).findByTestId('pa-profile-export');
    fireEvent.change(within(modal).getByLabelText('一句话介绍'), { target: { value: 'x'.repeat(130) } });
    expect(within(modal).getByText('130/120')).toBeTruthy();
    expect(within(within(modal).getByTestId('pa-profile-nav-basic')).getByText('这一部分有内容需要修改')).toBeTruthy();
    expect(within(modal).getByTestId('pa-profile-save').getAttribute('aria-disabled')).toBe('true');
  });

  it('lists the story-state fields of 说书人 and asks before discarding an edit', async () => {
    withModal('story-game', { kind: 'agent', agentId: 'ag-storyteller', section: 'play' });
    const modal = await screen.findByTestId('pa-profile-modal');
    expect((await within(modal).findAllByTestId('pa-state-field-row')).length).toBeGreaterThanOrEqual(3);
    fireEvent.click(within(modal).getByText('添加状态'));
    expect(within(modal).getAllByTestId('pa-state-field-row').length).toBeGreaterThanOrEqual(4);
    fireEvent.click(within(modal).getByText('取消'));
    expect(await screen.findByText('放弃修改？')).toBeTruthy();
  });
});

/* ── small modals ─────────────────────────────────────────────────────────────────────────── */

describe('small modals', () => {
  it('appearance: seven swatches; a new theme applied to the character drops the theme defaults', async () => {
    const { calls } = withModal('companion-chat', { kind: 'appearance', conversationId: 'conv-xiaoyue' });
    const modal = await screen.findByTestId('pa-appearance-modal');
    expect(await within(modal).findByText('和 小月 的所有对话')).toBeTruthy();
    expect(within(modal).getAllByTestId('pa-theme-swatch')).toHaveLength(7);
    const ink = within(modal).getAllByTestId('pa-theme-swatch').find((cell) => cell.dataset.theme === 'ink')!;
    fireEvent.click(ink);
    expect(ink.getAttribute('aria-pressed')).toBe('true');
    expect(within(modal).getByTestId('pa-appearance-preview').getAttribute('data-pa-skin')).toBe('ink');
    fireEvent.click(within(modal).getByTestId('pa-appearance-apply'));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT' && /^\/soul\/(characters\/ag-xiaoyue|chats\/conv-xiaoyue)$/.test(call.path))).toBe(true));
    const write = calls.find((call) => call.method === 'PUT' && /^\/soul\/(characters|chats)\//.test(call.path))!;
    expect((write.body as { appearance: Record<string, unknown> }).appearance).toMatchObject({ theme: 'ink' });
    expect((write.body as { appearance: Record<string, unknown> }).appearance).not.toHaveProperty('font');
  });

  it('chat settings: a group chat offers 谁来接话 and saves only what changed', async () => {
    const { calls } = withModal('companion-group', { kind: 'chatSettings', conversationId: 'conv-room' });
    const modal = await screen.findByTestId('pa-chat-settings-modal');
    const strategy = await within(modal).findByTestId('pa-chat-strategy');
    expect(within(modal).queryByTestId('pa-chat-reachout')).toBeNull();
    fireEvent.click(within(strategy).getByText('轮流'));
    expect(within(modal).getByText('按成员顺序轮流说。')).toBeTruthy();
    fireEvent.click(within(modal).getByText('保存'));
    await waitFor(() => expect(writes(calls, 'PUT', /^\/soul\/chats\/conv-room$/)).toHaveLength(1));
    const body = writes(calls, 'PUT', /^\/soul\/chats\/conv-room$/)[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).filter((key) => key !== 'revision')).toEqual(['groupStrategy']);
    expect(body.groupStrategy).toBe('list');
  });

  it('chat settings patch: mode only when it differs from the resolved mode; an empty note saves null', () => {
    const chat = buildFixture('companion-chat').soul!.chats[0]!;
    const form = {
      mode: 'companion' as const,
      personaId: chat.personaId,
      presetId: chat.presetId,
      scenario: chat.scenario,
      noteText: '  ',
      noteDepth: 4,
      lorebookIds: chat.lorebookIds,
      disabledLoreEntryIds: chat.disabledLoreEntryIds,
      historyBudget: chat.historyBudget,
      turnRecord: chat.turnRecord,
      groupStrategy: chat.groupStrategy,
    };
    expect(chatSettingsPatch(form, { ...chat, authorNote: null }, 'companion', false)).toEqual({});
    expect(chatSettingsPatch({ ...form, mode: 'work', noteText: '' }, { ...chat, authorNote: { text: 'x', depth: 4 } }, 'companion', false)).toEqual({
      mode: 'work',
      authorNote: null,
    });
  });

  it('a built-in style opens read-only with 复制一份来改', async () => {
    withModal('library', { kind: 'preset', presetId: 'builtin:real-chat' });
    const modal = await screen.findByTestId('pa-preset-modal');
    expect(await within(modal).findByText('内置文风不能直接修改。')).toBeTruthy();
    expect(within(modal).getByTestId('pa-preset-copy')).toBeTruthy();
    expect((within(modal).getByLabelText('名字') as HTMLInputElement).disabled).toBe(true);
  });

  it('persona: edit shows the default switch and a quiet 删除; a new first persona is the default', async () => {
    const fixture = buildFixture('library');
    const persona = fixture.soul!.personas[0]!;
    withModal('library', { kind: 'persona', personaId: persona.id });
    const modal = await screen.findByTestId('pa-persona-modal');
    expect(await within(modal).findByText('删除')).toBeTruthy();
    expect(within(modal).getByText('编辑人设')).toBeTruthy();
    expect(within(modal).getByText('设为默认')).toBeTruthy();
    expect((within(modal).getByLabelText('名字') as HTMLInputElement).value).toBe(persona.name);
    cleanup();
    withModal('first-run-soul', { kind: 'persona', personaId: null });
    const first = await screen.findByTestId('pa-persona-modal');
    expect(within(first).getByText('新建人设')).toBeTruthy();
    await waitFor(() => expect(within(first).getByRole('switch').getAttribute('data-disabled') !== null || (within(first).getByRole('switch') as HTMLButtonElement).disabled).toBe(true));
    expect((within(first).getByRole('switch') as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
  });

  it('memory: 约定 shows 到期 and saves the local end of that day with the source message', async () => {
    const { calls } = withModal('companion-chat', {
      kind: 'memory',
      memoryId: null,
      preset: { scope: 'agent', scopeId: 'ag-xiaoyue', content: '周六一起去旧书市集', kind: 'promise', sourceMessageId: 'nope' },
    });
    const due = await screen.findByTestId('pa-memory-due');
    const dialog = due.closest('[role="dialog"]') as HTMLElement;
    fireEvent.change(due, { target: { value: '2026-12-01' } });
    fireEvent.change(within(dialog).getByPlaceholderText(/例如/), { target: { value: '和小月的对话' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByText('保存'));
    });
    await waitFor(() => expect(writes(calls, 'POST', /^\/memories$/)).toHaveLength(1));
    const body = writes(calls, 'POST', /^\/memories$/)[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'promise', dueAt: new Date(2026, 11, 1, 23, 59, 59, 999).getTime(), sourceMessageId: 'nope' });
  });
});

/* ── 先开口 (W6) ──────────────────────────────────────────────────────────────────────────── */

describe('先开口', () => {
  const target = { conversationId: 'conv-xiaoyue', name: '小月 先开口', timezone: 'Asia/Shanghai' };

  it('creates, updates, removes or leaves the reachout routine', () => {
    const routine = reachRoutine();
    expect(reachoutWrite({ on: false, time: '20:00', note: '' }, null, target)).toBeNull();
    expect(reachoutWrite({ on: true, time: '20:00', note: '  ' }, null, target)).toEqual({
      path: '/routines',
      method: 'POST',
      body: { ...target, prompt: REACHOUT_PROMPT, time: '20:00', enabled: true, soul: { kind: 'reachout' } },
    });
    expect(reachoutWrite(reachForm(routine), routine, target)).toBeNull();
    expect(reachoutWrite({ ...reachForm(routine), time: '21:00' }, routine, target)).toEqual({
      path: '/routines/rt-reach',
      method: 'PATCH',
      body: {
        name: '小月 先开口',
        prompt: '问问海报做完没有',
        conversationId: 'conv-xiaoyue',
        time: '21:00',
        timezone: 'Asia/Shanghai',
        enabled: true,
        soul: { kind: 'reachout' },
        revision: 3,
      },
    });
    expect(reachoutWrite({ ...reachForm(routine), on: false }, routine, target)).toEqual({
      path: '/routines/rt-reach',
      method: 'DELETE',
      body: { revision: 3 },
    });
    // A routine switched off elsewhere stays as it is while the switch stays off; switching on enables it again.
    const off = reachRoutine({ enabled: false });
    expect(reachoutWrite(reachForm(off), off, target)).toBeNull();
    expect(reachoutWrite({ ...reachForm(off), on: true }, off, target)?.method).toBe('PATCH');
  });

  it('reads the default prompt back as an empty note and knows the quiet time', () => {
    expect(reachForm(null)).toEqual({ on: false, time: '20:00', note: '' });
    expect(reachForm(reachRoutine({ prompt: REACHOUT_PROMPT })).note).toBe('');
    expect(['22:59', '23:00', '07:59', '08:00'].map(reachQuiet)).toEqual([false, true, true, false]);
  });

  it('chat settings: switching it on saves a reachout routine through /routines, never in quiet time', async () => {
    const { calls } = withModal('companion-chat', { kind: 'chatSettings', conversationId: 'conv-xiaoyue' });
    const modal = await screen.findByTestId('pa-chat-settings-modal');
    const section = await within(modal).findByTestId('pa-chat-reachout');
    expect(within(section).getByText('只在这个时间、Fantay 开着时才会发生，错过就跳过。', { exact: false })).toBeTruthy();
    const time = within(section).getByLabelText('每天几点') as HTMLInputElement;
    expect(time.disabled).toBe(true);
    fireEvent.click(within(section).getByRole('switch'));
    await waitFor(() => expect(time.disabled).toBe(false));
    const save = within(modal).getByText('保存').closest('button') as HTMLButtonElement;
    fireEvent.change(time, { target: { value: '23:30' } });
    expect(within(section).getByText('23:00–8:00 是安静时段，换个时间吧。')).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.change(time, { target: { value: '21:30' } });
    fireEvent.change(within(section).getByLabelText('想让 TA 提起的事'), { target: { value: '问问海报做完没有' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(writes(calls, 'POST', /^\/routines$/)).toHaveLength(1));
    expect(writes(calls, 'POST', /^\/routines$/)[0]!.body).toMatchObject({
      conversationId: 'conv-xiaoyue',
      time: '21:30',
      prompt: '问问海报做完没有',
      enabled: true,
      soul: { kind: 'reachout' },
    });
    expect(writes(calls, 'PUT', /^\/soul\/chats\//)).toHaveLength(0);
  });

  it('the 例行 pane tags a reachout routine and edits it in 对话设置, where switching it off removes it', async () => {
    const { calls } = mount('companion-chat', { place: 'activity', activityTab: 'routines' }, 'zh-CN', (fixture) => {
      fixture.snapshot.routines = [...(fixture.snapshot.routines ?? []), reachRoutine()];
    });
    const entry = (await screen.findAllByTestId('pa-routine')).find((item) => item.dataset.reachout !== undefined)!;
    expect(within(entry).getByText('先开口')).toBeTruthy();
    fireEvent.click(within(entry).getByText('编辑'));
    const modal = await screen.findByTestId('pa-chat-settings-modal');
    const section = await within(modal).findByTestId('pa-chat-reachout');
    const toggle = within(section).getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect((within(section).getByLabelText('每天几点') as HTMLInputElement).value).toBe('20:30');
    expect((within(section).getByLabelText('想让 TA 提起的事') as HTMLTextAreaElement).value).toBe('问问海报做完没有');
    expect(within(section).getByText('上次没有开口：今天已经主动开口两次了')).toBeTruthy();
    fireEvent.click(toggle);
    fireEvent.click(within(modal).getByText('保存'));
    await waitFor(() => expect(writes(calls, 'DELETE', /^\/routines\/rt-reach$/)).toHaveLength(1));
    expect(writes(calls, 'DELETE', /^\/routines\/rt-reach$/)[0]!.body).toEqual({ revision: 3 });
  });
});
