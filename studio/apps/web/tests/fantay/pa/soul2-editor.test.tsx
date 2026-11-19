// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// S2-W3-E (STAGE2 5.8, 6.3, 10, 11): the profile editor's stage 2 parts — 声音 in 文风与模型, the 立绘 section, the 1:1
// crop step on portrait and persona-avatar upload, and the deck editor in 状态与玩法. Mounted over the lab fixtures and
// the fixture transport with every request recorded; the canvas work (crop, re-encode) is mocked at `soul-files`.
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PA_BUILTIN_DECKS } from '@open-design/contracts/soul';
import type { PaDeck } from '@open-design/contracts/soul';

import { I18nProvider } from '../../../src/i18n';
import { createFixtureTransport } from '../../../src/fantay/pa/lab/fixture-transport';
import { buildFixture, type PaFixture, type PaScenarioId } from '../../../src/fantay/pa/lab/fixtures';
import { PaTransportProvider } from '../../../src/fantay/pa/pa-transport';
import type { PaModalState, PaTransport, PaUiState } from '../../../src/fantay/pa/pa-types';
import { PersonalAgentWorkspace } from '../../../src/fantay/pa/PersonalAgentWorkspace';
import { __resetSoulVoiceForTests } from '../../../src/fantay/pa/soul/soul-voice';
import { deckIssues, deckOverLimit } from '../../../src/fantay/pa/soul/SoulDeckEditor';
import { voiceOverLimit } from '../../../src/fantay/pa/soul/SoulVoiceField';
import { registerFantayCommand, resetFantayCommandsForTests } from '../../../src/fantay/shell/commands';

const files = vi.hoisted(() => ({
  cropImageBlob: vi.fn(async () => new Blob(['cropped'], { type: 'image/png' })),
  imageToAsset: vi.fn(async () => ({ mime: 'image/webp' as const, data: 'UklGRgAAAAA=' })),
}));
vi.mock('../../../src/fantay/pa/soul/soul-files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/fantay/pa/soul/soul-files')>();
  return { ...actual, cropImageBlob: files.cropImageBlob, imageToAsset: files.imageToAsset };
});

/** `new Image()` reports a 800 × 500 picture, so the locked crop can be checked in pixels. */
class FakeImage {
  naturalWidth = 800;
  naturalHeight = 500;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    setTimeout(() => this.onload?.(), 0);
  }
}

interface Call {
  path: string;
  method: string;
  body: unknown;
}

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  __resetSoulVoiceForTests();
  resetFantayCommandsForTests();
  files.cropImageBlob.mockClear();
  files.imageToAsset.mockClear();
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:lab/${(n += 1)}`);
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal('Image', FakeImage);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

function mount(id: PaScenarioId, modal: PaModalState, prepare?: (fixture: PaFixture) => void, ui: Partial<PaUiState> = {}) {
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
        <PersonalAgentWorkspace active onOpenProject={vi.fn()} projects={fixture.projects} initialState={{ ...fixture.ui, modal, ...ui }} />
      </PaTransportProvider>
    </I18nProvider>,
  );
  return { calls, fixture };
}

const writes = (calls: Call[], method: string, path: RegExp) => calls.filter((call) => call.method === method && path.test(call.path));

/** The profile editor once the snapshot has arrived (the export menu appears only for a saved character). */
async function editor(): Promise<HTMLElement> {
  const modal = await screen.findByTestId('pa-profile-modal');
  await within(modal).findByTestId('pa-profile-export');
  return modal;
}

function characterOf(fixture: PaFixture, agentId: string) {
  const character = fixture.soul!.characters.find((item) => item.id === agentId);
  if (!character) throw new Error(`no character ${agentId}`);
  return character;
}

function deck(id: string, name: string, cards: number): PaDeck {
  return { id, name, cards: Array.from({ length: cards }, (_, i) => ({ title: `${name}${i + 1}`, text: '', secret: '' })) };
}

function pick(input: HTMLInputElement, name = 'picked.png') {
  fireEvent.change(input, { target: { files: [new File(['png'], name, { type: 'image/png' })] } });
}

/* ── pure rules ───────────────────────────────────────────────────────────────────────────── */

describe('deck and voice rules', () => {
  it('flags a deck without a name, with fewer than two cards, or with a card without a title', () => {
    const issues = deckIssues([
      { id: 'a', name: '  ', cards: [{ title: '甲', text: '', secret: '' }, { title: '乙', text: '', secret: '' }] },
      { id: 'b', name: '少', cards: [{ title: '甲', text: '', secret: '' }] },
      { id: 'c', name: '空', cards: [{ title: '甲', text: '', secret: '' }, { title: ' ', text: 'x', secret: '' }] },
      deck('d', '好', 2),
    ]);
    expect(issues).toEqual([
      { deckId: 'a', kind: 'name' },
      { deckId: 'b', kind: 'few' },
      { deckId: 'c', kind: 'title' },
    ]);
  });

  it('holds a deck or a voice over its limits', () => {
    expect(deckOverLimit([deck('a', '好', 2)])).toBe(false);
    expect(deckOverLimit([{ ...deck('a', '好', 2), name: 'x'.repeat(41) }])).toBe(true);
    expect(deckOverLimit([deck('a', '多', 121)])).toBe(true);
    expect(deckOverLimit([{ id: 'a', name: '长', cards: [{ title: '甲', text: 'x'.repeat(601), secret: '' }, { title: '乙', text: '', secret: '' }] }])).toBe(true);
    expect(voiceOverLimit(null)).toBe(false);
    expect(voiceOverLimit({ model: 'm', voice: 'v'.repeat(200), language: '' })).toBe(false);
    expect(voiceOverLimit({ model: 'm', voice: 'v'.repeat(201), language: '' })).toBe(true);
  });
});

/* ── crop ─────────────────────────────────────────────────────────────────────────────────── */

describe('portrait crop', () => {
  it('opens the crop dialog locked to 1:1, then crops a square and uploads it', async () => {
    const { calls } = mount('sprites-chat', { kind: 'agent', agentId: 'ag-xiaoyue', section: 'basic' });
    const modal = await editor();
    pick(modal.querySelector('[data-section="basic"] input[type="file"]') as HTMLInputElement);
    const dialog = await screen.findByTestId('fx-media-crop-dialog');
    expect(within(dialog).getByText('裁剪头像')).toBeTruthy();
    expect(within(dialog).queryAllByTestId(/^fx-media-crop-preset-/)).toHaveLength(0);
    await waitFor(() => expect((screen.getByTestId('fx-media-crop-box') as HTMLElement).style.width).toBe('62.5%'));
    expect(files.cropImageBlob).not.toHaveBeenCalled();
    expect(writes(calls, 'POST', /^\/soul\/assets$/)).toHaveLength(0);

    fireEvent.click(within(dialog).getByText('使用这张'));
    await waitFor(() => expect(files.cropImageBlob).toHaveBeenCalledTimes(1));
    const [source, rect] = files.cropImageBlob.mock.calls[0] as unknown as [File, { x: number; y: number; width: number; height: number }];
    expect(source.name).toBe('picked.png');
    expect(rect.width * 800).toBeCloseTo(rect.height * 500, 5); // a square in pixels
    expect(rect.x).toBeCloseTo(0.1875, 5);
    await waitFor(() => expect(writes(calls, 'POST', /^\/soul\/assets$/)).toHaveLength(1));
    expect(files.imageToAsset).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/png' }));
    await waitFor(() => expect(screen.queryByTestId('fx-media-crop-dialog')).toBeNull());

    fireEvent.click(within(modal).getByTestId('pa-profile-save'));
    await waitFor(() => expect(writes(calls, 'PUT', /^\/soul\/characters\/ag-xiaoyue$/)).toHaveLength(1));
    expect(writes(calls, 'PUT', /^\/soul\/characters\/ag-xiaoyue$/)[0]!.body).toMatchObject({ portraitAssetId: 'data:image/webp;base64,UklGRgAAAAA=' });
  });

  it('uploads nothing when the crop is cancelled', async () => {
    const { calls } = mount('sprites-chat', { kind: 'agent', agentId: 'ag-xiaoyue', section: 'basic' });
    const modal = await editor();
    pick(modal.querySelector('[data-section="basic"] input[type="file"]') as HTMLInputElement);
    const dialog = await screen.findByTestId('fx-media-crop-dialog');
    fireEvent.click(within(dialog).getByText('取消'));
    await waitFor(() => expect(screen.queryByTestId('fx-media-crop-dialog')).toBeNull());
    expect(files.cropImageBlob).not.toHaveBeenCalled();
    expect(files.imageToAsset).not.toHaveBeenCalled();
    expect(writes(calls, 'POST', /^\/soul\/assets$/)).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('crops the avatar of a persona too', async () => {
    mount('companion-chat', { kind: 'persona', personaId: null });
    const modal = await screen.findByTestId('pa-persona-modal');
    pick(modal.querySelector('input[type="file"]') as HTMLInputElement);
    const dialog = await screen.findByTestId('fx-media-crop-dialog');
    expect(within(dialog).queryAllByTestId(/^fx-media-crop-preset-/)).toHaveLength(0);
  });
});

/* ── sprites ──────────────────────────────────────────────────────────────────────────────── */

describe('sprites section', () => {
  it('shows eight wells, removes one and fills another without a crop step', async () => {
    const { calls } = mount('sprites-chat', { kind: 'agent', agentId: 'ag-xiaoyue', section: 'sprites' });
    const modal = await editor();
    const section = await within(modal).findByTestId('pa-profile-sprites');
    const wells = within(section).getAllByTestId('pa-sprite-well');
    expect(wells.map((well) => well.dataset.emotion)).toEqual(['neutral', 'happy', 'sad', 'angry', 'surprised', 'shy', 'worried', 'sleepy']);
    expect(within(section).getByText('已配 5 / 8')).toBeTruthy();
    const well = (emotion: string) => within(section).getAllByTestId('pa-sprite-well').find((item) => item.dataset.emotion === emotion)!;
    expect(within(well('angry')).getByText('未设置')).toBeTruthy();
    // every button names its mood, so the grid does not read 更换, 移除 eight times
    expect(within(well('happy')).getByRole('button', { name: '更换 开心' })).toBeTruthy();
    expect(within(well('happy')).getByRole('button', { name: '移除 开心' })).toBeTruthy();
    expect(within(well('angry')).getByRole('button', { name: '上传 生气' })).toBeTruthy();

    fireEvent.click(within(well('happy')).getByText('移除'));
    expect(within(section).getByText('已配 4 / 8')).toBeTruthy();
    expect(well('happy').hasAttribute('data-set')).toBe(false);

    fireEvent.click(within(well('angry')).getByText('上传'));
    pick(section.querySelector('input[type="file"]') as HTMLInputElement, 'angry.png');
    await waitFor(() => expect(well('angry').hasAttribute('data-set')).toBe(true));
    expect(screen.queryByTestId('fx-media-crop-dialog')).toBeNull();
    expect(files.cropImageBlob).not.toHaveBeenCalled();
    expect(within(well('angry')).getByText('更换')).toBeTruthy();

    fireEvent.click(within(modal).getByTestId('pa-profile-save'));
    await waitFor(() => expect(writes(calls, 'PUT', /^\/soul\/characters\/ag-xiaoyue$/)).toHaveLength(1));
    const body = writes(calls, 'PUT', /^\/soul\/characters\/ag-xiaoyue$/)[0]!.body as { sprites: Record<string, string> };
    expect(Object.keys(body).filter((key) => key !== 'revision')).toEqual(['sprites']);
    expect(body.sprites.angry).toBe('data:image/webp;base64,UklGRgAAAAA=');
    expect(body.sprites).not.toHaveProperty('happy');
  });

  it('says why an image was not taken', async () => {
    files.imageToAsset.mockRejectedValueOnce(new Error('image-too-large'));
    const { calls } = mount('sprites-chat', { kind: 'agent', agentId: 'ag-xiaoyue', section: 'sprites' });
    const modal = await editor();
    const section = await within(modal).findByTestId('pa-profile-sprites');
    const angry = within(section).getAllByTestId('pa-sprite-well').find((item) => item.dataset.emotion === 'angry')!;
    fireEvent.click(within(angry).getByText('上传'));
    pick(section.querySelector('input[type="file"]') as HTMLInputElement);
    expect(await within(angry).findByRole('alert')).toBeTruthy();
    expect(writes(calls, 'POST', /^\/soul\/assets$/)).toHaveLength(0);
  });
});

/* ── voice ────────────────────────────────────────────────────────────────────────────────── */

describe('voice field', () => {
  it('shows the saved service and loads its voice list', async () => {
    mount('voice-chat', { kind: 'agent', agentId: 'ag-xiaoyue', section: 'style' });
    const modal = await editor();
    const voice = await within(modal).findByTestId('pa-profile-voice');
    expect(within(voice).getByTestId('pa-profile-voice-model').textContent).toContain('ElevenLabs · elevenlabs-v3');
    await waitFor(() => expect(within(voice).getByTestId('pa-profile-voice-id').textContent).toContain('Soft (lab)'));
    expect(within(voice).queryByTestId('pa-profile-voice-unavailable')).toBeNull();
  });

  it('keeps a saved service that is not set up, with a free voice id and its limit', async () => {
    mount('voice-chat', { kind: 'agent', agentId: 'ag-xiaoyue', section: 'style' }, (fixture) => {
      characterOf(fixture, 'ag-xiaoyue').voice = { model: 'gpt-4o-mini-tts', voice: 'alloy', language: 'ja' };
    });
    const modal = await editor();
    const voice = await within(modal).findByTestId('pa-profile-voice');
    await waitFor(() => expect(within(voice).getByTestId('pa-profile-voice-model').textContent).toContain('未配置'));
    const id = within(voice).getByTestId('pa-profile-voice-id') as HTMLInputElement;
    expect(id.value).toBe('alloy');
    expect(voice.textContent).toContain('日本語');
    fireEvent.change(id, { target: { value: 'v'.repeat(201) } });
    // Held with a reason: aria-disabled plus the tooltip naming the section (not a silent native disabled).
    expect(within(modal).getByTestId('pa-profile-save').getAttribute('aria-disabled')).toBe('true');
    expect(within(within(modal).getByTestId('pa-profile-nav-style')).getByText('这一部分有内容需要修改')).toBeTruthy();
  });

  it('says when no speech service is set up and opens Settings', async () => {
    const openSettings = vi.fn();
    registerFantayCommand('fantay.openSettings', openSettings);
    mount('sprites-chat', { kind: 'agent', agentId: 'ag-xiaoyue', section: 'style' });
    const modal = await editor();
    const row = await within(modal).findByTestId('pa-profile-voice-unavailable');
    expect(row.textContent).toContain('没有可用的语音服务');
    fireEvent.click(within(row).getByText('打开设置'));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});

/* ── decks ────────────────────────────────────────────────────────────────────────────────── */

describe('deck editor', () => {
  it('creates a deck, pastes cards with the three separators, edits, reorders and saves only decks', async () => {
    const { calls } = mount('story-game', { kind: 'agent', agentId: 'ag-storyteller', section: 'play' });
    const modal = await editor();
    const decks = await within(modal).findByTestId('pa-profile-decks');
    expect(within(decks).getByText('选一个牌堆来编辑，或新建一个。')).toBeTruthy();
    const builtins = within(decks).getAllByTestId('pa-deck-builtin');
    expect(builtins).toHaveLength(PA_BUILTIN_DECKS.length);
    for (const row of builtins) {
      expect(within(row).queryByRole('button')).toBeNull();
      expect(within(row).getByText('内置')).toBeTruthy();
    }
    expect(within(decks).getByText('内置牌堆不能修改。')).toBeTruthy();

    fireEvent.click(within(decks).getByTestId('pa-deck-add'));
    const row = within(decks).getByTestId('pa-deck-row');
    expect(row.dataset.deckId).toBe('1');
    const name = within(decks).getByLabelText('牌堆名') as HTMLInputElement;
    expect(name.value).toBe('新牌堆 1');
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(within(decks).getAllByTestId('pa-card-row')).toHaveLength(2);
    expect(within(decks).getByText('每张牌都要有牌面')).toBeTruthy();
    // Held with a reason: aria-disabled plus the tooltip naming the section (not a silent native disabled).
    expect(within(modal).getByTestId('pa-profile-save').getAttribute('aria-disabled')).toBe('true');
    expect(within(within(modal).getByTestId('pa-profile-nav-play')).getByText('这一部分有内容需要修改')).toBeTruthy();

    fireEvent.change(name, { target: { value: '线索' } });
    fireEvent.change(within(decks).getByTestId('pa-deck-paste'), { target: { value: '甲 | 说明甲 | 秘密甲\n乙｜说明乙\n丙\t说明丙\n\n | 没有牌面' } });
    fireEvent.click(within(decks).getByTestId('pa-deck-paste-add'));
    expect(within(decks).getAllByTestId('pa-card-row')).toHaveLength(3);
    expect(within(decks).getByText('加入了 3 张')).toBeTruthy();
    expect(within(decks).getByText('有 1 行没有加入（没有牌面，或牌堆已满 120 张）')).toBeTruthy();
    expect((within(decks).getByTestId('pa-deck-paste') as HTMLTextAreaElement).value).toBe('');
    const title = (n: number) => (within(decks).getByLabelText(`牌面 ${n}`) as HTMLInputElement).value;
    expect([title(1), title(2), title(3)]).toEqual(['甲', '乙', '丙']);
    expect((within(decks).getByLabelText('说明 2') as HTMLTextAreaElement).value).toBe('说明乙');
    expect((within(decks).getByLabelText('只给 TA 看的内容 1') as HTMLTextAreaElement).value).toBe('秘密甲');
    expect(within(modal).getByTestId('pa-profile-save').getAttribute('aria-disabled')).toBeNull();

    fireEvent.click(within(decks).getByText('加一张'));
    expect(within(decks).getAllByTestId('pa-card-row')).toHaveLength(4);
    // Held with a reason: aria-disabled plus the tooltip naming the section (not a silent native disabled).
    expect(within(modal).getByTestId('pa-profile-save').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(within(within(decks).getAllByTestId('pa-card-row')[3]!).getByLabelText('删除这张'));
    expect(within(decks).getAllByTestId('pa-card-row')).toHaveLength(3);

    fireEvent.click(within(decks).getByLabelText('顺序 2 −'));
    expect([title(1), title(2), title(3)]).toEqual(['乙', '甲', '丙']);

    fireEvent.click(within(modal).getByTestId('pa-profile-save'));
    await waitFor(() => expect(writes(calls, 'PUT', /^\/soul\/characters\/ag-storyteller$/)).toHaveLength(1));
    const body = writes(calls, 'PUT', /^\/soul\/characters\/ag-storyteller$/)[0]!.body as { decks: PaDeck[] };
    expect(Object.keys(body).filter((key) => key !== 'revision')).toEqual(['decks']);
    expect(body.decks).toEqual([
      {
        id: '1',
        name: '线索',
        cards: [
          { title: '乙', text: '说明乙', secret: '' },
          { title: '甲', text: '说明甲', secret: '秘密甲' },
          { title: '丙', text: '说明丙', secret: '' },
        ],
      },
    ]);
  });

  it('enforces the deck and card limits', async () => {
    mount('story-game', { kind: 'agent', agentId: 'ag-storyteller', section: 'play' }, (fixture) => {
      characterOf(fixture, 'ag-storyteller').decks = [deck('full', '满', 119), ...Array.from({ length: 7 }, (_, i) => deck(`d${i}`, `牌${i}`, 2))];
    });
    const modal = await editor();
    const decks = await within(modal).findByTestId('pa-profile-decks');
    expect(within(decks).getAllByTestId('pa-deck-row')).toHaveLength(8);
    expect(within(decks).getByTestId('pa-deck-add').hasAttribute('data-disabled')).toBe(true);
    expect(within(decks).getByTestId('pa-deck-form').dataset.deckId).toBe('full');
    fireEvent.change(within(decks).getByTestId('pa-deck-paste'), { target: { value: '一\n二\n三' } });
    fireEvent.click(within(decks).getByTestId('pa-deck-paste-add'));
    expect(within(decks).getByText('加入了 1 张')).toBeTruthy();
    expect(within(decks).getByText('有 2 行没有加入（没有牌面，或牌堆已满 120 张）')).toBeTruthy();
    expect(within(decks).getAllByTestId('pa-card-row')).toHaveLength(120);
    expect((within(decks).getByText('加一张').closest('button') as HTMLButtonElement).hasAttribute('data-disabled')).toBe(true);
  });

  it('asks before deleting a deck and writes nothing until 保存', async () => {
    const { calls } = mount('story-game', { kind: 'agent', agentId: 'ag-storyteller', section: 'play' }, (fixture) => {
      characterOf(fixture, 'ag-storyteller').decks = [deck('clues', '线索', 3), deck('omens', '预兆', 2)];
    });
    const modal = await editor();
    const decks = await within(modal).findByTestId('pa-profile-decks');
    fireEvent.click(within(within(decks).getAllByTestId('pa-deck-row')[1]!).getByRole('button'));
    expect(within(decks).getByTestId('pa-deck-form').dataset.deckId).toBe('omens');
    fireEvent.click(within(decks).getByText('删除牌堆'));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/预兆/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(confirm).getByText('删除'));
    });
    await waitFor(() => expect(within(decks).getAllByTestId('pa-deck-row').map((item) => item.dataset.deckId)).toEqual(['clues']));
    expect(writes(calls, 'PUT', /^\/soul\/characters\//)).toHaveLength(0);
    fireEvent.click(within(modal).getByTestId('pa-profile-save'));
    await waitFor(() => expect(writes(calls, 'PUT', /^\/soul\/characters\/ag-storyteller$/)).toHaveLength(1));
    expect((writes(calls, 'PUT', /^\/soul\/characters\/ag-storyteller$/)[0]!.body as { decks: PaDeck[] }).decks.map((item) => item.id)).toEqual(['clues']);
  });
});
