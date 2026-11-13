// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesignSystemSummary } from '@open-design/contracts';

vi.mock('../../src/providers/registry', () => ({
  designSystemStaticUrl: (id: string, filePath: string) => `/design-systems/${id}/${filePath}`,
  fetchDesignSystem: vi.fn(),
  fetchDesignSystemStaticText: vi.fn(async () => null),
  fetchProjectFileText: vi.fn(),
  openExternalUrl: vi.fn(),
  projectRawUrl: (projectId: string, filePath: string) => `/raw/${projectId}/${filePath}`,
}));

import { DesignSystemPicker } from '../../src/components/DesignSystemPicker';
import { I18nProvider, type Locale } from '../../src/i18n';
import {
  fetchDesignSystem,
  fetchProjectFileText,
} from '../../src/providers/registry';

const fetchDesignSystemMock = vi.mocked(fetchDesignSystem);
const fetchProjectFileTextMock = vi.mocked(fetchProjectFileText);

const designSystems: DesignSystemSummary[] = [
  {
    id: 'clay',
    title: 'Clay',
    summary: 'Friendly tactile product UI.',
    category: 'Product',
    swatches: ['#f4efe7', '#25211d'],
  },
  {
    id: 'user:brand-acme',
    title: 'Acme',
    summary: 'Acme brand kit.',
    category: 'Brand',
    source: 'user',
    swatches: ['#0b5fff', '#0a0a0a'],
  },
];

beforeEach(() => {
  fetchDesignSystemMock.mockImplementation(async (id) => ({
    id,
    title: id === 'clay' ? 'Clay' : 'Acme',
    summary: id === 'clay' ? 'Friendly tactile product UI.' : 'Acme brand kit.',
    category: id === 'clay' ? 'Product' : 'Brand',
    body: id === 'clay' ? '# Clay\n\nFriendly tactile product UI.' : '# Acme',
    swatches: id === 'clay' ? ['#f4efe7', '#25211d'] : ['#0b5fff', '#0a0a0a'],
  }));
  fetchProjectFileTextMock.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// The picker no longer has a separate Brand Kit card for brand-backed systems:
// every system previews as the studio cover the 设计体系 page shows
// (DesignSystemCoverPreview). What still differs is the subtitle: a user
// system reads its own summary, a preset its category.
describe('DesignSystemPicker brand preview', () => {
  function renderPicker(
    props: Partial<ComponentProps<typeof DesignSystemPicker>> = {},
    locale: Locale = 'en',
  ) {
    return render(
      <I18nProvider initial={locale}>
        <DesignSystemPicker
          designSystems={designSystems}
          selectedId="user:brand-acme"
          onChange={vi.fn()}
          {...props}
        />
      </I18nProvider>,
    );
  }

  it('previews a selected brand-backed system with the studio cover, subtitled by its summary', async () => {
    renderPicker();

    fireEvent.click(await screen.findByTestId('project-ds-picker-trigger'));

    const cover = await screen.findByTestId('project-ds-picker-preview-cover');
    await waitFor(() => {
      expect(fetchDesignSystemMock).toHaveBeenCalledWith('user:brand-acme', null);
    });
    expect(within(cover).getByText('Acme')).toBeTruthy();
    expect(within(cover).getByText('In use')).toBeTruthy();
    expect(within(cover).getAllByText('Acme brand kit.').length).toBeGreaterThan(0);
    expect(within(cover).queryByText('Brand')).toBeNull();
    expect(screen.queryByTestId('project-ds-picker-preview-use')).toBeNull();
  });

  it('switches the cover to a hovered preset, subtitled by its category, and uses it', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });

    fireEvent.click(await screen.findByTestId('project-ds-picker-trigger'));
    await screen.findByTestId('project-ds-picker-preview-cover');

    fireEvent.mouseEnter(screen.getByTestId('project-ds-picker-option-clay'));

    await waitFor(() => {
      expect(fetchDesignSystemMock).toHaveBeenCalledWith('clay', null);
    });
    const cover = screen.getByTestId('project-ds-picker-preview-cover');
    expect(within(cover).getByText('Clay')).toBeTruthy();
    expect(within(cover).getByText('Product')).toBeTruthy();
    expect(within(cover).getByText('Friendly tactile product UI.')).toBeTruthy();
    expect(within(cover).queryByText('In use')).toBeNull();

    fireEvent.click(screen.getByTestId('project-ds-picker-preview-use'));
    expect(onChange).toHaveBeenCalledWith('clay');
  });
});
