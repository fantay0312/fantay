// SPDX-License-Identifier: AGPL-3.0-only
// A frame that cannot run script, for HTML that was made from a file's content (Word, RTF,
// OpenDocument, book chapters, mail bodies). The file is untrusted, so three things hold together:
//  - `sandbox="allow-same-origin"` and nothing else: no script, no forms, no popups, no navigation
//    of the app. Same-origin is what lets this component (the parent) fill and measure the document;
//    without `allow-scripts` the content cannot use it. Never add `allow-scripts` to this frame.
//  - a `default-src 'none'` policy: only inline styles, and pictures and fonts carried as `data:` or
//    `blob:` addresses, so nothing is ever fetched from the network.
//  - links never navigate the frame: a click is answered here.
// One opt-in, for a mail whose reader asked to see its pictures (`remotePictures`): the policy then
// also lets pictures load over http(s), and the document sends no referrer. Nothing else changes, and
// the policy is fixed for the life of the document, so the caller swaps the frame to change it.
// The caller still sanitises what it puts in (see `document/sanitize.ts`); this frame is the second
// wall, not the first. The frame scrolls itself and fills its box; the product's colour and type
// tokens are copied in so the document's stylesheet can use `var(--paper)` and friends and follows
// the theme without a reload.
'use client';

import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '../../../ui';
import styles from './SandboxFrame.module.css';

/** The policy of every frame document. Inline style only; pictures and fonts only from memory. */
export const SANDBOX_FRAME_CSP =
  "default-src 'none'; img-src data: blob:; font-src data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** The same policy, with pictures also from the network: only for `remotePictures`. */
export const SANDBOX_FRAME_REMOTE_PICTURES_CSP =
  "default-src 'none'; img-src data: blob: https: http:; font-src data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** Tokens copied from the host onto the frame's root, so frame styles are written like product styles. */
export const SANDBOX_FRAME_TOKENS = [
  '--paper',
  '--paper-deep',
  '--surface',
  '--sub',
  '--ink',
  '--ink-soft',
  '--ink-faint',
  '--ink-ghost',
  '--line',
  '--line-soft',
  '--shadow-ring',
  '--focus-ring-color',
  '--font-ui',
  '--font-mono',
] as const;

/**
 * The empty document the frame starts from. `<base target="_blank">` makes any link the click
 * handler misses ask for a new window, which the sandbox refuses: the frame itself never navigates.
 */
export function sandboxFrameDocument(css: string, options: { remotePictures?: boolean } = {}): string {
  // A stylesheet cannot close its own element.
  const safeCss = css.replace(/<\/style/gi, '<\\/style');
  const remote = options.remotePictures === true;
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${remote ? SANDBOX_FRAME_REMOTE_PICTURES_CSP : SANDBOX_FRAME_CSP}">` +
    (remote ? '<meta name="referrer" content="no-referrer">' : '') +
    '<base target="_blank">' +
    `<style data-frame-style="">${safeCss}</style>` +
    '</head><body></body></html>'
  );
}

/** Keys the frame keeps to itself: copying and selecting text must not reach the app's shortcuts. */
const FRAME_OWN_KEYS = new Set(['a', 'c', 'x']);

export interface SandboxFrameProps {
  /** Accessible name: the file's name. */
  title: string;
  /** The frame document's stylesheet. May use the copied tokens. */
  css: string;
  /**
   * Called once with the empty document. Fill `document.body` (with sanitised nodes) and attach
   * listeners; return a cleanup. Nodes of the frame belong to another realm: test them with
   * `nodeType` and `tagName`, never with `instanceof`.
   */
  onReady(document: Document): void | (() => void);
  /**
   * A link was activated. Return true when handled. Otherwise `#id` links scroll inside the frame
   * and http(s) and mailto links open outside the app; everything else is ignored.
   */
  onLink?(href: string, anchor: Element): boolean | void;
  /** Keys pressed while the frame has focus. Call `preventDefault()` to claim one. */
  onKeyDown?(event: KeyboardEvent): void;
  /**
   * Let pictures load over http(s) (a mail whose reader asked for them). Read once, when the frame
   * is made: change it by giving the frame a new `key`.
   */
  remotePictures?: boolean;
  className?: string;
}

function copyTokens(frame: HTMLIFrameElement, target: Document): void {
  const host = getComputedStyle(frame);
  const root = target.documentElement;
  for (const name of SANDBOX_FRAME_TOKENS) root.style.setProperty(name, host.getPropertyValue(name).trim());
  // The same scheme as the host: scrollbars match, and a transparent frame stays transparent.
  root.style.colorScheme = host.colorScheme || 'normal';
}

export const SandboxFrame = forwardRef<HTMLIFrameElement, SandboxFrameProps>(function SandboxFrame(
  { title, css, onReady, onLink, onKeyDown, remotePictures = false, className },
  forwardedRef,
) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [frameDocument, setFrameDocument] = useState<Document | null>(null);
  // The first stylesheet is part of the document; later ones replace the style element's text. The
  // policy is part of it too, and cannot be changed afterwards.
  const initialDocument = useMemo(() => sandboxFrameDocument(css, { remotePictures }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const callbacks = useRef({ onReady, onLink, onKeyDown });
  callbacks.current = { onReady, onLink, onKeyDown };

  const setRef = useCallback(
    (element: HTMLIFrameElement | null) => {
      frameRef.current = element;
      if (typeof forwardedRef === 'function') forwardedRef(element);
      else if (forwardedRef) forwardedRef.current = element;
    },
    [forwardedRef],
  );

  // ── the document's stylesheet ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const style = frameDocument?.querySelector('style[data-frame-style]');
    if (style && style.textContent !== css) style.textContent = css;
  }, [frameDocument, css]);

  // ── tokens follow the theme ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !frameDocument) return;
    const apply = (): void => copyTokens(frame, frameDocument);
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', apply);
    };
  }, [frameDocument]);

  // ── links and keys ────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !frameDocument) return;

    const onClick = (event: MouseEvent): void => {
      const target = event.target as Element | null;
      const anchor = target && typeof target.closest === 'function' ? target.closest('a, area') : null;
      if (!anchor) return;
      // Whatever the link is, the frame does not go there.
      event.preventDefault();
      const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href') ?? '';
      if (callbacks.current.onLink?.(href, anchor) === true) return;
      if (href.startsWith('#')) {
        const id = decodeFragment(href.slice(1));
        const destination = id ? (frameDocument.getElementById(id) ?? frameDocument.getElementsByName(id)[0]) : null;
        destination?.scrollIntoView({ block: 'start' });
        return;
      }
      if (/^(?:https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
    };

    const onKey = (event: KeyboardEvent): void => {
      callbacks.current.onKeyDown?.(event);
      if (event.defaultPrevented) return;
      // The app's shortcuts listen on the host document; a key pressed in here never gets there by
      // itself. Hand over the chords, except the ones that act on the text in the frame.
      if (!(event.metaKey || event.ctrlKey) || FRAME_OWN_KEYS.has(event.key.toLowerCase())) return;
      const copy = new KeyboardEvent('keydown', {
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        repeat: event.repeat,
        bubbles: true,
        cancelable: true,
      });
      if (!frame.dispatchEvent(copy)) event.preventDefault();
    };

    frameDocument.addEventListener('click', onClick);
    frameDocument.addEventListener('auxclick', onClick);
    frameDocument.addEventListener('keydown', onKey);
    return () => {
      frameDocument.removeEventListener('click', onClick);
      frameDocument.removeEventListener('auxclick', onClick);
      frameDocument.removeEventListener('keydown', onKey);
    };
  }, [frameDocument]);

  // ── hand the document to the caller ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!frameDocument) return;
    const cleanup = callbacks.current.onReady(frameDocument);
    return typeof cleanup === 'function' ? cleanup : undefined;
  }, [frameDocument]);

  return (
    <iframe
      ref={setRef}
      className={cn(styles.frame, className)}
      title={title}
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={initialDocument}
      data-artifact-frame=""
      onLoad={(event) => {
        const loaded = event.currentTarget.contentDocument;
        // Only the document this component wrote; anything else is left alone and stays empty.
        if (loaded?.querySelector('style[data-frame-style]')) setFrameDocument(loaded);
      }}
    />
  );
});

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}
