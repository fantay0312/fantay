// SPDX-License-Identifier: AGPL-3.0-only
// How a viewer gets at a file: its address, its bytes or its text.
// Three rules hold for every viewer, so they live here once:
//  - a load faster than the grace period shows no loading state at all;
//  - a newer version of the same file replaces the old content only when it has arrived, so the
//    preview never blinks while the agent is still writing;
//  - a file over the viewer's size limit is not fetched; the viewer says so instead.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useProjectCollabContext } from '../../collab/collab-context';
import { appendResourceQuery, workspaceProjectHeaders } from '../../collab/workspace-identity';
import { projectFileUrl } from '../../providers/registry';
import type { ProjectFile } from '../../types';

/** A load faster than this shows no loading state. */
export const ARTIFACT_SLOW_LOAD_MS = 180;

export type ArtifactSource<T> =
  /** Nothing to show yet; `slow` turns true once the grace period has passed. */
  | { status: 'loading'; slow: boolean; data: null }
  /** `stale` is true while a newer version of the same file is on its way. */
  | { status: 'ready'; data: T; stale: boolean }
  | { status: 'too-large'; size: number; limit: number; data: null }
  | { status: 'failed'; data: null };

export interface ArtifactSourceOptions {
  /** Files larger than this are not fetched. Omit for no limit. */
  maxBytes?: number;
  /** Set false to hold the fetch (a tab that is not visible, a mode that does not need the bytes). */
  enabled?: boolean;
}

export interface ArtifactSourceResult<T> {
  source: ArtifactSource<T>;
  reload(): void;
}

/** The file's address for `<img>`, `<video>`, a download and the decoders. It changes when the file does. */
export function useArtifactUrl(projectId: string, file: ProjectFile): string {
  const { workspaceContext } = useProjectCollabContext();
  return useMemo(
    () => appendResourceQuery(projectFileUrl(projectId, file.name, workspaceContext), `v=${Math.round(file.mtime)}`),
    [projectId, file.name, file.mtime, workspaceContext],
  );
}

function useArtifactFetch<T>(
  projectId: string,
  file: ProjectFile,
  read: (response: Response) => Promise<T>,
  options: ArtifactSourceOptions,
): ArtifactSourceResult<T> {
  const { workspaceContext } = useProjectCollabContext();
  const { maxBytes, enabled = true } = options;
  const [reloadTick, setReloadTick] = useState(0);
  // Content is stored with the file it belongs to, so a tab switch never shows another file's bytes.
  const [held, setHeld] = useState<{ name: string; data: T } | null>(null);
  const [phase, setPhase] = useState<{ name: string; value: 'loading' | 'slow' | 'ready' | 'failed' } | null>(null);

  const name = file.name;
  const mtime = file.mtime;
  const size = file.size;
  const tooLarge = maxBytes !== undefined && size > maxBytes;

  useEffect(() => {
    if (!enabled || tooLarge) return;
    const controller = new AbortController();
    let current = true;
    setPhase((previous) => (previous?.name === name && previous.value === 'ready' ? previous : { name, value: 'loading' }));
    const timer = window.setTimeout(() => {
      if (!current) return;
      setPhase((previous) => (previous?.name === name && previous.value === 'loading' ? { name, value: 'slow' } : previous));
    }, ARTIFACT_SLOW_LOAD_MS);

    const url = appendResourceQuery(projectFileUrl(projectId, name, workspaceContext), `v=${Math.round(mtime)}&r=${reloadTick}`);
    fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return read(response);
      })
      .then((data) => {
        if (!current) return;
        window.clearTimeout(timer);
        setHeld({ name, data });
        setPhase({ name, value: 'ready' });
      })
      .catch(() => {
        if (!current) return;
        window.clearTimeout(timer);
        setPhase({ name, value: 'failed' });
      });

    return () => {
      current = false;
      window.clearTimeout(timer);
      controller.abort();
    };
    // `read` is stable per caller (module-level function); the fetch is keyed on the file and reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, name, mtime, reloadTick, enabled, tooLarge, workspaceContext]);

  const reload = useCallback(() => setReloadTick((tick) => tick + 1), []);

  const source = useMemo<ArtifactSource<T>>(() => {
    if (tooLarge) return { status: 'too-large', size, limit: maxBytes ?? 0, data: null };
    const mine = held?.name === name ? held : null;
    const value = phase?.name === name ? phase.value : 'loading';
    if (mine) return { status: 'ready', data: mine.data, stale: value !== 'ready' };
    if (value === 'failed') return { status: 'failed', data: null };
    return { status: 'loading', slow: value === 'slow', data: null };
  }, [tooLarge, size, maxBytes, held, phase, name]);

  return { source, reload };
}

const readBytes = (response: Response): Promise<ArrayBuffer> => response.arrayBuffer();
const readText = (response: Response): Promise<string> => response.text();

/** The file's bytes, for decoders (PDF, Office, archives, fonts, models). */
export function useArtifactBytes(
  projectId: string,
  file: ProjectFile,
  options: ArtifactSourceOptions = {},
): ArtifactSourceResult<ArrayBuffer> {
  return useArtifactFetch(projectId, file, readBytes, options);
}

/** The file decoded as UTF-8 text. */
export function useArtifactText(
  projectId: string,
  file: ProjectFile,
  options: ArtifactSourceOptions = {},
): ArtifactSourceResult<string> {
  return useArtifactFetch(projectId, file, readText, options);
}

/** "5.6 KB", "2.3 MB". One decimal below 10 units, none above. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
