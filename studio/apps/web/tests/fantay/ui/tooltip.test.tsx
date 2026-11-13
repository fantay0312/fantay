// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Tooltip } from '../../../src/fantay/ui/tooltip';

afterEach(cleanup);

describe('Tooltip', () => {
  it('renders the child unchanged when the label is empty', () => {
    render(
      <Tooltip label="">
        <button type="button">Plain</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'Plain' });
    expect(button).not.toHaveAttribute('data-state');
    act(() => button.focus());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens on keyboard focus with the label and the shortcut key caps, in an fx surface', async () => {
    render(
      <Tooltip label="Search the workspace" shortcut="mod+shift+k" side="bottom">
        <button type="button">Search</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'Search' });
    act(() => button.focus());
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Search the workspace');
    expect(tooltip.textContent).toContain('Shift');

    const surface = document.querySelector('[data-slot="tooltip"]');
    expect(surface).toHaveClass('fx');
    expect(surface?.className).toContain('z-(--z-fx-tooltip)');
    expect(surface).toHaveAttribute('data-side', 'bottom');
    expect(surface?.querySelectorAll('kbd')).toHaveLength(3);
  });
});
