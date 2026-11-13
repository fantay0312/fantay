/* SPDX-License-Identifier: AGPL-3.0-only */
import { useLayoutEffect, useRef, useState } from 'react';

/** Tracks an element's content width so SVG charts draw at real pixels (crisp text, round corners stay round).
 *  Falls back to `fallback` until the first measurement, and where layout reports zero (tests). */
export function useElementWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width > 0 ? width : fallback] as const;
}
