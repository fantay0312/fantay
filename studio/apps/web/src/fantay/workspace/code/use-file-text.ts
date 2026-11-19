// SPDX-License-Identifier: AGPL-3.0-only
// Loads the text of the one file the 代码 surface is showing. Nothing is fetched for files that are
// not selected. A newer version of the same file replaces the old text only when it arrives, so the
// reader never sees the page blink while the agent is writing.
import { useCallback, useEffect, useState } from 'react';

import { useProjectCollabContext } from '../../../collab/collab-context';
import { fetchProjectFileText } from '../../../providers/registry';
import type { ProjectFile } from '../../../types';
import { normalizeNewlines } from './original-text';
import { looksBinary } from './text-preview';

/** A load faster than this shows no loading state at all. */
const SLOW_LOAD_MS = 180;

export interface LoadedText {
  name: string;
  size: number;
  /** The file exactly as served (what "copy" copies). */
  raw: string;
  /** The same text with "\n" line breaks only (what the editor shows). */
  text: string;
  /** The bytes did not decode as text. */
  binary: boolean;
}

export interface FileTextState {
  /** The last text that arrived. It may still be the previous file's while the next one loads. */
  loaded: LoadedText | null;
  /** The current file has been loading for longer than the grace period. */
  slow: boolean;
  /** The current file could not be loaded and no earlier version of it is at hand. */
  failed: boolean;
  reload(): void;
}

type Phase = 'loading' | 'slow' | 'ready' | 'failed';

export function useFileText(projectId: string, file: ProjectFile | null): FileTextState {
  const { workspaceContext } = useProjectCollabContext();
  const [loaded, setLoaded] = useState<LoadedText | null>(null);
  // The phase is stored with the file it describes, so a file switch never shows the old file's phase.
  const [status, setStatus] = useState<{ name: string; phase: Phase } | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const name = file?.name ?? null;
  const mtime = file?.mtime ?? 0;
  const size = file?.size ?? 0;

  useEffect(() => {
    if (name === null) {
      // Nothing is being read (no selection, or a file that is not text): drop the old text, so it
      // cannot resurface under the next file's name. Its phase goes with it: a "ready" left behind
      // would make the same file, picked again later, load without ever saying it is loading.
      setLoaded(null);
      setStatus(null);
      return;
    }
    const controller = new AbortController();
    // A response for a file (or version) that is no longer wanted is dropped.
    let current = true;
    setStatus((previous) =>
      previous?.name === name && previous.phase === 'ready' ? previous : { name, phase: 'loading' },
    );
    const timer = window.setTimeout(() => {
      if (!current) return;
      setStatus((previous) => (previous?.name === name && previous.phase === 'loading' ? { name, phase: 'slow' } : previous));
    }, SLOW_LOAD_MS);

    void fetchProjectFileText(projectId, name, {
      workspaceContext,
      cacheBustKey: mtime,
      signal: controller.signal,
    }).then((raw) => {
      if (!current) return;
      window.clearTimeout(timer);
      if (raw === null) {
        setStatus({ name, phase: 'failed' });
        return;
      }
      setLoaded((previous) =>
        // Unchanged content keeps the same object: nothing downstream recomputes or scrolls.
        previous && previous.name === name && previous.raw === raw
          ? previous
          : { name, size, raw, text: normalizeNewlines(raw), binary: looksBinary(raw) },
      );
      setStatus({ name, phase: 'ready' });
    });

    return () => {
      current = false;
      window.clearTimeout(timer);
      controller.abort();
    };
    // `size` rides along with `mtime`: a new size without a new mtime is not a new version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, name, mtime, workspaceContext, reloadTick]);

  const reload = useCallback(() => setReloadTick((tick) => tick + 1), []);

  const phase: Phase = name !== null && status?.name === name ? status.phase : 'loading';
  const hasCurrent = loaded !== null && loaded.name === name;
  return {
    loaded,
    slow: phase === 'slow',
    failed: phase === 'failed' && !hasCurrent,
    reload,
  };
}
