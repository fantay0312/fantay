// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Chip } from '../../../src/fantay/ui/chip';

afterEach(cleanup);

describe('Chip', () => {
  it('is a solid md type="button" by default', () => {
    render(<Chip>Image</Chip>);
    const chip = screen.getByRole('button', { name: 'Image' });
    expect(chip).toHaveAttribute('type', 'button');
    expect(chip).toHaveAttribute('data-variant', 'solid');
    expect(chip).toHaveAttribute('data-size', 'md');
    expect(chip).toHaveAttribute('data-tone', 'default');
    expect(chip.className).toContain('h-8');
    expect(chip.className).not.toContain('not-data-on:opacity-60');
  });

  it('rests faded as a suggestion until on', () => {
    const { rerender } = render(
      <Chip variant="suggestion" size="sm" icon={<span data-testid="glyph">✦</span>}>
        Poster
      </Chip>,
    );
    const chip = screen.getByRole('button', { name: /Poster/ });
    expect(chip.className).toContain('not-data-on:opacity-60');
    expect(chip.className).toContain('h-7');
    expect(screen.getByTestId('glyph').parentElement).toHaveAttribute('data-slot', 'chip-icon');
    expect(chip).not.toHaveAttribute('data-on');
    rerender(
      <Chip variant="suggestion" on>
        Poster
      </Chip>,
    );
    expect(screen.getByRole('button', { name: 'Poster' })).toHaveAttribute('data-on', '');
  });

  it('tints warning and danger tones at full opacity', () => {
    render(
      <>
        <Chip tone="warning" variant="suggestion">
          3 references ignored
        </Chip>
        <Chip tone="danger">Broken reference</Chip>
      </>,
    );
    const warning = screen.getByRole('button', { name: '3 references ignored' });
    expect(warning).toHaveAttribute('data-tone', 'warning');
    expect(warning).toHaveAttribute('data-variant', 'solid');
    expect(warning.className).toContain('text-warning-ink');
    expect(screen.getByRole('button', { name: 'Broken reference' }).className).toContain('text-accent-ink');
  });

  it('adds a separate remove button that does not activate the chip', () => {
    const onClick = vi.fn();
    const onRemove = vi.fn();
    render(
      <Chip onClick={onClick} onRemove={onRemove}>
        Template: Poster
      </Chip>,
    );
    const chip = screen.getByRole('button', { name: 'Template: Poster' });
    const remove = screen.getByRole('button', { name: 'Remove' });
    expect(chip.contains(remove)).toBe(false);
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disables natively', () => {
    render(<Chip disabled>Off</Chip>);
    const chip = screen.getByRole('button', { name: 'Off' });
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute('data-disabled', '');
  });
});
