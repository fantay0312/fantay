// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Companion chat (Soul UI spec §4.3 b/c, §4.4, §4.5, §4.6): the themed transcript (intro, clusters, narration, variants,
// story cards, the lines under a reply, the typing bubble of a real turn, the failed line, the care card), the message
// menu, the companion composer (placeholder, play menu, slash list, chips, pending sends, tray, state strip) and the
// pure helpers (delta text, slash rows, paced reveal). Work mode stays on today's renderer.
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealPlan } from '@open-design/contracts/soul';
import type { StateEffect } from '@open-design/contracts/soul';

import { I18nProvider } from '../../../src/i18n';
import { paSoulChatEn, paSoulChatZh } from '../../../src/i18n/pa-ui/soul-chat';
import { PersonalAgentWorkspace } from '../../../src/fantay/pa/PersonalAgentWorkspace';
import { PaTransportProvider } from '../../../src/fantay/pa/pa-transport';
import { createFixtureTransport } from '../../../src/fantay/pa/lab/fixture-transport';
import { buildFixture, type PaScenarioId } from '../../../src/fantay/pa/lab/fixtures';
import { deltaText } from '../../../src/fantay/pa/soul/SoulBubble';
import { soulDeckFor, soulSlashOpen, soulSlashRows } from '../../../src/fantay/pa/soul/SoulSlashList';
import { __resetSoulComposeForTests } from '../../../src/fantay/pa/soul/soul-compose';
import { __resetSoulLiveForTests } from '../../../src/fantay/pa/soul/soul-live';
import { __resetSoulVoiceForTests } from '../../../src/fantay/pa/soul/soul-voice';
import { __resetSoulRevealForTests, skipSoulReveal, soulBubbles, useSoulReveal } from '../../../src/fantay/pa/soul/useSoulReveal';

const scrollIntoView = vi.fn();

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  scrollIntoView.mockClear();
  try {
    window.localStorage.clear();
  } catch {
    /* no storage */
  }
});

afterEach(() => {
  cleanup();
  __resetSoulComposeForTests();
  __resetSoulRevealForTests();
  __resetSoulLiveForTests();
  __resetSoulVoiceForTests();
  vi.useRealTimers();
});

const FAST = { latency: 0, chatDelays: { startMs: 5, replyMs: 5, liveMs: 60_000 } };

function mount(id: PaScenarioId, options: { conversationId?: string; locale?: 'en' | 'zh-CN'; liveMs?: number } = {}) {
  const fixture = buildFixture(id);
  const ui = options.conversationId ? { ...fixture.ui, conversationId: options.conversationId } : fixture.ui;
  const transport = createFixtureTransport(fixture, { ...FAST, chatDelays: { ...FAST.chatDelays, ...(options.liveMs ? { liveMs: options.liveMs } : {}) } });
  return render(
    <I18nProvider initial={options.locale ?? 'zh-CN'}>
      <PaTransportProvider transport={transport}>
        <PersonalAgentWorkspace active onOpenProject={vi.fn()} projects={fixture.projects} initialState={ui} />
      </PaTransportProvider>
    </I18nProvider>,
  );
}

async function transcript(): Promise<HTMLElement> {
  return screen.findByTestId('pa-soul-transcript');
}

function itemOf(messageId: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-testid="pa-soul-item"][data-message-id="${messageId}"]`);
  if (!node) throw new Error(`no item ${messageId}`);
  return node;
}

async function openMenu(root: HTMLElement): Promise<string[]> {
  const trigger = within(root).getAllByTestId('pa-soul-menu-trigger')[0]!;
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  const menu = await screen.findByTestId('pa-soul-message-menu');
  // Radix marks the rest of the page aria-hidden while a menu is open; read the rows directly.
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.getAttribute('data-action') ?? '');
}

/* ── i18n ──────────────────────────────────────────────────────────────────────────────────── */

describe('soul-chat copy', () => {
  it('defines every English key in Chinese, and Chinese writes TA literally', () => {
    expect(Object.keys(paSoulChatZh).sort()).toEqual(Object.keys(paSoulChatEn).sort());
    expect(paSoulChatZh['pa.soul.chat.menu.hide']).toBe('不让 TA 看到');
    expect(paSoulChatEn['pa.soul.chat.menu.hide']).toBe('Hide from {name}');
  });
});

/* ── pure helpers ──────────────────────────────────────────────────────────────────────────── */

describe('delta text', () => {
  const t = ((key: string, vars?: Record<string, string | number>) =>
    (paSoulChatZh as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ''))) as never;

  it('uses a true minus, 获得 / 失去 per item and label → value', () => {
    const effects: StateEffect[] = [
      { key: 'hp', label: '生命', kind: 'number', delta: -2, value: 8 },
      { key: 'gold', label: '金币', kind: 'number', delta: 3, value: 12 },
      { key: 'bag', label: '背包', kind: 'list', added: ['铜钥匙'], removed: ['火柴'], value: ['铜钥匙'] },
      { key: 'location', label: '位置', kind: 'text', value: '三楼尽头' },
    ];
    expect(deltaText(t, effects)).toBe('生命 −2 · 金币 +3 · 获得 铜钥匙 · 失去 火柴 · 位置 → 三楼尽头');
  });
});

describe('slash rows', () => {
  const decks = [
    { id: 'soup', name: '海龟汤', cards: [] },
    { id: 'topic', name: '话题', cards: [] },
  ] as never;

  it('opens only for a leading slash without a line break', () => {
    expect(soulSlashOpen('/r')).toBe(true);
    expect(soulSlashOpen('hi /r')).toBe(false);
    expect(soulSlashOpen('/roll\nd20')).toBe(false);
  });

  it('lists every command for a bare slash and marks /task free while a turn runs', () => {
    const rows = soulSlashRows('/', { decks, busy: true });
    expect(rows.map((row) => (row.kind === 'command' ? row.command.id : row.deck.id))).toEqual(['roll', 'draw', 'event', 'continue', 'task']);
    expect(rows.filter((row) => !row.busy).map((row) => (row.kind === 'command' ? row.command.id : ''))).toEqual(['task']);
  });

  it('marks an unparsable roll and lists decks after /draw', () => {
    const roll = soulSlashRows('/roll 翻墙', { decks, busy: false })[0]!;
    expect(roll.kind === 'command' && roll.invalid).toBe(true);
    expect(soulSlashRows('/roll d20+2 翻墙 12', { decks, busy: false })[0]).toMatchObject({ invalid: false, arg: 'd20+2 翻墙 12' });
    expect(soulSlashRows('/draw ', { decks, busy: false }).map((row) => row.key)).toEqual(['deck:soup', 'deck:topic']);
    expect(soulDeckFor('海龟汤', decks)?.id).toBe('soup');
    expect(soulDeckFor('海', decks)).toBeNull();
  });

  it('marks /continue invalid in a 我来点名 room', () => {
    const row = soulSlashRows('/continue', { decks, busy: false, manual: true })[0]!;
    expect(row.kind === 'command' && row.command.id === 'continue' && row.invalid).toBe(true);
    expect(soulSlashRows('/continue', { decks, busy: false })[0]).toMatchObject({ invalid: false });
  });
});

describe('paced reveal', () => {
  it('memoises bubble splitting per message id and text', () => {
    const first = soulBubbles('m1', '一\n\n二');
    expect(first).toEqual(['一', '二']);
    expect(soulBubbles('m1', '一\n\n二')).toBe(first);
  });

  it('reveals at the engine offsets and a skip shows the rest at once', () => {
    vi.useFakeTimers();
    const bubbles = ['第一句话', '第二句话稍微长一点', '第三句', '第四句'];
    const offsets = revealPlan(bubbles);
    const { result } = renderHook(() => useSoulReveal('m-paced', bubbles, true));
    expect(result.current).toBe(1);
    act(() => {
      vi.advanceTimersByTime(offsets[1]!);
    });
    expect(result.current).toBe(2);
    act(() => skipSoulReveal());
    expect(result.current).toBe(4);
  });

  it('shows everything at once when not enabled', () => {
    const { result } = renderHook(() => useSoulReveal('m-history', ['a', 'b', 'c'], false));
    expect(result.current).toBe(3);
  });
});

/* ── companion transcript ──────────────────────────────────────────────────────────────────── */

describe('companion transcript (companion-chat)', () => {
  it('themes the column and starts with the intro', async () => {
    mount('companion-chat');
    await transcript();
    const view = screen.getByTestId('pa-conversation');
    expect(view.getAttribute('data-mode')).toBe('companion');
    expect(view.getAttribute('data-pa-skin')).toBe('sakura');
    const intro = screen.getByTestId('pa-soul-intro');
    expect(intro.textContent).toContain('小月');
    expect(intro.textContent).toMatch(/小月 是 AI 扮演的角色 · 认识第 \d+ 天/);
  });

  it('renders clusters as bubbles with unboxed narration and no raw asterisks', async () => {
    mount('companion-chat');
    const column = await transcript();
    expect(within(column).getAllByTestId('pa-soul-bubble').some((node) => node.getAttribute('data-side') === 'out')).toBe(true);
    expect(within(column).getAllByTestId('pa-soul-bubble').some((node) => node.getAttribute('data-side') === 'in')).toBe(true);
    expect(within(column).getAllByTestId('pa-soul-narration').length).toBeGreaterThan(0);
    for (const bubble of within(column).getAllByTestId('pa-soul-bubble')) expect(bubble.textContent).not.toMatch(/\*/);
  });

  it('shows the selected variant 2/3, the roll card with 成功 and the 想记下 line', async () => {
    mount('companion-chat');
    await transcript();
    const newest = itemOf('xy-13b');
    expect(within(newest).getByTestId('pa-soul-variant-bar').textContent).toContain('2/3');
    const roll = screen.getAllByTestId('pa-soul-story').find((node) => node.getAttribute('data-kind') === 'roll')!;
    expect(roll.textContent).toContain('故事 · 掷骰');
    expect(roll.textContent).toContain('成功');
    const candidate = screen.getByTestId('pa-soul-candidate');
    expect(candidate.textContent).toContain('想记下：陪阿树去逛河岸的旧书市集');
    expect(candidate.textContent).toContain('记下');
    expect(candidate.textContent).toContain('忽略');
  });

  it('follows the end without scrolling anything but its own scroller', async () => {
    mount('companion-chat');
    await transcript();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('lists the message actions in order, and a story item offers copy, hide and delete', async () => {
    mount('companion-chat');
    await transcript();
    // 朗读 (stage 2) follows 复制 on an agent reply; 小月 has no voice here, so it is offered disabled with the reason.
    expect(await openMenu(itemOf('xy-11'))).toEqual(['quote', 'copy', 'speak', 'edit', 'remember', 'branch', 'context', 'hide', 'delete']);
    cleanup();
    mount('companion-chat');
    await transcript();
    const story = document.querySelector<HTMLElement>('[data-message-id="xy-10"]')!;
    expect(await openMenu(story)).toEqual(['copy', 'hide', 'delete']);
  });

  it('shows the failed line with 重试 under the owner line of a failed turn', async () => {
    mount('companion-chat', { conversationId: 'conv-zhou' });
    await transcript();
    const failed = await screen.findByTestId('pa-soul-failed');
    expect(failed.textContent).toContain('没有收到回复（模型服务暂时不可用（503））');
    expect(within(failed).getByRole('button').textContent).toBe('重试');
  });

  it('shows the care card under a crisis line and remembers its dismissal on this device', async () => {
    mount('companion-chat', { conversationId: 'conv-alan' });
    await transcript();
    const care = await screen.findByTestId('pa-soul-care');
    expect(care.textContent).toContain('12356');
    fireEvent.click(within(care).getByRole('button', { name: '关闭提示' }));
    await waitFor(() => expect(screen.queryByTestId('pa-soul-care')).toBeNull());
    expect(JSON.parse(window.localStorage.getItem('fantay.pa.care.dismissed.v1') ?? '[]')).toEqual(['al-03']);
  });
});

describe('companion transcript (story-game, companion-group)', () => {
  it('story-game: delta lines, the interlude card, the strip and the next-step tray', async () => {
    mount('story-game');
    await transcript();
    const deltas = screen.getAllByTestId('pa-soul-delta').map((node) => node.textContent ?? '');
    expect(deltas.some((text) => text.includes('−2'))).toBe(true);
    expect(deltas.some((text) => text.includes('获得 铜钥匙'))).toBe(true);
    const event = screen.getAllByTestId('pa-soul-story').find((node) => node.getAttribute('data-kind') === 'event')!;
    expect(event.textContent).toContain('故事 · 小插曲');
    const strip = await screen.findByTestId('pa-soul-state-strip');
    expect(strip.textContent).toContain('小插曲 · 还剩 2 轮');
    expect(strip.textContent).toMatch(/全部 \d+ 项/);
    const tray = await screen.findByTestId('pa-soul-tray');
    expect(tray.getAttribute('data-kind')).toBe('next');
    expect(tray.textContent).toContain('下一步');
    expect(tray.textContent).toContain('掷 d20 · 撬锁 · 目标 12');
    expect(tray.textContent).toContain('用力把门撬开');
  });

  it('a choice fills the input and never sends', async () => {
    mount('story-game');
    const tray = await screen.findByTestId('pa-soul-tray');
    fireEvent.click(within(tray).getByText('先躲进旁边的杂物间'));
    await waitFor(() => expect((screen.getByTestId('pa-composer-input') as HTMLTextAreaElement).value).toBe('先躲进旁边的杂物间'));
    expect(screen.queryByTestId('pa-soul-pending')).toBeNull();
  });

  it('companion-group: names on clusters, the draw secret line and the typing bubble of the running turn', async () => {
    mount('companion-group');
    await transcript();
    expect(screen.getByTestId('pa-soul-intro').getAttribute('data-room')).toBe('');
    const draw = screen.getAllByTestId('pa-soul-story').find((node) => node.getAttribute('data-kind') === 'draw')!;
    expect(draw.textContent).toContain('含只有 阿岚 知道的内容');
    expect(within(draw).getByRole('button', { name: '揭晓' })).toBeTruthy();
    const typing = await screen.findByTestId('pa-soul-typing');
    // Dots until the running turn's first live text arrives (stage 2), then the live label.
    expect(typing.getAttribute('aria-label')).toMatch(/^阿岚 正在(输入|回复)$/);
    expect(screen.queryByTestId('pa-soul-state-strip')).toBeNull();
  });
});

/* ── companion composer ────────────────────────────────────────────────────────────────────── */

describe('companion composer', () => {
  it('names the character, shows no model picker and no queue note', async () => {
    mount('companion-chat');
    await transcript();
    const input = screen.getByTestId('pa-composer-input') as HTMLTextAreaElement;
    expect(input.getAttribute('placeholder')).toBe('给 小月 发消息');
    expect(screen.queryByTestId('pa-composer-model-picker')).toBeNull();
    expect(screen.queryByTestId('pa-soul-persona-chip')).toBeNull();
  });

  it('opens the slash list on / and the play menu on ＋', async () => {
    mount('companion-chat');
    await transcript();
    const input = screen.getByTestId('pa-composer-input') as HTMLTextAreaElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '/' } });
    const list = await screen.findByTestId('pa-soul-slash-list');
    expect(within(list).getAllByRole('option')).toHaveLength(5);
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('pa-soul-slash-list')).toBeNull());
    fireEvent.pointerDown(screen.getByTestId('pa-composer-plus'), { button: 0, ctrlKey: false, pointerType: 'mouse' });
    const menu = await screen.findByTestId('pa-soul-play-menu');
    expect(menu.textContent).toContain('玩法');
    expect(menu.textContent).toContain('/roll');
    expect(menu.textContent).toContain('作为任务交给 TA');
  });

  it('/task sets the task chip and Esc cancels it', async () => {
    mount('companion-chat');
    await transcript();
    const input = screen.getByTestId('pa-composer-input') as HTMLTextAreaElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '/task' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const chip = await screen.findByTestId('pa-soul-chip');
    expect(chip.getAttribute('data-kind')).toBe('task');
    expect(chip.textContent).toContain('作为任务交给 小月 · 会有进度和结果');
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('pa-soul-chip')).toBeNull());
  });

  it('a send shows a pending bubble, the typing bubble of the real turn, then the reply and no typing', async () => {
    mount('companion-chat', { liveMs: 60_000 });
    await transcript();
    const input = screen.getByTestId('pa-composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '今天好累' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('');
    await waitFor(() => expect(screen.queryAllByText('今天好累').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByTestId('pa-soul-typing')).toBeTruthy());
    await waitFor(() => expect(screen.queryByTestId('pa-soul-typing')).toBeNull(), { timeout: 4000 });
    expect(screen.queryByTestId('pa-soul-pending')).toBeNull();
  });
});

/* ── work mode keeps today's renderer ──────────────────────────────────────────────────────── */

describe('work mode', () => {
  it('fantay-chat keeps the work transcript, its ＋ menu and model picker', async () => {
    mount('fantay-chat', { locale: 'en' });
    await screen.findByTestId('pa-work-line');
    expect(screen.queryByTestId('pa-soul-transcript')).toBeNull();
    expect(screen.getByTestId('pa-conversation').getAttribute('data-mode')).toBe('work');
    expect(screen.getByTestId('pa-conversation').hasAttribute('data-pa-skin')).toBe(false);
    fireEvent.pointerDown(screen.getByTestId('pa-composer-plus'), { button: 0, ctrlKey: false, pointerType: 'mouse' });
    await waitFor(() => expect(screen.queryByTestId('pa-soul-play-menu')).toBeNull());
  });
});
