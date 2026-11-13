// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TOAST_DURATION,
  Toaster,
  __resetToastsForTests,
  dismissToast,
  toast,
  useToasts,
} from '../../../src/fantay/ui/toast';

beforeEach(() => {
  vi.useFakeTimers();
  __resetToastsForTests();
});

afterEach(() => {
  cleanup();
  act(() => __resetToastsForTests());
  vi.useRealTimers();
});

describe('toast store', () => {
  it('lists a toast and auto-dismisses it after the default duration', () => {
    const { result } = renderHook(() => useToasts());
    let id = '';
    act(() => {
      id = toast({ title: 'Board saved' });
    });
    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ id, title: 'Board saved', tone: 'default', duration: DEFAULT_TOAST_DURATION });
    act(() => vi.advanceTimersByTime(DEFAULT_TOAST_DURATION - 1));
    expect(result.current).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toHaveLength(0);
  });

  it('replaces a toast with the same id and restarts its timer', () => {
    const { result } = renderHook(() => useToasts());
    act(() => {
      toast({ id: 'export', title: 'Exporting…', busy: true, duration: 1000 });
    });
    act(() => vi.advanceTimersByTime(900));
    act(() => {
      toast({ id: 'export', title: 'Exported', tone: 'success', duration: 1000 });
    });
    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ title: 'Exported', tone: 'success' });
    act(() => vi.advanceTimersByTime(900));
    expect(result.current).toHaveLength(1);
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toHaveLength(0);
  });

  it('keeps sticky toasts (duration 0) until dismissed', () => {
    const { result } = renderHook(() => useToasts());
    let id = '';
    act(() => {
      id = toast({ title: 'Rendering…', duration: 0 });
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toHaveLength(1);
    act(() => dismissToast(id));
    expect(result.current).toHaveLength(0);
  });
});

describe('Toaster', () => {
  it('renders a labelled fx region with at most three toasts', () => {
    render(<Toaster />);
    act(() => {
      for (const title of ['one', 'two', 'three', 'four']) toast({ title });
    });
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region).toHaveClass('fx');
    expect(region.querySelectorAll('[data-slot="toast"]')).toHaveLength(3);
    expect(screen.queryByText('one')).toBeNull();
    expect(screen.getByText('four')).toBeInTheDocument();
  });

  it('pauses the timers while hovered and resumes with the remaining time', () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Hover me', duration: 1000 });
    });
    const region = screen.getByRole('region', { name: 'Notifications' });
    act(() => vi.advanceTimersByTime(600));
    fireEvent.pointerEnter(region);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText('Hover me')).toBeInTheDocument();
    fireEvent.pointerLeave(region);
    act(() => vi.advanceTimersByTime(399));
    expect(screen.getByText('Hover me')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('Hover me')).toBeNull();
  });

  it('stays paused while focus is inside, even after the pointer leaves', () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Focus me', duration: 1000 });
    });
    const region = screen.getByRole('region', { name: 'Notifications' });
    fireEvent.pointerEnter(region);
    act(() => screen.getByRole('button', { name: 'Dismiss' }).focus());
    fireEvent.pointerLeave(region);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText('Focus me')).toBeInTheDocument();
  });

  it('resumes the timers once a toast dismissed from the keyboard takes the focus with it', () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'First', duration: 1000 });
    });
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    act(() => dismiss.focus());
    fireEvent.click(dismiss);
    expect(screen.queryByText('First')).toBeNull();
    act(() => {
      toast({ title: 'Second', duration: 1000 });
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByText('Second')).toBeNull();
  });

  it('dismisses from its button, runs actions, and alerts for danger', () => {
    const onRetry = vi.fn();
    render(<Toaster />);
    act(() => {
      toast({ title: 'Saved', tone: 'success' });
      toast({ title: 'Render failed', tone: 'danger', action: { label: 'Retry', onClick: onRetry } });
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Render failed');
    expect(screen.getByRole('status')).toHaveTextContent('Saved');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Render failed')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('shows a spinner for busy toasts', () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Rendering video…', busy: true, duration: 0 });
    });
    const item = screen.getByText('Rendering video…').closest('[data-slot="toast"]');
    expect(item?.querySelector('[data-slot="spinner"]')).not.toBeNull();
  });
});
