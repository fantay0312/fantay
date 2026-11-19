// SPDX-License-Identifier: AGPL-3.0-only
// A deck in the viewer: its structure, and its slides as pictures drawn on demand. The hook owns the
// worker and every object URL it hands out, and releases both when the bytes change or the viewer
// unmounts. A newer version of the file is drawn behind the old pictures: each slide keeps showing
// what it showed until its new picture is ready, so an update never blanks the run.
import { useCallback, useEffect, useRef, useState } from 'react';

import { createDeckClient, type DeckClient, type RenderedSlide } from './deck-client';
import type { DeckFailure, DeckInfo, DeckKind, UnsupportedCount } from './protocol';

/** Drawn slides kept for scrolling back. Past either cap, the ones farthest from the reader go. */
const CACHE_MAX_BYTES = 96 * 1024 * 1024;
const CACHE_MAX_SLIDES = 120;

export interface SlidePicture {
  /** Address of the slide's SVG, for an `<img>` only. */
  url: string;
  unsupported: UnsupportedCount[];
}

/** A slide's picture, or `failed` when the engine could not draw it. Absent while not drawn yet. */
export type SlideState = SlidePicture | 'failed';

export interface DeckSession {
  /** The opened deck; null while opening and after a failure. */
  deck: DeckInfo | null;
  failure: DeckFailure | null;
  /** True from the moment bytes arrive until the deck opens or fails. */
  opening: boolean;
  slides: ReadonlyMap<number, SlideState>;
  /** The slides the reader is at or near, most wanted first. Those not drawn yet get drawn. */
  want(indices: readonly number[]): void;
}

interface CacheEntry {
  state: SlideState;
  bytes: number;
  /** Which opening of the file drew it; older ones are shown until redrawn. */
  generation: number;
}

function release(entry: CacheEntry | undefined): void {
  if (entry && entry.state !== 'failed') URL.revokeObjectURL(entry.state.url);
}

export function useDeck(kind: DeckKind, bytes: ArrayBuffer | null): DeckSession {
  const [opened, setOpened] = useState<{ bytes: ArrayBuffer; deck: DeckInfo | null; failure: DeckFailure | null } | null>(null);
  const [slides, setSlides] = useState<ReadonlyMap<number, SlideState>>(() => new Map());

  const cacheRef = useRef(new Map<number, CacheEntry>());
  const clientRef = useRef<DeckClient | null>(null);
  const generationRef = useRef(0);
  const wantedRef = useRef<readonly number[]>([]);

  const publish = useCallback(() => {
    setSlides(new Map([...cacheRef.current].map(([index, entry]) => [index, entry.state])));
  }, []);

  const request = useCallback(() => {
    const generation = generationRef.current;
    const cache = cacheRef.current;
    // A slide that failed in this opening is not asked for again; a reload is a new opening.
    clientRef.current?.want(wantedRef.current.filter((index) => cache.get(index)?.generation !== generation));
  }, []);

  useEffect(() => {
    if (!bytes) return;
    let current = true;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const cache = cacheRef.current;

    const evict = (): void => {
      let total = 0;
      for (const entry of cache.values()) total += entry.bytes;
      if (total <= CACHE_MAX_BYTES && cache.size <= CACHE_MAX_SLIDES) return;
      const wanted = new Set(wantedRef.current);
      const focus = wantedRef.current[0] ?? 0;
      const spare = [...cache.keys()].filter((index) => !wanted.has(index)).sort((a, b) => Math.abs(b - focus) - Math.abs(a - focus));
      for (const index of spare) {
        if (total <= CACHE_MAX_BYTES && cache.size <= CACHE_MAX_SLIDES) break;
        const entry = cache.get(index);
        total -= entry?.bytes ?? 0;
        release(entry);
        cache.delete(index);
      }
    };

    const onSlide = (index: number, result: RenderedSlide | 'failed'): void => {
      if (!current) return;
      const previous = cache.get(index);
      const state: SlideState = result === 'failed' ? 'failed' : { url: URL.createObjectURL(result.image), unsupported: result.unsupported };
      cache.set(index, { state, bytes: result === 'failed' ? 0 : result.image.size, generation });
      release(previous);
      evict();
      publish();
    };

    const client = createDeckClient(kind, bytes, onSlide);
    clientRef.current = client;
    client.open().then(
      (deck) => {
        if (!current) return;
        // Pictures of slides the new version no longer has are dropped; the rest stay until redrawn.
        for (const index of [...cache.keys()]) {
          if (index < deck.slides.length) continue;
          release(cache.get(index));
          cache.delete(index);
        }
        setOpened({ bytes, deck, failure: null });
        publish();
        request();
      },
      (failure: DeckFailure) => {
        if (current) setOpened({ bytes, deck: null, failure });
      },
    );

    return () => {
      current = false;
      client.dispose();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [kind, bytes, publish, request]);

  // Every address handed out is revoked when the viewer goes away.
  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      for (const entry of cache.values()) release(entry);
      cache.clear();
    };
  }, []);

  const want = useCallback(
    (indices: readonly number[]) => {
      wantedRef.current = indices;
      request();
    },
    [request],
  );

  const mine = opened !== null && opened.bytes === bytes ? opened : null;
  return {
    deck: mine?.deck ?? null,
    failure: mine?.failure ?? null,
    opening: bytes !== null && mine === null,
    slides,
    want,
  };
}
