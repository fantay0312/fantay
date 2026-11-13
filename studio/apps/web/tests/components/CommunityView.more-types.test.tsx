// @vitest-environment jsdom
//
// OPEND-3098 / OPEND-3118: the Community filter row is a FIXED list in Home
// order — 原型 / 动效设计 / 幻灯片 / 文档 / 图片 / HyperFrames / WebGL / 实时产物 /
// 视频 / 音频 — all on the row itself (per product: 更多也展开，又不是占不下),
// whether or not the catalogue has that kind yet (an empty kind shows the empty
// state, it is not hidden). Document and WebGL templates are classified out of
// the plugin catalogue like every other kind, so their tabs grid the bundled
// examples instead of sitting empty.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommunityView } from '../../src/components/CommunityView';
import { orderedCreateChips } from '../../src/components/home-hero/chips';
import { Icon } from '../../src/components/Icon';

vi.mock('../../src/analytics/provider', () => ({
  useAnalytics: () => ({ track: vi.fn() }),
}));

function plugin(id: string, title: string, manifest: Record<string, unknown>) {
  return {
    id,
    title,
    version: '1.0.0',
    trust: 'bundled' as const,
    sourceKind: 'bundled' as const,
    source: `/plugins/_official/examples/${id}`,
    manifest: { name: id, title, ...manifest },
  };
}

const LANDING = plugin('example-landing-prototype', 'SaaS Landing Page', {
  tags: ['landing'],
  od: { mode: 'prototype', preview: { type: 'html', entry: './example.html' } },
});
// The bundled résumé example: a prototype-mode plugin whose tags name a
// document. It used to fall into 原型 → 文档 / 报告 and leave 文档 empty.
const RESUME = plugin('example-resume-modern', 'Modern Résumé', {
  tags: ['example', 'prototype', 'personal', 'resume', 'cv'],
  od: { mode: 'prototype', preview: { type: 'html', entry: './example.html' } },
});
const DOCS_PAGE = plugin('example-docs-page', 'Docs Page', {
  tags: ['example', 'prototype', 'engineering', 'docs', 'documentation', 'guide'],
  od: { mode: 'prototype', preview: { type: 'html', entry: './example.html' } },
});
// A bundled WebGL example: prototype-mode plus the webgl / shader tags.
const NEON_GRID = plugin('example-webgl-neon-grid', 'Neon Grid', {
  tags: ['example', 'prototype', 'web', 'webgl', 'webgl2', 'shader', 'gpu'],
  od: { mode: 'prototype', preview: { type: 'html', entry: './example.html' } },
});

let fetchMock: ReturnType<typeof vi.fn>;

function serveCatalogue(plugins: unknown[]) {
  fetchMock = vi.fn(async (url: unknown) => {
    if (url === '/api/plugins') {
      return new Response(JSON.stringify({ plugins }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function inlineTabs(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll('.community-template-view__type-tabs > button.home-hero__type-pill'),
  ) as HTMLButtonElement[];
}

function cards(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.community-template-grid .community-template-card')) as HTMLElement[];
}

describe('CommunityView — every kind is a fixed tab (OPEND-3098)', () => {
  it('keeps Motion design permanently second and lists every kind in Home order, even with none published', async () => {
    serveCatalogue([LANDING]);
    render(<CommunityView />);
    await waitFor(() => expect(cards().length).toBe(1));

    expect(inlineTabs().map((tab) => tab.getAttribute('data-chip'))).toEqual([
      'prototype',
      'motion-design',
      'deck',
      'document',
      'image',
      'hyperframes',
      'webgl',
      'live-artifact',
      'video',
      'audio',
    ]);
    expect(inlineTabs().slice(5).map((tab) => tab.textContent?.trim()))
      .toEqual(['HyperFrames', 'WebGL', 'Live Artifact', 'Video', 'Audio']);
    expect(inlineTabs().map((button) => button.getAttribute('data-chip'))).toEqual(
      orderedCreateChips().map((chip) => chip.id).filter((id) => id !== 'web-clone'),
    );
    expect(screen.queryByTestId('community-type-tabs-more')).toBeNull();

    fireEvent.click(inlineTabs()[1]!);
    expect(screen.getByText('No Motion design templates yet')).toBeTruthy();
    expect(inlineTabs()[1]!.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(inlineTabs()[0]!);
    expect(inlineTabs()[1]!.getAttribute('data-chip')).toBe('motion-design');
  });

  it('shows the empty state for a kind with nothing published, and the row never reshuffles', async () => {
    serveCatalogue([LANDING]);
    render(<CommunityView />);
    await waitFor(() => expect(cards().length).toBe(1));

    const before = inlineTabs().map((tab) => tab.getAttribute('data-chip'));
    fireEvent.click(screen.getByTestId('community-type-tab-audio'));

    expect(inlineTabs().map((tab) => tab.getAttribute('data-chip'))).toEqual(before);
    expect(screen.getByTestId('community-type-tab-audio').classList.contains('is-active')).toBe(true);
    expect(cards()).toHaveLength(0);
    expect(screen.getByTestId('community-empty-state')).toBeTruthy();
    expect(screen.getByText('No Audio templates yet')).toBeTruthy();
  });

  it('wears the Home webgl chip (sparkles glyph) and hands WebGL templates to the Home webgl chip as a prototype', async () => {
    serveCatalogue([LANDING, NEON_GRID]);
    const onUsePrompt = vi.fn();
    render(<CommunityView onUsePrompt={onUsePrompt} />);
    await waitFor(() => expect(cards().length).toBe(1));

    const webglTab = screen.getByTestId('community-type-tab-webgl');
    // Same glyph the Home `webgl` chip draws (home-hero/chips.ts: `sparkles`).
    expect(webglTab.querySelector('svg')?.outerHTML).toBe(
      renderToStaticMarkup(<Icon name="sparkles" size={14} aria-hidden />),
    );
    fireEvent.click(webglTab);

    // The WebGL example is classified out of the catalogue into its own tab —
    // it no longer masquerades as a plain prototype.
    expect(cards().map((card) => card.getAttribute('data-template-type'))).toEqual(['WebGL']);
    expect(document.querySelector('.community-template-grid')?.getAttribute('data-layout')).toBeNull();

    fireEvent.click(cards()[0]!.querySelector('.community-template-card__prompt-btn')!);
    expect(onUsePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'example-webgl-neon-grid', chipId: 'webgl', projectKind: 'prototype' }),
    );

    // And Prototype no longer lists it.
    fireEvent.click(inlineTabs()[0]!);
    expect(cards().map((card) => card.getAttribute('data-template-type'))).toEqual(['Prototype']);
  });
});

describe('CommunityView — 文档 tab (OPEND-3118)', () => {
  it('grids the bundled document examples under 文档 instead of an empty state', async () => {
    serveCatalogue([LANDING, RESUME, DOCS_PAGE]);
    render(<CommunityView />);
    await waitFor(() => expect(cards().length).toBe(1));

    const documentTab = inlineTabs().find((tab) => tab.getAttribute('data-chip') === 'document')!;
    fireEvent.click(documentTab);
    expect(screen.queryByTestId('community-empty-state')).toBeNull();
    expect(cards().map((card) => card.querySelector('.community-template-card__title')?.textContent)).toEqual([
      'Modern Résumé',
      'Docs Page',
    ]);
    expect(cards().every((card) => card.getAttribute('data-template-type') === 'Document')).toBe(true);

    // They left 原型 for good: a plugin lands in exactly one tab.
    fireEvent.click(inlineTabs()[0]!);
    expect(cards().map((card) => card.querySelector('.community-template-card__title')?.textContent)).toEqual([
      'SaaS Landing Page',
    ]);
  });
});
