// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';

import { cn } from '../../../src/fantay/ui/cn';

describe('cn (tailwind-merge with the Fantay scales)', () => {
  it('treats the type scale as font sizes, not colours', () => {
    expect(cn('text-body text-ink', 'text-caption')).toBe('text-ink text-caption');
    expect(cn('text-ink', 'text-ink-soft')).toBe('text-ink-soft');
  });

  it('merges the shadow, radius, motion and ease scales', () => {
    expect(cn('shadow-ring', 'shadow-none')).toBe('shadow-none');
    expect(cn('shadow-ring', 'shadow-elevation-1-hover')).toBe('shadow-elevation-1-hover');
    expect(cn('rounded-row', 'rounded-modal')).toBe('rounded-modal');
    expect(cn('duration-fast', 'duration-enter')).toBe('duration-enter');
    expect(cn('ease-out-quint', 'ease-out-quad')).toBe('ease-out-quad');
    expect(cn('animate-fx-chip-in', 'animate-fx-fade-out')).toBe('animate-fx-fade-out');
    expect(cn('font-ui', 'font-mono')).toBe('font-mono');
  });

  it('keeps one focus-ring utility', () => {
    expect(cn('focus-ring', 'focus-ring-inset')).toBe('focus-ring-inset');
  });

  it('joins conditional classes like clsx', () => {
    expect(cn('px-3', false, null, undefined, { 'bg-surface': true, 'bg-paper': false })).toBe('px-3 bg-surface');
  });
});
