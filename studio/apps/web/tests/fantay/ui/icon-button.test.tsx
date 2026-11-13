// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IconButton } from '../../../src/fantay/ui/icon-button';
import { XIcon } from '../../../src/fantay/ui/icons';

afterEach(cleanup);

describe('IconButton', () => {
  it('is a type="button" named by its aria-label, without a native title', () => {
    render(
      <IconButton aria-label="Close panel">
        <XIcon />
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Close panel' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).not.toHaveAttribute('title');
    expect(button).not.toHaveAttribute('aria-pressed');
    expect(button).toHaveAttribute('data-variant', 'quiet');
    expect(button).toHaveAttribute('data-size', 'md');
    expect(button.className).toContain('size-8');
    // the glyph is decorative
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('maps sizes xs/sm/md/lg to 24/28/32/40', () => {
    const { rerender } = render(<IconButton aria-label="x" size="xs" />);
    expect(screen.getByRole('button').className).toContain('size-6');
    rerender(<IconButton aria-label="x" size="sm" />);
    expect(screen.getByRole('button').className).toContain('size-7');
    rerender(<IconButton aria-label="x" size="lg" />);
    expect(screen.getByRole('button').className).toContain('size-10');
  });

  it('reflects a toggle through data-on and aria-pressed', () => {
    const { rerender } = render(<IconButton aria-label="Grid" on />);
    const button = screen.getByRole('button', { name: 'Grid' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveAttribute('data-on', '');
    rerender(<IconButton aria-label="Grid" on={false} />);
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button).not.toHaveAttribute('data-on');
  });

  it('shows the label and the shortcut key caps in its tooltip on focus', async () => {
    render(<IconButton aria-label="Search" shortcut="mod+k" />);
    const button = screen.getByRole('button', { name: 'Search' });
    act(() => button.focus());
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Search');
    // jsdom reports no mac platform → Ctrl
    expect(tooltip.textContent).toContain('Ctrl');
    expect(tooltip.textContent).toContain('K');
  });

  it('renders no tooltip when tooltip={false}', () => {
    render(<IconButton aria-label="Quiet" tooltip={false} />);
    act(() => screen.getByRole('button', { name: 'Quiet' }).focus());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('honours disabledReason like Button', async () => {
    const onClick = vi.fn();
    render(<IconButton aria-label="Delete" disabled disabledReason="Nothing selected" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    act(() => button.focus());
    expect((await screen.findByRole('tooltip')).textContent).toContain('Nothing selected');
  });

  it('natively disables without a reason', () => {
    const onClick = vi.fn();
    render(<IconButton aria-label="Delete" disabled onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('data-disabled', '');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
