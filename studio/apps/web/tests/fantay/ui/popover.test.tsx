// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Popover, PopoverContent, PopoverTrigger, type PopoverWidth } from '../../../src/fantay/ui/popover';

afterEach(cleanup);

function renderOpen(width?: PopoverWidth) {
  render(
    <Popover defaultOpen>
      <PopoverTrigger>Params</PopoverTrigger>
      <PopoverContent width={width} aria-label="Params">
        <p>Body</p>
      </PopoverContent>
    </Popover>,
  );
  return screen.getByRole('dialog', { name: 'Params' });
}

describe('PopoverContent', () => {
  it('opens from its trigger as an fx surface on the floating z step', () => {
    render(
      <Popover>
        <PopoverTrigger>Params</PopoverTrigger>
        <PopoverContent aria-label="Params">Body</PopoverContent>
      </Popover>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Params' }));
    const content = screen.getByRole('dialog', { name: 'Params' });
    expect(content).toHaveClass('fx');
    expect(content.className).toContain('z-(--z-fx-floating)');
    expect(content).toHaveAttribute('data-width', 'md');
    expect(content.className).toContain('w-[min(280px,calc(100vw-24px))]');
  });

  it('maps the named widths', () => {
    expect(renderOpen('sm').className).toContain('w-[min(220px,calc(100vw-24px))]');
    cleanup();
    expect(renderOpen('lg').className).toContain('w-[min(340px,calc(100vw-24px))]');
    cleanup();
    const auto = renderOpen('auto');
    expect(auto.className).not.toMatch(/w-\[min\(/);
  });

  it('accepts a pixel width, capped at the viewport', () => {
    const content = renderOpen(300);
    expect(content).toHaveAttribute('data-width', 'px');
    expect(content.style.getPropertyValue('--fx-popover-width')).toBe('300px');
    expect(content.className).toContain('w-[min(var(--fx-popover-width),calc(100vw-24px))]');
    expect(content.className).not.toContain('w-[min(280px');
  });
});
