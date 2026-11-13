// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MaterialLibrary } from '@open-design/contracts';
import { MaterialsView } from '../../src/components/materials/MaterialsView';
import { I18nProvider } from '../../src/i18n';
import { makeItem, MockIntersectionObserver, summaryResponse } from './materials/fixtures';

beforeEach(() => { localStorage.clear(); MockIntersectionObserver.reset(); vi.stubGlobal('IntersectionObserver', MockIntersectionObserver); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('adds folders, switches global/single-library views, restores selection and removes only the connection', async () => {
  let libraries: MaterialLibrary[] = [];
  const calls: { method: string; path: string; scope: string | null }[] = [];
  let nextFolder: string | null = '/first';
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    const method = init?.method ?? 'GET';
    const scope = url.searchParams.get('libraryId');
    calls.push({ method, path: url.pathname, scope });
    if (url.pathname === '/api/dialog/open-folder') return json({ path: nextFolder });
    if (url.pathname === '/api/materials/libraries' && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      const library: MaterialLibrary = { id: `library_${body.root.slice(1)}`, name: body.root.slice(1), root: body.root,
        total: 1, status: { enabled: true, root: body.root, rootSource: 'selected' } };
      libraries.push(library);
      return json({ library });
    }
    if (url.pathname.startsWith('/api/materials/libraries/') && method === 'DELETE') {
      libraries = libraries.filter((library) => !url.pathname.endsWith(library.id));
      return json({ ok: true });
    }
    const selected = libraries.filter((library) => !scope || scope === library.id);
    if (url.pathname === '/api/materials/summary') return json(summaryResponse({
      libraryId: scope ?? '', libraries: [...libraries], total: selected.length,
      status: { enabled: selected.length > 0, root: null, rootSource: null, reason: 'not-configured' },
    }));
    if (url.pathname === '/api/materials/items') {
      const items = selected.map((library) => makeItem(1, { id: `${library.id}:same-record`, libraryId: library.id,
        libraryName: library.name, title: library.name }));
      return json({ query: '', total: items.length, offset: 0, returned: items.length, nextOffset: null, items });
    }
    throw new Error(`Unexpected request: ${method} ${input}`);
  }));
  const content = <I18nProvider initial="en"><MaterialsView isActive /></I18nProvider>;
  const view = render(content);
  await screen.findByTestId('materials-unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Add library' }));
  expect((await screen.findByTestId('material-card')).textContent).toContain('first');
  expect((screen.getByTestId('materials-library-scope') as HTMLSelectElement).value).toBe('library_first');

  nextFolder = '/second';
  fireEvent.click(screen.getByRole('button', { name: 'Add library' }));
  await waitFor(() => expect((screen.getByTestId('materials-library-scope') as HTMLSelectElement).value).toBe('library_second'));
  await waitFor(() => expect(screen.getAllByTestId('material-card')).toHaveLength(1));
  expect(screen.getByTestId('material-card').textContent).toContain('second');
  view.unmount(); render(content);
  await screen.findByTestId('materials-grid');
  expect((screen.getByTestId('materials-library-scope') as HTMLSelectElement).value).toBe('library_second');
  // The scope control is the app's Select (combobox + listbox), not a native <select>.
  fireEvent.click(screen.getByTestId('materials-library-scope'));
  fireEvent.click(screen.getByRole('option', { name: 'All libraries' }));
  expect((screen.getByTestId('materials-library-scope') as HTMLButtonElement).value).toBe('');
  await waitFor(() => expect(screen.getAllByTestId('material-card')).toHaveLength(2));
  fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove first' }));
  await waitFor(() => expect(screen.getAllByTestId('material-card')).toHaveLength(1));
  expect(calls.some((call) => call.path === '/api/materials/items' && call.scope === 'library_second')).toBe(true);
  expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/api/materials/libraries/library_first']);

  nextFolder = null;
  fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
  // Manage opens a modal; its folder-picker button is the one titled "Add library"
  // (the submit button beside it is for a typed path).
  const pickFolder = within(await screen.findByTestId('materials-library-manager')).getByTitle('Add library');
  fireEvent.click(pickFolder);
  await waitFor(() => expect(pickFolder).not.toBeDisabled());
  expect(calls.filter((call) => call.method === 'POST' && call.path === '/api/materials/libraries')).toHaveLength(2);
});
