// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// 角色库 and card import (Soul UI spec §6.2, §7.2; addendum item 9). The page and the modal render inside a PaContext
// built from the `library` lab fixture, with a stateful `ui` and spied actions, so the tests see exactly what the page
// asks the data layer to do.
import '../helpers/radix-jsdom';
import { useMemo, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { PA_PLACEHOLDER_PNG, embedCard } from '@open-design/contracts/soul';
import { I18nProvider } from '../../../src/i18n';
import { PaContext, createPaDrafts } from '../../../src/fantay/pa/pa-context';
import { buildIndex } from '../../../src/fantay/pa/pa-model';
import type { PaActions, PaContextValue, PaData, PaModalState, PaNav, PaUiState } from '../../../src/fantay/pa/pa-types';
import { buildFixture } from '../../../src/fantay/pa/lab/fixtures';
import { SoulLibraryPage } from '../../../src/fantay/pa/soul/SoulLibraryPage';
import { SoulCardImportModal } from '../../../src/fantay/pa/soul/SoulCardImportModal';
import { libraryCharacters, libraryTags } from '../../../src/fantay/pa/soul/SoulLibraryTiles';

const NOW = Date.UTC(2026, 10, 14, 4, 0, 0);

const BASE_UI: PaUiState = {
  place: 'library',
  conversationId: null,
  inspectorOpen: false,
  inspectorOpenCompanion: false,
  inspectorTab: 'activity',
  inspectorWidth: 320,
  tasksFilter: null,
  memoryFilter: 'all',
  modal: null,
  rosterQuery: '',
  rosterFilter: 'all',
  libraryTab: 'characters',
  libraryQuery: '',
  libraryTag: null,
  focusTurn: null,
};

type AnyFn = (...args: unknown[]) => unknown;
interface Spies {
  actions: Record<string, Mock<AnyFn>>;
  openModal: Mock<AnyFn>;
  openConversation: Mock<AnyFn>;
  openAgent: Mock<AnyFn>;
}

function spyActions(overrides: Partial<Record<keyof PaActions, AnyFn>>, spies: Spies): PaActions {
  return new Proxy({} as PaActions, {
    get(_target, key: string) {
      spies.actions[key] ??= vi.fn<AnyFn>(overrides[key as keyof PaActions] ?? (async () => undefined));
      return spies.actions[key];
    },
  });
}

function Harness({ initial, spies, actions }: { initial: Partial<PaUiState>; spies: Spies; actions: PaActions }) {
  const fixture = useMemo(() => buildFixture('library', NOW), []);
  const index = useMemo(() => buildIndex(fixture.snapshot, fixture.channels, fixture.models, fixture.soul ?? null, 'en'), [fixture]);
  const [ui, setUi] = useState<PaUiState>({ ...BASE_UI, ...fixture.ui, ...initial });
  const data: PaData = {
    snapshot: fixture.snapshot,
    soul: fixture.soul ?? null,
    models: fixture.models,
    control: fixture.control,
    channels: fixture.channels,
    load: 'ready',
    stale: null,
    pending: new Set(),
    actions,
  };
  const nav = new Proxy({} as PaNav, {
    get(_target, key: string) {
      if (key === 'setLibrary') {
        return (patch: { tab?: PaUiState['libraryTab']; query?: string; tag?: string | null }) =>
          setUi((current) => ({
            ...current,
            ...(patch.tab !== undefined ? { libraryTab: patch.tab } : {}),
            ...(patch.query !== undefined ? { libraryQuery: patch.query } : {}),
            ...(patch.tag !== undefined ? { libraryTag: patch.tag } : {}),
          }));
      }
      if (key === 'openModal') {
        return (modal: PaModalState) => {
          spies.openModal(modal);
          setUi((current) => ({ ...current, modal }));
        };
      }
      if (key === 'closeModal') return () => setUi((current) => ({ ...current, modal: null }));
      if (key === 'openConversation') return spies.openConversation;
      if (key === 'openAgent') return spies.openAgent;
      return () => undefined;
    },
  });
  const value: PaContextValue = {
    data,
    index,
    ui,
    nav,
    drafts: useMemo(() => createPaDrafts(), []),
    layout: { width: 1192, roster: 'full', inspector: 'docked' },
    projects: [],
    onOpenProject: () => undefined,
    now: NOW,
  };
  const modal = ui.modal;
  return (
    <PaContext.Provider value={value}>
      <SoulLibraryPage />
      {modal?.kind === 'cardImport' ? (
        <SoulCardImportModal open onClose={() => setUi((current) => ({ ...current, modal: null }))} file={modal.file} agentId={modal.agentId} />
      ) : null}
    </PaContext.Provider>
  );
}

function mount(initial: Partial<PaUiState> = {}, overrides: Partial<Record<keyof PaActions, AnyFn>> = {}) {
  const spies: Spies = { actions: {}, openModal: vi.fn<AnyFn>(), openConversation: vi.fn<AnyFn>(), openAgent: vi.fn<AnyFn>(async () => undefined) };
  const actions = spyActions(overrides, spies);
  render(
    <I18nProvider initial="en">
      <Harness initial={initial} spies={spies} actions={actions} />
    </I18nProvider>,
  );
  return spies;
}

function v2Card(name: string) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      description: '一个住在海边灯塔里的守灯人，话不多。',
      personality: '安静，细心。',
      scenario: '',
      first_mes: '*灯塔的门开了一条缝。* 「风大，进来吧。」',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: ['「又是你。」'],
      tags: ['日常', '海边'],
      creator: 'lab',
      character_version: '1',
      extensions: { regex_scripts: [{ scriptName: 'hide', findRegex: '/x/g', replaceString: '' }], fav: true },
    },
  };
}

const jsonFile = (value: unknown, name: string) => new File([JSON.stringify(value)], name, { type: 'application/json' });

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(cleanup);

describe('library helpers', () => {
  it('orders Fantay first, then enabled characters by last activity', () => {
    const fixture = buildFixture('library', NOW);
    const index = buildIndex(fixture.snapshot, fixture.channels, fixture.models, fixture.soul ?? null, 'en');
    const entries = libraryCharacters(index);
    expect(entries[0]?.fantay).toBe(true);
    expect(entries).toHaveLength(index.agents.size);
    const enabled = entries.filter((entry) => !entry.fantay && entry.agent.enabled);
    for (let i = 1; i < enabled.length; i += 1) expect(enabled[i - 1]!.activity).toBeGreaterThanOrEqual(enabled[i]!.activity);
  });

  it('lists at most twelve tags, the most used first', () => {
    const fixture = buildFixture('library', NOW);
    const index = buildIndex(fixture.snapshot, fixture.channels, fixture.models, fixture.soul ?? null, 'en');
    const tags = libraryTags(index);
    expect(tags.length).toBeLessThanOrEqual(12);
    expect(tags.slice(0, 2)).toEqual(expect.arrayContaining(['日常']));
  });
});

describe('SoulLibraryPage', () => {
  it('shows four inline tabs with counts and the character tiles', async () => {
    mount();
    expect(await screen.findByTestId('pa-library-page')).toBeTruthy();
    for (const id of ['characters', 'lorebooks', 'personas', 'presets']) {
      expect(screen.getByTestId(`pa-library-tab-${id}`).textContent).toMatch(/\d+$/);
    }
    const tiles = screen.getAllByTestId('pa-library-tile');
    expect(tiles.length).toBeGreaterThanOrEqual(7);
    expect(within(tiles[0]!).getByText('Main assistant')).toBeTruthy();
    const linqi = tiles.find((tile) => tile.dataset.agent === 'ag-linqi');
    expect(linqi && within(linqi).getByText(/to review$/)).toBeTruthy();
    expect(screen.getByText('Starters')).toBeTruthy();
    expect(screen.getByTestId('pa-library-import')).toBeTruthy();
  });

  it('shelves the starters not met yet, then the four work templates, each with a cover beside its name', async () => {
    const spies = mount();
    const shelf = await screen.findByTestId('pa-starter-shelf');
    const starters = within(shelf).getAllByTestId('pa-starter-tile');
    expect(starters.map((tile) => tile.dataset.starter)).toEqual(['tea-room']);
    expect(within(starters[0]!).getByText('Window-side tea')).toBeTruthy();
    expect(within(starters[0]!).getAllByRole('img')).toHaveLength(2);
    const templates = within(shelf).getAllByTestId('pa-starter-template');
    expect(templates.map((tile) => tile.dataset.template)).toEqual(['researcher', 'designer', 'writer', 'reviewer']);
    expect(within(templates[0]!).getByText('Assistant')).toBeTruthy();
    fireEvent.click(templates[0]!);
    expect(spies.openModal).toHaveBeenCalledWith({ kind: 'agent', agentId: null, template: 'researcher' });
  });

  it('opens a character on tile click and the editor from the pencil', async () => {
    const spies = mount();
    const tile = (await screen.findAllByTestId('pa-library-tile')).find((item) => item.dataset.agent === 'ag-xiaoyue')!;
    fireEvent.click(within(tile).getAllByRole('button')[0]!);
    expect(spies.openAgent).toHaveBeenCalledWith('ag-xiaoyue');
    fireEvent.click(within(tile).getByRole('button', { name: 'Edit profile' }));
    expect(spies.openModal).toHaveBeenCalledWith({ kind: 'agent', agentId: 'ag-xiaoyue' });
  });

  it('narrows tiles by tag and hides the starter shelf while filtering', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '日常' }));
    await waitFor(() => expect(screen.queryByText('Starters')).toBeNull());
    const agents = screen.getAllByTestId('pa-library-tile').map((tile) => tile.dataset.agent);
    expect(agents).toEqual(expect.arrayContaining(['ag-xiaoyue', 'ag-linqi']));
    expect(agents).not.toContain('ag-zhou');
  });

  it('shows the quiet no-match line for a search without results', async () => {
    mount();
    fireEvent.change(await screen.findByTestId('pa-library-search'), { target: { value: 'zzzz-nothing' } });
    expect(await screen.findByText('No matching characters')).toBeTruthy();
  });

  it('lists world books with counts, bindings and the review tag', async () => {
    const spies = mount({ libraryTab: 'lorebooks' });
    const rows = await screen.findAllByTestId('pa-library-lorebook');
    expect(rows).toHaveLength(3);
    const harbor = rows.find((row) => row.textContent?.includes('雾港旧码头'))!;
    expect(within(harbor).getByText(/to review$/)).toBeTruthy();
    expect(within(harbor).getByText('Not bound')).toBeTruthy();
    fireEvent.click(within(harbor).getAllByRole('button')[0]!);
    expect(spies.openModal).toHaveBeenCalledWith({ kind: 'lorebook', lorebookId: 'lb-harbor' });
  });

  it('marks the default persona and tags built-in styles', async () => {
    mount({ libraryTab: 'personas' });
    expect(await screen.findAllByTestId('pa-library-persona')).toHaveLength(2);
    expect(screen.getAllByText('Default')).toHaveLength(1);
    cleanup();
    mount({ libraryTab: 'presets' });
    const presets = await screen.findAllByTestId('pa-library-preset');
    expect(presets.filter((row) => row.dataset.builtin !== undefined)).toHaveLength(5);
    expect(screen.getByText('My styles')).toBeTruthy();
    expect(screen.getByText('慢回信')).toBeTruthy();
    expect(screen.queryByTestId('pa-library-import')).toBeNull();
  });

  it('opens the card import modal from 导入 on the characters tab', async () => {
    const spies = mount();
    fireEvent.click(await screen.findByTestId('pa-library-import'));
    expect(spies.openModal).toHaveBeenCalledWith({ kind: 'cardImport' });
    expect(await screen.findByTestId('pa-card-import-drop')).toBeTruthy();
  });
});

describe('SoulCardImportModal', () => {
  it('reads a V2 JSON card on this device, shows three columns and imports with the edited name', async () => {
    const result = {
      agent: { id: 'ag-new', name: '守灯人阿青' },
      conversation: { id: 'conv-new' },
      report: { needsReview: [{ key: 'extensions.regex_scripts', kind: 'regex', summary: 'x', action: 'quarantined' }], preservedKeys: [] },
    };
    const spies = mount({ modal: { kind: 'cardImport', file: jsonFile(v2Card('守灯人'), '守灯人.json') } }, { importCard: async () => result });
    const ready = await screen.findByTestId('pa-card-import-ready');
    expect(within(ready).getByText('Description')).toBeTruthy();
    expect(within(ready).getByText('Alternate greetings × 1')).toBeTruthy();
    expect(within(ready).getByText('Tags 2')).toBeTruthy();
    expect(within(screen.getByTestId('pa-card-import-review')).getByText('Quarantined')).toBeTruthy();
    expect(screen.getByText('Character card V2')).toBeTruthy();
    const name = screen.getByTestId('pa-card-import-name') as HTMLInputElement;
    expect(name.value).toBe('守灯人');
    fireEvent.change(name, { target: { value: '守灯人阿青' } });
    fireEvent.click(screen.getByTestId('pa-card-import-submit'));
    await waitFor(() => expect(spies.actions.importCard).toHaveBeenCalled());
    const body = spies.actions.importCard!.mock.calls[0]![0] as { card: { data: { name: string } }; model?: unknown; agentId?: string; fileName?: string };
    expect(body.card.data.name).toBe('守灯人阿青');
    expect(body.fileName).toBe('守灯人.json');
    expect(body.model).toBeTruthy();
    expect(body.agentId).toBeUndefined();
    await waitFor(() => expect(spies.openConversation).toHaveBeenCalledWith('conv-new'));
  });

  it('reads a PNG card through its embedded chunks', async () => {
    // jsdom has no image decoder: the portrait re-encode fails and the card still imports without art.
    vi.stubGlobal('createImageBitmap', vi.fn(async () => Promise.reject(new Error('no decoder'))));
    try {
      const png = embedCard(PA_PLACEHOLDER_PNG, { spec: 'chara_card_v3', spec_version: '3.0', data: v2Card('灯塔').data });
      mount({ modal: { kind: 'cardImport', file: new File([new Uint8Array(png)], '灯塔.png', { type: 'image/png' }) } });
      const ready = await screen.findByTestId('pa-card-import-ready');
      expect(within(ready).getByText('Greeting')).toBeTruthy();
      expect(screen.getByText('Character card V3')).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('offers a world-book file as a world book', async () => {
    const world = { name: '灯塔', entries: { 0: { uid: 0, key: ['灯塔'], content: '灯塔在岬角上。', comment: '灯塔', constant: false, order: 100, position: 0 } } };
    const spies = mount(
      { modal: { kind: 'cardImport', file: jsonFile(world, '灯塔.json') } },
      { importWorld: async () => ({ lorebook: { id: 'lb-new', name: '灯塔' }, report: [] }) },
    );
    const callout = await screen.findByTestId('pa-card-import-error');
    expect(callout.dataset.error).toBe('world');
    fireEvent.click(screen.getByTestId('pa-card-import-as-world'));
    await waitFor(() => expect(spies.actions.importWorld).toHaveBeenCalled());
    await waitFor(() => expect(spies.openModal).toHaveBeenCalledWith({ kind: 'lorebook', lorebookId: 'lb-new' }));
  });

  it('says so when the file holds no card, or is not PNG or JSON', async () => {
    mount({ modal: { kind: 'cardImport', file: jsonFile({ foo: 1 }, 'note.json') } });
    expect(await screen.findByText('No character card was found in this file.')).toBeTruthy();
    cleanup();
    mount({ modal: { kind: 'cardImport', file: new File(['hello'], 'note.txt', { type: 'text/plain' }) } });
    expect(await screen.findByText('This format is not supported yet.')).toBeTruthy();
    cleanup();
    mount({ modal: { kind: 'cardImport', file: new File(['{nope'], 'bad.json', { type: 'application/json' }) } });
    expect(await screen.findByText('This is not a valid JSON file.')).toBeTruthy();
  });

  it('onto an existing character lists the fields that change and sends the agent id', async () => {
    const spies = mount(
      { modal: { kind: 'cardImport', file: jsonFile(v2Card('守灯人'), '守灯人.json'), agentId: 'ag-xiaoyue' } },
      { importCard: async () => ({ agent: { id: 'ag-xiaoyue', name: '小月' }, conversation: { id: 'conv-xiaoyue' }, report: { needsReview: [], preservedKeys: [] } }) },
    );
    const replaced = await screen.findByTestId('pa-card-import-replaced');
    expect(replaced.textContent).toContain('Description');
    expect(replaced.textContent).toContain('Greeting');
    expect(screen.queryByTestId('pa-card-import-name')).toBeNull();
    fireEvent.click(screen.getByTestId('pa-card-import-submit'));
    await waitFor(() => expect(spies.actions.importCard).toHaveBeenCalled());
    const body = spies.actions.importCard!.mock.calls[0]![0] as { agentId?: string; model?: unknown; revision?: unknown };
    expect(body.agentId).toBe('ag-xiaoyue');
    expect(body.model).toBeUndefined();
    // The overwrite carries the card's revision so the daemon can refuse a stale replace.
    expect(typeof body.revision).toBe('number');
  });

  it('goes back to the drop zone with 重新选择', async () => {
    mount({ modal: { kind: 'cardImport', file: jsonFile(v2Card('守灯人'), '守灯人.json') } });
    fireEvent.click(await screen.findByTestId('pa-card-import-reselect'));
    expect(await screen.findByTestId('pa-card-import-drop')).toBeTruthy();
  });
});
