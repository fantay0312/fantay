// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePresence } from '../../src/hooks/usePresence';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function Probe({ open }: { open: boolean }) {
  const { mounted, closing } = usePresence(open, 150);
  return mounted ? <div data-testid="surface" data-state={closing ? 'closed' : 'open'} /> : null;
}

const surface = () => document.querySelector<HTMLElement>('[data-testid="surface"]');
const motion = (reduce: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query.includes('reduce'), media: query }));

describe('usePresence', () => {
  it('keeps a closed surface for one exit clock, inert, then unmounts', () => {
    vi.useFakeTimers();
    motion(false);
    const { rerender } = render(<Probe open />);
    expect(surface()?.dataset.state).toBe('open');
    rerender(<Probe open={false} />);
    expect(surface()?.dataset.state).toBe('closed');
    act(() => { vi.advanceTimersByTime(150); });
    expect(surface()).toBeNull();
  });

  it('reopening during the exit cancels it', () => {
    vi.useFakeTimers();
    motion(false);
    const { rerender } = render(<Probe open />);
    rerender(<Probe open={false} />);
    rerender(<Probe open />);
    act(() => { vi.advanceTimersByTime(500); });
    expect(surface()?.dataset.state).toBe('open');
  });

  it('unmounts at once under reduced motion or without matchMedia', () => {
    motion(true);
    const { rerender } = render(<Probe open />);
    rerender(<Probe open={false} />);
    expect(surface()).toBeNull();
  });
});
