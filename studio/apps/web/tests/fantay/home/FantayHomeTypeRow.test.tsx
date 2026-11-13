// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Home creation chips (spec 02 §8.2 + amendment C4): shell off → the upstream TypePillRow; shell on → the
// Fantay row in its fixed order with Fantay labels, picks through `onPick`, 社媒设计 offers platform sizes and
// writes the size into the brief, 更多 lists every other chip in props order.
import '../helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seed = vi.hoisted(() => vi.fn());
vi.mock('../../../src/components/HomeView', () => ({ seedHomeComposerPrompt: seed }));

import { findChip, orderedCreateChips, type HomeHeroChip } from '../../../src/components/home-hero/chips';
import { FantayHomeTypeRow } from '../../../src/fantay/home/FantayHomeTypeRow';
import { HOME_COMPOSER_PROMPT_DRAFT_KEY } from '../../../src/fantay/home/home-composer-brief';
import { I18nProvider } from '../../../src/i18n';

const INLINE_ORDER = ['prototype', 'image', 'video', 'motion-design', 'social', 'deck', 'document'];

function renderRow(overrides: Partial<{ disabled: boolean; activeChipId: string | null }> = {}) {
  const onPick = vi.fn<(chip: HomeHeroChip) => void>();
  const chips = orderedCreateChips().filter((chip) => chip.action.kind === 'apply-scenario');
  render(
    <I18nProvider initial="zh-CN">
      <FantayHomeTypeRow
        chips={chips}
        activeChipId={overrides.activeChipId ?? null}
        disabled={overrides.disabled}
        labelFor={(id) => `label:${id}`}
        onPick={onPick}
      />
    </I18nProvider>,
  );
  return { onPick, chips };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('FantayHomeTypeRow with the shell off', () => {
  it('renders the upstream type pills unchanged', () => {
    renderRow();
    expect(screen.getByTestId('home-hero-type-pills')).toBeInTheDocument();
    expect(screen.queryByTestId('fantay-home-type-row')).toBeNull();
  });
});

describe('FantayHomeTypeRow with the shell on', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    seed.mockClear();
    // jsdom has no layout: a 0×0 trigger in a 0×0 viewport reads as detached, and the menus hide when
    // their trigger is (`hideWhenDetached`), so give the boxes a size.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 40, 200, 28));
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1024 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 768 });
  });

  it('shows the seven creation types in order with Fantay labels, then 更多', () => {
    renderRow();
    const row = screen.getByTestId('fantay-home-type-row');
    expect(row).toHaveAttribute('aria-label', '创作类型');
    expect(screen.queryByTestId('home-hero-type-pills')).toBeNull();
    const ids = Array.from(row.querySelectorAll('[data-testid^="fantay-home-chip-"]')).map((element) =>
      element.getAttribute('data-testid')?.replace('fantay-home-chip-', ''),
    );
    expect(ids).toEqual([...INLINE_ORDER, 'more']);
    // Each chip leads with its feature icon; the label is the chip's text.
    const labels = INLINE_ORDER.map((id) => screen.getByTestId(`fantay-home-chip-${id}`).textContent?.trim());
    expect(labels).toEqual(['网页/应用设计', '图片', '视频', '代码动画', '社媒设计', '演示', '文档']);
    expect(screen.getByTestId('fantay-home-chip-more').textContent).toBe('更多');
  });

  it('picks through onPick with the same chip objects the upstream pill uses', () => {
    const { onPick, chips } = renderRow();
    fireEvent.click(screen.getByTestId('fantay-home-chip-prototype'));
    expect(onPick).toHaveBeenCalledWith(chips.find((chip) => chip.id === 'prototype'));
    fireEvent.click(screen.getByTestId('fantay-home-chip-motion-design'));
    expect(onPick).toHaveBeenLastCalledWith(chips.find((chip) => chip.id === 'motion-design'));
  });

  it('offers the platform sizes on 社媒设计 and writes the size into the brief', async () => {
    window.localStorage.setItem(HOME_COMPOSER_PROMPT_DRAFT_KEY, '秋季上新海报');
    const { onPick } = renderRow();
    fireEvent.keyDown(screen.getByTestId('fantay-home-chip-social'), { key: 'Enter' });
    const menu = await screen.findByTestId('fantay-home-social-menu');
    expect(menu.textContent).toContain('平台尺寸');
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.getAttribute('data-testid'))).toEqual([
      'fantay-home-social-xhs',
      'fantay-home-social-story',
      'fantay-home-social-square',
      'fantay-home-social-portrait',
      'fantay-home-social-landscape',
    ]);
    expect(items[0]?.textContent).toContain('小红书 3:4');
    expect(items[0]?.textContent).toContain('1242×1660');
    expect(items[1]?.textContent).toContain('1080×1920');

    fireEvent.click(items[0]!);
    // `social` is not in the create-rail chips HomeHero passes: the row resolves it from the catalog
    expect(onPick).toHaveBeenCalledWith(findChip('social'));
    await waitFor(() => expect(seed).toHaveBeenCalledWith('画布尺寸：1242×1660（小红书 3:4）\n秋季上新海报', 'page'));
  });

  it('lists every other chip behind 更多 in props order', () => {
    const { onPick, chips } = renderRow();
    fireEvent.keyDown(screen.getByTestId('fantay-home-chip-more'), { key: 'Enter' });
    const menu = screen.getByTestId('fantay-home-chip-more-menu');
    const expected = chips.filter((chip) => !INLINE_ORDER.includes(chip.id)).map((chip) => chip.id);
    expect(expected.length).toBeGreaterThan(0);
    const listed = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((item) =>
      item.getAttribute('data-testid')?.replace('fantay-home-more-', ''),
    );
    expect(listed).toEqual(expected);
    const first = screen.getByTestId(`fantay-home-more-${expected[0]}`);
    expect(first.textContent).toBe(`label:${expected[0]}`);
    fireEvent.click(first);
    expect(onPick).toHaveBeenCalledWith(chips.find((chip) => chip.id === expected[0]));
  });

  it('disables every chip while HomeHero says so', () => {
    const { onPick } = renderRow({ disabled: true });
    for (const id of [...INLINE_ORDER, 'more']) {
      expect(screen.getByTestId(`fantay-home-chip-${id}`)).toBeDisabled();
    }
    fireEvent.click(screen.getByTestId('fantay-home-chip-image'));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('marks the active chip', () => {
    renderRow({ activeChipId: 'deck' });
    expect(screen.getByTestId('fantay-home-chip-deck')).toHaveAttribute('data-on', '');
    expect(screen.getByTestId('fantay-home-chip-image')).not.toHaveAttribute('data-on');
  });
});
