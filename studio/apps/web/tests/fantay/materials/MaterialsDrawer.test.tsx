// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registryMocks = vi.hoisted(() => ({ invalidateProjectFilesCache: vi.fn() }));
vi.mock('../../../src/providers/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/registry')>()),
  invalidateProjectFilesCache: registryMocks.invalidateProjectFilesCache,
}));

import { readMaterialDrag } from '../../../src/fantay/materials/material-drag';
import {
  closeMaterialsDrawer,
  getMaterialsDrawerState,
  openMaterialsDrawer,
  resetMaterialsDrawerForTests,
} from '../../../src/fantay/materials/materials-drawer-store';
import { MaterialsDrawerHost } from '../../../src/fantay/materials/MaterialsDrawerHost';
import {
  drainQueuedBoardInserts,
  resetWorkspaceBusForTests,
  subscribeWorkspaceCommand,
  type WorkspaceCommandOf,
} from '../../../src/fantay/workspace/workspace-bus';
import { I18nProvider } from '../../../src/i18n';
import { MockIntersectionObserver, makeItem, materialsFetch } from '../../components/materials/fixtures';

class FakeDataTransfer {
  private readonly data = new Map<string, string>();
  effectAllowed = 'all';
  dropEffect = 'none';
  get types(): string[] {
    return Array.from(this.data.keys());
  }
  setData(format: string, value: string): void {
    this.data.set(format, value);
  }
  getData(format: string): string {
    return this.data.get(format) ?? '';
  }
}

let fetchState: ReturnType<typeof materialsFetch>;

function renderHost() {
  return render(
    <I18nProvider initial="en">
      <button type="button" data-testid="opener">
        open materials
      </button>
      <MaterialsDrawerHost />
    </I18nProvider>,
  );
}

async function openDrawer() {
  act(() => openMaterialsDrawer());
  const drawer = await screen.findByTestId('materials-drawer');
  await within(drawer).findAllByTestId('materials-drawer-card');
  await within(drawer).findByTestId('materials-drawer-count');
  return drawer;
}

function cardFor(drawer: HTMLElement, id: string): HTMLElement {
  const card = within(drawer)
    .getAllByTestId('materials-drawer-card')
    .find((candidate) => candidate.getAttribute('data-material-id') === id);
  if (!card) throw new Error(`no drawer card ${id}`);
  return card;
}

function applyCalls() {
  return fetchState.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/apply'));
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  MockIntersectionObserver.reset();
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  fetchState = materialsFetch({ failApply: new Set(['item-1']) });
  vi.stubGlobal('fetch', vi.fn(fetchState.handler));
  registryMocks.invalidateProjectFilesCache.mockClear();
  resetMaterialsDrawerForTests();
  resetWorkspaceBusForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetMaterialsDrawerForTests();
  resetWorkspaceBusForTests();
  window.history.replaceState(null, '', '/');
});

describe('MaterialsDrawer', () => {
  it('mounts and fetches nothing before the first open, then follows the store and stays mounted', async () => {
    renderHost();
    expect(screen.queryByTestId('materials-drawer')).toBeNull();
    expect(fetchState.calls).toHaveLength(0);

    const drawer = await openDrawer();
    expect(screen.getByRole('complementary', { name: 'Materials' })).toBe(drawer);
    expect(drawer.getAttribute('data-state')).toBe('open');
    expect(drawer.hasAttribute('inert')).toBe(false);
    expect(within(drawer).getAllByTestId('materials-drawer-card')).toHaveLength(24);
    expect(within(drawer).getByTestId('materials-drawer-count').textContent).toBe('60 results');

    act(() => closeMaterialsDrawer());
    expect(screen.getByTestId('materials-drawer')).toBe(drawer);
    expect(drawer.getAttribute('data-state')).toBe('closed');
    expect(drawer.hasAttribute('inert')).toBe(true);

    act(() => openMaterialsDrawer());
    expect(drawer.getAttribute('data-state')).toBe('open');
    // the loaded page survives a close/open
    expect(within(drawer).getAllByTestId('materials-drawer-card')).toHaveLength(24);
  });

  it('wires search and the kind filter to the daemon query', async () => {
    renderHost();
    const drawer = await openDrawer();

    fireEvent.change(within(drawer).getByTestId('materials-drawer-search'), { target: { value: 'Material 1' } });
    await waitFor(() =>
      expect(fetchState.calls.some((call) => call.url.includes('/api/materials/items?') && call.url.includes('q=Material+1'))).toBe(true),
    );

    const kinds = within(drawer).getByTestId('materials-drawer-kind-filter');
    expect(within(kinds).getByRole('button', { name: /^All/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(kinds).getByRole('button', { name: /SVG icons/ }));
    await waitFor(() => expect(fetchState.calls.some((call) => call.url.includes('kind=svg'))).toBe(true));
    expect(within(kinds).getByRole('button', { name: /SVG icons/ }).getAttribute('aria-pressed')).toBe('true');
    expect(within(drawer).getByRole('combobox', { name: 'Category' })).toBeTruthy();
  });

  it('disables insert with a reason off project routes', async () => {
    renderHost();
    const drawer = await openDrawer();
    const insert = within(cardFor(drawer, 'item-0')).getByTestId('materials-drawer-insert');

    expect(insert.getAttribute('aria-disabled')).toBe('true');
    expect(insert.getAttribute('aria-label')).toBe('Insert on board');
    fireEvent.click(insert);
    expect(applyCalls()).toHaveLength(0);
    act(() => insert.focus());
    expect((await screen.findAllByText('Open a project to insert on its board')).length).toBeGreaterThan(0);
  });

  it('inserts on a project route: apply, then board.insert to the mounted board, with status', async () => {
    window.history.replaceState(null, '', '/projects/p1');
    const received: WorkspaceCommandOf<'board.insert'>[] = [];
    subscribeWorkspaceCommand('board.insert', (command) => {
      received.push(command);
      return true;
    });
    renderHost();
    const drawer = await openDrawer();

    fireEvent.click(within(cardFor(drawer, 'item-0')).getByTestId('materials-drawer-insert'));
    expect(within(drawer).getByTestId('materials-drawer-status').textContent).toBe('Inserting…');
    await waitFor(() =>
      expect(within(drawer).getByTestId('materials-drawer-status').textContent).toBe('Inserted “Material 0”'),
    );
    expect(applyCalls().map((call) => [call.url, call.body])).toEqual([
      ['/api/materials/items/item-0/apply', { projectId: 'p1' }],
    ]);
    expect(registryMocks.invalidateProjectFilesCache).toHaveBeenCalledWith('p1', null);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'board.insert', projectId: 'p1', select: true });
    expect(received[0]?.drafts).toHaveLength(1);
    expect(received[0]?.drafts[0]).toMatchObject({ provenance: { source: 'material', materialId: 'item-0' } });
  });

  it('reports a queued insert when no board is mounted, and a failed one with the daemon detail', async () => {
    window.history.replaceState(null, '', '/projects/p1');
    renderHost();
    const drawer = await openDrawer();
    const status = () => within(drawer).getByTestId('materials-drawer-status').textContent;

    fireEvent.click(within(cardFor(drawer, 'item-0')).getByTestId('materials-drawer-insert'));
    await waitFor(() => expect(status()).toBe('Copied into the project; it appears when you open the board'));
    expect(drainQueuedBoardInserts('p1')).toHaveLength(1);

    fireEvent.click(within(cardFor(drawer, 'item-1')).getByTestId('materials-drawer-insert'));
    await waitFor(() => expect(status()).toBe('Could not insert (item-1 cannot be copied)'));
    expect(drainQueuedBoardInserts('p1')).toHaveLength(0);
  });

  it('writes the material payload when a card starts dragging', async () => {
    renderHost();
    const drawer = await openDrawer();
    const card = cardFor(drawer, 'item-2');
    expect(card.getAttribute('draggable')).toBe('true');

    const dataTransfer = new FakeDataTransfer();
    fireEvent.dragStart(card, { dataTransfer });

    const payload = readMaterialDrag(dataTransfer as unknown as DataTransfer);
    expect(payload?.item).toMatchObject({ id: 'item-2', title: 'Material 2', kind: makeItem(2).kind });
    expect(dataTransfer.getData('text/plain')).toBe('Material 2');
    expect(dataTransfer.effectAllowed).toBe('copy');
  });

  it('focuses the search on open, takes "/" while open, closes on Esc and hands focus back', async () => {
    renderHost();
    const opener = screen.getByTestId('opener');
    opener.focus();
    const drawer = await openDrawer();
    const search = within(drawer).getByTestId('materials-drawer-search');
    await waitFor(() => expect(document.activeElement).toBe(search));

    act(() => opener.focus());
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(search);

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(getMaterialsDrawerState().open).toBe(false);
    expect(drawer.getAttribute('data-state')).toBe('closed');
    expect(document.activeElement).toBe(opener);
  });

  it('opens the details from a card and keeps the drawer open when the dialog closes', async () => {
    renderHost();
    const drawer = await openDrawer();
    const details = within(cardFor(drawer, 'item-3')).getByTestId('materials-drawer-details');

    fireEvent.click(details);
    const dialog = await screen.findByTestId('material-detail');
    expect(within(dialog).getByRole('heading', { name: 'Material 3' })).toBeTruthy();

    fireEvent.keyDown(within(dialog).getByTestId('material-detail-close'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('material-detail')).toBeNull());
    expect(getMaterialsDrawerState().open).toBe(true);
    expect(document.activeElement).toBe(details);

    // a click on the card body (not on its actions) opens the same details
    fireEvent.click(within(cardFor(drawer, 'item-4')).getByText('Material 4'));
    expect(await screen.findByTestId('material-detail')).toBeTruthy();
  });
});
