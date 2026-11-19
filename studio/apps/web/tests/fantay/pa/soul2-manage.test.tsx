// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// S2-W3-D (stage 2 spec 9.3, 5.8): the appearance picker's layout, pattern, frame, accent and 立绘 controls, the
// appearance modal's stage wiring, and 语音回复 in chat settings with its disabled and hint states. The picker is
// mounted alone in a stateful harness; the modals over the lab fixtures and the fixture transport, every request
// recorded.
import '../helpers/radix-jsdom';

import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaChatAppearance } from '@open-design/contracts/soul';
import { guardAccent } from '@open-design/contracts/soul';

import { I18nProvider } from '../../../src/i18n';
import { createFixtureTransport } from '../../../src/fantay/pa/lab/fixture-transport';
import { buildFixture, type PaFixture, type PaScenarioId } from '../../../src/fantay/pa/lab/fixtures';
import { LAB_SPEECH_STATUS } from '../../../src/fantay/pa/lab/soul-fixtures';
import { PaTransportProvider } from '../../../src/fantay/pa/pa-transport';
import type { PaModalState, PaTransport, PaUiState } from '../../../src/fantay/pa/pa-types';
import { PersonalAgentWorkspace } from '../../../src/fantay/pa/PersonalAgentWorkspace';
import { SOUL_ACCENT_SEED, SOUL_ACCENT_SWATCHES, soulAccentFromDraft } from '../../../src/fantay/pa/soul/soul-look';
import { __resetSoulVoiceForTests } from '../../../src/fantay/pa/soul/soul-voice';
import { SoulAppearancePicker, withTheme, type SoulAppearancePickerProps } from '../../../src/fantay/pa/soul/SoulAppearancePicker';
import { chatSettingsPatch } from '../../../src/fantay/pa/soul/SoulChatSettingsModal';
import { registerFantayCommand, resetFantayCommandsForTests } from '../../../src/fantay/shell/commands';

interface Call {
  path: string;
  method: string;
  body: unknown;
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  __resetSoulVoiceForTests();
});
afterEach(() => {
  cleanup();
  __resetSoulVoiceForTests();
  resetFantayCommandsForTests();
});

/* ── harnesses ────────────────────────────────────────────────────────────────────────────── */

function Harness(p: {
  initial: PaChatAppearance;
  base: PaChatAppearance | null;
  stage: SoulAppearancePickerProps['stage'];
  writes: PaChatAppearance[];
}) {
  const [value, setValue] = useState<PaChatAppearance>(p.initial);
  return (
    <SoulAppearancePicker
      value={value}
      base={p.base}
      onChange={(next) => {
        p.writes.push(next);
        setValue(next);
      }}
      portrait={{ src: null, name: '小月' }}
      {...(p.stage ? { stage: p.stage } : {})}
    />
  );
}

function picker(initial: PaChatAppearance, options: { base?: PaChatAppearance; stage?: SoulAppearancePickerProps['stage'] } = {}) {
  const writes: PaChatAppearance[] = [];
  render(
    <I18nProvider initial="zh-CN">
      <Harness initial={initial} base={options.base ?? null} stage={options.stage} writes={writes} />
    </I18nProvider>,
  );
  return writes;
}

/** The item of a full-width Segmented by its label. */
function item(group: HTMLElement, label: string): HTMLButtonElement {
  return within(group).getByText(label).closest('button') as HTMLButtonElement;
}

const seg = (testId: string, label: string) => item(screen.getByTestId(testId), label);

function mount(id: PaScenarioId, ui: Partial<PaUiState> = {}, prepare?: (fixture: PaFixture) => void) {
  const fixture = buildFixture(id);
  prepare?.(fixture);
  const base = createFixtureTransport(fixture, { latency: 0 });
  const calls: Call[] = [];
  const transport = (<T,>(path?: string, method?: string, body?: unknown, signal?: AbortSignal) => {
    calls.push({ path: path ?? '', method: method ?? 'GET', body });
    return base<T>(path, method, body, signal);
  }) as PaTransport;
  render(
    <I18nProvider initial="zh-CN">
      <PaTransportProvider transport={transport}>
        <PersonalAgentWorkspace active onOpenProject={vi.fn()} projects={fixture.projects} initialState={{ ...fixture.ui, ...ui }} />
      </PaTransportProvider>
    </I18nProvider>,
  );
  return { calls, fixture };
}

const withModal = (id: PaScenarioId, modal: PaModalState, prepare?: (fixture: PaFixture) => void) => mount(id, { modal }, prepare);

const writesOf = (calls: Call[], method: string, path: RegExp) => calls.filter((call) => call.method === method && path.test(call.path));

/* ── picker ───────────────────────────────────────────────────────────────────────────────── */

describe('appearance picker (stage 2 controls)', () => {
  it('layout, pattern, frame and accent mode each write their key and keep the others', () => {
    const initial: PaChatAppearance = { theme: 'sakura', shape: 'round', font: 'kai', accent: '#3478c4', stage: 'side' };
    const writes = picker(initial);
    fireEvent.click(seg('pa-look-layout', '手帐'));
    expect(writes.at(-1)).toEqual({ ...initial, layout: 'journal' });
    fireEvent.click(seg('pa-look-pattern', '横线'));
    expect(writes.at(-1)).toEqual({ ...initial, layout: 'journal', pattern: 'ruled' });
    fireEvent.click(seg('pa-look-frame', '拍立得'));
    expect(writes.at(-1)).toEqual({ ...initial, layout: 'journal', pattern: 'ruled', avatarFrame: 'polaroid' });
    fireEvent.click(seg('pa-look-accent-mode', '跟随主题'));
    expect(writes.at(-1)).toEqual({ ...initial, layout: 'journal', pattern: 'ruled', avatarFrame: 'polaroid', accent: null });

    const preview = screen.getByTestId('pa-appearance-preview');
    expect(preview.getAttribute('data-pa-layout')).toBe('journal');
    expect(preview.getAttribute('data-pa-pattern')).toBe('ruled');
    expect(preview.getAttribute('data-pa-frame')).toBe('polaroid');
    expect(preview.hasAttribute('data-pa-accent')).toBe(false);
  });

  it('shows the resolved value of the layer below', () => {
    picker({}, { base: { theme: 'archive', layout: 'journal', avatarFrame: 'polaroid' } });
    expect(seg('pa-look-layout', '手帐').getAttribute('aria-checked')).toBe('true');
    expect(seg('pa-look-frame', '拍立得').getAttribute('aria-checked')).toBe('true');
    // archive's own pattern shows while no layer sets one
    expect(seg('pa-look-pattern', '横线').getAttribute('aria-checked')).toBe('true');
    expect(seg('pa-look-accent-mode', '跟随主题').getAttribute('aria-checked')).toBe('true');
  });

  it('a theme change keeps the accent and the layout and drops font, pattern and frame', () => {
    const writes = picker({ theme: 'sakura', font: 'kai', pattern: 'dots', avatarFrame: 'polaroid', layout: 'journal', accent: '#3478c4' });
    const ink = screen.getAllByTestId('pa-theme-swatch').find((cell) => cell.dataset.theme === 'ink')!;
    fireEvent.click(ink);
    expect(writes.at(-1)).toEqual({ theme: 'ink', layout: 'journal', accent: '#3478c4' });
    const preview = screen.getByTestId('pa-appearance-preview');
    expect(preview.getAttribute('data-pa-skin')).toBe('ink');
    expect(preview.hasAttribute('data-pa-accent')).toBe(true);
    expect(withTheme({ theme: 'clean', layout: 'journal', accent: '#123456', stage: 'side' }, 'rain')).toEqual({
      theme: 'rain',
      layout: 'journal',
      accent: '#123456',
      stage: 'side',
    });
  });

  it('custom accent: seed, adjusted note with both results, valid and invalid drafts, swatches, the well, the memory', () => {
    const writes = picker({});
    expect(screen.queryByTestId('pa-look-accent-hex')).toBeNull();
    fireEvent.click(seg('pa-look-accent-mode', '自选'));
    expect(writes.at(-1)).toEqual({ accent: SOUL_ACCENT_SEED });

    let hex = screen.getByTestId('pa-look-accent-hex') as HTMLInputElement;
    const well = screen.getByTestId('pa-look-accent-color') as HTMLInputElement;
    expect(hex.value).toBe(SOUL_ACCENT_SEED);
    expect(well.getAttribute('type')).toBe('color');
    expect(well.value).toBe(SOUL_ACCENT_SEED);

    // The seed is not readable as picked: the note names the light and the dark result, with a dot for each.
    const seed = guardAccent('fantay', SOUL_ACCENT_SEED);
    if (!seed?.ok) throw new Error('seed guard');
    const note = screen.getByTestId('pa-look-accent-note');
    expect(note.textContent).toBe(`为了看得清，浅色下用 ${seed.light.accent}，深色下用 ${seed.dark.accent}。`);
    const dots = note.querySelectorAll('[data-mode]');
    expect(dots).toHaveLength(2);
    expect(dots[0]!.getAttribute('style')).toContain(seed.light.accent);
    expect(dots[1]!.getAttribute('style')).toContain(seed.dark.accent);
    expect(screen.getByTestId('pa-appearance-preview').getAttribute('style')).toContain(seed.light.accent);

    // A valid draft is written lower-cased and stays as typed.
    fireEvent.change(hex, { target: { value: '#3E9A6A' } });
    expect(writes.at(-1)).toEqual({ accent: '#3e9a6a' });
    expect(hex.value).toBe('#3E9A6A');

    // An invalid draft writes nothing and says so.
    const count = writes.length;
    fireEvent.change(hex, { target: { value: '#12' } });
    expect(writes).toHaveLength(count);
    expect(screen.getByTestId('pa-look-accent-note').textContent).toBe('请输入 6 位十六进制色值。');
    expect(hex.getAttribute('aria-invalid')).toBe('true');

    // A swatch writes its colour and replaces the draft.
    const swatch = screen.getAllByTestId('pa-look-accent-swatch')[4]!;
    fireEvent.click(swatch);
    expect(writes.at(-1)).toEqual({ accent: SOUL_ACCENT_SWATCHES[4]! });
    expect(hex.value).toBe(SOUL_ACCENT_SWATCHES[4]);
    expect(swatch.getAttribute('aria-pressed')).toBe('true');
    // This swatch reads as picked on the light paper: the note names only the dark-mode change.
    const picked = guardAccent('fantay', SOUL_ACCENT_SWATCHES[4]!);
    if (!picked?.ok) throw new Error('swatch guard');
    expect(picked.light.adjusted).toBe(false);
    expect(screen.getByTestId('pa-look-accent-note').textContent).toBe(`浅色下就用这个颜色；深色下为了看得清，改用 ${picked.dark.accent}。`);

    // The colour well.
    fireEvent.change(screen.getByTestId('pa-look-accent-color'), { target: { value: '#7a5cc8' } });
    expect(writes.at(-1)).toEqual({ accent: '#7a5cc8' });

    // 跟随主题 → 自选 returns to the last custom colour.
    fireEvent.click(seg('pa-look-accent-mode', '跟随主题'));
    expect(writes.at(-1)).toEqual({ accent: null });
    expect(screen.queryByTestId('pa-look-accent-hex')).toBeNull();
    fireEvent.click(seg('pa-look-accent-mode', '自选'));
    expect(writes.at(-1)).toEqual({ accent: '#7a5cc8' });

    // A draft without the leading # is a 6-digit hex colour too.
    hex = screen.getByTestId('pa-look-accent-hex') as HTMLInputElement;
    fireEvent.change(hex, { target: { value: 'D0587E' } });
    expect(writes.at(-1)).toEqual({ accent: '#d0587e' });
  });

  it('reads a draft as #rrggbb or nothing', () => {
    expect(soulAccentFromDraft(' #ABCDEF ')).toBe('#abcdef');
    expect(soulAccentFromDraft('abcdef')).toBe('#abcdef');
    expect(soulAccentFromDraft('#abcde')).toBeNull();
    expect(soulAccentFromDraft('red')).toBeNull();
    expect(soulAccentFromDraft('')).toBeNull();
    expect(SOUL_ACCENT_SEED).toBe('#808080');
  });

  it('the 立绘 row: on with sprites, disabled with its reason otherwise, absent without the prop', () => {
    const onAdd = vi.fn();
    const writes = picker({ stage: 'side' }, { stage: { available: true, reason: 'no-sprites', onAdd } });
    let row = screen.getByTestId('pa-look-stage');
    let toggle = within(row).getByRole('switch') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.disabled).toBe(false);
    expect(row.textContent).toContain('在聊天左侧显示 小月 的大图');
    fireEvent.click(toggle);
    expect(writes.at(-1)).toEqual({ stage: 'off' });
    fireEvent.click(toggle);
    expect(writes.at(-1)).toEqual({ stage: 'side' });
    cleanup();

    picker({}, { stage: { available: false, reason: 'no-sprites', onAdd } });
    row = screen.getByTestId('pa-look-stage');
    toggle = within(row).getByRole('switch') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(row.textContent).toContain('先在角色资料的「立绘」里添加图片。');
    fireEvent.click(within(row).getByTestId('pa-look-stage-add'));
    expect(onAdd).toHaveBeenCalledTimes(1);
    cleanup();

    picker({}, { stage: { available: false, reason: 'room' } });
    row = screen.getByTestId('pa-look-stage');
    expect((within(row).getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    expect(row.textContent).toContain('群聊不显示立绘。');
    expect(within(row).queryByTestId('pa-look-stage-add')).toBeNull();
    cleanup();

    picker({});
    expect(screen.queryByTestId('pa-look-stage')).toBeNull();
  });
});

/* ── appearance modal ─────────────────────────────────────────────────────────────────────── */

describe('appearance modal: the 立绘 switch', () => {
  it('a character with sprites: the switch is on and 应用 writes the chat layer', async () => {
    const { calls } = withModal('sprites-chat', { kind: 'appearance', conversationId: 'conv-xiaoyue' });
    const modal = await screen.findByTestId('pa-appearance-modal');
    const row = await within(modal).findByTestId('pa-look-stage');
    await waitFor(() => expect(row.hasAttribute('data-available')).toBe(true));
    const toggle = within(row).getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    fireEvent.click(within(modal).getByTestId('pa-appearance-apply'));
    await waitFor(() => expect(writesOf(calls, 'PUT', /^\/soul\/chats\/conv-xiaoyue$/)).toHaveLength(1));
    const body = writesOf(calls, 'PUT', /^\/soul\/chats\/conv-xiaoyue$/)[0]!.body as { appearance: PaChatAppearance };
    expect(body.appearance).toMatchObject({ stage: 'off' });
  });

  it('no sprites: disabled, and 去添加 opens the profile editor', async () => {
    withModal('companion-chat', { kind: 'appearance', conversationId: 'conv-xiaoyue' });
    const modal = await screen.findByTestId('pa-appearance-modal');
    await within(modal).findByText('和 小月 的所有对话');
    const row = within(modal).getByTestId('pa-look-stage');
    expect((within(row).getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    expect(row.textContent).toContain('先在角色资料的「立绘」里添加图片。');
    fireEvent.click(within(row).getByTestId('pa-look-stage-add'));
    expect(await screen.findByTestId('pa-profile-modal')).toBeTruthy();
  });

  it('a group chat: disabled with the room reason', async () => {
    withModal('companion-group', { kind: 'appearance', conversationId: 'conv-room' });
    const modal = await screen.findByTestId('pa-appearance-modal');
    const row = await within(modal).findByTestId('pa-look-stage');
    expect((within(row).getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    expect(row.textContent).toContain('群聊不显示立绘。');
  });
});

/* ── chat settings: 语音回复 ────────────────────────────────────────────────────────────────── */

describe('chat settings: 语音回复', () => {
  it('without a speech service: 点了才读 and 自动朗读 are disabled, the line says why, 关 saves alone', async () => {
    const { calls } = withModal('companion-chat', { kind: 'chatSettings', conversationId: 'conv-xiaoyue' });
    const modal = await screen.findByTestId('pa-chat-settings-modal');
    const voice = await within(modal).findByTestId('pa-chat-voice');
    await waitFor(() => expect(item(voice, '点了才读').disabled).toBe(true));
    expect(item(voice, '自动朗读').disabled).toBe(true);
    expect(item(voice, '关').disabled).toBe(false);
    expect(item(voice, '点了才读').getAttribute('aria-checked')).toBe('true');
    expect(within(modal).getByText('点「朗读」才生成那一条的语音，用角色的语音服务：默认是 TokenToSea，也可以是你自己选的。')).toBeTruthy();
    const note = within(modal).getByTestId('pa-chat-voice-note');
    expect(note.textContent).toContain('没有可用的语音服务。登录 TokenToSea 即可使用它的语音，或在 设置 ▸ 模型与提供商 ▸ 媒体 里添加语音提供商。');
    expect(within(note).getByTestId('pa-chat-voice-settings').textContent).toBe('打开设置');

    fireEvent.click(item(voice, '关'));
    expect(within(modal).getByText('不显示朗读，也不生成语音。')).toBeTruthy();
    fireEvent.click(within(modal).getByText('保存'));
    await waitFor(() => expect(writesOf(calls, 'PUT', /^\/soul\/chats\/conv-xiaoyue$/)).toHaveLength(1));
    const body = writesOf(calls, 'PUT', /^\/soul\/chats\/conv-xiaoyue$/)[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).filter((key) => key !== 'revision')).toEqual(['voiceReplies']);
    expect(body.voiceReplies).toBe('off');
  });

  it('打开设置 closes the modal and runs the shell command', async () => {
    const openSettings = vi.fn();
    registerFantayCommand('fantay.openSettings', openSettings);
    withModal('companion-chat', { kind: 'chatSettings', conversationId: 'conv-xiaoyue' });
    const modal = await screen.findByTestId('pa-chat-settings-modal');
    const link = await within(modal).findByTestId('pa-chat-voice-settings');
    fireEvent.click(link);
    expect(openSettings).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('pa-chat-settings-modal')).toBeNull());
  });

  it('with a service and a voice: every choice is open, no line, 自动朗读 saves', async () => {
    const { calls } = withModal('voice-chat', { kind: 'chatSettings', conversationId: 'conv-xiaoyue' });
    const modal = await screen.findByTestId('pa-chat-settings-modal');
    const voice = await within(modal).findByTestId('pa-chat-voice');
    await waitFor(() => expect(calls.some((call) => call.path === '/soul/speech/status')).toBe(true));
    await waitFor(() => expect(item(voice, '自动朗读').disabled).toBe(false));
    expect(within(modal).queryByTestId('pa-chat-voice-note')).toBeNull();
    fireEvent.click(item(voice, '自动朗读'));
    expect(within(modal).getByText('这个对话开着时，新回复会自动生成并播放语音。每条回复都会用到语音服务。')).toBeTruthy();
    fireEvent.click(within(modal).getByText('保存'));
    await waitFor(() => expect(writesOf(calls, 'PUT', /^\/soul\/chats\/conv-xiaoyue$/)).toHaveLength(1));
    expect((writesOf(calls, 'PUT', /^\/soul\/chats\/conv-xiaoyue$/)[0]!.body as Record<string, unknown>).voiceReplies).toBe('auto');
  });

  it('a character without a voice: the line and 去选声音, which opens the profile editor', async () => {
    withModal('voice-chat', { kind: 'chatSettings', conversationId: 'conv-xiaoyue' }, (fixture) => {
      fixture.soul!.characters = fixture.soul!.characters.map((character) =>
        character.id === 'ag-xiaoyue' ? { ...character, voice: null } : character,
      );
    });
    const modal = await screen.findByTestId('pa-chat-settings-modal');
    const note = await within(modal).findByTestId('pa-chat-voice-note');
    await waitFor(() => expect(note.textContent).toContain('小月 还没有声音。在角色资料的「文风与模型」里选一个。'));
    fireEvent.click(within(note).getByTestId('pa-chat-voice-profile'));
    expect(await screen.findByTestId('pa-profile-modal')).toBeTruthy();
  });

  it('a group chat with a service: each character uses its own voice', async () => {
    withModal('companion-group', { kind: 'chatSettings', conversationId: 'conv-room' }, (fixture) => {
      fixture.speech = { status: structuredClone(LAB_SPEECH_STATUS) };
    });
    const modal = await screen.findByTestId('pa-chat-settings-modal');
    const voice = await within(modal).findByTestId('pa-chat-voice');
    await waitFor(() => expect(within(modal).getByTestId('pa-chat-voice-note').textContent).toBe('群聊里每个角色用自己的声音。'));
    expect(item(voice, '自动朗读').disabled).toBe(false);
  });

  it('is shown in companion mode only', async () => {
    withModal('companion-chat', { kind: 'chatSettings', conversationId: 'conv-xiaoyue' });
    const modal = await screen.findByTestId('pa-chat-settings-modal');
    await within(modal).findByTestId('pa-chat-voice');
    fireEvent.click(item(within(modal).getByTestId('pa-chat-mode'), '工作'));
    expect(within(modal).queryByTestId('pa-chat-voice')).toBeNull();
  });

  it('the patch carries voiceReplies only when it changed; a stage 1 row reads as 点了才读', () => {
    const chat = buildFixture('companion-chat').soul!.chats[0]!;
    const form = {
      mode: 'companion' as const,
      personaId: chat.personaId,
      presetId: chat.presetId,
      scenario: chat.scenario,
      noteText: chat.authorNote?.text ?? '',
      noteDepth: chat.authorNote?.depth ?? 4,
      lorebookIds: chat.lorebookIds,
      disabledLoreEntryIds: chat.disabledLoreEntryIds,
      historyBudget: chat.historyBudget,
      turnRecord: chat.turnRecord,
      groupStrategy: chat.groupStrategy,
    };
    expect(chatSettingsPatch({ ...form, voiceReplies: chat.voiceReplies }, chat, 'companion', false)).toEqual({});
    expect(chatSettingsPatch({ ...form, voiceReplies: 'auto' }, chat, 'companion', false)).toEqual({ voiceReplies: 'auto' });
    expect(chatSettingsPatch(form, chat, 'companion', false)).toEqual({});
    const { voiceReplies: _stored, ...stage1 } = chat;
    expect(chatSettingsPatch({ ...form, voiceReplies: 'manual' }, stage1 as typeof chat, 'companion', false)).toEqual({});
    expect(chatSettingsPatch({ ...form, voiceReplies: 'off' }, stage1 as typeof chat, 'companion', false)).toEqual({ voiceReplies: 'off' });
  });
});
