// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Spinner, Skeleton and Dot: the small status primitives.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Dot } from '../../../src/fantay/ui/dot';
import { Skeleton } from '../../../src/fantay/ui/skeleton';
import { Spinner } from '../../../src/fantay/ui/spinner';

afterEach(cleanup);

describe('Spinner', () => {
  it('is decorative without a label', () => {
    const { container } = render(<Spinner size="xs" />);
    const spinner = container.querySelector('[data-slot="spinner"]');
    expect(spinner).toHaveAttribute('aria-hidden', 'true');
    expect(spinner).toHaveAttribute('data-size', 'xs');
    expect(spinner?.className).toContain('animate-fx-spin');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('announces a label as a status', () => {
    render(<Spinner label="Loading…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });
});

describe('Skeleton', () => {
  it('maps shapes and staggers by index', () => {
    const { container } = render(
      <>
        <Skeleton shape="line" index={2} />
        <Skeleton shape="tile" aspect="4/3" />
      </>,
    );
    const [line, tile] = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="skeleton"]'));
    expect(line).toHaveAttribute('aria-hidden', 'true');
    expect(line?.className).toContain('h-3');
    expect(line?.style.animationDelay).toBe('0.24s');
    expect(tile).toHaveAttribute('data-shape', 'tile');
    expect(tile?.firstElementChild?.className).toContain('aspect-[4/3]');
  });
});

describe('Dot', () => {
  it('maps tones, shapes and sizes', () => {
    const { container } = render(
      <>
        <Dot tone="running" />
        <Dot tone="failed" shape="square" size="lg" />
      </>,
    );
    const [running, failed] = Array.from(container.querySelectorAll('[data-slot="dot"]'));
    expect(running?.className).toContain('animate-fx-status');
    expect(running?.className).toContain('rounded-full');
    expect(failed?.className).toContain('bg-accent-ink');
    expect(failed?.className).toContain('rounded-[25%]');
    expect(failed?.className).toContain('size-2.5');
  });
});
