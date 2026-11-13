// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Switch } from '../../../src/fantay/ui/switch';

afterEach(cleanup);

describe('Switch', () => {
  it('is a switch that toggles aria-checked', () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Live preview" onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole('switch', { name: 'Live preview' });
    expect(control).toHaveAttribute('aria-checked', 'false');
    expect(control).toHaveAttribute('data-size', 'md');
    expect(control.className).toContain('w-[34px]');
    fireEvent.click(control);
    expect(control).toHaveAttribute('aria-checked', 'true');
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('has a small size and a disabled state', () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Small" size="sm" disabled onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole('switch', { name: 'Small' });
    expect(control.className).toContain('w-[26px]');
    expect(control).toBeDisabled();
    expect(control).toHaveAttribute('data-disabled', '');
    fireEvent.click(control);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
