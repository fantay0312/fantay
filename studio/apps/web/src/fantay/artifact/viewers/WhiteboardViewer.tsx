// SPDX-License-Identifier: AGPL-3.0-only
// Excalidraw drawings (`.excalidraw`): the scene drawn by Excalidraw's own exporter, hand-drawn
// strokes and fonts as excalidraw.com draws them, shown as one picture on the canvas stage. It opens
// fitted to the window and never enlarged; ⌘-scroll or a pinch zooms around the pointer, dragging
// and the arrow keys pan, a double click goes back to "fit". The picture is an SVG in an <img>, so
// nothing in the file can run, load or navigate. "Source" shows the JSON, laid out when minified.
// Light and dark: a drawing keeps the paper it was drawn on (white paper stays white, the way a PDF
// page does), and a file saved in Excalidraw's dark theme keeps that look in both app themes. Only a
// drawing without paper follows the app: in the dark theme it is inked with Excalidraw's own dark
// rendering, so its strokes stay readable on the dark ground. The reader's zoom and place survive a
// tab switch and every rewrite by the agent; a half-written file keeps the last good picture.
'use client';

import { Check, Copy, FileDown, FileWarning, Hourglass, ImageDown, Images, Shapes, WrapText } from 'lucide-react';
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
import { copyText, downloadBlob } from '../../board/interaction/file-actions';
import { LARGE_TEXT_BYTES } from '../../workspace/code/text-preview';
import { ArtifactShell, type ArtifactAction, type ArtifactMenuEntry, type ArtifactShellState } from '../shell/ArtifactShell';
import { ArtifactZoom, nextZoomStep } from '../shell/ArtifactZoom';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { formatBytes, useArtifactText } from '../use-artifact-source';
import { readArtifactViewState, useArtifactViewState, writeArtifactViewState } from '../use-view-state';
import type { ArtifactViewerProps } from '../viewer-types';
import { readJson } from './text/json-format';
import { TextPane } from './text/TextPane';
import {
  CAMERA_PAD,
  MAX_ZOOM,
  MIN_ZOOM,
  centreFor,
  centrePoint,
  clampZoom,
  fitZoom,
  pictureAt,
  scrollToPut,
  type CameraCentre,
  type Point,
  type Size,
} from './whiteboard/camera';
import { preloadWhiteboardLibrary } from './whiteboard/draw';
import { copyPicture, pictureBaseName, pictureToPng, useIsDarkTheme } from './whiteboard/picture-files';
import { MAX_SCENE_FILE_BYTES, hashText, readScene } from './whiteboard/scene';
import { useWhiteboardPicture } from './whiteboard/use-whiteboard-picture';
import styles from './WhiteboardViewer.module.css';

type WhiteboardMode = 'drawing' | 'source';

const COPIED_MS = 1500;
/** Arrow keys move the camera this far; with Shift, most of a window. */
const KEY_PAN = 48;

export default function WhiteboardViewer({ projectId, file, active }: ArtifactViewerProps): JSX.Element {
  const t = useT();
  const fileActions = useArtifactFileActions(projectId, file);
  const [mode, setMode] = useArtifactViewState<WhiteboardMode>(projectId, file.name, 'mode', 'drawing');
  const [wrap, setWrap] = useArtifactViewState<boolean>(projectId, file.name, 'wrap', false);
  const showingSource = mode === 'source';

  // The library is large: start fetching it as soon as the drawing is wanted, while the file loads.
  useEffect(() => {
    if (active && !showingSource) preloadWhiteboardLibrary();
  }, [active, showingSource]);

  // ── the file and the picture ──────────────────────────────────────────────────────────────────
  const text = useArtifactText(projectId, file, { enabled: active, maxBytes: MAX_SCENE_FILE_BYTES });
  const raw = text.source.status === 'ready' ? text.source.data : null;
  const reading = useMemo(() => (raw === null ? null : readScene(raw)), [raw]);
  const contentKey = useMemo(() => (raw === null ? 'pending' : hashText(raw)), [raw]);
  const appDark = useIsDarkTheme();
  const scene = reading?.kind === 'scene' ? reading.scene : null;
  const dark = scene ? scene.authoredDark || (scene.background === null && appDark) : false;
  const fileKey = `${projectId}\n${file.name}`;
  const renderKey = `${fileKey}\n${contentKey}\n${dark ? 'dark' : 'light'}`;
  const { shown, phase, redraw } = useWhiteboardPicture({ fileKey, renderKey, scene, dark, enabled: active && !showingSource });
  const picture = shown?.picture ?? null;

  // ── size and zoom ─────────────────────────────────────────────────────────────────────────────
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  /** null = fit to the window; a number = that zoom, kept across resizes, tab switches and updates. */
  const [zoom, setZoom] = useArtifactViewState<number | null>(projectId, file.name, 'zoom', null);
  /** The picture point to keep under the pointer when the zoom changes. */
  const anchorRef = useRef<{ point: Point; at: Point } | null>(null);

  const size = useMemo<Size | null>(() => (picture ? { width: picture.width, height: picture.height } : null), [picture]);
  const fit = size ? fitZoom(size, viewport) : 1;
  const scale = zoom ?? fit;
  const hasPicture = shown !== null && !showingSource;

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasPicture]);

  const zoomAt = useCallback(
    (next: number | null, clientX?: number, clientY?: number) => {
      const element = viewportRef.current;
      if (element && size) {
        const rect = element.getBoundingClientRect();
        const view = { width: element.clientWidth, height: element.clientHeight };
        const at = {
          x: clientX === undefined ? view.width / 2 : clientX - rect.left,
          y: clientY === undefined ? view.height / 2 : clientY - rect.top,
        };
        const current = zoom ?? fitZoom(size, view);
        anchorRef.current = { point: pictureAt({ x: element.scrollLeft, y: element.scrollTop }, at, view, size, current), at };
      }
      setZoom(next === null ? null : clampZoom(next));
    },
    [size, zoom, setZoom],
  );

  // After the zoom has been applied, scroll so the anchored point is back under the pointer.
  useLayoutEffect(() => {
    const element = viewportRef.current;
    const anchor = anchorRef.current;
    if (!element || !anchor || !size) return;
    anchorRef.current = null;
    const target = scrollToPut(anchor.point, anchor.at, { width: element.clientWidth, height: element.clientHeight }, size, scale);
    element.scrollLeft = target.x;
    element.scrollTop = target.y;
  }, [scale, size]);

  // ── the reader's place ────────────────────────────────────────────────────────────────────────
  // When a picture arrives (on opening, after a tab switch, after the agent's rewrite), the drawing
  // point that was in the middle of the window goes back there. Scrolling records it again.
  const placedRef = useRef<{ element: HTMLDivElement; url: string } | null>(null);
  const cameraRef = useRef({ size, scale, zoom, origin: picture?.origin ?? null });
  cameraRef.current = { size, scale, zoom, origin: picture?.origin ?? null };

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element || !shown || !size) return;
    if (placedRef.current?.element === element && placedRef.current.url === shown.url) return;
    placedRef.current = { element, url: shown.url };
    if (zoom === null) return;
    const centre = readArtifactViewState<CameraCentre>(projectId, file.name, 'centre');
    const point = centre ? centrePoint(centre, shown.picture.origin) : null;
    if (!point) return;
    const view = { width: element.clientWidth, height: element.clientHeight };
    const target = scrollToPut(point, { x: view.width / 2, y: view.height / 2 }, view, size, scale);
    element.scrollLeft = target.x;
    element.scrollTop = target.y;
  }, [shown, size, scale, zoom, projectId, file.name, hasPicture]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    let frame = 0;
    const record = (): void => {
      frame = 0;
      const camera = cameraRef.current;
      if (!camera.size || camera.zoom === null) return;
      const view = { width: element.clientWidth, height: element.clientHeight };
      const centre = centreFor({ x: element.scrollLeft, y: element.scrollTop }, view, camera.size, camera.scale, camera.origin);
      writeArtifactViewState(projectId, file.name, 'centre', centre);
    };
    const onScroll = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(record);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [hasPicture, projectId, file.name]);

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
  }, [size, zoom, zoomAt, hasPicture]);

  // ── panning ───────────────────────────────────────────────────────────────────────────────────
  const dragRef = useRef<{ x: number; y: number; left: number; top: number; id: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const pannable =
    size !== null && (size.width * scale + CAMERA_PAD * 2 > viewport.width + 1 || size.height * scale + CAMERA_PAD * 2 > viewport.height + 1);

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
    const element = event.currentTarget;
    const command = event.metaKey || event.ctrlKey;
    const across = event.shiftKey ? Math.round(element.clientWidth * 0.8) : KEY_PAN;
    const down = event.shiftKey ? Math.round(element.clientHeight * 0.8) : KEY_PAN;
    if (!command && event.key === 'ArrowLeft') element.scrollLeft -= across;
    else if (!command && event.key === 'ArrowRight') element.scrollLeft += across;
    else if (!command && event.key === 'ArrowUp') element.scrollTop -= down;
    else if (!command && event.key === 'ArrowDown') element.scrollTop += down;
    else if (event.key === '+' || event.key === '=') zoomAt(nextZoomStep(scale, 1, MIN_ZOOM, MAX_ZOOM));
    else if (event.key === '-' || event.key === '_') zoomAt(nextZoomStep(scale, -1, MIN_ZOOM, MAX_ZOOM));
    else if (event.key === '0') zoomAt(null);
    else if (!command && event.key === '1') zoomAt(1);
    else return;
    event.preventDefault();
  };

  // ── source view ───────────────────────────────────────────────────────────────────────────────
  /** A minified file is laid out for reading; one already laid out is shown as it is. */
  const source = useMemo(() => {
    if (!showingSource || raw === null) return null;
    const json = readJson(raw);
    return json.preferFormatted && json.formatted !== null ? { text: json.formatted, view: 'formatted' } : { text: raw, view: 'source' };
  }, [showingSource, raw]);

  // ── actions ───────────────────────────────────────────────────────────────────────────────────
  const [copied, setCopied] = useState<'picture' | 'source' | null>(null);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );
  const flashCopied = useCallback((what: 'picture' | 'source') => {
    setCopied(what);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(null), COPIED_MS);
  }, []);

  const baseName = pictureBaseName(file.name);
  const menu = useMemo<ArtifactMenuEntry[]>(() => {
    const shared = fileActions.menu.map((entry, index) => (index === 0 ? { ...entry, separated: true } : entry));
    return [
      {
        id: 'copy-image',
        label: copied === 'picture' ? t('fileViewer.copied') : t('artifact.image.copy'),
        icon: copied === 'picture' ? Check : Copy,
        disabled: !picture,
        onSelect: () => {
          if (picture) void copyPicture(picture).then((done) => done && flashCopied('picture'));
        },
      },
      {
        id: 'save-svg',
        label: t('artifact.whiteboard.saveSvg'),
        icon: FileDown,
        disabled: !picture,
        onSelect: () => {
          if (picture) downloadBlob(picture.svg, `${baseName}.svg`);
        },
      },
      {
        id: 'save-png',
        label: t('artifact.whiteboard.savePng'),
        icon: ImageDown,
        disabled: !picture,
        onSelect: () => {
          if (picture) void pictureToPng(picture).then((blob) => downloadBlob(blob, `${baseName}.png`), () => undefined);
        },
      },
      ...shared,
    ];
  }, [baseName, copied, fileActions.menu, flashCopied, picture, t]);

  const actions = useMemo<ArtifactAction[]>(() => {
    if (!showingSource) return [fileActions.download];
    return [
      { id: 'wrap', label: t('workspace.code.wrap'), icon: WrapText, on: wrap, disabled: raw === null, onSelect: () => setWrap((value) => !value) },
      {
        id: 'copy',
        label: copied === 'source' ? t('fileViewer.copied') : t('artifact.text.copyAll'),
        icon: copied === 'source' ? Check : Copy,
        disabled: source === null,
        onSelect: () => {
          if (source) void copyText(source.text).then((done) => done && flashCopied('source'));
        },
      },
      fileActions.download,
    ];
  }, [showingSource, fileActions.download, t, wrap, setWrap, raw, copied, source, flashCopied]);

  // ── facts ─────────────────────────────────────────────────────────────────────────────────────
  const stats = reading && 'stats' in reading ? reading.stats : null;
  const facts = [
    stats && stats.elements > 0
      ? stats.elements === 1
        ? t('artifact.whiteboard.elementsOne')
        : t('artifact.whiteboard.elements', { count: stats.elements.toLocaleString() })
      : null,
    stats && stats.images > 0
      ? stats.images === 1
        ? t('artifact.whiteboard.imagesOne')
        : t('artifact.whiteboard.images', { count: stats.images.toLocaleString() })
      : null,
    formatBytes(file.size),
  ].filter(Boolean);

  // ── state ─────────────────────────────────────────────────────────────────────────────────────
  const toSource = { label: t('artifact.notebook.showSource'), onSelect: () => setMode('source') };
  const download = { label: t('fileViewer.download'), onSelect: fileActions.downloadFile };
  /** True when a picture of an earlier version stays up because the latest one cannot be shown. */
  let previous = false;
  let state: ArtifactShellState | null = null;
  if (showingSource) {
    state = fileActions.sourceState(text.source, text.reload);
  } else if (reading === null) {
    if (!shown || text.source.status === 'too-large') state = fileActions.sourceState(text.source, text.reload);
  } else if (reading.kind === 'damaged' || reading.kind === 'not-scene') {
    if (shown && reading.kind === 'damaged') previous = true;
    else {
      const damaged = reading.kind === 'damaged';
      state = {
        kind: 'notice',
        icon: FileWarning,
        title: t(damaged ? 'artifact.whiteboard.damaged' : 'artifact.whiteboard.notScene'),
        description: t(damaged ? 'artifact.whiteboard.damagedHint' : 'artifact.whiteboard.notSceneHint'),
        action: toSource,
        secondaryAction: download,
      };
    }
  } else if (reading.kind === 'empty' || (reading.kind === 'scene' && phase === 'nothing')) {
    state = { kind: 'notice', icon: Shapes, title: t('artifact.whiteboard.empty'), description: t('artifact.whiteboard.emptyHint') };
  } else if (reading.kind === 'too-many-elements') {
    state = {
      kind: 'notice',
      icon: Shapes,
      title: t('artifact.whiteboard.tooMany'),
      description: t('artifact.whiteboard.tooManyHint', { count: reading.count.toLocaleString(), limit: reading.limit.toLocaleString() }),
      action: toSource,
      secondaryAction: download,
    };
  } else if (reading.kind === 'too-many-bytes') {
    state = {
      kind: 'notice',
      icon: Images,
      title: t('artifact.whiteboard.imagesTooLarge'),
      description: t('artifact.whiteboard.imagesTooLargeHint', { size: formatBytes(reading.bytes), limit: formatBytes(reading.limit) }),
      action: download,
      secondaryAction: toSource,
    };
  } else if (phase === 'failed' || phase === 'timeout') {
    if (shown) previous = true;
    else if (phase === 'failed') {
      state = {
        kind: 'notice',
        icon: FileWarning,
        title: t('artifact.whiteboard.failed'),
        description: t('artifact.whiteboard.failedHint'),
        action: toSource,
        secondaryAction: download,
      };
    } else {
      state = {
        kind: 'notice',
        icon: Hourglass,
        title: t('artifact.whiteboard.slow'),
        description: t('artifact.whiteboard.slowHint'),
        action: { label: t('artifact.whiteboard.redraw'), onSelect: redraw },
        secondaryAction: toSource,
      };
    }
  } else if (!shown) {
    state = phase === 'slow' ? { kind: 'loading', label: t('artifact.whiteboard.drawing') } : { kind: 'loading', quiet: true };
  }

  return (
    <ArtifactShell
      viewer="whiteboard"
      path={file.name}
      stage={showingSource ? 'fill' : 'canvas'}
      modes={[
        { id: 'drawing', label: t('artifact.whiteboard.viewDrawing') },
        { id: 'source', label: t('artifact.notebook.viewSource') },
      ]}
      mode={mode}
      modesLabel={t('artifact.viewMode')}
      onModeChange={(next) => setMode(next === 'source' ? 'source' : 'drawing')}
      controls={
        showingSource || state !== null || !size ? null : (
          <ArtifactZoom
            zoom={scale}
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            presets={[0.5, 1, 2, 4]}
            onZoom={(next) => zoomAt(next)}
            onFit={() => zoomAt(null)}
          />
        )
      }
      meta={facts.join(' · ')}
      actions={actions}
      menu={menu}
      menuLabel={t('nextStep.more')}
      state={state}
    >
      {showingSource ? (
        source !== null ? (
          <TextPane
            projectId={projectId}
            fileName={file.name}
            view={source.view}
            languageName={`${file.name}.json`}
            text={source.text}
            wrap={wrap}
            notice={source.text.length > LARGE_TEXT_BYTES ? t('workspace.code.largeFile') : null}
          />
        ) : null
      ) : shown && size ? (
        <div className={styles.surface}>
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
                data-paper={shown.picture.paper || undefined}
                style={{ width: Math.max(1, size.width * scale), height: Math.max(1, size.height * scale) }}
              >
                <img className={styles.image} src={shown.url} alt="" draggable={false} decoding="async" />
              </div>
            </div>
          </div>
          <p className={styles.note} data-shown={previous || undefined} aria-hidden={!previous} role="status">
            {t('artifact.whiteboard.previous')}
          </p>
        </div>
      ) : null}
    </ArtifactShell>
  );
}
