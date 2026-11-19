// SPDX-License-Identifier: AGPL-3.0-only
// The HTML body of a message, in the frame that cannot run script (`parts/SandboxFrame.tsx`). The
// frame is as tall as the message, so the header, the attachments and the body scroll as one column;
// a layout wider than the column is drawn smaller to fit (never below 60%, after that it scrolls
// sideways inside the frame, and the viewer marks the edge). Pictures the message carries (`cid:`) get `blob:` addresses made from
// its own parts and released when the body is replaced. Hovering or focusing a link reports its real
// address, so a link whose words say one place and whose address says another can be seen for what
// it is; what a click does is the viewer's (`onLink`).
//
// Remote pictures (`remotePictures`, the reader asked): the frame's policy is part of its document
// and cannot change, so turning them on or off makes a second frame. It is filled out of sight, at
// the shown one's width, and takes its place once its pictures have arrived (or after
// `SWAP_WAIT_MS`), so the reader sees one change: boxes become pictures, nothing blinks and the
// column keeps its place. New content while pictures are shown takes the same way in (its pictures
// would otherwise arrive one by one in front of the reader); with pictures blocked it goes straight
// into the shown frame, as it always has. A shown picture that does not load becomes the same quiet
// box a blocked one is, and the frame takes its new height.
'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';

import { cn } from '../../../ui';
import styles from '../EmailViewer.module.css';
import { SandboxFrame } from '../parts/SandboxFrame';
import { MAIL_FRAME_CSS, MAIL_GUARD_CSS } from './frame-css';
import { pictureType } from './mail-format';
import type { MailAttachment } from './mail-types';
import { CID_ATTRIBUTE, blockedBox, type PreparedMailHtml } from './sanitize-mail';

/** A wide layout is drawn at least this large (smaller, its words stop being readable); beyond that it scrolls sideways. */
const MIN_FIT_ZOOM = 0.6;
/** The new frame takes over after this even if some of its pictures are still on their way. */
const SWAP_WAIT_MS = 1500;

export interface MailFrameProps {
  title: string;
  /** Made with the same `remotePictures` as given here. */
  prepared: PreparedMailHtml;
  /** Pictures may load from the network (the reader asked, for this message). */
  remotePictures?: boolean;
  /** The message's parts, for its `cid:` pictures. */
  attachments: readonly MailAttachment[];
  /** A link was activated. Return true when handled (the frame never navigates either way). */
  onLink(href: string, anchor: Element, frame: HTMLIFrameElement | null): boolean;
  /** The address under the pointer or the focus; null when there is none. */
  onHover(href: string | null): void;
  /** The frame has its height. `sideways`: the message is still wider than the column and scrolls. */
  onFitted(sideways: boolean): void;
  /** How many shown remote pictures did not load (they are boxes now); 0 again for new content. */
  onPicturesFailed?(count: number): void;
  className?: string;
}

type Callbacks = Pick<MailFrameProps, 'onLink' | 'onHover' | 'onFitted' | 'onPicturesFailed'>;

/** One frame document: a message's content made one way (`remote` or not). */
interface Layer {
  /** Its own document: a new one gets a new id. */
  id: number;
  remote: boolean;
  prepared: PreparedMailHtml;
}

interface Layers {
  shown: Layer;
  /** Being made out of sight; takes `shown`'s place when ready. */
  incoming: Layer | null;
  serial: number;
}

function anchorOf(target: EventTarget | null): Element | null {
  const element = target as Element | null;
  return element && typeof element.closest === 'function' ? element.closest('a[href]') : null;
}

function isRemotePicture(element: Element | null): element is Element {
  return element?.localName === 'img' && /^https?:/i.test(element.getAttribute('src') ?? '');
}

interface FrameLayerProps {
  title: string;
  layer: Layer;
  attachments: readonly MailAttachment[];
  /** In view and in the column's flow; otherwise being filled out of sight before it takes over. */
  shown: boolean;
  callbacks: MutableRefObject<Callbacks>;
  /** A layer out of sight is ready to be shown. */
  onReady(id: number): void;
  className?: string;
}

function FrameLayer({ title, layer, attachments, shown, callbacks, onReady, className }: FrameLayerProps): JSX.Element {
  const { id, prepared, remote } = layer;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [frameDocument, setFrameDocument] = useState<Document | null>(null);
  const addresses = useRef<string[]>([]);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const [failed, setFailed] = useState(0);

  /** Sizes the frame to the message: fit the width first, then take the height that gives. */
  const fit = useCallback(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc?.body || frame.clientWidth === 0) return;
    const root = doc.documentElement;
    const inset = getComputedStyle(frame).getPropertyValue('--mail-inset').trim();
    if (inset) root.style.setProperty('--fx-pad', inset);
    root.style.setProperty('--fx-zoom', '1');
    const room = doc.body.clientWidth;
    const natural = doc.body.scrollWidth;
    const zoom = natural > room + 1 && room > 0 ? Math.max(MIN_FIT_ZOOM, room / natural) : 1;
    root.style.setProperty('--fx-zoom', String(Math.round(zoom * 1000) / 1000));
    // A sideways scrollbar, where the system draws one, takes height from the window.
    const bar = Math.max(0, (doc.defaultView?.innerHeight ?? 0) - root.clientHeight);
    const height = `${Math.ceil(root.getBoundingClientRect().height) + bar}px`;
    if (frame.style.height !== height) frame.style.height = height;
    if (shownRef.current) callbacks.current.onFitted(natural * zoom > room + 1);
  }, [callbacks]);

  const onFrameReady = useCallback(
    (ready: Document) => {
      if (!ready.head.querySelector('style[data-mail]')) {
        const own = ready.createElement('style');
        own.setAttribute('data-mail', '');
        const guard = ready.createElement('style');
        guard.textContent = MAIL_GUARD_CSS;
        ready.head.append(own, guard);
      }
      setFrameDocument(ready);

      const onOver = (event: Event): void => callbacks.current.onHover(anchorOf(event.target)?.getAttribute('href') ?? null);
      const onLeave = (): void => callbacks.current.onHover(null);
      // A picture that arrives late changes the height; one that does not arrive becomes a box.
      const onSettle = (event: Event): void => {
        const target = event.target as Element | null;
        if (target?.localName !== 'img') return;
        if (event.type === 'error' && isRemotePicture(target)) {
          target.replaceWith(blockedBox(target));
          setFailed((count) => count + 1);
        }
        fit();
      };
      ready.addEventListener('mouseover', onOver);
      ready.addEventListener('focusin', onOver);
      ready.addEventListener('focusout', onLeave);
      ready.documentElement.addEventListener('mouseleave', onLeave);
      ready.addEventListener('load', onSettle, true);
      ready.addEventListener('error', onSettle, true);
      void ready.fonts?.ready.then(fit);
      return () => {
        ready.removeEventListener('mouseover', onOver);
        ready.removeEventListener('focusin', onOver);
        ready.removeEventListener('focusout', onLeave);
        ready.documentElement.removeEventListener('mouseleave', onLeave);
        ready.removeEventListener('load', onSettle, true);
        ready.removeEventListener('error', onSettle, true);
      };
    },
    [callbacks, fit],
  );

  // ── the message goes in, in one step ──────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    if (!frameDocument) return;
    const own = frameDocument.head.querySelector('style[data-mail]');
    if (own && own.textContent !== prepared.css) own.textContent = prepared.css;
    if (prepared.bodyStyle) frameDocument.body.setAttribute('style', prepared.bodyStyle);
    else frameDocument.body.removeAttribute('style');

    const content = prepared.fragment.cloneNode(true) as DocumentFragment;
    const made = new Map<string, string>();
    for (const image of Array.from(content.querySelectorAll(`img[${CID_ATTRIBUTE}]`))) {
      const cid = image.getAttribute(CID_ATTRIBUTE) ?? '';
      image.removeAttribute(CID_ATTRIBUTE);
      let address = made.get(cid);
      if (address === undefined) {
        const part = attachments.find((attachment) => attachment.contentId === cid);
        const type = part ? pictureType(part) : null;
        address = part && type ? URL.createObjectURL(new Blob([part.content], { type })) : '';
        made.set(cid, address);
      }
      if (address) image.setAttribute('src', address);
      else image.remove();
    }
    frameDocument.body.replaceChildren(content);
    for (const address of addresses.current) URL.revokeObjectURL(address);
    addresses.current = [...made.values()].filter(Boolean);
    setFailed(0);
    fit();
  }, [frameDocument, prepared, attachments, fit]);

  // ── out of sight: ready once its pictures are in, or have had their time ──────────────────────
  useEffect(() => {
    if (shown || !frameDocument) return;
    const doc = frameDocument;
    const waiting = (): boolean => Array.from(doc.images).some((image) => !image.complete);
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      fit();
      onReady(id);
    };
    if (!waiting()) {
      finish();
      return;
    }
    const check = (event: Event): void => {
      if ((event.target as Element | null)?.localName === 'img' && !waiting()) finish();
    };
    doc.addEventListener('load', check, true);
    doc.addEventListener('error', check, true);
    const timer = window.setTimeout(finish, SWAP_WAIT_MS);
    return () => {
      doc.removeEventListener('load', check, true);
      doc.removeEventListener('error', check, true);
      window.clearTimeout(timer);
    };
  }, [shown, frameDocument, prepared, id, fit, onReady]);

  // ── in view: the viewer hears this frame's size and its failed pictures ───────────────────────
  useEffect(() => {
    if (shown) fit();
  }, [shown, fit]);
  useEffect(() => {
    if (shown) callbacks.current.onPicturesFailed?.(failed);
  }, [shown, failed, callbacks]);

  // ── the column's width changes: fit again ─────────────────────────────────────────────────────
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !frameDocument || typeof ResizeObserver === 'undefined') return;
    let width = frame.clientWidth;
    const observer = new ResizeObserver(() => {
      if (frame.clientWidth === width) return;
      width = frame.clientWidth;
      fit();
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frameDocument, fit]);

  useEffect(
    () => () => {
      for (const address of addresses.current) URL.revokeObjectURL(address);
      addresses.current = [];
    },
    [],
  );

  return (
    <SandboxFrame
      ref={frameRef}
      title={title}
      css={MAIL_FRAME_CSS}
      remotePictures={remote}
      className={cn(className, !shown && styles.frameIncoming)}
      onReady={onFrameReady}
      onLink={(href, anchor) => callbacks.current.onLink(href, anchor, frameRef.current)}
    />
  );
}

export function MailFrame({
  title,
  prepared,
  remotePictures = false,
  attachments,
  onLink,
  onHover,
  onFitted,
  onPicturesFailed,
  className,
}: MailFrameProps): JSX.Element {
  const callbacks = useRef<Callbacks>({ onLink, onHover, onFitted, onPicturesFailed });
  callbacks.current = { onLink, onHover, onFitted, onPicturesFailed };

  // The shown frame, and the one being made out of sight (see the top of the file).
  const [layers, setLayers] = useState<Layers>(() => ({ shown: { id: 0, remote: remotePictures, prepared }, incoming: null, serial: 0 }));
  let current = layers;
  const { shown, incoming, serial } = layers;
  if (remotePictures === shown.remote && prepared === shown.prepared) {
    // Back to what is on screen: whatever was being made is not needed.
    if (incoming) current = { shown, incoming: null, serial };
  } else if (remotePictures === shown.remote && !remotePictures) {
    // Pictures blocked, new content: straight into the shown frame.
    current = { shown: { ...shown, prepared }, incoming: null, serial };
  } else if (incoming?.remote === remotePictures) {
    // Newer content for the frame being made: into it, out of sight.
    if (incoming.prepared !== prepared) current = { shown, incoming: { ...incoming, prepared }, serial };
  } else {
    current = { shown, incoming: { id: serial + 1, remote: remotePictures, prepared }, serial: serial + 1 };
  }
  if (current !== layers) setLayers(current);

  const onReady = useCallback((id: number) => {
    setLayers((previous) => (previous.incoming?.id === id ? { ...previous, shown: previous.incoming, incoming: null } : previous));
  }, []);

  // Keyed by document: a different policy, or pictures that must arrive out of sight, is a new one.
  const frame = (layer: Layer, inView: boolean): JSX.Element => (
    <FrameLayer
      key={layer.id}
      title={title}
      layer={layer}
      attachments={attachments}
      shown={inView}
      callbacks={callbacks}
      onReady={onReady}
      className={className}
    />
  );
  return (
    <>
      {frame(current.shown, true)}
      {current.incoming ? frame(current.incoming, false) : null}
    </>
  );
}
