// SPDX-License-Identifier: AGPL-3.0-only
// Character portraits (Soul UI spec §8.6). One image per character, always cover-fit on a top focal point. Without an
// image: SoulAgentPortrait falls back to the existing paper face (Fantay: the mascot still), and SoulPortrait /
// SoulPortraitCover draw a monogram on the given theme's paper. Characters never get a live mascot. Stage 2: the
// polaroid frame is drawn (a small card around a square photo, tilted inside a transcript from 40 px up), a change of
// image crossfades, and SoulAgentPortrait can show the sprite of an emotion instead of the portrait.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { PaCharacterView, PaChatTheme, PaEmotion, PersonalAgent } from '@open-design/contracts';
import { PA_THEME_META, resolveAppearance, spriteFor } from '@open-design/contracts/soul';

import { FantayMascotStill } from '../../brand/FantayMascot';
import { cn } from '../../ui';
import { paSoulAssetUrl } from '../pa-api';
import { PaAvatar } from '../PaAvatar';
import { soulFrameOf } from './soul-theme';
import styles from './SoulPortrait.module.css';
import scopeStyles from './SoulThemeScope.module.css';

export type SoulFrame = 'circle' | 'squircle' | 'polaroid' | 'scope'; // 'scope': follow the nearest [data-pa-frame]

/** Size of the Fantay mascot on a library cover (spec §6.2). */
const COVER_MASCOT = 64;
/** Below this size a polaroid has no room for its card and is drawn as a squircle. */
const POLAROID_MIN = 28;
/** From this size a polaroid inside a transcript is tilted (`data-size-lg`). */
const LARGE_FROM = 40;
/** Fallback for a crossfade whose animation never reports its end (a hidden element); a little over --pa-dur-swap. */
const SWAP_SETTLE_MS = 450;

function reducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export interface SoulImageSwap {
  /** The previous image while the new one loads and fades in; null when nothing is swapping. */
  under: string | null;
  /** 'wait' until the new image has loaded, then 'in' while it fades in over `under`. */
  phase: 'wait' | 'in' | null;
  onLoad(): void;
  onSwapEnd(): void;
}

/** A crossfade between two images: when `image` changes from one URL to another, the previous one stays under the
 *  new one until the new one has loaded and faded in over --pa-dur-swap (CSS). Reduced motion: an instant swap. A
 *  change from or to no image never fades. */
export function useSoulImageSwap(image: string | null): SoulImageSwap {
  const [swap, setSwap] = useState<{ current: string | null; under: string | null; ready: boolean }>(() => ({ current: image, under: null, ready: true }));
  let state = swap;
  if (swap.current !== image) {
    // A newer change while one is still loading keeps the image that is actually on screen underneath.
    const onScreen = swap.under !== null && !swap.ready ? swap.under : swap.current;
    state = { current: image, under: image !== null && onScreen !== null && onScreen !== image ? onScreen : null, ready: false };
    setSwap(state);
  }
  const fading = state.under !== null && state.ready;
  useEffect(() => {
    if (!fading) return undefined;
    const timer = window.setTimeout(() => setSwap((now) => (now.under === null ? now : { ...now, under: null })), SWAP_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [fading]);
  const loaded = state.current;
  return {
    under: state.under,
    phase: state.under === null ? null : state.ready ? 'in' : 'wait',
    onLoad: () =>
      setSwap((now) => {
        if (now.current !== loaded || now.ready) return now;
        return reducedMotion() ? { ...now, under: null, ready: true } : { ...now, ready: true };
      }),
    onSwapEnd: () => setSwap((now) => (now.under === null ? now : { ...now, under: null })),
  };
}

/** The first code point of a name, upper-cased for Latin; '·' for an empty name. */
function monogramOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase() : '·';
}

/** The image URL unless it failed to load; a new URL gets a fresh attempt. */
function useLoadable(src: string | null): { image: string | null; onError(): void } {
  const [failed, setFailed] = useState<string | null>(null);
  const image = src && src !== failed ? src : null;
  return { image, onError: () => setFailed(src) };
}

export interface SoulPortraitProps {
  src: string | null;
  name: string;
  size: number;
  frame?: SoulFrame; // default 'circle'
  theme?: PaChatTheme; // monogram paper; default 'fantay'
  fallback?: ReactNode;
  dim?: boolean;
  className?: string;
}

export function SoulPortrait({ src, name, size, frame = 'circle', theme = 'fantay', fallback, dim = false, className }: SoulPortraitProps) {
  const { image, onError } = useLoadable(src);
  const swap = useSoulImageSwap(image);
  const box = { '--pa-portrait': `${size}px` } as CSSProperties;
  const drawn: SoulFrame = frame === 'polaroid' && size < POLAROID_MIN ? 'squircle' : frame;
  if (!image && fallback !== undefined && fallback !== null && fallback !== false) {
    return (
      <span data-slot="soul-portrait" data-fallback="" data-dim={dim ? '' : undefined} className={cn(styles.portrait, className)} style={box}>
        {fallback}
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={name || undefined}
      data-slot="soul-portrait"
      data-frame={drawn}
      data-size-lg={size >= LARGE_FROM ? '' : undefined}
      data-size-sm={size < POLAROID_MIN ? '' : undefined}
      data-monogram={image ? undefined : ''}
      data-dim={dim ? '' : undefined}
      className={cn(styles.portrait, styles.framed, className)}
      style={box}
    >
      {image ? (
        <>
          {swap.under ? (
            <img
              key={`under:${swap.under}`}
              src={swap.under}
              alt=""
              aria-hidden
              draggable={false}
              data-out={swap.phase === 'in' ? '' : undefined}
              className={cn(styles.image, styles.under)}
            />
          ) : null}
          <img
            key={image}
            src={image}
            alt=""
            draggable={false}
            decoding="async"
            data-swap={swap.phase ?? undefined}
            className={styles.image}
            onLoad={swap.onLoad}
            onAnimationEnd={swap.onSwapEnd}
            onError={onError}
          />
        </>
      ) : (
        <span aria-hidden data-pa-skin={theme} className={styles.monogram}>
          {monogramOf(name)}
        </span>
      )}
    </span>
  );
}

export interface SoulAgentPortraitProps {
  agent: PersonalAgent | null;
  character: PaCharacterView | null;
  fantay: boolean;
  size: number;
  frame?: SoulFrame; // default: the character's own frame
  dim?: boolean;
  className?: string;
  /** Show the sprite of this emotion (else the neutral sprite) instead of the portrait; no sprite → the portrait. */
  emotion?: PaEmotion | null;
}

/** Sprite or portrait image → else PaAvatar (Fantay: the mascot still). Agents without a character use the circle
 *  frame. A sprite change crossfades like any change of image. */
export function SoulAgentPortrait({ agent, character, fantay, size, frame, dim = false, className, emotion = null }: SoulAgentPortraitProps) {
  const appearance = character?.appearance;
  const ownFrame = useMemo<SoulFrame>(
    () => (character && !fantay ? soulFrameOf(resolveAppearance(appearance)) : 'circle'),
    [character, fantay, appearance],
  );
  const sprite = emotion && character && !fantay ? spriteFor(character.sprites, emotion) : null;
  return (
    <SoulPortrait
      src={paSoulAssetUrl(sprite ?? character?.portraitAssetId)}
      name={character?.nickname || agent?.name || ''}
      size={size}
      frame={frame ?? ownFrame}
      dim={dim}
      className={className}
      fallback={<PaAvatar agent={agent} size={size} fantay={fantay} />}
    />
  );
}

export interface SoulPortraitCoverProps {
  src: string | null;
  name: string;
  theme?: PaChatTheme;
  mascot?: boolean;
  className?: string;
}

/** Fills its parent box: the image, the Fantay mascot still on its disc tint, or a monogram on the theme's paper
 *  with the theme's own pattern. */
export function SoulPortraitCover({ src, name, theme = 'fantay', mascot = false, className }: SoulPortraitCoverProps) {
  const { image, onError } = useLoadable(src);
  if (image) {
    return (
      <span role="img" aria-label={name || undefined} data-slot="soul-portrait-cover" className={cn(styles.cover, className)}>
        <img src={image} alt="" draggable={false} decoding="async" className={styles.image} onError={onError} />
      </span>
    );
  }
  if (mascot) {
    return (
      <span role="img" aria-label={name || undefined} data-slot="soul-portrait-cover" data-mascot="" className={cn(styles.cover, styles.coverMascot, className)}>
        <FantayMascotStill size={COVER_MASCOT} />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={name || undefined}
      data-slot="soul-portrait-cover"
      data-monogram=""
      data-pa-skin={theme}
      data-pa-pattern={PA_THEME_META[theme]?.pattern ?? 'none'}
      className={cn(styles.cover, scopeStyles.paper, styles.coverMonogram, className)}
    >
      <span aria-hidden className={styles.coverGlyph}>
        {monogramOf(name)}
      </span>
    </span>
  );
}
