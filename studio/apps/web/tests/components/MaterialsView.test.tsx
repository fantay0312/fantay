// @vitest-environment jsdom
//
// 素材库 view against the materials contract with a mocked daemon: the
// unavailable / failed states, results + inventory, an empty search, the
// infinite-scroll append (no pagination UI), and the detail dialog's
// open → Escape → focus-back loop.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MaterialsView } from '../../src/components/materials/MaterialsView';
import { I18nProvider } from '../../src/i18n';
import {
  MockIntersectionObserver,
  makeItem,
  materialsFetch,
  summaryResponse,
  type MaterialsFetchOptions,
} from './materials/fixtures';

let calls: ReturnType<typeof materialsFetch>['calls'];

function setup(options: MaterialsFetchOptions = {}, locale: 'en' | 'zh-CN' = 'en') {
  const mock = materialsFetch(options);
  calls = mock.calls;
  vi.stubGlobal('fetch', vi.fn(mock.handler));
  return render(
    <I18nProvider initial={locale}>
      <MaterialsView isActive />
    </I18nProvider>,
  );
}

function itemRequests() {
  return calls
    .filter((call) => call.url.startsWith('/api/materials/items') && !/\/items\/[^?]/.test(call.url))
    .map((call) => new URL(call.url, 'http://localhost').searchParams);
}

beforeEach(() => {
  localStorage.clear();
  MockIntersectionObserver.reset();
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MaterialsView', () => {
  it('offers folder selection when the daemon reports the library disabled', async () => {
    setup({
      summary: summaryResponse({
        status: {
          enabled: false,
          root: '/Users/me/fantay-design/素材库',
          rootSource: 'sibling',
          reason: 'missing-root',
          message: 'Library root does not exist',
        },
        total: 0,
        categories: {},
        kinds: {},
        collections: {},
      }),
    });

    const panel = await screen.findByTestId('materials-unavailable');
    expect(panel.textContent).toContain('Material library not found');
    expect(panel.textContent).not.toContain('FANTASY_DESIGN_LIBRARY');
    expect(screen.getByRole('button', { name: 'Add library' })).toBeTruthy();
    expect(panel.textContent).toContain('automatically');
    expect(panel.textContent).toContain('The library folder does not exist.');
    expect(panel.textContent).toContain('/Users/me/fantay-design/素材库');
    // A disabled library is never searched.
    expect(itemRequests()).toHaveLength(0);
    expect(screen.queryByTestId('materials-grid')).toBeNull();
  });

  it('shows a retryable error when the daemon route is missing', async () => {
    setup({ summary: { status: 404, body: { error: 'Not found' } } });

    const error = await screen.findByTestId('materials-error');
    expect(error.textContent).toContain('Could not load materials');
    expect(error.textContent).toContain('Not found');
    const summaryCalls = () => calls.filter((call) => call.url === '/api/materials/summary').length;
    expect(summaryCalls()).toBe(1);
    fireEvent.click(within(error).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(summaryCalls()).toBe(2));
  });

  it('renders the inventory, the first batch of 24 and announces the count', async () => {
    setup();

    const grid = await screen.findByTestId('materials-grid');
    expect(within(grid).getAllByTestId('material-card')).toHaveLength(24);
    expect(screen.getByTestId('materials-inventory').textContent).toContain(
      '60 items · 2 categories · 2 collections',
    );
    expect(screen.getByTestId('materials-live').textContent).toBe('60 results');
    expect(screen.getByTestId('materials-live').getAttribute('aria-live')).toBe('polite');
    // No pagination UI anywhere: no page buttons, no "next".
    expect(screen.queryByRole('button', { name: /next|previous|page/i })).toBeNull();
    const first = itemRequests()[0]!;
    expect(first.get('limit')).toBe('24');
    expect(first.get('offset')).toBeNull();

    // Thumbnail when indexed (lazy), typographic cover otherwise.
    const cards = within(grid).getAllByTestId('material-card');
    const withThumb = cards[0]!.querySelector('img');
    expect(withThumb?.getAttribute('loading')).toBe('lazy');
    expect(withThumb?.getAttribute('src')).toBe('/api/materials/items/item-0/thumbnail');
    expect(cards[1]!.querySelector('img')).toBeNull();
    expect(cards[1]!.querySelector('[data-cover="type"]')?.textContent).toContain('Material 1');
  });

  it('appends the next batch when the sentinel scrolls into view, then stops at the end', async () => {
    setup();
    await screen.findByTestId('materials-grid');

    act(() => MockIntersectionObserver.intersectAll());
    await waitFor(() => expect(screen.getAllByTestId('material-card')).toHaveLength(48));
    expect(itemRequests()[1]!.get('offset')).toBe('24');

    act(() => MockIntersectionObserver.intersectAll());
    await waitFor(() => expect(screen.getAllByTestId('material-card')).toHaveLength(60));
    expect(itemRequests()[2]!.get('offset')).toBe('48');
    await screen.findByText('All 60 shown');

    // Nothing left: further intersections do not request again.
    const before = itemRequests().length;
    act(() => MockIntersectionObserver.intersectAll());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(itemRequests()).toHaveLength(before);
  });

  it('searches after the debounce and shows the empty state with a reset', async () => {
    setup();
    await screen.findByTestId('materials-grid');

    fireEvent.change(screen.getByTestId('materials-search'), { target: { value: 'zzz-no-hit' } });
    const empty = await screen.findByTestId('materials-empty');
    expect(empty.textContent).toContain('No materials match.');
    expect(itemRequests().at(-1)!.get('q')).toBe('zzz-no-hit');
    expect(screen.getByTestId('materials-live').textContent).toBe('0 results');

    fireEvent.click(within(empty).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getAllByTestId('material-card')).toHaveLength(24));
  });

  it('renders Level 1 Hairline Tabs for business categories and never physical formats', async () => {
    setup({
      summary: summaryResponse({
        categories: {
          '交互组件': 20,
          '设计 Skill': 10,
          '图像创作': 8,
          '视频创作': 6,
          '收藏网站': 15,
          '风格参考': 5,
          'SVG 图标': 12,
          '页面模板': 4,
          '参考资料': 3,
        },
        kinds: { component: 20, skill: 16, website: 15, svg: 12, style: 5, html: 1, markdown: 1, file: 36 },
      }),
    });

    const tabStrip = await screen.findByTestId('materials-category-tabs');
    expect(tabStrip).toBeTruthy();

    const businessCategories = [
      '全部',
      '组件',
      '设计 Skill',
      '图像创作',
      '视频创作',
      '收藏网站',
      '风格参考',
      'SVG 图标',
      '模板与资料',
    ];
    for (const cat of businessCategories) {
      expect(within(tabStrip).getByRole('tab', { name: new RegExp(cat) })).toBeTruthy();
    }

    // Strictly assert physical file formats are NEVER exposed as tabs
    expect(within(tabStrip).queryByRole('tab', { name: /html/i })).toBeNull();
    expect(within(tabStrip).queryByRole('tab', { name: /markdown/i })).toBeNull();
    expect(within(tabStrip).queryByRole('tab', { name: /file|文件/i })).toBeNull();

    // Initial active tab is 全部
    const allTab = within(tabStrip).getByRole('tab', { name: /全部/ });
    expect(allTab.getAttribute('aria-selected')).toBe('true');
  });

  it('dynamically reveals 9 design system subcategories when 组件 tab is selected', async () => {
    setup();
    const tabStrip = await screen.findByTestId('materials-category-tabs');
    const compTab = within(tabStrip).getByRole('tab', { name: /组件/ });
    fireEvent.click(compTab);

    const sectionBar = await screen.findByTestId('materials-section-capsules');
    const expectedSubcategories = [
      '全部',
      '操作',
      '输入',
      '导航',
      '浮层',
      '数据展示',
      '反馈',
      '布局',
      '动效视觉',
      'Agent/AI 组件',
    ];
    for (const sub of expectedSubcategories) {
      expect(within(sectionBar).getByRole('button', { name: new RegExp(sub) })).toBeTruthy();
    }

    // Clicking a micro-capsule updates the section filter
    const inputCapsule = within(sectionBar).getByRole('button', { name: /输入/ });
    fireEvent.click(inputCapsule);
    expect(inputCapsule.getAttribute('aria-pressed')).toBe('true');

    // Toggle off: clicking again returns to all
    fireEvent.click(inputCapsule);
    expect(inputCapsule.getAttribute('aria-pressed')).toBe('false');
  });

  it('resets section filter when switching categories to prevent 0-hit deadlocks', async () => {
    setup();
    const tabStrip = await screen.findByTestId('materials-category-tabs');

    // Select 组件 -> 输入
    fireEvent.click(within(tabStrip).getByRole('tab', { name: /组件/ }));
    const sectionBar = await screen.findByTestId('materials-section-capsules');
    const inputCapsule = within(sectionBar).getByRole('button', { name: /输入/ });
    fireEvent.click(inputCapsule);
    expect(inputCapsule.getAttribute('aria-pressed')).toBe('true');

    // Switch to SVG 图标
    fireEvent.click(within(tabStrip).getByRole('tab', { name: /SVG 图标/ }));
    await waitFor(() => {
      const lastReq = itemRequests().at(-1)!;
      expect(lastReq.get('category')).toBe('SVG 图标');
    });
    // Verify no section deadlock: active section is reset to empty ('全部')
    const resetSectionBar = screen.queryByTestId('materials-section-capsules');
    if (resetSectionBar) {
      const allCapsule = within(resetSectionBar).getByRole('button', { name: /全部/ });
      expect(allCapsule.getAttribute('aria-pressed')).toBe('true');
    }
  });

  it('filters items with search query within active category and section', async () => {
    setup();
    const tabStrip = await screen.findByTestId('materials-category-tabs');
    fireEvent.click(within(tabStrip).getByRole('tab', { name: /SVG 图标/ }));

    const searchInput = screen.getByTestId('materials-search');
    fireEvent.change(searchInput, { target: { value: 'Material 0' } });

    await waitFor(() => {
      const lastReq = itemRequests().at(-1)!;
      expect(lastReq.get('category')).toBe('SVG 图标');
      expect(lastReq.get('q')).toBe('Material 0');
    });
  });

  it('renders archetype-specific card elements for Component, Skill, Multimedia, Website, and Style', async () => {
    setup({
      items: [
        makeItem(1, { id: 'c-1', title: 'Button Component', kind: 'component', category: '交互组件', tags: ['TypeScript', '已校验'] }),
        makeItem(2, { id: 's-1', title: 'Hairline Create', kind: 'skill', category: '设计 Skill', description: 'npx hairline-create' }),
        makeItem(3, { id: 'm-1', title: 'Ink Cinema Prompt', kind: 'video', category: '视频创作', description: '8k ink render 18 套提示词' }),
        makeItem(4, { id: 'w-1', title: 'Mobbin', kind: 'website', category: '收藏网站', source: 'https://mobbin.com' }),
        makeItem(5, { id: 'st-1', title: 'Paper Ink', kind: 'style', category: '风格参考', palette: [{ name: 'Ink', value: '#202020' }] }),
      ],
      summary: summaryResponse({
        total: 5,
        categories: { '交互组件': 1, '设计 Skill': 1, '视频创作': 1, '收藏网站': 1, '风格参考': 1 },
      }),
    });

    const grid = await screen.findByTestId('materials-grid');
    const cards = within(grid).getAllByTestId('material-card');

    // 1. Component card: archetype badge & preview action button
    const compCard = cards.find((el) => el.getAttribute('data-material-id') === 'c-1')!;
    expect(compCard.getAttribute('data-archetype')).toBe('component');
    expect(within(compCard).getByRole('button', { name: /预览组件/ })).toBeTruthy();

    // 2. Skill card: archetype badge & monospace command / copy button
    const skillCard = cards.find((el) => el.getAttribute('data-material-id') === 's-1')!;
    expect(skillCard.getAttribute('data-archetype')).toBe('skill');
    expect(skillCard.textContent).toContain('/nmem-skill-load');
    expect(within(skillCard).getByRole('button', { name: /复制/ })).toBeTruthy();

    // 3. Multimedia card: archetype badge & prompt badge
    const mediaCard = cards.find((el) => el.getAttribute('data-material-id') === 'm-1')!;
    expect(mediaCard.getAttribute('data-archetype')).toBe('multimedia');

    // 4. Website card: archetype badge, domain & external link
    const siteCard = cards.find((el) => el.getAttribute('data-material-id') === 'w-1')!;
    expect(siteCard.getAttribute('data-archetype')).toBe('website');
    expect(siteCard.textContent).toContain('mobbin.com');
    const extLink = siteCard.querySelector('a');
    expect(extLink?.getAttribute('href')).toBe('https://mobbin.com/');

    // 5. Style card: archetype badge & swatches
    const styleCard = cards.find((el) => el.getAttribute('data-material-id') === 'st-1')!;
    expect(styleCard.getAttribute('data-archetype')).toBe('style');
    expect(styleCard.querySelector('[title="Ink: #202020"]')).toBeTruthy();
  });

  it('focuses search on "/" unless the user is typing elsewhere', async () => {
    setup();
    await screen.findByTestId('materials-grid');
    const search = screen.getByTestId('materials-search');

    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(search);

    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    fireEvent.keyDown(other, { key: '/' });
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it('opens the detail dialog, closes it on Escape and returns focus to the card', async () => {
    setup();
    const grid = await screen.findByTestId('materials-grid');
    const card = within(grid).getAllByTestId('material-card')[1]!;
    card.focus();
    fireEvent.click(card);

    const dialog = await screen.findByTestId('material-detail');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Material 1' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId('material-detail-close'));
    expect(dialog.textContent).toContain('MIT · Example');
    // Full record arrives: file list with copy buttons, missing file flagged.
    const files = await within(dialog).findByTestId('material-detail-files');
    expect(within(files).getAllByRole('button', { name: /Copy the path of/ })).toHaveLength(2);
    expect(files.textContent).toContain('Missing');
    expect(dialog.textContent).toContain('#87ea5c');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('material-detail')).toBeNull());
    expect(document.activeElement).toBe(card);
  });

  it('copies the reference packet from the detail dialog', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    setup();
    const grid = await screen.findByTestId('materials-grid');
    fireEvent.click(within(grid).getAllByTestId('material-card')[0]!);
    const dialog = await screen.findByTestId('material-detail');

    fireEvent.click(within(dialog).getByTestId('material-detail-copy-packet'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Reference packet\n\n- item-0'));
    const contextCall = calls.find((call) => call.url === '/api/materials/context');
    expect(contextCall?.method).toBe('POST');
    expect(contextCall?.body).toEqual({ ids: ['item-0'] });

    await waitFor(() => expect(within(dialog).getByTestId('material-detail-copy-entry')).not.toBeDisabled());
    fireEvent.click(within(dialog).getByTestId('material-detail-copy-entry'));
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith('/library/素材库/SVG 图标/item-0/index.tsx'),
    );
  });

  it('links website sources with rel=noopener and shows the reading state', async () => {
    setup({
      items: [
        makeItem(0, {
          id: 'site-a',
          title: 'Site A',
          kind: 'website',
          source: 'https://example.com/a',
          useStatus: '待阅读',
          thumbnailUrl: null,
        }),
      ],
      summary: summaryResponse({ total: 1, kinds: { website: 1 }, categories: { 收藏网站: 1 } }),
    });
    const grid = await screen.findByTestId('materials-grid');
    const card = within(grid).getByTestId('material-card');
    // Typographic cover names the host.
    expect(card.querySelector('[data-cover="type"]')?.textContent).toContain('example.com');
    fireEvent.click(card);
    const link = await screen.findByTestId('material-detail-source');
    expect(link.getAttribute('href')).toBe('https://example.com/a');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.getByTestId('material-detail').textContent).toContain('Reading state: 待阅读');
  });

  it('renders Chinese copy in zh-CN', async () => {
    setup({}, 'zh-CN');
    await screen.findByTestId('materials-grid');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('素材库');
    expect(screen.getByTestId('materials-inventory').textContent).toContain('共 60 项 · 2 个分类 · 2 个合集');
    // The index date follows the app locale, not the browser's.
    expect(screen.getByTestId('materials-inventory').textContent).toContain('2026年10月25日');
    expect(screen.getByTestId('materials-live').textContent).toBe('60 个结果');
  });

  it('says "1 result" for a single hit', async () => {
    setup({ items: [makeItem(0)] });
    await screen.findByTestId('materials-grid');
    expect(screen.getByTestId('materials-live').textContent).toBe('1 result');
  });

  it('closes the detail dialog when the view is hidden (Back, rail or tab)', async () => {
    const view = setup();
    const grid = await screen.findByTestId('materials-grid');
    fireEvent.click(within(grid).getAllByTestId('material-card')[0]!);
    await screen.findByTestId('material-detail');
    view.rerender(
      <I18nProvider initial="en">
        <MaterialsView isActive={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId('material-detail')).toBeNull());
  });

  it('fetches nothing until the view is first shown', async () => {
    const mock = materialsFetch();
    const fetchMock = vi.fn(mock.handler);
    vi.stubGlobal('fetch', fetchMock);
    const view = render(
      <I18nProvider initial="en">
        <MaterialsView isActive={false} />
      </I18nProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled();
    view.rerender(
      <I18nProvider initial="en">
        <MaterialsView isActive />
      </I18nProvider>,
    );
    await screen.findByTestId('materials-grid');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('opens detail on card Enter/Space while isolating inner card actions and avoiding button nesting', async () => {
    setup(
      {
        items: [
          makeItem(1, { id: 's-1', title: 'Hairline Create', kind: 'skill', category: '设计 Skill' }),
          makeItem(2, { id: 'w-1', title: 'Linear App', kind: 'website', category: '收藏网站', source: 'https://linear.app' }),
        ],
        summary: summaryResponse({ total: 2 }),
      },
      'zh-CN',
    );
    const grid = await screen.findByTestId('materials-grid');
    const cards = within(grid).getAllByTestId('material-card');
    for (const card of cards) {
      expect(card.tagName.toLowerCase()).toBe('div');
      expect(card.getAttribute('role')).toBe('button');
      expect(card.closest('button')).toBeNull();
    }

    const skillCard = cards.find((c) => c.getAttribute('data-material-id') === 's-1')!;
    const copyBtn = within(skillCard).getByRole('button', { name: /复制/ });
    fireEvent.click(copyBtn);
    copyBtn.focus();
    fireEvent.keyDown(copyBtn, { key: 'Enter' });
    fireEvent.keyDown(copyBtn, { key: ' ' });
    expect(screen.queryByTestId('material-detail')).toBeNull();

    const siteCard = cards.find((c) => c.getAttribute('data-material-id') === 'w-1')!;
    fireEvent.click(within(siteCard).getByRole('link', { name: /在浏览器中打开/ }));
    expect(screen.queryByTestId('material-detail')).toBeNull();

    fireEvent.keyDown(skillCard, { key: 'ArrowDown' });
    expect(screen.queryByTestId('material-detail')).toBeNull();
    fireEvent.keyDown(skillCard, { key: 'Enter' });
    expect(await screen.findByTestId('material-detail')).toBeTruthy();
  });
});
