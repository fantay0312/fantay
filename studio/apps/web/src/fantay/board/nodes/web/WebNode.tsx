'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Web face (spec 03 §4.2): a live URL or app preview with a 28 px header (status dot, host + path, Reload, Open in
// a browser tab) over the page. Live → the URL in an iframe with the web sandbox; not live → its cover (desktop host
// capture only: an external page has no snapshot bridge) or the globe placeholder. A page that stays blank for 8 s
// may refuse embedding: the face then offers the browser tab.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, RefreshCw } from 'lucide-react';

import { useT } from '../../../../i18n';
import { Button } from '../../../ui/button';
import { IconButton } from '../../../ui/icon-button';
import { cn } from '../../../ui/cn';
import { useBoardEngine, useBoardHost } from '../../context';
import { captureLiveCover, coverCaptureQueue, contractCoverOf, COVER_CAPTURE_IDLE_MS, resolveCover, saveNodeCover } from '../../engine/covers';
import { BOARD_INTERACTIVE_ATTR } from '../../extensions';
import { urlLabel } from '../../model/labels';
import type { EngineNodeOf, NodeFaceProps } from '../../model/types';
import { CoverImage } from '../common/CoverImage';
import { ErrorFace } from '../common/ErrorFace';
import { PlaceholderFace } from '../common/PlaceholderFace';
import { ICON_STROKE } from '../common/kind-icons';
import { overlapsChrome } from '../frame/FrameNode';
import { frameRegistryFor, type FrameHandle } from '../frame/frame-registry';
import { FrameSurface } from '../frame/FrameSurface';
import type { FrameLiveSlot } from '../frame/use-frame-live';
import { checkWebUrl, currentAppOrigin, WEB_SANDBOX } from './url-policy';
import styles from './web.module.css';

export const WEB_HEADER_HEIGHT = 28;
export const WEB_BLANK_HINT_MS = 8_000;

const INTERACTIVE = { [BOARD_INTERACTIVE_ATTR]: '' } as const;
const stop = (event: { stopPropagation(): void }) => event.stopPropagation();

function afterTwoFrames(callback: () => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    const timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  }
  let second = 0;
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(callback);
  });
  return () => {
    cancelAnimationFrame(first);
    if (second) cancelAnimationFrame(second);
  };
}

export function WebNode({ view }: NodeFaceProps) {
  const engine = useBoardEngine();
  const { env } = useBoardHost();
  const t = useT();
  const node = view.node as EngineNodeOf<'web'>;
  const nodeId = node.id;
  const registry = frameRegistryFor(engine);
  const check = useMemo(() => checkWebUrl(node.data.url, currentAppOrigin()), [node.data.url]);
  const url = check.ok ? check.url : null;
  const label = urlLabel(node.data.url);
  const [reload, setReload] = useState(0);
  const [ready, setReady] = useState(false);
  const [stuck, setStuck] = useState(false);
  const current: FrameLiveSlot | null = view.live && url ? { key: `${url}#${reload}`, transport: { kind: 'url', src: url } } : null;
  const currentIframe = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  readyRef.current = ready && current !== null;
  const viewRef = useRef(view);
  viewRef.current = view;
  const cancelFrames = useRef<(() => void) | null>(null);
  const currentKey = current?.key ?? null;

  useEffect(() => {
    setReady(false);
    setStuck(false);
    if (!currentKey) return undefined;
    const timer = setTimeout(() => setStuck(true), WEB_BLANK_HINT_MS);
    return () => clearTimeout(timer);
  }, [currentKey]);
  useEffect(() => () => cancelFrames.current?.(), []);

  const onLoad = useCallback((_role: 'current' | 'pending', key: string) => {
    cancelFrames.current?.();
    cancelFrames.current = afterTwoFrames(() => {
      cancelFrames.current = null;
      if (key === currentKey) {
        setReady(true);
        setStuck(false);
      }
    });
  }, [currentKey]);

  const captureCover = useCallback(async (): Promise<boolean> => {
    const iframe = currentIframe.current;
    if (!iframe || !readyRef.current) return false;
    const exports = await import('../../../../runtime/exports');
    // an external page has no snapshot bridge: only the desktop compositor can see it
    if (!exports.isOpenDesignHostAvailable()) return false;
    return coverCaptureQueue.run(async () => {
      const target = currentIframe.current;
      if (!target) return false;
      const rect = target.getBoundingClientRect();
      if (overlapsChrome(rect, engine.camera.elements()?.root ?? null)) return false;
      const image = await captureLiveCover({ iframe: target, preferHost: true, onScreenScale: viewRef.current.settledZoom }).catch(() => null);
      if (!image) return false;
      const saved = await saveNodeCover({
        projectId: env.projectId,
        nodeId,
        image,
        workspaceContext: env.workspaceContext,
        update: (id, cover) => engine.commands.updateNode(id, { data: { cover } }, { origin: 'system', label: 'cover' }),
      });
      return saved !== null;
    });
  }, [engine, env.projectId, env.workspaceContext, nodeId]);

  // one cover per page once it rendered (Refresh cover replaces it)
  const hasCover = contractCoverOf(node) !== undefined;
  useEffect(() => {
    if (!ready || !current || view.readOnly || view.selected || view.hovered || view.mode !== null || hasCover) return undefined;
    const timer = setTimeout(() => void captureCover(), COVER_CAPTURE_IDLE_MS);
    return () => clearTimeout(timer);
  }, [ready, current, view.readOnly, view.selected, view.hovered, view.mode, hasCover, captureCover]);

  useEffect(() => {
    const handle: FrameHandle = {
      nodeId,
      kind: 'web',
      iframe: () => currentIframe.current,
      loaded: () => readyRef.current,
      async whenLoaded(timeoutMs) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          if (readyRef.current && currentIframe.current) return currentIframe.current;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return null;
      },
      reload: () => setReload((value) => value + 1),
      refreshCover: () => captureCover(),
      post: () => {},
    };
    return registry.register(handle);
  }, [registry, nodeId, captureCover]);

  const cover = useMemo(
    () => resolveCover({ node, messages: env.messages, projectId: env.projectId, workspaceContext: env.workspaceContext }),
    [node, env.messages, env.projectId, env.workspaceContext],
  );
  const host = url ? new URL(url).host : label;
  const underlay = cover ? <CoverImage src={cover.url} alt={label} /> : <PlaceholderFace kind="web" caption={host} />;
  const openTab = env.onOpenBrowserTab && url ? () => env.onOpenBrowserTab?.(url) : undefined;
  const bodyHeight = Math.max(0, node.h - WEB_HEADER_HEIGHT);

  return (
    <div className={styles.web} data-testid="board-web" data-selected={view.selected ? '' : undefined}>
      <div className={styles.header}>
        <span className={cn(styles.dot, ready && current && styles.dotLive)} aria-hidden />
        <span className={styles.url} title={node.data.url}>
          {label}
        </span>
        <span className={styles.actions} {...INTERACTIVE} onPointerDown={stop}>
          <IconButton size="xs" aria-label={t('board.node.reload')} onClick={() => setReload((value) => value + 1)} disabled={!url}>
            <RefreshCw strokeWidth={ICON_STROKE} />
          </IconButton>
          {openTab ? (
            <IconButton size="xs" aria-label={t('board.node.openBrowserTab')} onClick={openTab}>
              <AppWindow strokeWidth={ICON_STROKE} />
            </IconButton>
          ) : null}
        </span>
      </div>
      <div className={styles.body} style={{ height: bodyHeight }}>
        {!check.ok ? (
          <ErrorFace message={t(check.reasonKey)} />
        ) : (
          <FrameSurface
            title={label}
            width={node.w}
            height={bodyHeight}
            layoutZoom={view.layoutZoom}
            sandbox={WEB_SANDBOX}
            current={current}
            pending={null}
            active={view.active}
            motionActive={false}
            motionMuted
            underlay={underlay}
            ready={ready}
            onFrame={(iframe) => {
              currentIframe.current = iframe;
            }}
            onFrameGone={(iframe) => {
              if (currentIframe.current === iframe) currentIframe.current = null;
            }}
            onLoad={onLoad}
          />
        )}
        {stuck && current && !ready ? (
          <div className={styles.hint} {...INTERACTIVE} onPointerDown={stop}>
            <span>{t('board.node.webBlankHint')}</span>
            {openTab ? (
              <Button size="sm" variant="default" onClick={openTab}>
                <AppWindow strokeWidth={ICON_STROKE} />
                {t('board.node.openBrowserTab')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
