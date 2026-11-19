// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Memories are never deleted from the Personal Agent surfaces either: the 记忆 page, the memory modal and
// the companion inspector offer 归档, and the confirm says where it can be restored. The action keeps its
// route (DELETE /api/pa/memories/:id), which the service now turns into an archive. Those surfaces list only
// memories in use, and editing shows the place and model access as fixed (the service refuses to change them).
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import { paEn, paZh } from '../../../src/i18n/pa';
import { paJa } from '../../../src/i18n/pa-ja';
import { PersonalAgentWorkspace } from '../../../src/fantay/pa/PersonalAgentWorkspace';
import { PaTransportProvider } from '../../../src/fantay/pa/pa-transport';
import { createFixtureTransport } from '../../../src/fantay/pa/lab/fixture-transport';
import { buildFixture } from '../../../src/fantay/pa/lab/fixtures';
import type { PaFixture } from '../../../src/fantay/pa/lab/fixtures';
import type { PaInspectorTab, PaModalState, PaPlace, PaTransport } from '../../../src/fantay/pa/pa-types';
import { Toaster, __resetToastsForTests } from '../../../src/fantay/ui';

// The transcript belongs to another unit.
vi.mock('../../../src/fantay/pa/PaTranscript', () => ({ PaTranscript: () => null }));

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  __resetToastsForTests();
});

function mount(options: {
  place?: PaPlace;
  tab?: PaInspectorTab;
  modal?: PaModalState;
  locale?: 'en' | 'zh-CN';
  tweak?: (fixture: PaFixture) => void;
}) {
  const fixture = buildFixture('companion-chat');
  options.tweak?.(fixture);
  const base = createFixtureTransport(fixture, { latency: 0 });
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const transport: PaTransport = (path = '', method = 'GET', body, signal) => {
    calls.push({ path, method, body });
    return base(path, method, body, signal);
  };
  render(
    <I18nProvider initial={options.locale ?? 'en'}>
      <PaTransportProvider transport={transport}>
        <PersonalAgentWorkspace
          active
          onOpenProject={vi.fn()}
          projects={fixture.projects}
          initialState={{
            ...fixture.ui,
            ...(options.place ? { place: options.place } : {}),
            inspectorOpen: options.tab !== undefined,
            inspectorOpenCompanion: options.tab !== undefined,
            inspectorTab: options.tab ?? 'soul',
            ...(options.modal ? { modal: options.modal } : {}),
          }}
        />
      </PaTransportProvider>
      <Toaster />
    </I18nProvider>,
  );
  return { calls, fixture };
}

const archived = (calls: Array<{ path: string; method: string }>) =>
  calls.filter((call) => call.method === 'DELETE' && call.path.startsWith('/memories/'));

describe('PA memory surfaces archive instead of deleting', () => {
  it('the 记忆 page archives through a confirm that says where to restore it', async () => {
    const { calls } = mount({ place: 'memory' });
    const rows = await screen.findAllByTestId('pa-memory-row');
    const menu = within(rows[0]!).getByRole('button', { name: 'More actions' });
    fireEvent.pointerDown(menu, { button: 0, ctrlKey: false });
    const items = await screen.findByRole('menu');
    expect(items.textContent).not.toMatch(/Delete/);
    await act(async () => {
      fireEvent.click(within(items).getByText('Archive'));
    });

    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Archive this memory?')).toBeTruthy();
    expect(confirm.textContent).toContain('Memory → Archived');
    expect(archived(calls)).toHaveLength(0);
    const before = rows.length;
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(archived(calls)).toHaveLength(1));
    expect(await screen.findByText('Memory archived')).toBeTruthy();
    // The archived memory leaves the list.
    await waitFor(() => expect(screen.getAllByTestId('pa-memory-row')).toHaveLength(before - 1));
    // The link to the Memory Center is translated like the rest of the page.
    expect(screen.getByTestId('pa-open-memory-center').textContent).toContain('Memory Center');
  });

  it('the companion inspector offers 归档 for a remembered memory', async () => {
    const { calls } = mount({ tab: 'memory', locale: 'zh-CN' });
    const remembered = await screen.findByTestId('pa-soul-remembered');
    const row = within(remembered).getAllByTestId('pa-soul-memory')[0]!;
    fireEvent.pointerDown(within(row).getAllByRole('button').at(-1)!, { button: 0, ctrlKey: false });
    const items = await screen.findByRole('menu');
    expect(items.textContent).not.toMatch(/删除/);
    await act(async () => {
      fireEvent.click(within(items).getByText('归档'));
    });
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('归档这条记忆？')).toBeTruthy();
    expect(confirm.textContent).toContain('「记忆」→「已归档」里恢复');
    fireEvent.click(within(confirm).getByRole('button', { name: '归档' }));
    await waitFor(() => expect(archived(calls)).toHaveLength(1));
  });

  it('the memory modal archives instead of deleting', async () => {
    const fixture = buildFixture('companion-chat');
    const memoryId = fixture.snapshot.memories[0]!.id;
    const { calls } = mount({ modal: { kind: 'memory', memoryId } });
    const archive = await screen.findByRole('button', { name: 'Archive' });
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    fireEvent.click(archive);
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain('Memory → Archived');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(archived(calls).map((call) => call.path)).toEqual([`/memories/${encodeURIComponent(memoryId)}`]));
  });

  it('lists only memories in use on the 记忆 page and in the companion inspector', async () => {
    const putAway = (fixture: PaFixture) => {
      for (const memory of fixture.snapshot.memories) {
        if (memory.id === 'mem-xy-tea') memory.status = 'archived';
        if (memory.id === 'mem-xy-moment') memory.status = 'challenged';
      }
    };
    mount({ place: 'memory', locale: 'zh-CN', tweak: putAway });
    const page = await screen.findByTestId('pa-memory-page');
    await within(page).findAllByTestId('pa-memory-row');
    expect(page.textContent).not.toContain('阿树喝茶不加糖。');
    // A memory with an open disagreement is still in use.
    expect(page.textContent).toContain('旧书市集的字该像晒过太阳的纸');
    cleanup();

    mount({ tab: 'memory', locale: 'zh-CN', tweak: putAway });
    const remembered = await screen.findByTestId('pa-soul-remembered');
    expect(within(remembered).getAllByTestId('pa-soul-memory')).toHaveLength(1);
    expect(remembered.textContent).not.toContain('阿树喝茶不加糖');
  });

  it('shows the place and model access as fixed when editing, and saves them unchanged', async () => {
    const { calls, fixture } = mount({ modal: { kind: 'memory', memoryId: 'mem-xy-tea' }, locale: 'zh-CN' });
    const memory = fixture.snapshot.memories.find((entry) => entry.id === 'mem-xy-tea')!;
    const scope = await screen.findByTestId('pa-memory-scope-fixed');
    expect(scope.textContent).toContain('小月');
    expect(screen.getByTestId('pa-memory-data-class-fixed').textContent).toBe('标准');
    expect(document.body.textContent).toContain('编辑不会改变适用范围。要放到别处，请在记忆中心用「复制到…」。');
    // No control offers a move.
    expect(screen.queryByRole('group', { name: '可见范围' })).toBeNull();

    const content = screen.getByDisplayValue('阿树喝茶不加糖。');
    fireEvent.change(content, { target: { value: '阿树喝茶不加糖，也不加奶。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH' && call.path === '/memories/mem-xy-tea')).toBe(true));
    const body = calls.find((call) => call.method === 'PATCH' && call.path === '/memories/mem-xy-tea')!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      content: '阿树喝茶不加糖，也不加奶。',
      scope: memory.scope,
      scopeId: memory.scopeId,
      dataClass: memory.dataClass,
    });
  });

  it('keeps the archive copy in all three languages, without the word delete', () => {
    const keys = [
      'pa.memory.archive',
      'pa.memory.archiveTitle',
      'pa.memory.archiveBody',
      'pa.memory.archived',
      'pa.memory.archivedBody',
      'pa.memory.openCenter',
      'pa.memoryForm.scopeFixed',
      'pa.memoryForm.dataClassFixed',
    ] as const;
    for (const dict of [paEn, paZh, paJa]) {
      for (const key of keys) {
        expect(dict[key]).toBeTruthy();
        expect(dict[key]).not.toMatch(/删除|削除|delet/i);
      }
    }
  });
});
