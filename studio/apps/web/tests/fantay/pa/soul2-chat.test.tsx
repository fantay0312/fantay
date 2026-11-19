// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Stage 2 in the companion transcript (STAGE2 4.10, 5.8, 6.3, 8.4): the running reply's live text in the typing row
// and the stored reply replacing it without a second reveal; the labelled draft of a stopped reply; 朗读 in the menu
// and the pill with its honest disabled reasons; the voice bar; 自动朗读 of fresh replies only; the standing picture
// inside the column's measure; the journal head line.
import '../helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import { PersonalAgentWorkspace } from '../../../src/fantay/pa/PersonalAgentWorkspace';
import { PaTransportProvider } from '../../../src/fantay/pa/pa-transport';
import type { PaTransport } from '../../../src/fantay/pa/pa-types';
import { createFixtureTransport, type FixtureTransportOptions } from '../../../src/fantay/pa/lab/fixture-transport';
import { buildFixture, type PaFixture, type PaScenarioId } from '../../../src/fantay/pa/lab/fixtures';
import { withoutSpeech } from '../../../src/fantay/pa/lab/soul-fixtures';
import { __resetSoulComposeForTests } from '../../../src/fantay/pa/soul/soul-compose';
import { __resetSoulLiveForTests } from '../../../src/fantay/pa/soul/soul-live';
import { __resetSoulVoiceForTests, soulAudio } from '../../../src/fantay/pa/soul/soul-voice';
import { paSoulAssetUrl } from '../../../src/fantay/pa/pa-api';
import { __resetSoulRevealForTests } from '../../../src/fantay/pa/soul/useSoulReveal';

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  // jsdom has no media playback: play resolves, pause is a no-op.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

interface Mounted {
  calls: Array<{ path: string; method: string; body: unknown }>;
}

function mount(
  fixtureOrId: PaScenarioId | PaFixture,
  options: { locale?: 'en' | 'zh-CN'; chatDelays?: FixtureTransportOptions['chatDelays'] } = {},
): Mounted {
  const fixture = typeof fixtureOrId === 'string' ? buildFixture(fixtureOrId) : fixtureOrId;
  const base = createFixtureTransport(fixture, { latency: 0, chatDelays: { startMs: 5, replyMs: 5, liveMs: 60_000, ...options.chatDelays } });
  const calls: Mounted['calls'] = [];
  const transport = ((path: string, method?: string, body?: unknown, ...rest: unknown[]) => {
    calls.push({ path, method: method ?? 'GET', body });
    return (base as (...args: unknown[]) => Promise<unknown>)(path, method, body, ...rest);
  }) as PaTransport;
  render(
    <I18nProvider initial={options.locale ?? 'zh-CN'}>
      <PaTransportProvider transport={transport}>
        <PersonalAgentWorkspace active onOpenProject={vi.fn()} projects={fixture.projects} initialState={fixture.ui} />
      </PaTransportProvider>
    </I18nProvider>,
  );
  return { calls };
}

function itemOf(messageId: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-testid="pa-soul-item"][data-message-id="${messageId}"]`);
  if (!node) throw new Error(`no item ${messageId}`);
  return node;
}

function newestItem(): HTMLElement {
  const items = screen.getAllByTestId('pa-soul-item');
  return items[items.length - 1]!;
}

async function openMenu(root: HTMLElement): Promise<HTMLElement> {
  fireEvent.pointerDown(within(root).getAllByTestId('pa-soul-menu-trigger')[0]!, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  return screen.findByTestId('pa-soul-message-menu');
}

function withChat(fixture: PaFixture, conversationId: string, patch: Record<string, unknown>): PaFixture {
  const soul = fixture.soul!;
  return { ...fixture, soul: { ...soul, chats: soul.chats.map((chat) => (chat.id === conversationId ? { ...chat, ...patch } : chat)) } };
}

/* ── live text ─────────────────────────────────────────────────────────────────────────────── */

describe('live text in the typing row (live-chat)', () => {
  it('grows as bubbles with the live label, never shows the footer, and gives way to the stored reply without a reveal', async () => {
    mount('live-chat', { chatDelays: { liveMs: 1500, streamStepMs: 60 } });
    const live = await screen.findByTestId('pa-soul-live', {}, { timeout: 3000 });
    expect(live.getAttribute('data-tone')).toBe('live');
    const typing = screen.getByTestId('pa-soul-typing');
    expect(typing.getAttribute('aria-label')).toBe('小月 正在回复');
    await waitFor(() => expect(within(live).getAllByTestId('pa-soul-bubble').length).toBeGreaterThan(1), { timeout: 3000 });
    expect(live.textContent).not.toMatch(/turn_meta|mood:|remember:/);
    // The stored reply (its id is the attempt's) replaces the live bubbles, all at once and without an entrance.
    await waitFor(() => expect(screen.queryByTestId('pa-soul-live')).toBeNull(), { timeout: 5000 });
    const stored = await waitFor(() => itemOf('xy-15'));
    expect(stored.textContent).toContain('今晚要不要奖励自己一杯热可可？');
    expect(stored.querySelectorAll('[data-enter]').length).toBe(0);
    expect(screen.queryByTestId('pa-soul-typing')).toBeNull();
    expect(screen.queryByTestId('pa-soul-live-ghost')).toBeNull();
  });

  it('shows the dots only when the runtime does not stream (&stream=0)', async () => {
    const { calls } = mount('live-chat', { chatDelays: { streamStepMs: 0 } });
    const typing = await screen.findByTestId('pa-soul-typing');
    await waitFor(() => expect(calls.some((call) => call.path.startsWith('/soul/live'))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByTestId('pa-soul-live')).toBeNull();
    expect(typing.querySelector('[data-slot="soul-typing-dots"]')).not.toBeNull();
    expect(typing.getAttribute('aria-label')).toBe('小月 正在输入');
  });

  it('a stop leaves the dimmed draft with its line, 复制 and 收起; nothing is stored', async () => {
    mount('live-chat', { chatDelays: { streamHoldAt: 0.6 } });
    const live = await screen.findByTestId('pa-soul-live', {}, { timeout: 3000 });
    await waitFor(() => expect(live.textContent).toContain('真的吗'), { timeout: 3000 });
    fireEvent.click(screen.getByTestId('pa-soul-typing-stop'));
    const ghost = await screen.findByTestId('pa-soul-live-ghost', {}, { timeout: 3000 });
    expect(ghost.getAttribute('data-tone')).toBe('stopped');
    expect(within(ghost).getByTestId('pa-soul-live').getAttribute('data-tone')).toBe('stopped');
    expect(ghost.textContent).toContain('已停止，这段没有保存');
    expect(ghost.textContent).toContain('真的吗');
    expect(within(ghost).getByRole('button', { name: '复制' })).toBeTruthy();
    expect(document.querySelector('[data-testid="pa-soul-item"][data-message-id="xy-15"]')).toBeNull();
    fireEvent.click(within(ghost).getByTestId('pa-soul-live-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('pa-soul-live-ghost')).toBeNull());
  });

  it('a new send hides the draft at once, so the owner line never sits above it', async () => {
    mount('live-chat', { chatDelays: { streamHoldAt: 0.6 } });
    const live = await screen.findByTestId('pa-soul-live', {}, { timeout: 3000 });
    await waitFor(() => expect(live.textContent).toContain('真的吗'), { timeout: 3000 });
    fireEvent.click(screen.getByTestId('pa-soul-typing-stop'));
    await screen.findByTestId('pa-soul-live-ghost', {}, { timeout: 3000 });
    const input = screen.getByTestId('pa-composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '那就先这样吧' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // the send is pending (not in the snapshot yet): its bubble shows, the draft does not
    expect(screen.getByTestId('pa-soul-transcript').textContent).toContain('那就先这样吧');
    expect(screen.queryByTestId('pa-soul-live-ghost')).toBeNull();
  });
});

/* ── voice ─────────────────────────────────────────────────────────────────────────────────── */

describe('朗读 and the voice bar (voice-chat)', () => {
  it('offers 朗读 after 复制 in the menu and in the pill, shows the stored audio as a bar, and a click generates one', async () => {
    const { calls } = mount('voice-chat');
    await screen.findByTestId('pa-soul-transcript');
    // The stored item of xy-11 restores its bar, inside the last boxed bubble.
    const bar = await waitFor(() => {
      const node = itemOf('xy-11').querySelector<HTMLElement>('[data-testid="pa-soul-voice-bar"]');
      if (!node) throw new Error('no bar yet');
      return node;
    });
    expect(bar.getAttribute('data-surface')).toBe('bubble');
    expect(bar.closest('[data-testid="pa-soul-bubble"]')).not.toBeNull();
    expect(bar.getAttribute('data-state')).toBe('idle');

    const newest = itemOf('xy-13b');
    expect(newest.querySelector('[data-testid="pa-soul-voice-bar"]')).toBeNull();
    await waitFor(() => expect(within(newest).getByTestId('pa-soul-speak').hasAttribute('aria-disabled')).toBe(false));
    const menu = await openMenu(newest);
    const rows = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((row) => row.getAttribute('data-action'));
    expect(rows.slice(0, 3)).toEqual(['quote', 'copy', 'speak']);
    fireEvent.click(within(menu).getByText('朗读'));
    await waitFor(() => expect(itemOf('xy-13b').querySelector('[data-testid="pa-soul-voice-bar"]')?.getAttribute('data-state')).toBe('loading'));
    expect(itemOf('xy-13b').textContent).toContain('正在生成语音…');
    expect(calls.filter((call) => call.path === '/soul/speech' && call.method === 'POST').map((call) => (call.body as { messageId: string }).messageId)).toEqual(['xy-13b']);
    await waitFor(
      () => expect(itemOf('xy-13b').querySelector('[data-testid="pa-soul-voice-bar"]')?.getAttribute('data-state')).not.toBe('loading'),
      { timeout: 3000 },
    );
  });

  it('&speech=none: 朗读 is disabled with its reason, and no bar is drawn', async () => {
    mount(withoutSpeech(buildFixture('voice-chat')));
    await screen.findByTestId('pa-soul-transcript');
    const newest = itemOf('xy-13b');
    await waitFor(() => expect(within(newest).getByTestId('pa-soul-speak').getAttribute('aria-disabled')).toBe('true'));
    const menu = await openMenu(newest);
    const speak = menu.querySelector<HTMLElement>('[data-action="speak"]')!;
    expect(speak.hasAttribute('data-disabled')).toBe(true);
    expect(speak.textContent).toContain('没有可用的语音服务');
    expect(screen.queryByTestId('pa-soul-voice-bar')).toBeNull();
  });

  it('a character without a voice says so; owner lines and story cards never offer 朗读', async () => {
    mount('companion-chat', { locale: 'en' });
    await screen.findByTestId('pa-soul-transcript');
    const menu = await openMenu(itemOf('xy-13b'));
    const speak = menu.querySelector<HTMLElement>('[data-action="speak"]')!;
    expect(speak.hasAttribute('data-disabled')).toBe(true);
    expect(speak.textContent).toContain('No voice chosen for 小月 yet');
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('pa-soul-message-menu')).toBeNull());
    const ownerMenu = await openMenu(itemOf('xy-12'));
    expect(ownerMenu.querySelector('[data-action="speak"]')).toBeNull();
  });

  it('语音回复 关: no 朗读 and no bars', async () => {
    mount(withChat(buildFixture('voice-chat'), 'conv-xiaoyue', { voiceReplies: 'off' }));
    await screen.findByTestId('pa-soul-transcript');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByTestId('pa-soul-speak')).toBeNull();
    expect(screen.queryByTestId('pa-soul-voice-bar')).toBeNull();
    const menu = await openMenu(itemOf('xy-13b'));
    expect(menu.querySelector('[data-action="speak"]')).toBeNull();
  });

  it('switching the playing reply to another variant stops its audio', async () => {
    mount('voice-chat');
    await screen.findByTestId('pa-soul-transcript');
    const newest = itemOf('xy-13b');
    await waitFor(() => expect(within(newest).getByTestId('pa-soul-speak').hasAttribute('aria-disabled')).toBe(false));
    fireEvent.click(within(newest).getByTestId('pa-soul-speak'));
    await waitFor(() => expect(soulAudio.get()).toMatchObject({ messageId: 'xy-13b', phase: 'playing' }), { timeout: 3000 });
    fireEvent.click(within(itemOf('xy-13b')).getByRole('button', { name: '上一个说法' }));
    await waitFor(() => expect(document.querySelector('[data-testid="pa-soul-item"][data-message-id="xy-13b"]')).toBeNull());
    await waitFor(() => expect(soulAudio.get().messageId).toBeNull());
  });

  it('自动朗读 reads a fresh reply once and never the history', async () => {
    const { calls } = mount(withChat(buildFixture('voice-chat'), 'conv-xiaoyue', { voiceReplies: 'auto' }));
    await screen.findByTestId('pa-soul-transcript');
    await waitFor(() => expect(calls.some((call) => call.path === '/soul/speech/status')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const spoken = () => calls.filter((call) => call.path === '/soul/speech' && call.method === 'POST').map((call) => (call.body as { messageId: string }).messageId);
    expect(spoken()).toEqual([]);
    const input = screen.getByTestId('pa-composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '晚安' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(spoken()).toHaveLength(1), { timeout: 4000 });
    const reply = spoken()[0]!;
    expect(reply).not.toMatch(/^xy-/);
    await waitFor(() => expect(itemOf(reply).querySelector('[data-testid="pa-soul-voice-bar"]')).not.toBeNull(), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spoken()).toEqual([reply]);
  });
});

/* ── standing picture and journal ──────────────────────────────────────────────────────────── */

describe('the standing picture (sprites-chat)', () => {
  it('stands inside the column when the transcript is wide, named with the mood', async () => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(930);
    mount('sprites-chat');
    const stage = await screen.findByTestId('pa-soul-stage');
    expect(stage.getAttribute('aria-label')).toBe('小月，困倦');
    expect(screen.getByTestId('pa-transcript').hasAttribute('data-stage')).toBe(true);
  });

  it('is not drawn on a narrow transcript, nor in a chat without the stage', async () => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(796);
    mount('sprites-chat');
    await screen.findByTestId('pa-soul-transcript');
    expect(screen.queryByTestId('pa-soul-stage')).toBeNull();
    expect(screen.getByTestId('pa-transcript').hasAttribute('data-stage')).toBe(false);
    cleanup();
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    mount('companion-chat');
    await screen.findByTestId('pa-soul-transcript');
    expect(screen.queryByTestId('pa-soul-stage')).toBeNull();
  });

  it('stays drawn for a mood without an image: 平静, else the portrait, named for what it shows', async () => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(930);
    const base = buildFixture('sprites-chat');
    const xy = base.soul!.characters.find((item) => item.id === 'ag-xiaoyue')!;
    const withSprites = (sprites: Record<string, string>): PaFixture => ({
      ...base,
      soul: { ...base.soul!, characters: base.soul!.characters.map((item) => (item.id === 'ag-xiaoyue' ? { ...item, sprites } : item)) },
    });
    // the newest reply is 有点困 (sleepy): with 平静 and 困倦 gone, the portrait stands in
    mount(withSprites({ happy: xy.sprites.happy!, sad: xy.sprites.sad! }));
    const stage = await screen.findByTestId('pa-soul-stage');
    expect(screen.getByTestId('pa-transcript').hasAttribute('data-stage')).toBe(true);
    expect(stage.getAttribute('aria-label')).toBe('小月');
    expect(stage.querySelector('img:not([aria-hidden])')?.getAttribute('src')).toBe(paSoulAssetUrl(xy.portraitAssetId));
    cleanup();
    // with 平静 kept, the fallback is 平静 and the name says so
    mount(withSprites({ neutral: xy.sprites.neutral!, happy: xy.sprites.happy! }));
    expect((await screen.findByTestId('pa-soul-stage')).getAttribute('aria-label')).toBe('小月，平静');
  });
});

describe('the journal (journal-chat)', () => {
  it('heads each incoming entry with the name and the time, with 48 px portraits', async () => {
    mount('journal-chat');
    await screen.findByTestId('pa-soul-transcript');
    const heads = screen.getAllByTestId('pa-soul-cluster-head');
    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) expect(head.textContent).toMatch(/^小月\d{2}:\d{2}$/);
    const portrait = heads[0]!.closest('[data-side="in"]')!.querySelector<HTMLElement>('[data-slot="soul-portrait"]')!;
    expect(portrait.style.getPropertyValue('--pa-portrait')).toBe('48px');
  });

  it('the bubble layout has no head line', async () => {
    mount('companion-chat');
    await screen.findByTestId('pa-soul-transcript');
    expect(screen.queryByTestId('pa-soul-cluster-head')).toBeNull();
  });
});
