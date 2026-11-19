// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useStreamingMarkdownSnapshot } from '../../../src/components/chat/useStreamingMarkdownSnapshot';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('keeps short text immediate, batches long deltas, and publishes the final text immediately', () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(
    ({ source, live }) => useStreamingMarkdownSnapshot(source, live),
    { initialProps: { source: 'Short', live: true } },
  );
  rerender({ source: 'Short reply', live: true });
  expect(result.current).toBe('Short reply');
  const long = 'Short reply' + ' long'.repeat(1_000);
  rerender({ source: long, live: true });
  rerender({ source: long + ' newer', live: true });
  expect(result.current).toBe('Short reply');
  act(() => vi.advanceTimersByTime(120));
  expect(result.current).toBe(long + ' newer');
  rerender({ source: long + ' newer and final', live: false });
  expect(result.current).toBe(long + ' newer and final');
});

it('does not render stale text after the streaming source is replaced', () => {
  const original = 'Original '.repeat(500);
  const replacement = 'Replacement '.repeat(500);
  const { result, rerender } = renderHook(
    ({ source }) => useStreamingMarkdownSnapshot(source, true),
    { initialProps: { source: original } },
  );
  rerender({ source: replacement });
  expect(result.current).toBe(replacement);
});

it('presents one new Markdown input for a burst of long-reply deltas', () => {
  vi.useFakeTimers();
  const source = 'Long Markdown paragraph.\n\n'.repeat(300);
  const { result, rerender } = renderHook(
    ({ text }) => useStreamingMarkdownSnapshot(text, true),
    { initialProps: { text: source } },
  );
  const snapshots = new Set([result.current]);
  for (let index = 1; index <= 100; index++) {
    rerender({ text: source + 'x'.repeat(index) });
    snapshots.add(result.current);
  }
  act(() => vi.advanceTimersByTime(120));
  snapshots.add(result.current);
  expect(snapshots.size).toBe(2);
  expect(result.current).toBe(source + 'x'.repeat(100));
});
