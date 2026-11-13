'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Frame face (spec 03 §4.1, §5): a project HTML page. Not live → its cover (board cover, chat snapshot, stale
// cover) or the page placeholder. Live → the URL or srcdoc transport with reload double-buffering, motion activity,
// the message bridges (current href, observability, capture and comment targets, edit messages), cover capture once
// rendered, and the Edit / Capture / Comment sessions the chrome drives. Every live surface registers a handle in the
// frame registry.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { fitNodeSize } from '@open-design/contracts';

import { useT } from '../../../../i18n';
import { STAGE_ATTACHMENT_EVENT, type StageAttachmentEventDetail } from '../../../../components/ChatComposer';
import { uploadProjectFiles, writeProjectTextFileDetailed } from '../../../../providers/registry';
import { Button } from '../../../ui/button';
import { Spinner } from '../../../ui/spinner';
import { toast } from '../../../ui/toast';
import { useFrameCommentSession } from '../../comments/use-board-comment-session';
import { useBoardEngine, useBoardHost } from '../../context';
import {
  captureLiveCover,
  COVER_CAPTURE_IDLE_MS,
  coverCaptureQueue,
  needsCoverCapture,
  resolveCover,
  saveNodeCover,
} from '../../engine/covers';
import { FRAME_SANDBOX } from '../../engine/frame-transport';
import { registerFrameWindow, type FrameMessageHandlers } from '../../engine/message-router';
import { loadFrameSource } from '../../engine/source-cache';
import { BOARD_INTERACTIVE_ATTR } from '../../extensions';
import { nodeDisplayTitle } from '../../model/labels';
import type { EngineNodeOf, NodeFaceProps } from '../../model/types';
import { CoverImage } from '../common/CoverImage';
import { PlaceholderFace } from '../common/PlaceholderFace';
import { ICON_STROKE } from '../common/kind-icons';
import { frameRegistryFor, type FrameHandle } from './frame-registry';
import { FrameSurface, type FrameRole } from './FrameSurface';
import { basenameOf, projectFileFor, projectFilePathSet } from './project-files';
import { captureCropRect, createFrameCaptureSession, targetScreenRect, type FrameCaptureSession } from './use-frame-capture';
import { createFrameEditSession, type FrameEditSession } from './use-frame-edit-session';
import { useFrameLive } from './use-frame-live';
import styles from './frame.module.css';

const INTERACTIVE = { [BOARD_INTERACTIVE_ATTR]: '' } as const;

/** Chrome islands that may cover part of a node on screen (host captures must not include them). */
export const BOARD_CHROME_ISLAND_ATTR = 'data-board-chrome';

/** True when a chrome island (toolbar, context bar, minimap…) covers part of `rect` on screen. */
export function overlapsChrome(rect: DOMRect, root: HTMLElement | null): boolean {
  if (!root) return false;
  for (const island of root.querySelectorAll<HTMLElement>(`[${BOARD_CHROME_ISLAND_ATTR}]`)) {
    const box = island.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    if (box.left < rect.right && rect.left < box.right && box.top < rect.bottom && rect.top < box.bottom) return true;
  }
  return false;
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('capture image failed to decode'));
    image.src = src;
  });
}

/** Crops a snapshot data URL to a rect (image px) as a PNG. */
async function cropToPng(dataUrl: string, crop: { x: number; y: number; width: number; height: number }): Promise<Blob | null> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = crop.width;
  canvas.height = crop.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

export function FrameNode({ view }: NodeFaceProps) {
  const engine = useBoardEngine();
  const { env } = useBoardHost();
  const t = useT();
  const node = view.node as EngineNodeOf<'frame'>;
  const nodeId = node.id;
  const { commands } = engine;
  const registry = frameRegistryFor(engine);
  const path = node.data.ref?.path ?? null;
  const liveArtifactId = typeof node.data.liveArtifactId === 'string' ? node.data.liveArtifactId : null;
  const file = projectFileFor(env.files, path);
  const building = path !== null && env.buildingPaths.has(path);
  const projectFilePaths = projectFilePathSet(env.files);
  const editMode = view.mode === 'edit' && path !== null;
  const captureMode = view.mode === 'capture';
  const title = node.title ?? (path ? basenameOf(path) : t('board.node.untitled'));

  const [editingSource, setEditingSource] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [blank, setBlank] = useState(false);

  const live = useFrameLive({
    live: view.live,
    projectId: env.projectId,
    path,
    liveArtifactId,
    file,
    building,
    filesRefreshKey: env.filesRefreshKey,
    isDeckProject: env.isDeckProject,
    projectFilePaths,
    workspaceContext: env.workspaceContext,
    editingSource: editMode ? editingSource : null,
    reload,
  });

  /* ── refs read by long-lived callbacks ─────────────────────────────────────────────────── */
  const currentIframe = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  readyRef.current = live.ready && live.current !== null;
  const fileRef = useRef(file);
  fileRef.current = file;
  const viewRef = useRef(view);
  viewRef.current = view;
  const envRef = useRef(env);
  envRef.current = env;
  const editSession = useRef<FrameEditSession | null>(null);
  const captureSession = useRef<FrameCaptureSession | null>(null);
  const loadWaiters = useRef<Array<(iframe: HTMLIFrameElement | null) => void>>([]);

  const post = useCallback((message: unknown) => {
    try {
      currentIframe.current?.contentWindow?.postMessage(message, '*');
    } catch {
      /* the document is gone */
    }
  }, []);

  /* Comment tool on this frame: picker on, hover/click targets → the board comment layer */
  const commentSession = useFrameCommentSession({
    nodeId,
    path,
    commenting: view.commenting && !editMode && !captureMode,
    ready: live.ready && live.current !== null,
    documentKey: live.current?.key ?? null,
    post,
  });

  /* ── message routing for every mounted document of this node ───────────────────────────── */
  const handlers = useMemo<FrameMessageHandlers>(
    () => ({
      onBridgeReady(href) {
        commands.setRuntime(nodeId, { currentHref: href });
      },
      onObservability(message) {
        if (message.event === 'white_screen') setBlank(true);
        else if (message.event === 'runtime_error' && message.message) {
          commands.setRuntime(nodeId, { phase: 'error', error: { message: message.message } });
        }
      },
      onCommentHover(target) {
        commentSession.current?.hover(target);
        captureSession.current?.hover(target);
      },
      onCommentLeave() {
        commentSession.current?.leave();
        captureSession.current?.leave();
      },
      onCommentTarget(target) {
        // the comment composer takes focus itself
        if (commentSession.current) {
          commentSession.current.pick(target);
          return;
        }
        captureSession.current?.pick(target);
        // keys (Enter / mod+Enter) go to the board again, not into the picked document
        engine.camera.elements()?.root.focus({ preventScroll: true });
      },
      onEdit(message) {
        editSession.current?.handleMessage(message);
      },
      onOpenFile(fileName) {
        // a link to another project page opens that page next to this one (prototype flow)
        commands.ensureFileNodes([fileName], { near: nodeId, select: true, reveal: true });
      },
    }),
    [commands, engine, nodeId, commentSession],
  );

  const routedFrames = useRef(new Map<HTMLIFrameElement, () => void>());
  const onFrame = useCallback(
    (iframe: HTMLIFrameElement, role: FrameRole) => {
      const win = iframe.contentWindow;
      if (win && !routedFrames.current.has(iframe)) routedFrames.current.set(iframe, registerFrameWindow(win, handlers));
      if (role === 'current') currentIframe.current = iframe;
    },
    [handlers],
  );
  const onFrameGone = useCallback((iframe: HTMLIFrameElement) => {
    routedFrames.current.get(iframe)?.();
    routedFrames.current.delete(iframe);
    if (currentIframe.current === iframe) currentIframe.current = null;
  }, []);
  useEffect(
    () => () => {
      for (const off of routedFrames.current.values()) off();
      routedFrames.current.clear();
    },
    [],
  );

  // a new document: forget the old blank/error state
  const currentKey = live.current?.key ?? null;
  useEffect(() => {
    setBlank(false);
    const runtime = engine.store.getState().runtime.get(nodeId);
    if (runtime?.phase === 'error') commands.setRuntime(nodeId, { phase: undefined, error: undefined });
    if (!currentKey && runtime?.currentHref) commands.setRuntime(nodeId, { currentHref: undefined });
  }, [currentKey, commands, engine, nodeId]);

  /* ── cover capture once the live document rendered ─────────────────────────────────────── */
  const captureCover = useCallback(
    (force: boolean): Promise<boolean> => {
      if (!currentIframe.current || !readyRef.current) return Promise.resolve(false);
      if (!force && viewRef.current.readOnly) return Promise.resolve(false);
      return coverCaptureQueue.run(async () => {
        const target = currentIframe.current;
        if (!target) return false;
        const rect = target.getBoundingClientRect();
        const current = viewRef.current;
        const preferHost = !current.selected && !current.hovered && !overlapsChrome(rect, engine.camera.elements()?.root ?? null);
        const image = await captureLiveCover({ iframe: target, preferHost, onScreenScale: current.settledZoom }).catch(() => null);
        if (!image) return false;
        const saved = await saveNodeCover({
          projectId: envRef.current.projectId,
          nodeId,
          image,
          sourceMtime: fileRef.current?.mtime,
          workspaceContext: envRef.current.workspaceContext,
          update: (id, cover) => commands.updateNode(id, { data: { cover } }, { origin: 'system', label: 'cover' }),
        });
        return saved !== null;
      });
    },
    [commands, engine, nodeId],
  );

  const attemptedCover = useRef<string | null>(null);
  const fileMtime = file?.mtime;
  useEffect(() => {
    if (!live.ready || !live.current || view.readOnly || view.mode !== null || building || fileMtime === undefined) return undefined;
    if (!needsCoverCapture(node, fileMtime)) return undefined;
    const attempt = `${fileMtime}`;
    if (attemptedCover.current === attempt) return undefined;
    const timer = setTimeout(() => {
      attemptedCover.current = attempt;
      void captureCover(false);
    }, COVER_CAPTURE_IDLE_MS);
    return () => clearTimeout(timer);
  }, [live.ready, live.current, view.readOnly, view.mode, building, fileMtime, node, captureCover]);

  /* ── registry handle and facts ──────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!live.ready || !live.current) return;
    const iframe = currentIframe.current;
    for (const resolve of loadWaiters.current.splice(0)) resolve(iframe);
  }, [live.ready, live.current]);

  useEffect(() => {
    const handle: FrameHandle = {
      nodeId,
      kind: 'frame',
      iframe: () => currentIframe.current,
      loaded: () => readyRef.current,
      whenLoaded(timeoutMs) {
        if (readyRef.current && currentIframe.current) return Promise.resolve(currentIframe.current);
        return new Promise((resolve) => {
          const done = (iframe: HTMLIFrameElement | null) => {
            clearTimeout(timer);
            resolve(iframe);
          };
          const timer = setTimeout(() => {
            loadWaiters.current = loadWaiters.current.filter((entry) => entry !== done);
            resolve(null);
          }, timeoutMs);
          loadWaiters.current.push(done);
        });
      },
      reload: () => setReload((value) => value + 1),
      refreshCover: () => captureCover(true),
      post,
    };
    return registry.register(handle);
  }, [registry, nodeId, captureCover, post]);

  const transportKind = live.current?.transport.kind;
  useEffect(() => {
    registry.setFacts(nodeId, { powered: live.powered, ...(transportKind ? { transport: transportKind } : {}) });
  }, [registry, nodeId, live.powered, transportKind]);
  useEffect(() => () => registry.setFacts(nodeId, null), [registry, nodeId]);

  /* ── Edit session (03 §5.3) ─────────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!editMode || !path) return undefined;
    const session = createFrameEditSession({
      nodeId,
      path,
      readOnly: viewRef.current.readOnly,
      initialMtime: fileRef.current?.mtime,
      sizeBytes: () => fileRef.current?.size,
      loadSource: async () => {
        const current = fileRef.current;
        if (!current) return null;
        return loadFrameSource({ projectId: envRef.current.projectId, file: current, workspaceContext: envRef.current.workspaceContext });
      },
      mountEditing: (source) => setEditingSource(source),
      write: async (content, versionLabel) => {
        const result = await writeProjectTextFileDetailed(
          envRef.current.projectId,
          path,
          content,
          {
            ...(fileRef.current?.artifactManifest ? { artifactManifest: fileRef.current.artifactManifest } : {}),
            versionSource: 'manual',
            versionLabel,
          },
          envRef.current.workspaceContext,
        );
        if (!result.ok) return { ok: false, message: result.message };
        envRef.current.onRefreshFiles?.();
        return { ok: true, mtime: typeof result.file.mtime === 'number' ? result.file.mtime : null };
      },
      post,
      notify: ({ key, vars, tone }) => {
        toast({ title: t(key, vars), ...(tone ? { tone } : {}) });
      },
      onEnded: () => {
        setEditingSource(null);
        if (registry.editSession() === session) registry.setEditSession(null);
        commands.setRuntime(nodeId, { editSession: undefined });
        const mode = engine.store.getState().ui.mode;
        if (mode?.nodeId === nodeId && mode.mode === 'edit') commands.setMode(null);
      },
      labels: {
        content: t('manualEdit.applyContent'),
        html: t('manualEdit.applyHtml'),
        undo: t('manualEdit.undo'),
        redo: t('manualEdit.redo'),
      },
    });
    editSession.current = session;
    registry.setEditSession(session);
    const unsubscribe = session.subscribe(() => {
      const phase = session.getState().phase;
      commands.setRuntime(nodeId, { editSession: phase === 'idle' ? undefined : phase });
    });
    void session.start();
    return () => {
      unsubscribe();
      if (editSession.current === session) editSession.current = null;
      void session.exit().finally(() => {
        if (registry.editSession() === session) registry.setEditSession(null);
        setEditingSource(null);
        commands.setRuntime(nodeId, { editSession: undefined });
      });
    };
    // one session per Edit entry
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, path, nodeId]);

  // the editing document loaded: the bridge goes on
  useEffect(() => {
    if (!editMode || !live.ready || !live.current || live.current.transport.kind !== 'srcdoc' || editingSource === null) return;
    editSession.current?.frameLoaded();
  }, [editMode, live.ready, live.current, editingSource]);

  // an external change of the edited file ends the session
  useEffect(() => {
    if (fileMtime !== undefined) editSession.current?.fileChanged(fileMtime);
  }, [fileMtime]);

  /* ── Capture session (03 §5.3) ──────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!captureMode) return undefined;
    const session = createFrameCaptureSession(
      {
        nodeId,
        kind: 'frame',
        post,
        async captureImage({ target, full }) {
          const iframe = currentIframe.current;
          if (!iframe) return null;
          const exports = await import('../../../../runtime/exports');
          const rect = iframe.getBoundingClientRect();
          const width = engine.store.getState().doc.nodes.get(nodeId)?.w ?? node.w;
          const scale = width > 0 ? rect.width / width : 1;
          if (target && !full && exports.isOpenDesignHostAvailable()) {
            const screen = targetScreenRect(rect, target.position, scale);
            const inside = screen.left >= 0 && screen.top >= 0 && screen.left + screen.width <= window.innerWidth && screen.top + screen.height <= window.innerHeight;
            if (inside) {
              const snapshot = await exports.captureHostRegionSnapshot(screen);
              if (snapshot) return { blob: await dataUrlToBlob(snapshot.dataUrl), width: snapshot.w, height: snapshot.h };
            }
          }
          const snapshot = await exports.requestPreviewSnapshot(iframe, 4_000, full ? { full: true } : {});
          if (!snapshot) return null;
          if (!target || full) return { blob: await dataUrlToBlob(snapshot.dataUrl), width: snapshot.w, height: snapshot.h };
          const crop = captureCropRect(target.position, snapshot, width);
          const blob = await cropToPng(snapshot.dataUrl, crop);
          return blob ? { blob, width: crop.width, height: crop.height } : null;
        },
        async upload(upload) {
          const result = await uploadProjectFiles(envRef.current.projectId, [upload], undefined, envRef.current.workspaceContext);
          const uploaded = result.uploaded[0];
          envRef.current.onRefreshFiles?.();
          return uploaded ? { path: uploaded.path, name: uploaded.name } : null;
        },
        place({ path: imagePath, title: imageTitle, width, height }) {
          const size = fitNodeSize(width, height, 512, 512);
          const id = commands.addNode(
            {
              kind: 'image',
              title: imageTitle,
              w: size.w,
              h: size.h,
              data: { ref: { path: imagePath }, naturalWidth: width, naturalHeight: height },
              placement: { mode: 'near', nodeId, side: 'right' },
            },
            { select: false },
          );
          commands.connect(nodeId, id, 'lineage');
          commands.select([id]);
          return id;
        },
        stage(attachment) {
          const detail: StageAttachmentEventDetail = { attachments: [attachment] };
          window.dispatchEvent(new CustomEvent<StageAttachmentEventDetail>(STAGE_ATTACHMENT_EVENT, { detail }));
        },
        notify: ({ key, vars, tone }) => {
          toast({ title: t(key, vars), ...(tone ? { tone } : {}) });
        },
        nodeTitle: () => {
          const doc = engine.store.getState().doc;
          return nodeDisplayTitle(doc, doc.nodes.get(nodeId) ?? node, t);
        },
        fullPageLabel: () => t('board.capture.fullPage'),
        captureTitle: (page, element) => t('board.capture.title', { page, element }),
      },
      viewRef.current.captureTool ?? 'pick',
    );
    captureSession.current = session;
    registry.setCaptureSession(session);
    if (readyRef.current) session.frameLoaded();
    return () => {
      session.end();
      if (captureSession.current === session) captureSession.current = null;
      if (registry.captureSession() === session) registry.setCaptureSession(null);
    };
    // one session per Capture entry
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureMode, nodeId]);

  useEffect(() => {
    if (view.captureTool) captureSession.current?.setTool(view.captureTool);
  }, [view.captureTool]);

  // a (re)loaded document needs the picker again
  useEffect(() => {
    if (captureMode && live.ready && live.current) captureSession.current?.frameLoaded();
  }, [captureMode, live.ready, live.current]);

  /* ── render ─────────────────────────────────────────────────────────────────────────────── */
  const cover = useMemo(
    () => resolveCover({ node, file, messages: env.messages, projectId: env.projectId, workspaceContext: env.workspaceContext }),
    [node, file, env.messages, env.projectId, env.workspaceContext],
  );
  const underlay = cover ? (
    <CoverImage src={cover.url} alt={title} stale={cover.stale && cover.source === 'board'} />
  ) : (
    <PlaceholderFace kind="frame" caption={title} />
  );

  const loading = view.live && (!live.current || !live.ready);
  return (
    <div className={styles.frame} data-testid="board-frame" data-selected={view.selected ? '' : undefined} data-live={view.live ? '' : undefined}>
      <FrameSurface
        title={title}
        width={node.w}
        height={node.h}
        layoutZoom={view.layoutZoom}
        sandbox={FRAME_SANDBOX}
        current={view.live ? live.current : null}
        pending={view.live ? live.pending : null}
        active={view.active}
        motionActive={view.selected || view.hovered}
        motionMuted={!view.selected}
        underlay={underlay}
        ready={live.ready}
        onFrame={onFrame}
        onFrameGone={onFrameGone}
        onLoad={live.onLoad}
      />
      {loading ? (
        <span className={styles.status} data-testid="board-frame-loading">
          <Spinner size="xs" />
          {t('board.node.state.loading')}
        </span>
      ) : null}
      {blank && view.live ? (
        <div className={styles.blank} role="alert" data-testid="board-frame-blank" {...INTERACTIVE} onPointerDown={(event) => event.stopPropagation()}>
          <span className={styles.blankGlyph} aria-hidden>
            <TriangleAlert size={24} strokeWidth={ICON_STROKE} />
          </span>
          <span>{t('board.node.state.blank')}</span>
          <span className={styles.blankActions}>
            <Button size="sm" variant="default" onClick={() => setReload((value) => value + 1)}>
              <RefreshCw strokeWidth={ICON_STROKE} />
              {t('board.node.reload')}
            </Button>
            {path ? (
              <Button size="sm" variant="ghost" onClick={() => env.onOpenInFiles(path)}>
                {t('board.node.openInFiles')}
              </Button>
            ) : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
