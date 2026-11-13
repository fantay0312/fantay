// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Progress } from '../../../src/fantay/ui/progress';

afterEach(cleanup);

function indicator(bar: HTMLElement): HTMLElement {
  const node = bar.querySelector<HTMLElement>('[data-slot="progress-indicator"]');
  if (!node) throw new Error('missing indicator');
  return node;
}

describe('Progress', () => {
  it('is a native progressbar with a clamped value', () => {
    render(<Progress aria-label="Upload" value={40} />);
    const bar = screen.getByRole('progressbar', { name: 'Upload' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('data-state', 'loading');
    expect(indicator(bar).style.width).toBe('40%');
  });

  it('clamps out-of-range values and honours max', () => {
    const { rerender } = render(<Progress aria-label="Upload" value={150} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect(bar).toHaveAttribute('data-state', 'complete');
    rerender(<Progress aria-label="Upload" value={-5} />);
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    rerender(<Progress aria-label="Upload" value={3} max={4} />);
    expect(bar).toHaveAttribute('aria-valuemax', '4');
    expect(indicator(bar).style.width).toBe('75%');
  });

  it('is indeterminate without a value', () => {
    render(<Progress aria-label="Rendering" value={null} />);
    const bar = screen.getByRole('progressbar', { name: 'Rendering' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('data-state', 'indeterminate');
    expect(indicator(bar).className).toContain('animate-fx-skeleton');
  });
});
