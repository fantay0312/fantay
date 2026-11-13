// @vitest-environment jsdom
//
// 「从素材库添加」 in the project composer's "+" menu: the picker applies
// non-website picks through POST /api/materials/items/:id/apply and stages the
// returned project paths as attachment chips (like "Select from library");
// website records — and every pick under 「插入参考包」 — become a markdown
// reference packet inserted into the editor. No project id → no entry.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invalidateSpy = vi.hoisted(() => vi.fn());

vi.mock('../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/registry')>();
  return {
    ...actual,
    invalidateProjectFilesCache: (...args: Parameters<typeof actual.invalidateProjectFilesCache>) => {
      invalidateSpy(...args);
      actual.invalidateProjectFilesCache(...args);
    },
  };
});

import { ChatComposer } from '../../src/components/ChatComposer';
import { I18nProvider } from '../../src/i18n';
import { composerText } from '../helpers/lexical-composer';
import {
  MockIntersectionObserver,
  WEBSITE_ITEM,
  makeItem,
  materialsFetch,
  summaryResponse,
  type MaterialsFetchOptions,
} from './materials/fixtures';

let calls: ReturnType<typeof materialsFetch>['calls'];

const ITEMS = [makeItem(0), makeItem(1), WEBSITE_ITEM];

function renderComposer(
  overrides: Partial<ComponentProps<typeof ChatComposer>> = {},
  options: MaterialsFetchOptions = {},
) {
  const mock = materialsFetch({
    items: ITEMS,
    summary: summaryResponse({
      total: 3,
      kinds: { component: 1, svg: 1, website: 1 },
      categories: { 交互组件: 1, 'SVG 图标': 1, 收藏网站: 1 },
    }),
    ...options,
  });
  calls = mock.calls;
  vi.stubGlobal('fetch', vi.fn(mock.handler));
  return render(
    <I18nProvider initial="en">
      <ChatComposer
        projectId="project-1"
        projectFiles={[]}
        streaming={false}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        {...overrides}
      />
    </I18nProvider>,
  );
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openPicker() {
  await flush();
  fireEvent.click(screen.getByTestId('chat-plus-trigger'));
  fireEvent.click(await screen.findByTestId('composer-plus-materials'));
  const picker = await screen.findByTestId('material-picker');
  await within(picker).findByTestId('material-picker-grid');
  return picker;
}

function pick(picker: HTMLElement, id: string) {
  const card = within(picker)
    .getAllByTestId('material-picker-card')
    .find((candidate) => candidate.getAttribute('data-material-id') === id);
  if (!card) throw new Error(`no picker card ${id}`);
  fireEvent.click(card);
  expect(card.getAttribute('aria-pressed')).toBe('true');
}

function applyCalls() {
  return calls.filter((call) => call.method === 'POST' && call.url.endsWith('/apply') && call.url.includes('/api/materials/'));
}

beforeEach(() => {
  invalidateSpy.mockClear();
  MockIntersectionObserver.reset();
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ChatComposer — add from materials', () => {
  it('applies file materials and stages the returned paths as attachment chips', async () => {
    renderComposer();
    const picker = await openPicker();
    pick(picker, 'item-0');
    pick(picker, 'item-1');
    expect(within(picker).getByTestId('material-picker-selected').textContent).toBe('2 selected');
    fireEvent.click(within(picker).getByTestId('material-picker-confirm'));

    await waitFor(() => expect(screen.queryByTestId('material-picker')).toBeNull());
    expect(applyCalls().map((call) => [call.url, call.body])).toEqual([
      ['/api/materials/items/item-0/apply', { projectId: 'project-1' }],
      ['/api/materials/items/item-1/apply', { projectId: 'project-1' }],
    ]);
    const staged = await screen.findByTestId('staged-attachments');
    // Thumbnails stage as image chips (previewing the project copy), entries
    // as document chips — two of each for two applied materials.
    await waitFor(() => expect(within(staged).getAllByTestId('staged-attachment-image')).toHaveLength(2));
    const images = within(staged)
      .getAllByTestId('staged-attachment-image')
      .map((chip) => chip.querySelector('img')?.getAttribute('src') ?? '');
    expect(images[0]).toMatch(/item-0.*thumbnail\.png/);
    expect(images[1]).toMatch(/item-1.*thumbnail\.png/);
    expect(within(staged).getAllByRole('button', { name: 'Preview thumbnail.png' })).toHaveLength(2);
    expect((staged.textContent ?? '').match(/index\.tsx/g)).toHaveLength(2);
    // The daemon wrote into the project, so its file-list cache is dropped
    // (as the upload path does) — once for the batch.
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy.mock.calls[0]?.[0]).toBe('project-1');
    // No packet was requested for plain file materials.
    expect(calls.some((call) => call.url === '/api/materials/context')).toBe(false);
  });

  it('inserts a reference packet for website records instead of copying them', async () => {
    renderComposer();
    const picker = await openPicker();
    pick(picker, 'site-linear');
    expect(within(picker).getByText(/Websites are bookmarks/)).toBeTruthy();
    fireEvent.click(within(picker).getByTestId('material-picker-confirm'));

    await waitFor(() => expect(composerText()).toContain('# Reference packet'));
    expect(composerText()).toContain('- site-linear');
    expect(applyCalls()).toHaveLength(0);
    const contextCall = calls.find((call) => call.url === '/api/materials/context');
    expect(contextCall?.body).toEqual({ ids: ['site-linear'] });
    expect(screen.queryByTestId('staged-attachments')).toBeNull();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('inserts one packet for every pick with 插入参考包', async () => {
    renderComposer();
    const picker = await openPicker();
    pick(picker, 'item-0');
    pick(picker, 'site-linear');
    fireEvent.click(within(picker).getByTestId('material-picker-packet'));

    await waitFor(() => expect(composerText()).toContain('- item-0'));
    expect(composerText()).toContain('- site-linear');
    expect(applyCalls()).toHaveLength(0);
  });

  it('surfaces apply failures through the composer hint', async () => {
    renderComposer({}, { failApply: new Set(['item-1']) });
    const picker = await openPicker();
    pick(picker, 'item-0');
    pick(picker, 'item-1');
    fireEvent.click(within(picker).getByTestId('material-picker-confirm'));

    await screen.findByText('Added 1 item(s); 1 failed (item-1 cannot be copied).');
    expect((await screen.findByTestId('staged-attachments')).textContent).toContain('index.tsx');
  });

  it('hides the entry when the composer has no project', async () => {
    renderComposer({ projectId: null });
    await flush();
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    await screen.findByTestId('composer-plus-attach');
    expect(screen.queryByTestId('composer-plus-materials')).toBeNull();
  });
});
