// SPDX-License-Identifier: AGPL-3.0-only
// The first part of a file that is too large to load whole. The daemon reads only the head from
// disk, so a 2 GB log opens as fast as a small one. The result has the same shape as the other
// artifact sources, so "loading", "failed" and "retry" read the same as for every other file.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useProjectCollabContext } from '../../../../collab/collab-context';
import { fetchProjectFileTextPreview } from '../../../../providers/registry';
import type { ProjectFile } from '../../../../types';
import { ARTIFACT_SLOW_LOAD_MS, type ArtifactSource, type ArtifactSourceResult } from '../../use-artifact-source';
import { TEXT_HEAD_BYTES, trimToWholeLines } from './text-format';

export interface TextHead {
  /** Whole lines from the start of the file. */
  text: string;
  /** How many bytes of the file those lines are. */
  bytes: number;
}

type Phase = 'loading' | 'slow' | 'ready' | 'failed';

export function useTextHead(projectId: string, file: ProjectFile, enabled: boolean): ArtifactSourceResult<TextHead> {
  const { workspaceContext } = useProjectCollabContext();
  const [reloadTick, setReloadTick] = useState(0);
  const [held, setHeld] = useState<{ name: string; data: TextHead } | null>(null);
  const [phase, setPhase] = useState<{ name: string; value: Phase } | null>(null);
  const name = file.name;
  const mtime = file.mtime;

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setPhase((previous) => (previous?.name === name && previous.value === 'ready' ? previous : { name, value: 'loading' }));
    const timer = window.setTimeout(() => {
      if (!current) return;
      setPhase((previous) => (previous?.name === name && previous.value === 'loading' ? { name, value: 'slow' } : previous));
    }, ARTIFACT_SLOW_LOAD_MS);

    void fetchProjectFileTextPreview(projectId, name, {
      limit: TEXT_HEAD_BYTES,
      cacheBustKey: `${Math.round(mtime)}-${reloadTick}`,
      workspaceContext,
    }).then((response) => {
      if (!current) return;
      window.clearTimeout(timer);
      if (response === null) {
        setPhase({ name, value: 'failed' });
        return;
      }
      const text = response.truncated ? trimToWholeLines(response.text) : response.text;
      setHeld({ name, data: { text, bytes: new Blob([text]).size } });
      setPhase({ name, value: 'ready' });
    });

    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [projectId, name, mtime, reloadTick, enabled, workspaceContext]);

  const reload = useCallback(() => setReloadTick((tick) => tick + 1), []);

  const source = useMemo<ArtifactSource<TextHead>>(() => {
    const mine = held?.name === name ? held : null;
    const value = phase?.name === name ? phase.value : 'loading';
    if (mine) return { status: 'ready', data: mine.data, stale: value !== 'ready' };
    if (value === 'failed') return { status: 'failed', data: null };
    return { status: 'loading', slow: value === 'slow', data: null };
  }, [held, phase, name]);

  return { source, reload };
}
