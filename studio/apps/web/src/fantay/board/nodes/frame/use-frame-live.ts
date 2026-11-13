// SPDX-License-Identifier: AGPL-3.0-only
// Transport selection, source loading and reload-without-flash for a live frame (spec 03 §5.1, §5.2). While the
// node holds a live slot it shows `current`; a changed document mounts as `pending` (opacity 0, under `current`)
// and replaces it two frames after its `load`, so a reload never flashes white (the repo rule "keep both iframes
// mounted and swap visibility"). A newer change while pending replaces the pending iframe; swaps are limited to one
// per 1 200 ms (trailing). The source is loaded only here (live promotion or Edit), never above 2 MiB.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectFile, WorkspaceCollabContext } from '@open-design/contracts';

import { htmlNeedsPoweredPreview } from '../../../../components/file-viewer-render-mode';
import {
  buildFrameSrcdoc,
  decideFrameTransport,
  FRAME_SOURCE_MAX_BYTES,
  frameUrl,
  liveArtifactFrameUrl,
  looksLikeDeck,
  transportKey,
  type FrameTransport,
} from '../../engine/frame-transport';
import { cachedFrameSource, loadFrameSource } from '../../engine/source-cache';

export const FRAME_RELOAD_MIN_INTERVAL_MS = 1_200;
/** without a source decision after this long, the URL transport is mounted (the cover stays up meanwhile) */
export const FRAME_SOURCE_DECISION_TIMEOUT_MS = 1_500;

export interface FrameLiveInput {
  live: boolean;
  projectId: string;
  /** project path of the page; null for a live-artifact frame */
  path: string | null;
  liveArtifactId: string | null;
  file: ProjectFile | undefined;
  building: boolean;
  filesRefreshKey: number | undefined;
  isDeckProject: boolean;
  projectFilePaths: ReadonlySet<string> | null;
  workspaceContext: WorkspaceCollabContext | null;
  /** a HyperFrames composition in a motion node (`odMotionPreview=1`) */
  motion?: boolean;
  /** Edit session: the source to mount as an editing srcdoc */
  editingSource: string | null;
  /** Reload action counter */
  reload: number;
}

export interface FrameLiveSlot {
  key: string;
  transport: FrameTransport;
}

export interface FrameLive {
  current: FrameLiveSlot | null;
  pending: FrameLiveSlot | null;
  /** the current document loaded two frames ago: the cover can fade out */
  ready: boolean;
  /** the source the decision used (null: URL without a source) */
  source: string | null;
  powered: boolean;
  onLoad(role: 'current' | 'pending', key: string): void;
}

function slotOf(transport: FrameTransport): FrameLiveSlot {
  return { key: transportKey(transport), transport };
}

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

/** Computes the transport the node should show (async: the source may need a fetch). */
async function desiredTransport(input: FrameLiveInput, signal: AbortSignal): Promise<{ transport: FrameTransport | null; source: string | null }> {
  if (!input.live) return { transport: null, source: null };
  const { projectId, path, file, workspaceContext } = input;
  if (!path) {
    if (!input.liveArtifactId) return { transport: null, source: null };
    return { transport: { kind: 'url', src: liveArtifactFrameUrl(projectId, input.liveArtifactId, workspaceContext) }, source: null };
  }
  const url = (): FrameTransport => ({
    kind: 'url',
    src: frameUrl({
      projectId,
      path,
      mtime: file?.mtime,
      building: input.building,
      filesRefreshKey: input.filesRefreshKey,
      motion: input.motion === true,
      reload: input.reload,
      workspaceContext,
    }),
  });
  if (input.editingSource !== null) {
    const built = await buildFrameSrcdoc({
      projectId,
      path,
      source: input.editingSource,
      projectFilePaths: input.projectFilePaths,
      editing: true,
      deck: input.isDeckProject || looksLikeDeck(input.editingSource),
      workspaceContext,
      reloadKey: input.reload,
    });
    return { transport: { kind: 'srcdoc', srcDoc: built.srcDoc }, source: input.editingSource };
  }
  if (!file || file.size > FRAME_SOURCE_MAX_BYTES || input.building) return { transport: url(), source: null };
  const source = cachedFrameSource({ projectId, file, workspaceContext }) ?? (await loadFrameSource({ projectId, file, workspaceContext, signal }));
  if (signal.aborted) return { transport: null, source: null };
  const kind = decideFrameTransport({
    source,
    path,
    sizeBytes: file.size,
    projectFilePaths: input.projectFilePaths,
    editing: false,
    isDeckProject: input.isDeckProject,
  });
  if (kind === 'url' || source === null) return { transport: url(), source };
  const built = await buildFrameSrcdoc({
    projectId,
    path,
    source,
    projectFilePaths: input.projectFilePaths,
    editing: false,
    deck: input.isDeckProject || looksLikeDeck(source),
    workspaceContext,
    reloadKey: input.reload,
  });
  return { transport: { kind: 'srcdoc', srcDoc: built.srcDoc }, source };
}

export function useFrameLive(input: FrameLiveInput): FrameLive {
  const [current, setCurrent] = useState<FrameLiveSlot | null>(null);
  const [pending, setPending] = useState<FrameLiveSlot | null>(null);
  const [ready, setReady] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const currentRef = useRef<FrameLiveSlot | null>(null);
  const pendingRef = useRef<FrameLiveSlot | null>(null);
  const lastSwapAt = useRef(0);
  const swapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelFrames = useRef<(() => void) | null>(null);

  const setCurrentSlot = useCallback((slot: FrameLiveSlot | null) => {
    currentRef.current = slot;
    setCurrent(slot);
  }, []);
  const setPendingSlot = useCallback((slot: FrameLiveSlot | null) => {
    pendingRef.current = slot;
    setPending(slot);
  }, []);

  const offer = useCallback(
    (slot: FrameLiveSlot | null) => {
      if (swapTimer.current) {
        clearTimeout(swapTimer.current);
        swapTimer.current = null;
      }
      if (!slot) {
        cancelFrames.current?.();
        setCurrentSlot(null);
        setPendingSlot(null);
        setReady(false);
        return;
      }
      const showing = currentRef.current;
      if (!showing) {
        lastSwapAt.current = Date.now();
        setCurrentSlot(slot);
        setReady(false);
        return;
      }
      if (showing.key === slot.key) {
        if (pendingRef.current) setPendingSlot(null);
        return;
      }
      if (pendingRef.current?.key === slot.key) return;
      const wait = FRAME_RELOAD_MIN_INTERVAL_MS - (Date.now() - lastSwapAt.current);
      if (wait > 0) {
        swapTimer.current = setTimeout(() => {
          swapTimer.current = null;
          lastSwapAt.current = Date.now();
          setPendingSlot(slot);
        }, wait);
        return;
      }
      lastSwapAt.current = Date.now();
      setPendingSlot(slot);
    },
    [setCurrentSlot, setPendingSlot],
  );

  const { live, projectId, path, liveArtifactId, building, isDeckProject, editingSource, reload, motion } = input;
  const fileMtime = input.file?.mtime;
  const fileSize = input.file?.size;
  const filesRefreshKey = building ? input.filesRefreshKey : undefined;
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    if (!live) {
      offer(null);
      setSource(null);
      return undefined;
    }
    const controller = new AbortController();
    let settled = false;
    const fallback = setTimeout(() => {
      // a slow source fetch must not keep a live frame on its cover forever
      if (settled || currentRef.current || !path) return;
      offer(slotOf({ kind: 'url', src: frameUrl({ projectId, path, mtime: fileMtime, motion: motion === true, reload, workspaceContext: latest.current.workspaceContext }) }));
    }, FRAME_SOURCE_DECISION_TIMEOUT_MS);
    void desiredTransport(latest.current, controller.signal)
      .then((result) => {
        settled = true;
        if (controller.signal.aborted) return;
        setSource(result.source);
        offer(result.transport ? slotOf(result.transport) : null);
      })
      .catch(() => {
        settled = true;
        if (controller.signal.aborted || !path) return;
        offer(slotOf({ kind: 'url', src: frameUrl({ projectId, path, mtime: fileMtime, motion: motion === true, reload, workspaceContext: latest.current.workspaceContext }) }));
      });
    return () => {
      controller.abort();
      clearTimeout(fallback);
    };
    // the file identity (mtime/size), build state, edit source and reload counter decide the document
  }, [live, projectId, path, liveArtifactId, fileMtime, fileSize, building, filesRefreshKey, isDeckProject, editingSource, reload, motion, offer]);

  useEffect(
    () => () => {
      if (swapTimer.current) clearTimeout(swapTimer.current);
      cancelFrames.current?.();
    },
    [],
  );

  const onLoad = useCallback(
    (role: 'current' | 'pending', key: string) => {
      cancelFrames.current?.();
      if (role === 'current') {
        if (currentRef.current?.key !== key) return;
        cancelFrames.current = afterTwoFrames(() => {
          cancelFrames.current = null;
          if (currentRef.current?.key === key) setReady(true);
        });
        return;
      }
      if (pendingRef.current?.key !== key) return;
      cancelFrames.current = afterTwoFrames(() => {
        cancelFrames.current = null;
        const next = pendingRef.current;
        if (!next || next.key !== key) return;
        setCurrentSlot(next);
        setPendingSlot(null);
        setReady(true);
      });
    },
    [setCurrentSlot, setPendingSlot],
  );

  const powered = useMemo(() => htmlNeedsPoweredPreview(source), [source]);
  return { current, pending, ready, source, powered, onLoad };
}
