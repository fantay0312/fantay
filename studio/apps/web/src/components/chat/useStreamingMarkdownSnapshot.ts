import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const LONG_MARKDOWN_LENGTH = 4_096;
const MIN_UPDATE_INTERVAL_MS = 32;
const MAX_UPDATE_INTERVAL_MS = 120;

/** Batch expensive Markdown updates while keeping short replies and the final frame immediate. */
export function useStreamingMarkdownSnapshot(source: string, live: boolean): string {
  const [snapshot, setSnapshot] = useState(source);
  const latest = useRef(source);
  const budgetedSource = useRef<string | null>(null);
  const nextUpdateAt = useRef(0);
  const batched = live && source.length >= LONG_MARKDOWN_LENGTH;
  // A protocol boundary can replace or shorten the accumulated text. Never
  // hold a snapshot that contains content the current source has removed.
  const visible = batched && source.startsWith(snapshot) ? snapshot : source;
  const renderStartedAt = batched ? performance.now() : 0;

  useLayoutEffect(() => {
    latest.current = source;
    if (!batched) {
      budgetedSource.current = null;
      nextUpdateAt.current = 0;
    }
    if (visible !== snapshot) setSnapshot(visible);
  }, [batched, snapshot, source, visible]);

  useLayoutEffect(() => {
    if (!batched || budgetedSource.current === visible) return;
    budgetedSource.current = visible;
    const now = performance.now();
    const interval = Math.min(
      MAX_UPDATE_INTERVAL_MS,
      Math.max(MIN_UPDATE_INTERVAL_MS, (now - renderStartedAt) * 2),
    );
    nextUpdateAt.current = now + interval;
  }, [batched, renderStartedAt, visible]);

  const pending = batched && source !== visible;
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(
      () => setSnapshot(latest.current),
      Math.max(0, nextUpdateAt.current - performance.now()),
    );
    return () => clearTimeout(timer);
  }, [pending, visible]);

  return visible;
}
