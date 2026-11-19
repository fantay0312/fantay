// SPDX-License-Identifier: AGPL-3.0-only
// Presenting: one slide on black, as large as the screen allows. It asks the browser for the whole
// screen and, when that is refused, fills the viewer's own frame instead. Arrows, space and a click
// move through the deck (slides the author hid are skipped), Esc leaves. The count and the close
// button show for a moment after each move and then get out of the way.
'use client';

import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { useT } from '../../../../i18n';
import { IconButton } from '../../../ui';
import styles from './Presenter.module.css';
import type { DeckInfo } from './protocol';
import { firstShown, nextShown } from './slide-layout';
import type { SlideState } from './use-deck';

/** How long the count and the close button stay after the last move. */
const CHROME_MS = 1800;

export interface PresenterProps {
  /** The viewer's frame. The presentation fills it when the screen cannot be taken. */
  host: HTMLElement;
  deck: DeckInfo;
  slides: ReadonlyMap<number, SlideState>;
  /** The slide to open on, 0-based. */
  start: number;
  /** The file's name, for the accessible label. */
  name: string;
  want(indices: readonly number[]): void;
  /** Called once, with the slide the presentation ended on. */
  onExit(index: number): void;
}

export function Presenter({ host, deck, slides, start, name, want, onExit }: PresenterProps): JSX.Element {
  const t = useT();
  const hidden = deck.slides.map((slide) => slide.hidden);
  const [index, setIndex] = useState(() => firstShown(hidden, start));
  const [chrome, setChrome] = useState(true);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const leftRef = useRef(false);

  const leave = useCallback(() => {
    if (leftRef.current) return;
    leftRef.current = true;
    exitRef.current(indexRef.current);
  }, []);

  // ── the screen ────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const element = overlayRef.current;
    if (!element) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.focus({ preventScroll: true });
    let entered = false;
    const onChange = (): void => {
      if (document.fullscreenElement === element) entered = true;
      // The browser's own Esc leaves fullscreen without a key event: that ends the presentation.
      else if (entered) leave();
    };
    document.addEventListener('fullscreenchange', onChange);
    // Refused (no permission, embedded, unsupported): the overlay already fills the viewer's frame.
    void Promise.resolve(element.requestFullscreen?.({ navigationUI: 'hide' })).catch(() => undefined);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => undefined);
      before?.focus({ preventScroll: true });
    };
  }, [leave]);

  // ── the slide ─────────────────────────────────────────────────────────────────────────────────
  const count = deck.slides.length;
  const hiddenKey = hidden.join();
  useEffect(() => {
    const flags = hiddenKey.split(',').map((flag) => flag === 'true');
    want([index, nextShown(flags, index, 1), nextShown(flags, index, -1)]);
  }, [hiddenKey, index, want]);

  const go = useCallback(
    (to: number) => {
      setIndex(Math.min(count - 1, Math.max(0, to)));
      setChrome(true);
    },
    [count],
  );
  const step = useCallback((direction: 1 | -1) => go(nextShown(hidden, indexRef.current, direction)), [go, hidden]);

  // The count and the close button leave after a pause; any move of the pointer brings them back.
  useEffect(() => {
    if (!chrome) return;
    const timer = window.setTimeout(() => setChrome(false), CHROME_MS);
    return () => window.clearTimeout(timer);
  }, [chrome, index]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // On the close button, Enter and space press the button.
    if (event.target !== event.currentTarget && (event.key === 'Enter' || event.key === ' ')) return;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
      case 'PageDown':
      case ' ':
      case 'Enter':
        step(1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'PageUp':
      case 'Backspace':
        step(-1);
        break;
      case 'Home':
        go(firstShown(hidden, 0));
        break;
      case 'End':
        go(firstShown(hidden, count - 1));
        break;
      case 'Escape':
        leave();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const state = slides.get(index);
  const slide = deck.slides[index];
  // The slides either side are kept in the frame, unseen, so the browser has them decoded and a
  // step shows the next slide at once instead of a white frame.
  const stack = [...new Set([index, nextShown(hidden, index, 1), nextShown(hidden, index, -1)])].flatMap((position) => {
    const entry = slides.get(position);
    return entry && entry !== 'failed' ? [{ position, url: entry.url }] : [];
  });
  const label = t('artifact.slides.slideLabel', { index: index + 1 });
  const ratio: CSSProperties = { ['--slide-ratio' as string]: String(deck.width / deck.height) };

  return createPortal(
    <div
      ref={overlayRef}
      className={styles.presenter}
      // The presentation is dark whatever the app's theme, so the controls on it use the dark tokens.
      data-theme="dark"
      data-chrome={chrome || undefined}
      data-presenter=""
      role="dialog"
      aria-modal="true"
      aria-label={t('artifact.slides.presenting', { name })}
      tabIndex={-1}
      style={ratio}
      onKeyDown={onKeyDown}
      onClick={() => step(1)}
      onPointerMove={() => setChrome(true)}
    >
      <div className={styles.frame} role="img" aria-label={slide?.title ? `${label} · ${slide.title}` : label}>
        {stack.map(({ position, url }) => (
          <img key={position} className={styles.picture} data-current={position === index || undefined} src={url} alt="" draggable={false} />
        ))}
        {state === 'failed' ? <p className={styles.failed}>{t('artifact.slides.slideFailed')}</p> : null}
      </div>
      <span className={styles.counter} aria-live="polite" data-presenter-count="">
        {index + 1} / {count}
      </span>
      <span className={styles.close} onClick={(event) => event.stopPropagation()}>
        <IconButton
          size="md"
          shape="round"
          aria-label={t('artifact.slides.endPresent')}
          // A tooltip is drawn outside the fullscreen element, where it could not be seen.
          tooltip={false}
          tabIndex={chrome ? 0 : -1}
          onClick={leave}
        >
          <X aria-hidden="true" strokeWidth={1.75} />
        </IconButton>
      </span>
    </div>,
    host,
  );
}
