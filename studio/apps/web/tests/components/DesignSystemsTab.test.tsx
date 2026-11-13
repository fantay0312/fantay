// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { DesignSystemSummary } from '@open-design/contracts';

import { DesignSystemsTab } from '../../src/components/DesignSystemsTab';
import {
  deleteDesignSystemDraft,
  DesignSystemDeleteError,
  fetchDesignSystem,
  updateDesignSystemDraft,
} from '../../src/providers/registry';

const exportMocks = vi.hoisted(() => ({
  downloadDesignSystemArchive: vi.fn(async () => true),
  downloadProjectArchive: vi.fn(async () => false),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchDesignSystem: vi.fn(async (id: string) => ({
      id,
      title: id === 'linear' ? 'Linear' : 'Acme Design System',
      summary: id === 'linear' ? 'Quiet issue-tracker system.' : 'Internal product system.',
      category: id === 'linear' ? 'Productivity & SaaS' : 'Custom',
      body: `# ${id}\n\n## Colors\n- Primary #111111`,
    })),
    updateDesignSystemDraft: vi.fn(async () => null),
    deleteDesignSystemDraft: vi.fn(async () => true),
  };
});

vi.mock('../../src/runtime/exports', () => exportMocks);

const viewTransitions = vi.hoisted(() => [] as string[]);
const transitionsOn = vi.hoisted(() => ({ value: false }));

vi.mock('../../src/runtime/studio-view-transition', () => ({
  studioTransitionsEnabled: () => transitionsOn.value,
  studioViewTransition: (kind: string, update: () => void) => {
    viewTransitions.push(kind);
    update();
  },
}));

afterEach(() => {
  viewTransitions.length = 0;
  transitionsOn.value = false;
  cleanup();
  exportMocks.downloadDesignSystemArchive.mockReset();
  exportMocks.downloadDesignSystemArchive.mockResolvedValue(true);
  exportMocks.downloadProjectArchive.mockReset();
  exportMocks.downloadProjectArchive.mockResolvedValue(false);
  vi.restoreAllMocks();
});

const systems: DesignSystemSummary[] = [
  {
    id: 'user:acme',
    title: 'Acme Design System',
    category: 'Custom',
    summary: 'Internal product system.',
    surface: 'web',
    source: 'user',
    status: 'draft',
    isEditable: true,
    updatedAt: '2026-05-13T03:19:00.000Z',
  },
  {
    id: 'linear',
    title: 'Linear',
    category: 'Productivity & SaaS',
    summary: 'Quiet issue-tracker system.',
    surface: 'web',
    source: 'built-in',
    status: 'published',
    isEditable: false,
  },
];

// The active scope's first row auto-selects into the detail pane, so a title
// can appear twice (row + detail). Scope row lookups to the sidebar list.
function list() {
  return within(screen.getByTestId('design-systems-list'));
}

function openOfficialPresets() {
  fireEvent.click(screen.getByRole('tab', { name: 'Official presets' }));
}

describe('DesignSystemsTab', () => {
  it('renders structured list and preview skeletons while design systems load', () => {
    const { container } = render(
      <DesignSystemsTab
        loading
        systems={[]}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onOpenSystem={() => {}}
      />,
    );

    expect(screen.getByTestId('design-systems-sidebar-skeleton')).toBeTruthy();
    expect(screen.getByTestId('design-systems-preview-skeleton')).toBeTruthy();
    expect(screen.getByTestId('design-systems-loading-row-0')).toBeTruthy();
    expect(screen.getByText('Loading design systems…')).toBeTruthy();
    expect(container.querySelector('.loading-spinner')).toBeNull();
  });

  it('keeps the summary-derived kit visible while the selected system detail resolves', async () => {
    let resolveDetail!: (value: Awaited<ReturnType<typeof fetchDesignSystem>>) => void;
    vi.mocked(fetchDesignSystem).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );
    const { container } = render(
      <DesignSystemsTab
        systems={systems}
        selectedId="user:acme"
        onSelect={() => {}}
        onCreate={() => {}}
        onOpenSystem={() => {}}
      />,
    );

    expect(screen.getByTestId('design-kit-view-user:acme')).toBeTruthy();
    expect(screen.queryByTestId('design-system-detail-loading-user:acme')).toBeNull();
    expect(container.querySelector('.loading-spinner')).toBeNull();

    resolveDetail({
      id: 'user:acme',
      title: 'Acme Design System',
      summary: 'Internal product system.',
      category: 'Custom',
      body: '# Acme\n\n## Colors\n- Primary #111111',
    });
    await screen.findByTestId('design-kit-view-user:acme');
  });

  it('uses design-system scopes directly instead of a design-system/template switcher', () => {
    render(
      <DesignSystemsTab
        systems={systems}
        selectedId="user:acme"
        onSelect={() => {}}
        onCreate={() => {}}
        onOpenSystem={() => {}}
      />,
    );

    expect(screen.queryByRole('tab', { name: 'Design system' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Template' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Your systems' }).textContent).toContain('1');
    expect(screen.getByRole('tab', { name: 'Official presets' }).textContent).toContain('1');
    // #5517 ships three scopes; the Enterprise "coming soon" placeholder is gone.
    expect(screen.queryByRole('tab', { name: 'Enterprise' })).toBeNull();
  });

  it('separates user-created design systems from the official preset library', () => {
    render(
      <DesignSystemsTab
        systems={systems}
        selectedId="user:acme"
        onSelect={() => {}}
        onCreate={() => {}}
        onOpenSystem={() => {}}
      />,
    );

    // "Your systems" is the default scope: Acme shows, Linear (a preset) does not.
    expect(screen.getByTestId('design-systems-create').textContent).toContain('Create');
    expect(screen.getByTestId('design-system-card-user:acme')).toBeTruthy();
    expect(screen.queryByTestId('design-system-card-linear')).toBeNull();

    openOfficialPresets();
    expect(screen.getByTestId('design-system-card-linear')).toBeTruthy();
    expect(list().queryByText('Acme Design System')).toBeNull();
  });

  it('shows the user system scenario (summary) as the row subtitle, not a generic placeholder', () => {
    render(
      <DesignSystemsTab
        systems={systems}
        selectedId="user:acme"
        onSelect={() => {}}
        onCreate={() => {}}
        onOpenSystem={() => {}}
      />,
    );

    // The user row's subtitle now reads the scenario (summary) instead of the
    // repeated "Design system" placeholder it used to show.
    const row = within(screen.getByTestId('design-system-card-user:acme'));
    expect(row.getByText('Internal product system.')).toBeTruthy();
    expect(row.queryByText('Design system')).toBeNull();
  });

  it('routes create and edit actions to the dedicated design-system flow', async () => {
    const onCreate = vi.fn();
    const onOpenSystem = vi.fn();
    render(
      <DesignSystemsTab
        systems={systems}
        selectedId={null}
        onSelect={() => {}}
        onCreate={onCreate}
        onOpenSystem={onOpenSystem}
      />,
    );

    fireEvent.click(screen.getByTestId('design-systems-create'));
    expect(onCreate).toHaveBeenCalledOnce();

    // Acme is the only user system, so it auto-selects into the detail pane,
    // exposing the agent edit action that routes back into the authoring flow.
    fireEvent.click(await screen.findByRole('button', { name: /Edit with agent/i }));
    expect(onOpenSystem).toHaveBeenCalledWith('user:acme');
  });

  it('keeps built-in library systems read-only with the redundant cover removed', async () => {
    const onOpenSystem = vi.fn();
    render(
      <DesignSystemsTab
        systems={systems}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onOpenSystem={onOpenSystem}
      />,
    );

    openOfficialPresets();
    // Linear auto-selects into the read-only detail pane.
    await screen.findByTestId('design-kit-view-linear');
    // A built-in preset is browse-only: no agent edit affordance, and the
    // redundant top showcase cover (with its preview button) has been removed.
    expect(screen.queryByRole('button', { name: /Edit with agent/i })).toBeNull();
    expect(screen.queryByTestId('design-kit-cover-preview')).toBeNull();
    expect(onOpenSystem).not.toHaveBeenCalled();
  });

  it('sets a system as the global default through the detail pane', async () => {
    const onSelect = vi.fn();
    render(
      <DesignSystemsTab
        systems={systems}
        selectedId={null}
        onSelect={onSelect}
        onCreate={() => {}}
        onOpenSystem={() => {}}
      />,
    );

    openOfficialPresets();
    // A preset's only action is a labelled button, not a one-item ⋯ menu.
    fireEvent.click(await screen.findByRole('button', { name: 'Default for new chats' }));
    expect(onSelect).toHaveBeenCalledWith('linear');
    expect(screen.queryByTestId('design-kit-more-actions')).toBeNull();
  });

  it('shows loading and result feedback when publishing a user system', async () => {
    let resolveUpdate!: (value: Awaited<ReturnType<typeof updateDesignSystemDraft>>) => void;
    vi.mocked(updateDesignSystemDraft).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    render(
      <DesignSystemsTab
        systems={systems}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onOpenSystem={() => {}}
      />,
    );

    const toggle = await screen.findByRole('button', { name: 'Draft' });
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Loading…')).toBeTruthy();

    resolveUpdate({
      id: 'user:acme',
      title: 'Acme Design System',
      summary: 'Internal product system.',
      category: 'Custom',
      status: 'published',
      body: '# Acme',
    });

    await waitFor(() => expect(screen.getByText('Done')).toBeTruthy());
  });

  it('leaves the archive to the studio export icon when the system is editable', async () => {
    render(
      <DesignSystemsTab
        systems={systems}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onOpenSystem={() => {}}
      />,
    );

    fireEvent.click(await screen.findByTestId('design-kit-more-actions'));
    expect(screen.queryByRole('menuitem', { name: 'Download design system (.zip + SKILLS.md)' })).toBeNull();
  });

  it('shows loading and result feedback for detail overflow downloads', async () => {
    // A read-only system has no studio export icon, so its menu keeps the download.
    const fetchDetail = vi.mocked(fetchDesignSystem);
    const original = fetchDetail.getMockImplementation();
    fetchDetail.mockImplementation(async (id: string) => ({
      id,
      title: 'Acme Design System',
      summary: 'Internal product system.',
      category: 'Custom',
      body: `# ${id}`,
      canMutate: false,
    }));
    onTestFinished(() => { if (original) fetchDetail.mockImplementation(original); });
    let resolveDownload!: (value: boolean) => void;
    exportMocks.downloadDesignSystemArchive.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveDownload = resolve;
      }),
    );
    render(
      <DesignSystemsTab
        systems={systems}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onOpenSystem={() => {}}
      />,
    );

    // The download item arrives once the detail says the system is read-only.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Export' })).toBeNull());
    fireEvent.click(await screen.findByTestId('design-kit-more-actions'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Download design system (.zip + SKILLS.md)' }));

    expect(screen.getByText('Download design system (.zip + SKILLS.md)')).toBeTruthy();
    resolveDownload(true);

    await waitFor(() => expect(screen.getByText('Done')).toBeTruthy());
  });

  it('explains when a design system delete is denied instead of suggesting a retry', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(deleteDesignSystemDraft).mockRejectedValueOnce(
      new DesignSystemDeleteError(
        'WORKSPACE_RESOURCE_MANAGE_DENIED',
        403,
        'WORKSPACE_RESOURCE_MANAGE_DENIED',
      ),
    );
    render(
      <DesignSystemsTab
        systems={systems}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onOpenSystem={() => {}}
      />,
    );

    fireEvent.click(await screen.findByTestId('design-kit-more-actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Acme Design System' }));

    await waitFor(() => {
      expect(
        screen.getByText('You don\'t have permission to delete this design system.'),
      ).toBeTruthy();
    });
    expect(screen.queryByText('Something went wrong. Please try again.')).toBeNull();
  });
});

// --- #2062: built-in library surface-chip filtering -----------------------

function ds(
  overrides: Partial<DesignSystemSummary> & Pick<DesignSystemSummary, 'id' | 'title'>,
): DesignSystemSummary {
  return {
    id: overrides.id,
    title: overrides.title,
    category: overrides.category ?? 'Uncategorized',
    summary: overrides.summary ?? `${overrides.title} summary`,
    surface: overrides.surface ?? 'web',
  };
}

// Two style categories, each spanning more than one surface, so a style
// filter genuinely narrows every surface count. None set `source`/`isEditable`,
// so they populate the built-in library section the surface chips belong to.
//   Retro:  web x2, image x1   Social: web x1, image x1
const librarySystems: DesignSystemSummary[] = [
  ds({ id: 'retro-web-1', title: 'Retro Web One', category: 'Retro', surface: 'web' }),
  ds({ id: 'retro-web-2', title: 'Retro Web Two', category: 'Retro', surface: 'web' }),
  ds({ id: 'retro-img-1', title: 'Retro Image One', category: 'Retro', surface: 'image' }),
  ds({ id: 'social-web-1', title: 'Social Web One', category: 'Social', surface: 'web' }),
  ds({ id: 'social-img-1', title: 'Social Image One', category: 'Social', surface: 'image' }),
];

function renderTab(items: DesignSystemSummary[] = librarySystems) {
  return render(
    <DesignSystemsTab
      systems={items}
      selectedId={null}
      onSelect={vi.fn()}
    />,
  );
}

// The surface pill renders its label and a `.filter-pill-count` span; read
// the count back by the visible label so assertions describe the UI.
function surfacePillCount(label: string): string | null {
  for (const pill of screen.getAllByRole('tab')) {
    const countEl = pill.querySelector('.filter-pill-count');
    if (!countEl) continue;
    const labelText = (pill.textContent ?? '').replace(countEl.textContent ?? '', '');
    if (labelText === label) return countEl.textContent ?? null;
  }
  return null;
}

// The category filter is the app's custom select: open the trigger, then pick the option.
function selectCategory(value: string) {
  fireEvent.click(screen.getByTestId('design-systems-category-select'));
  fireEvent.click(screen.getByRole('option', { name: value }));
}

describe('DesignSystemsTab surface filtering', () => {
  it('scopes surface pill counts to the selected style category', () => {
    // Regression: nexu-io/open-design#2062 — surface chips kept showing the
    // unfiltered totals after a style category was applied. The counts must
    // describe the filtered result set, otherwise "All 149 / Web 149" is a
    // lie about what the user is looking at.
    renderTab();
    openOfficialPresets();

    expect(surfacePillCount('All')).toBe('5');
    expect(surfacePillCount('Web')).toBe('3');
    expect(surfacePillCount('Image')).toBe('2');

    selectCategory('Retro');

    expect(surfacePillCount('All')).toBe('3');
    expect(surfacePillCount('Web')).toBe('2');
    expect(surfacePillCount('Image')).toBe('1');
  });

  it('keeps the style category when a surface chip refines within it', () => {
    // Regression: nexu-io/open-design#2062 — clicking a surface chip reset
    // the style category to "All", discarding the user's filter instead of
    // refining inside it. The category survives when it still has matches
    // for the chosen surface.
    renderTab();
    openOfficialPresets();
    selectCategory('Retro');

    fireEvent.click(screen.getByRole('tab', { name: /^Web/ }));

    expect(
      (screen.getByTestId('design-systems-category-select') as HTMLButtonElement).value,
    ).toBe('Retro');
    expect(list().getByText('Retro Web One')).toBeTruthy();
    expect(list().getByText('Retro Web Two')).toBeTruthy();
    // A web system from a different category must not leak back in.
    expect(list().queryByText('Social Web One')).toBeNull();
  });

  it('hides a surface chip that has no systems in the selected style category', () => {
    // Consequence of the #2062 fix: a chip whose count drops to zero for the
    // active style category falls away, the same way a globally-empty
    // surface already does — so a chip never advertises an empty result set.
    const webOnlyCategory: DesignSystemSummary[] = [
      ds({ id: 'tools-web-1', title: 'Tools Web One', category: 'Tools', surface: 'web' }),
      ds({ id: 'retro-web-1', title: 'Retro Web One', category: 'Retro', surface: 'web' }),
      ds({ id: 'retro-img-1', title: 'Retro Image One', category: 'Retro', surface: 'image' }),
    ];
    renderTab(webOnlyCategory);
    openOfficialPresets();
    expect(screen.queryByRole('tab', { name: /^Image/ })).not.toBeNull();

    selectCategory('Tools');

    // Tools has only web systems, so the Image chip no longer applies.
    expect(screen.queryByRole('tab', { name: /^Image/ })).toBeNull();
    expect(surfacePillCount('Web')).toBe('1');
  });

  it('keeps the active surface chip visible when a search filters out all of its results', () => {
    // PR #2141 review (Looper): the scoped-count hide rule must never remove
    // the chip the user is currently on. Select Image, then search for text
    // only web systems match — the Image chip must stay, and stay selected,
    // so the active filter is visible instead of an empty list with no chip.
    renderTab();
    openOfficialPresets();
    fireEvent.click(screen.getByRole('tab', { name: /^Image/ }));

    fireEvent.change(screen.getByTestId('design-systems-search'), {
      target: { value: 'Web' },
    });

    const imageTab = screen.queryByRole('tab', { name: /^Image/ });
    expect(imageTab).not.toBeNull();
    expect(imageTab?.getAttribute('aria-selected')).toBe('true');
    // ...and it honestly reports zero matches for the current search.
    expect(surfacePillCount('Image')).toBe('0');
  });
});

describe('DesignSystemsTab rail', () => {
  // jsdom has no layout: give the selected row and scope tab the geometry a browser would.
  function stubSelectionLayout() {
    const measured = (element: HTMLElement) => (
      element.hasAttribute('data-selected-row') || element.getAttribute('aria-selected') === 'true'
    );
    const indexOf = (element: HTMLElement) => [...element.parentElement!.children].indexOf(element);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return measured(this) ? 48 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return measured(this) ? 72 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      return measured(this) ? indexOf(this) * 49 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      return measured(this) ? indexOf(this) * 100 : 0;
    });
  }

  const listMark = () => screen.getByTestId('design-systems-list').firstElementChild as HTMLElement;

  it('shows a neutral monogram for a system without swatches, never invented colours', () => {
    const { container } = renderTab([ds({ id: 'plain', title: '  éclair' })]);
    openOfficialPresets();

    const thumb = screen.getByTestId('design-system-card-plain').firstElementChild!;
    expect(thumb.textContent).toBe('É');
    expect(container.innerHTML).not.toContain('hsl(');
  });

  it('keeps four palette bands for a system with swatches', () => {
    renderTab([{ ...ds({ id: 'tinted', title: 'Tinted' }), swatches: ['#111', '#222', '#333', '#444', '#555'] }]);
    openOfficialPresets();

    const thumb = screen.getByTestId('design-system-card-tinted').firstElementChild!;
    expect(thumb.firstElementChild!.children).toHaveLength(4);
    expect(thumb.textContent).toBe('');
  });

  it('leaves the selection to the row until the sliding mark can be measured', () => {
    renderTab();
    openOfficialPresets();

    expect(listMark().hasAttribute('data-placed')).toBe(false);
    expect(screen.getByTestId('design-system-card-retro-web-1').getAttribute('aria-pressed')).toBe('true');
  });

  it('moves one mark to the selected row and follows filtering', () => {
    stubSelectionLayout();
    renderTab();
    openOfficialPresets();

    expect(listMark().hasAttribute('data-placed')).toBe(true);
    expect(listMark().style.transform).toBe('translateY(49px)');
    expect(listMark().style.height).toBe('48px');

    fireEvent.click(screen.getByTestId('design-system-card-retro-img-1'));
    expect(listMark().style.transform).toBe('translateY(147px)');

    fireEvent.change(screen.getByTestId('design-systems-search'), { target: { value: 'Image' } });
    expect(listMark().style.transform).toBe('translateY(49px)');
  });

  it('slides one underline between the scope tabs', () => {
    stubSelectionLayout();
    renderTab();
    const underline = screen.getByRole('tablist', { name: /source|scope/i }).firstElementChild as HTMLElement;
    expect(underline.style.transform).toBe('translateX(100px)');
    expect(underline.style.width).toBe('72px');

    openOfficialPresets();
    expect(underline.style.transform).toBe('translateX(200px)');
  });

  it('keeps the row fallback until its logo has loaded', () => {
    renderTab([ds({ id: 'airbnb', title: 'Airbnb', category: 'Retro', surface: 'web' }), ...librarySystems]);
    openOfficialPresets();
    const row = screen.getByTestId('design-system-card-airbnb');
    const logo = row.querySelector('img') as HTMLImageElement;
    expect(logo.src).toContain('airbnb.com');
    expect(logo.hasAttribute('data-loaded')).toBe(false);
    // A request still in flight leaves the fallback in the slot.
    expect(logo.previousElementSibling).not.toBeNull();

    Object.defineProperty(logo, 'naturalWidth', { configurable: true, value: 64 });
    fireEvent.load(logo);
    expect(logo.hasAttribute('data-loaded')).toBe(true);
    expect(logo.previousElementSibling).toBeNull();
  });

  it('switches systems at once when transitions are off', () => {
    renderTab();
    openOfficialPresets();
    fireEvent.click(screen.getByTestId('design-system-card-retro-web-2'));
    expect(viewTransitions).toEqual([]);
    expect(screen.getByTestId('design-system-card-retro-web-2').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('design-system-detail-retro-web-2').closest('[aria-hidden]')).toBeNull();
  });

  it('moves the selection on the click and swaps the pages once the next one is ready', async () => {
    transitionsOn.value = true;
    renderTab();
    openOfficialPresets();
    expect(screen.getByTestId('design-system-card-retro-web-2').getAttribute('aria-pressed')).toBe('false');
    // Let the first system of the scope settle into the pane.
    await waitFor(() => expect(document.querySelector('[data-pane-leaving]')).toBeNull());
    viewTransitions.length = 0;

    fireEvent.click(screen.getByTestId('design-system-card-retro-web-2'));
    // The row answers the click in the same render; the page it chose loads out of sight.
    expect(screen.getByTestId('design-system-card-retro-web-2').getAttribute('aria-pressed')).toBe('true');
    const pending = screen.getByTestId('design-system-detail-retro-web-2').closest('[aria-hidden]');
    expect(pending).not.toBeNull();
    expect(pending!.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('[data-pane-leaving]')).not.toBeNull();

    await waitFor(() => expect(viewTransitions).toEqual(['swap']));
    expect(screen.getByTestId('design-system-detail-retro-web-2').closest('[aria-hidden]')).toBeNull();
    expect(document.querySelector('[data-pane-leaving]')).toBeNull();

    // Clicking the row that is already open swaps nothing.
    fireEvent.click(screen.getByTestId('design-system-card-retro-web-2'));
    expect(document.querySelector('[data-pane-leaving]')).toBeNull();
    expect(viewTransitions).toEqual(['swap']);
  });

  it('opens a focused preset in the official scope', () => {
    window.sessionStorage.setItem('od:focus-design-system', 'linear');
    renderTab(systems);
    expect(screen.getByRole('tab', { name: 'Official presets' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('design-system-detail-linear')).toBeTruthy();
  });

  it('shows the first row of a new scope in the same render as the switch', () => {
    renderTab(systems);
    openOfficialPresets();
    expect(screen.getByTestId('design-system-card-linear').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('design-system-detail-linear')).toBeTruthy();
  });

  it('keeps both panes when a search empties your systems, with a way back', () => {
    renderTab(systems);
    fireEvent.change(screen.getByTestId('design-systems-search'), { target: { value: 'nothing here' } });

    expect(screen.getByTestId('design-systems-empty').textContent).toContain('No design systems match');
    expect(screen.queryByText('Create your first design system')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByTestId('design-system-card-user:acme')).toBeTruthy();
  });
});
