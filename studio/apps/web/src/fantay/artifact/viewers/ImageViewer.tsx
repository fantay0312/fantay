// SPDX-License-Identifier: AGPL-3.0-only
// Images: one picture centred on a quiet ground. It opens fitted to the window and never upscaled;
// pinch or ⌘-scroll zooms around the pointer, dragging pans, a double click switches between "fit"
// and 100%. A checker shows through transparent areas only. SVG adds a "source" view.
// Formats the browser cannot decode (HEIC, TIFF, PSD) go through `decodeImage` first.
'use client';

import { Copy, ImageOff } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { useT } from '../../../i18n';
import { ArtifactShell, type ArtifactMenuEntry, type ArtifactShellState } from '../shell/ArtifactShell';
import { ArtifactZoom, nextZoomStep } from '../shell/ArtifactZoom';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { formatBytes, useArtifactBytes, useArtifactText, useArtifactUrl } from '../use-artifact-source';
import { useArtifactViewState } from '../use-view-state';
import type { ArtifactViewerProps } from '../viewer-types';
import { decodeImage, needsDecoding } from './image-decoders';
import styles from './ImageViewer.module.css';
import { CodePane } from './parts/CodePane';

/** Space kept between the picture and the edge of the stage. */
const PAD = 24;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;
/** From this zoom on, pixels are drawn as squares (for inspecting icons and pixel art). */
const PIXEL_ZOOM = 4;
const MAX_DECODE_BYTES = 80 * 1024 * 1024;

interface Size {
  width: number;
  height: number;
}

/** The zoom that shows the whole picture, never above 100%. */
export function fitZoom(natural: Size, viewport: Size, pad = PAD): number {
  if (natural.width <= 0 || natural.height <= 0) return 1;
  const availableWidth = Math.max(1, viewport.width - pad * 2);
  const availableHeight = Math.max(1, viewport.height - pad * 2);
  return Math.min(1, availableWidth / natural.width, availableHeight / natural.height);
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Where the picture's left/top edge sits inside the scrolling plane at a zoom. */
function frameOffset(viewport: number, natural: number, zoom: number): number {
  return Math.max(PAD, (viewport - natural * zoom) / 2);
}

export default function ImageViewer({ projectId, file, family, active }: ArtifactViewerProps): JSX.Element {
  const t = useT();
  const fileActions = useArtifactFileActions(projectId, file);
  const rawUrl = useArtifactUrl(projectId, file);
  const isSvg = family.format === 'svg';
  const decoding = needsDecoding(family.format);
  const [mode, setMode] = useArtifactViewState<'preview' | 'source'>(projectId, file.name, 'mode', 'preview');

  // ── the picture's address ─────────────────────────────────────────────────────────────────────
  const bytes = useArtifactBytes(projectId, file, { enabled: decoding && active, maxBytes: MAX_DECODE_BYTES });
  const [decoded, setDecoded] = useState<{ key: string; url: string } | null>(null);
  const [decodeFailed, setDecodeFailed] = useState<string | null>(null);
  const decodeKey = `${file.name}:${file.mtime}`;
  const decodeSource = bytes.source.status === 'ready' ? bytes.source.data : null;

  useEffect(() => {
    if (!decoding || decodeSource === null) return;
    let current = true;
    let created: string | null = null;
    setDecodeFailed(null);
    decodeImage(family.format, decodeSource).then(
      (blob) => {
        if (!current) return;
        created = URL.createObjectURL(blob);
        setDecoded({ key: decodeKey, url: created });
      },
      () => {
        if (current) setDecodeFailed(decodeKey);
      },
    );
    return () => {
      current = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [decoding, decodeSource, decodeKey, family.format]);

  const imageUrl = decoding ? (decoded?.key === decodeKey ? decoded.url : null) : rawUrl;

  // ── size and zoom ─────────────────────────────────────────────────────────────────────────────
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [natural, setNatural] = useState<{ key: string; size: Size } | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  /** null = fit to the window; a number = that zoom, kept across resizes, tab switches and updates. */
  const [zoom, setZoom] = useArtifactViewState<number | null>(projectId, file.name, 'zoom', null);
  /** The picture point to keep under the pointer when the zoom changes. */
  const anchorRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const size = natural?.key === imageUrl ? natural.size : null;
  const fit = size ? fitZoom(size, viewport) : 1;
  const scale = zoom ?? fit;

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode, imageUrl]);

  const zoomAt = useCallback(
    (next: number | null, clientX?: number, clientY?: number) => {
      const element = viewportRef.current;
      if (element && size) {
        const rect = element.getBoundingClientRect();
        const px = clientX === undefined ? element.clientWidth / 2 : clientX - rect.left;
        const py = clientY === undefined ? element.clientHeight / 2 : clientY - rect.top;
        const current = zoom ?? fitZoom(size, { width: element.clientWidth, height: element.clientHeight });
        anchorRef.current = {
          x: (element.scrollLeft + px - frameOffset(element.clientWidth, size.width, current)) / current,
          y: (element.scrollTop + py - frameOffset(element.clientHeight, size.height, current)) / current,
          px,
          py,
        };
      }
      setZoom(next === null ? null : clampZoom(next));
    },
    [size, zoom],
  );

  // After the zoom has been applied, scroll so the anchored point is back under the pointer.
  useLayoutEffect(() => {
    const element = viewportRef.current;
    const anchor = anchorRef.current;
    if (!element || !anchor || !size) return;
    anchorRef.current = null;
    element.scrollLeft = anchor.x * scale + frameOffset(element.clientWidth, size.width, scale) - anchor.px;
    element.scrollTop = anchor.y * scale + frameOffset(element.clientHeight, size.height, scale) - anchor.py;
  }, [scale, size]);

  // Pinch and ⌘/Ctrl-scroll zoom. The listener is not passive: the page must not zoom instead.
  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !size) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const current = zoom ?? fitZoom(size, { width: element.clientWidth, height: element.clientHeight });
      zoomAt(current * Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [size, zoom, zoomAt, mode]);

  // ── panning ───────────────────────────────────────────────────────────────────────────────────
  const dragRef = useRef<{ x: number; y: number; left: number; top: number; id: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const pannable = size !== null && (size.width * scale + PAD * 2 > viewport.width + 1 || size.height * scale + PAD * 2 > viewport.height + 1);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !pannable) return;
    const element = event.currentTarget;
    dragRef.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop, id: event.pointerId };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!dragging) {
      if (Math.abs(dx) + Math.abs(dy) < 4) return;
      // Captured only once the pointer has really moved, so a plain click still reaches the picture.
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    event.currentTarget.scrollLeft = drag.left - dx;
    event.currentTarget.scrollTop = drag.top - dy;
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.id !== event.pointerId) return;
    dragRef.current = null;
    if (dragging) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      setDragging(false);
    }
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!size) return;
    if (zoom === null && fit < 1) zoomAt(1, event.clientX, event.clientY);
    else zoomAt(null);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!size || event.altKey) return;
    // The zoom keys work bare and with ⌘/Ctrl, as in the PDF, diagram and drawing viewers; with the
    // stage in focus they zoom the picture, not the whole window.
    const command = event.metaKey || event.ctrlKey;
    if (event.key === '+' || event.key === '=') zoomAt(nextZoomStep(scale, 1, MIN_ZOOM, MAX_ZOOM));
    else if (event.key === '-' || event.key === '_') zoomAt(nextZoomStep(scale, -1, MIN_ZOOM, MAX_ZOOM));
    else if (event.key === '0') zoomAt(null);
    else if (!command && event.key === '1') zoomAt(1);
    else return;
    event.preventDefault();
  };

  // ── source view (SVG) ─────────────────────────────────────────────────────────────────────────
  const text = useArtifactText(projectId, file, { enabled: isSvg && mode === 'source' && active });

  // ── actions ───────────────────────────────────────────────────────────────────────────────────
  const [copied, setCopied] = useState(false);
  const copyImage = useCallback(async () => {
    if (!imageUrl || typeof ClipboardItem === 'undefined') return;
    try {
      const response = await fetch(imageUrl);
      let blob = await response.blob();
      if (blob.type !== 'image/png') {
        // The clipboard takes PNG only: redraw the picture once.
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('encode'))), 'image/png'),
        );
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* The clipboard refused (no focus, no permission): nothing to undo. */
    }
  }, [imageUrl]);

  const menu = useMemo<ArtifactMenuEntry[]>(
    () => [
      { id: 'copy-image', label: copied ? t('fileViewer.copied') : t('artifact.image.copy'), icon: Copy, onSelect: () => void copyImage(), disabled: !imageUrl },
      ...fileActions.menu,
    ],
    [copied, copyImage, fileActions.menu, imageUrl, t],
  );

  const facts = [
    size ? `${size.width} × ${size.height}` : null,
    family.extension ? family.extension.toUpperCase() : null,
    formatBytes(file.size),
  ].filter(Boolean);

  // ── state ─────────────────────────────────────────────────────────────────────────────────────
  let state: ArtifactShellState | null = null;
  if (mode === 'source') {
    state = fileActions.sourceState(text.source, text.reload);
  } else if (decoding && decodeFailed === decodeKey) {
    state = fileActions.unsupported(t('artifact.image.decodeFailed'), undefined, ImageOff);
  } else if (decoding && imageUrl === null) {
    state =
      bytes.source.status === 'ready'
        ? { kind: 'loading', label: t('artifact.image.decoding') }
        : fileActions.sourceState(bytes.source, bytes.reload);
  } else if (loadFailed === imageUrl) {
    state = fileActions.unsupported(t('artifact.image.loadFailed'), undefined, ImageOff);
  }

  const showingSource = mode === 'source';

  return (
    <ArtifactShell
      viewer="image"
      path={file.name}
      stage={showingSource ? 'fill' : 'canvas'}
      modes={
        isSvg
          ? [
              { id: 'preview', label: t('fileViewer.preview') },
              { id: 'source', label: t('fileViewer.source') },
            ]
          : undefined
      }
      mode={mode}
      modesLabel={t('artifact.viewMode')}
      onModeChange={(next) => setMode(next === 'source' ? 'source' : 'preview')}
      controls={
        showingSource || state !== null ? null : (
          <ArtifactZoom
            zoom={size ? scale : null}
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            presets={[0.5, 1, 2, 4]}
            onZoom={(next) => zoomAt(next)}
            onFit={() => zoomAt(null)}
          />
        )
      }
      meta={facts.join(' · ')}
      actions={[fileActions.download]}
      menu={menu}
      menuLabel={t('nextStep.more')}
      state={state}
    >
      {showingSource ? (
        text.source.status === 'ready' ? (
          <CodePane docKey={`${file.name}:source`} fileName={file.name} text={text.source.data} wrap />
        ) : null
      ) : imageUrl ? (
        <div
          ref={viewportRef}
          className={styles.viewport}
          data-pannable={pannable || undefined}
          data-dragging={dragging || undefined}
          tabIndex={0}
          role="img"
          aria-label={file.name}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={onDoubleClick}
          onKeyDown={onKeyDown}
        >
          <div className={styles.plane}>
            <div
              className={styles.frame}
              data-ready={size !== null || undefined}
              data-pixel={scale >= PIXEL_ZOOM || undefined}
              style={size ? { width: Math.max(1, size.width * scale), height: Math.max(1, size.height * scale) } : undefined}
            >
              <img
                key={imageUrl}
                className={styles.image}
                src={imageUrl}
                alt=""
                draggable={false}
                decoding="async"
                onLoad={(event) => {
                  const element = event.currentTarget;
                  setNatural({ key: imageUrl, size: { width: element.naturalWidth || 300, height: element.naturalHeight || 150 } });
                }}
                onError={() => setLoadFailed(imageUrl)}
              />
            </div>
          </div>
        </div>
      ) : null}
    </ArtifactShell>
  );
}
