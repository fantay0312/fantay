// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// The /fantay-ui gallery contract the cascade e2e test (e2e/ui/fantay-ui-cascade.test.ts) relies on.
import '../helpers/radix-jsdom';

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/fantay/theme/theme', () => ({
  useTheme: () => ({ preference: 'dark', resolved: 'dark', setPreference: () => undefined }),
}));

import { Callout } from '../../../src/fantay/ui/callout';
import { EmptyState } from '../../../src/fantay/ui/empty-state';
import { FantayUiGallery } from '../../../src/fantay/ui/gallery/Gallery';
import { StatusLabel } from '../../../src/fantay/ui/status-label';
import { MetaLine } from '../../../src/fantay/ui/tile';
import { VisuallyHidden } from '../../../src/fantay/ui/visually-hidden';

afterEach(cleanup);

const BUTTON_VARIANTS = ['default', 'primary', 'ghost', 'danger', 'bare', 'link', 'brand'];

describe('FantayUiGallery', () => {
  it('renders the Fantay root, button matrix, R14 extras, theme islands, and legacy probe isolation', () => {
    render(<FantayUiGallery />);
    const gallery = screen.getByTestId('fx-gallery');
    expect(gallery).toHaveClass('fx');
    expect(gallery.closest('.fx-legacy')).toBeNull();
    for (const id of [
      'tokens',
      'buttons',
      'icon-buttons',
      'toolbar',
      'segmented',
      'tabs',
      'menus',
      'overlays',
      'inputs',
      'select',
      'controls',
      'status',
      'surfaces',
      'toast',
      'themes',
    ]) {
      expect(within(gallery).getByTestId(`gallery-section-${id}`)).toBeInTheDocument();
    }
    expect(within(gallery).getByTestId('theme-island-light')).toHaveAttribute('data-theme', 'light');
    expect(within(gallery).getByTestId('theme-island-dark')).toHaveAttribute('data-theme', 'dark');
    expect(within(gallery).getAllByTestId('fx-theme-segmented')).toHaveLength(2);
    expect(within(gallery).getByTestId('token-swatch-brand')).toBeInTheDocument();

    for (const variant of BUTTON_VARIANTS) {
      for (const size of ['sm', 'md', 'lg']) {
        expect(screen.getByTestId(`specimen-button-${variant}-${size}`)).toHaveAttribute('data-size', size);
      }
      expect(screen.getByTestId(`specimen-button-${variant}-md-disabled`)).toBeDisabled();
      expect(screen.getByTestId(`specimen-button-${variant}-md-reason`)).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByTestId(`specimen-button-${variant}-md-loading`)).toHaveAttribute('aria-busy', 'true');
    }

    expect(screen.getByTestId('specimen-toolbar-button-sm-select')).toHaveAttribute('data-size', 'sm');
    expect(screen.getByTestId('specimen-toolbar-button-md-select')).toHaveAttribute('data-size', 'md');
    expect(screen.getByTestId('specimen-modal-open-2xl')).toBeInTheDocument();
    expect(screen.getByTestId('specimen-popover-300')).toBeInTheDocument();
    for (const id of [
      'specimen-sheet-open-right',
      'specimen-collapsible',
      'specimen-disclosure',
      'specimen-callout-error',
      'specimen-empty-state-card',
      'specimen-empty-state-dashed',
      'specimen-tile-frosted',
      'specimen-status-label-done',
      'specimen-progress-40',
      'specimen-progress-indeterminate',
      'specimen-search-field-ring',
      'specimen-search-field-bar',
      'specimen-visually-hidden',
      'specimen-chip-warning-md',
      'specimen-chip-danger-sm',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }

    const region = within(gallery).getByTestId('fx-region');
    expect(within(region).getByTestId('fx-raw-button').tagName).toBe('BUTTON');

    const probe = screen.getByTestId('fx-legacy-probe');
    expect(probe).toHaveClass('fx-legacy');
    expect(gallery.contains(probe)).toBe(false);
    expect(probe.closest('.fx')).toBeNull();
    expect(within(probe).getByTestId('legacy-raw-primary')).toHaveClass('primary');
    expect(within(probe).getByTestId('legacy-raw-button')).toBeInTheDocument();

    const twins = Array.from(probe.querySelectorAll<HTMLElement>('[data-testid$="--legacy"]'));
    expect(twins.length).toBeGreaterThanOrEqual(15);
    for (const twin of twins) {
      const id = twin.dataset.testid?.replace(/--legacy$/, '') ?? '';
      expect(within(gallery).getByTestId(id), id).toBeInTheDocument();
    }
  });

  it('preserves MetaLine, VisuallyHidden asChild, EmptyState, Callout, and StatusLabel contracts', () => {
    render(
      <>
        <MetaLine data-testid="meta" trailing={<span data-testid="badge">Live</span>}>
          <span>12 images</span>
          {false}
          {null}
          <span>2 h ago</span>
        </MetaLine>
        <VisuallyHidden asChild>
          <h2>Section title</h2>
        </VisuallyHidden>
        <EmptyState data-testid="empty" variant="dashed" illustration={<span data-testid="art" />} title="Nothing here" />
        <Callout tone="error" role="alert">Failed</Callout>
        <StatusLabel>Not connected</StatusLabel>
      </>,
    );
    const meta = screen.getByTestId('meta');
    expect(meta.querySelectorAll('[aria-hidden]')).toHaveLength(1);
    expect(meta.textContent).toBe('12 images·2 h agoLive');
    const heading = screen.getByRole('heading', { name: 'Section title' });
    expect(heading).toHaveClass('sr-only');
    expect(heading).toHaveAttribute('data-slot', 'visually-hidden');
    expect(screen.getByTestId('empty').querySelector('p')).toBeNull();
    expect(screen.getByRole('alert')).toHaveAttribute('data-tone', 'error');
    const muted = screen.getByText('Not connected');
    expect(muted).toHaveAttribute('data-tone', 'muted');
    expect(muted.querySelector('[data-slot="dot"]')).toHaveAttribute('aria-hidden', 'true');
  });
});
