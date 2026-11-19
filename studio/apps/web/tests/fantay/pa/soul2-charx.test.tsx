// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// CHARX import in the card import modal (stage 2 spec §7.3, §7.5). Archives are built in the test with a stored-entry
// zip writer and read by the real readCardFile and engine; jsdom has no canvas, so the canvas re-encode is stubbed to
// a tiny WebP and the uploads and the import are spied actions.
import '../helpers/radix-jsdom';
import { deflateRawSync } from 'node:zlib';
import { useMemo, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { crc32 } from '@open-design/contracts/soul';
import { I18nProvider } from '../../../src/i18n';
import { PaContext, createPaDrafts } from '../../../src/fantay/pa/pa-context';
import { buildIndex } from '../../../src/fantay/pa/pa-model';
import type { PaActions, PaContextValue, PaData, PaModalState, PaNav, PaUiState } from '../../../src/fantay/pa/pa-types';
import { buildFixture } from '../../../src/fantay/pa/lab/fixtures';
import { SoulCardImportModal } from '../../../src/fantay/pa/soul/SoulCardImportModal';
import { SOUL_MAX_CHARX_BYTES } from '../../../src/fantay/pa/soul/soul-files';
import { Toaster, __resetToastsForTests } from '../../../src/fantay/ui';

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
  openConversation: Mock<AnyFn>;
}

function spyActions(overrides: Partial<Record<keyof PaActions, AnyFn>>, spies: Spies): PaActions {
  return new Proxy({} as PaActions, {
    get(_target, key: string) {
      spies.actions[key] ??= vi.fn<AnyFn>(overrides[key as keyof PaActions] ?? (async () => undefined));
      return spies.actions[key];
    },
  });
}

function Harness({ modal, spies, actions }: { modal: Extract<PaModalState, { kind: 'cardImport' }>; spies: Spies; actions: PaActions }) {
  const fixture = useMemo(() => buildFixture('library', NOW), []);
  const index = useMemo(() => buildIndex(fixture.snapshot, fixture.channels, fixture.models, fixture.soul ?? null, 'en'), [fixture]);
  const [open, setOpen] = useState(true);
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
      if (key === 'openConversation') return spies.openConversation;
      return () => undefined;
    },
  });
  const value: PaContextValue = {
    data,
    index,
    ui: { ...BASE_UI, ...fixture.ui, modal },
    nav,
    drafts: useMemo(() => createPaDrafts(), []),
    layout: { width: 1192, roster: 'full', inspector: 'docked' },
    projects: [],
    onOpenProject: () => undefined,
    now: NOW,
  };
  return (
    <PaContext.Provider value={value}>
      {open ? <SoulCardImportModal open onClose={() => setOpen(false)} file={modal.file} agentId={modal.agentId} /> : null}
      <Toaster />
    </PaContext.Provider>
  );
}

function mount(
  modal: Extract<PaModalState, { kind: 'cardImport' }>,
  overrides: Partial<Record<keyof PaActions, AnyFn>> = {},
  locale: 'en' | 'zh-CN' = 'en',
) {
  const spies: Spies = { actions: {}, openConversation: vi.fn<AnyFn>() };
  render(
    <I18nProvider initial={locale}>
      <Harness modal={modal} spies={spies} actions={spyActions(overrides, spies)} />
    </I18nProvider>,
  );
  return spies;
}

// ---- archive ------------------------------------------------------------------------------------------------------

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 12, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 1, 2, 3, 4]);

/** A test-only zip writer: stored entries (method 0), or raw deflate through node:zlib when asked. */
function zip(entries: Array<{ name: string; data: Uint8Array; deflate?: boolean }>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const body = entry.deflate ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(8, method, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, body.length, true);
    l.setUint32(22, entry.data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, body);
    const record = new Uint8Array(46 + name.length);
    const c = new DataView(record.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(10, method, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true);
    c.setUint32(24, entry.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);
    offset += local.length + body.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, size, true);
  e.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + 22);
  let at = 0;
  for (const part of [...chunks, ...central, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const card = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '小雨',
    description: '雨天开书店的店主。',
    personality: '安静，爱笑。',
    scenario: '',
    first_mes: '欢迎光临。',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '1.0',
    extensions: {},
    assets: [
      { type: 'icon', uri: 'embeded://assets/icon/images/main.png', name: 'main', ext: 'png' },
      { type: 'emotion', uri: 'embeded://assets/emotion/happy.png', name: 'happy', ext: 'png' },
      { type: 'emotion', uri: 'embedded://assets/emotion/sad.webp', name: 'sad', ext: 'webp' },
      { type: 'background', uri: 'embeded://assets/other/rain.png', name: 'rain', ext: 'png' },
    ],
  },
};
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const fileOf = (bytes: Uint8Array, name: string, type = '') => new File([new Uint8Array(bytes)], name, { type });

/** card.json, the portrait, two emotion images, the card's background and one file the card does not name. */
function charx(cardJson: Uint8Array = json(card), deflateCard = false): Uint8Array {
  return zip([
    { name: 'card.json', data: cardJson, deflate: deflateCard },
    { name: 'assets/icon/images/main.png', data: PNG },
    { name: 'assets/emotion/happy.png', data: PNG },
    { name: 'assets/emotion/sad.webp', data: WEBP },
    { name: 'assets/other/rain.png', data: PNG },
    { name: 'module.risum', data: new Uint8Array([1, 2, 3]) },
  ]);
}

const RESULT = {
  agent: { id: 'ag-new', name: '小雨' },
  conversation: { id: 'conv-new' },
  report: { needsReview: [], preservedKeys: [] },
};

/** Every upload answers the next id: as-1, as-2, … */
function uploads() {
  let n = 0;
  return async () => ({ id: `as-${(n += 1)}` });
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  // The canvas re-encode (imageToAsset) on jsdom: a decoded bitmap, a 2D context and a WebP blob of three bytes.
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 64, height: 64, close: () => undefined })));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ drawImage: () => undefined })) as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function toBlob(callback: BlobCallback) {
    callback(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }));
  });
});
afterEach(() => {
  cleanup();
  act(() => __resetToastsForTests());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SoulCardImportModal on CHARX', () => {
  it('shows the portrait, the sprites and the archive files in the three columns', async () => {
    mount({ kind: 'cardImport', file: fileOf(charx(), '小雨.charx') });
    const ready = await screen.findByTestId('pa-card-import-ready');
    expect(within(ready).getByText('Description')).toBeTruthy();
    expect(within(ready).getByTestId('pa-card-import-charx-portrait').textContent).toBe('Portrait');
    const sprites = within(ready).getByTestId('pa-card-import-charx-sprites');
    expect(within(sprites).getByText('Sprites × 2')).toBeTruthy();
    expect(within(sprites).getByText('Happy, Sad')).toBeTruthy();
    // 可用 counts its card rows plus 头像 and 立绘.
    const readyRows = within(ready).getAllByRole('listitem');
    expect(ready.querySelector('h3')?.textContent).toMatch(new RegExp(`${readyRows.length}$`));

    // The card's asset list itself is kept on the character, as for any V3 card.
    expect(within(screen.getByTestId('pa-card-import-preserved')).getByText('data.assets')).toBeTruthy();

    const review = screen.getByTestId('pa-card-import-review');
    // The card parser's own item for the background, then one row for the archive files that were not imported.
    expect(within(review).getByText('asset rain (background) is not imported')).toBeTruthy();
    const files = within(review).getByTestId('pa-card-import-charx-files');
    expect(within(files).getByText('Other files in the archive, not imported: 2')).toBeTruthy();
    const paths = within(files).getAllByRole('listitem').map((item) => item.textContent);
    expect(paths).toEqual(['assets/other/rain.png · Named by the card; not imported', 'module.risum · Not referenced by the card']);
    expect(review.querySelector('h3')?.textContent).toMatch(/2$/);
  });

  it('joins the mood names the Chinese way in Chinese', async () => {
    mount({ kind: 'cardImport', file: fileOf(charx(), '小雨.charx') }, {}, 'zh-CN');
    const sprites = await screen.findByTestId('pa-card-import-charx-sprites');
    expect(within(sprites).getByText('立绘 × 2')).toBeTruthy();
    expect(within(sprites).getByText('开心、难过')).toBeTruthy();
  });

  it('saves each sprite, then imports with their ids and the portrait', async () => {
    const spies = mount({ kind: 'cardImport', file: fileOf(charx(), '小雨.charx') }, { uploadAsset: uploads(), importCard: async () => RESULT });
    fireEvent.click(await screen.findByTestId('pa-card-import-submit'));
    await waitFor(() => expect(spies.actions.importCard).toHaveBeenCalledTimes(1));
    expect(spies.actions.uploadAsset).toHaveBeenCalledTimes(2);
    expect(spies.actions.uploadAsset!.mock.calls[0]![0]).toEqual({ mime: 'image/webp', data: 'AQID' });
    const body = spies.actions.importCard!.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.sprites).toEqual({ happy: 'as-1', sad: 'as-2' });
    expect(body.portrait).toEqual({ mime: 'image/webp', data: 'AQID' });
    expect(body.fileName).toBe('小雨.charx');
    expect(body.model).toBeTruthy();
    await waitFor(() => expect(spies.openConversation).toHaveBeenCalledWith('conv-new'));
    expect(await screen.findByText('Imported "小雨"')).toBeTruthy();
    expect(screen.queryByText(/sprites were not saved/)).toBeNull();
  });

  it('says which image it is saving on the submit button', async () => {
    const pending: Array<(value: { id: string }) => void> = [];
    const spies = mount(
      { kind: 'cardImport', file: fileOf(charx(), '小雨.charx') },
      { uploadAsset: () => new Promise((resolve) => pending.push(resolve)), importCard: async () => RESULT },
    );
    const submit = await screen.findByTestId('pa-card-import-submit');
    fireEvent.click(submit);
    await waitFor(() => expect(submit.textContent).toBe('Saving images 1 of 2…'));
    expect(submit.getAttribute('aria-busy')).toBe('true');
    act(() => pending[0]!({ id: 'as-1' }));
    await waitFor(() => expect(submit.textContent).toBe('Saving images 2 of 2…'));
    expect(spies.actions.importCard?.mock.calls.length ?? 0).toBe(0); // the spy exists once the modal first calls it
    act(() => pending[1]!({ id: 'as-2' }));
    await waitFor(() => expect(spies.actions.importCard).toHaveBeenCalledTimes(1));
  });

  it('imports without a sprite that could not be saved and says so in a second toast', async () => {
    let n = 0;
    const spies = mount(
      { kind: 'cardImport', file: fileOf(charx(), '小雨.charx') },
      {
        uploadAsset: async () => {
          n += 1;
          if (n === 1) throw new Error('disk full');
          return { id: `as-${n}` };
        },
        importCard: async () => RESULT,
      },
    );
    fireEvent.click(await screen.findByTestId('pa-card-import-submit'));
    await waitFor(() => expect(spies.actions.importCard).toHaveBeenCalledTimes(1));
    expect((spies.actions.importCard!.mock.calls[0]![0] as { sprites?: unknown }).sprites).toEqual({ sad: 'as-2' });
    expect(await screen.findByText('Imported "小雨"')).toBeTruthy();
    expect(await screen.findByText('1 sprites were not saved. You can add them later in the profile.')).toBeTruthy();
  });

  it('does not save the sprites again when the import is retried', async () => {
    let attempt = 0;
    const spies = mount(
      { kind: 'cardImport', file: fileOf(charx(), '小雨.charx') },
      {
        uploadAsset: uploads(),
        importCard: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error('offline');
          return RESULT;
        },
      },
    );
    const submit = await screen.findByTestId('pa-card-import-submit');
    fireEvent.click(submit);
    await waitFor(() => expect(spies.actions.importCard).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(submit.getAttribute('aria-busy')).toBeNull());
    fireEvent.click(submit);
    await waitFor(() => expect(spies.actions.importCard).toHaveBeenCalledTimes(2));
    expect(spies.actions.uploadAsset).toHaveBeenCalledTimes(2);
    expect((spies.actions.importCard!.mock.calls[1]![0] as { sprites?: unknown }).sprites).toEqual({ happy: 'as-1', sad: 'as-2' });
  });

  it('onto an existing character lists 立绘 among the replaced fields and sends the sprites', async () => {
    const spies = mount(
      { kind: 'cardImport', file: fileOf(charx(), '小雨.charx'), agentId: 'ag-xiaoyue' },
      { uploadAsset: uploads(), importCard: async () => ({ ...RESULT, agent: { id: 'ag-xiaoyue', name: '小月' } }) },
    );
    const replaced = await screen.findByTestId('pa-card-import-replaced');
    expect(replaced.textContent).toContain('Description');
    expect(replaced.textContent).toContain('Sprites × 2');
    fireEvent.click(screen.getByTestId('pa-card-import-submit'));
    await waitFor(() => expect(spies.actions.importCard).toHaveBeenCalledTimes(1));
    const body = spies.actions.importCard!.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.agentId).toBe('ag-xiaoyue');
    expect(body.sprites).toEqual({ happy: 'as-1', sad: 'as-2' });
  });

  it('shows no portrait row when the icon cannot be re-encoded, and none of the CHARX rows for a plain card', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => Promise.reject(new Error('no decoder'))));
    mount({ kind: 'cardImport', file: fileOf(charx(), '小雨.charx') });
    const ready = await screen.findByTestId('pa-card-import-ready');
    expect(within(ready).queryByTestId('pa-card-import-charx-portrait')).toBeNull();
    expect(within(ready).getByTestId('pa-card-import-charx-sprites')).toBeTruthy();
    cleanup();
    mount({ kind: 'cardImport', file: fileOf(json(card), '小雨.json', 'application/json') });
    await screen.findByTestId('pa-card-import-ready');
    expect(screen.queryByTestId('pa-card-import-charx-portrait')).toBeNull();
    expect(screen.queryByTestId('pa-card-import-charx-sprites')).toBeNull();
    expect(screen.queryByTestId('pa-card-import-charx-files')).toBeNull();
  });

  it('lists a referenced image that is missing from the archive', async () => {
    const archive = zip([
      { name: 'card.json', data: json(card) },
      { name: 'assets/emotion/happy.png', data: PNG },
    ]);
    mount({ kind: 'cardImport', file: fileOf(archive, '小雨.charx') });
    const files = await screen.findByTestId('pa-card-import-charx-files');
    const paths = within(files).getAllByRole('listitem').map((item) => item.textContent);
    expect(paths).toEqual([
      'assets/icon/images/main.png · Missing from the archive',
      'assets/emotion/sad.webp · Missing from the archive',
    ]);
    expect(within(screen.getByTestId('pa-card-import-charx-sprites')).getByText('Sprites × 1')).toBeTruthy();
  });

  it('takes a zip from the file button and a CHARX from a drop', async () => {
    mount({ kind: 'cardImport' });
    const input = (await screen.findByTestId('pa-card-import-file')) as HTMLInputElement;
    expect(input.accept).toBe('.png,.json,.charx,image/png,application/json,application/zip');
    fireEvent.change(input, { target: { files: [fileOf(charx(), 'card.zip', 'application/zip')] } });
    expect(await screen.findByTestId('pa-card-import-charx-sprites')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pa-card-import-reselect'));
    const zone = await screen.findByTestId('pa-card-import-drop');
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [fileOf(charx(), '小雨.charx')] } });
    expect(await screen.findByTestId('pa-card-import-charx-sprites')).toBeTruthy();
  });

  it.skipIf(typeof DecompressionStream === 'undefined')('inflates a deflated card.json with the browser inflate', async () => {
    mount({ kind: 'cardImport', file: fileOf(charx(json(card), true), '小雨.charx') });
    expect(await screen.findByTestId('pa-card-import-charx-sprites')).toBeTruthy();
    expect((screen.getByTestId('pa-card-import-name') as HTMLInputElement).value).toBe('小雨');
  });
});

describe('SoulCardImportModal CHARX errors', () => {
  const errorOf = async (file: File) => {
    mount({ kind: 'cardImport', file });
    const callout = await screen.findByTestId('pa-card-import-error');
    const shown = { kind: callout.dataset.error, text: callout.textContent };
    cleanup();
    return shown;
  };

  it('names a damaged archive, a missing card.json, ZIP64, a size over 64 MB and a broken card.json', async () => {
    expect(await errorOf(fileOf(new Uint8Array([1, 2, 3, 4]), 'broken.charx'))).toEqual({
      kind: 'charxCorrupt',
      text: 'This CHARX file is damaged or incomplete.',
    });
    expect(await errorOf(fileOf(zip([{ name: 'other.json', data: json(card) }]), 'x.charx'))).toEqual({
      kind: 'charxNoCard',
      text: 'The archive has no card.json.',
    });
    const wide = zip([{ name: 'card.json', data: json(card) }]);
    const end = new DataView(wide.buffer, wide.length - 22);
    end.setUint16(8, 0xffff, true);
    end.setUint16(10, 0xffff, true);
    expect(await errorOf(fileOf(wide, 'x.charx'))).toEqual({ kind: 'charxZip64', text: 'ZIP64 CHARX files are not supported yet.' });
    const big = fileOf(new Uint8Array(4), 'big.charx');
    Object.defineProperty(big, 'size', { value: SOUL_MAX_CHARX_BYTES + 1 });
    expect(await errorOf(big)).toEqual({ kind: 'tooLarge', text: 'The file is too large (20 MB for PNG and JSON, 64 MB for CHARX).' });
    expect(await errorOf(fileOf(zip([{ name: 'card.json', data: new TextEncoder().encode('{nope') }]), 'x.charx'))).toMatchObject({
      kind: 'badJson',
    });
    expect(await errorOf(fileOf(zip([{ name: 'card.json', data: json([1, 2, 3]) }]), 'x.charx'))).toMatchObject({ kind: 'noCard' });
  });
});
