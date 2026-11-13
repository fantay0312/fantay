// SPDX-License-Identifier: AGPL-3.0-only
// Load a project's film (`GET /movie`, spec 07 §3.3) with light polling: refetch when `version`
// (the movie-studio.json mtime) changes, poll every `busyPollMs` only while a production or render
// runs. 404 `MOVIE_NOT_FOUND` → `missing`. A refetch keeps showing the previous document.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MovieDocument, WorkspaceCollabContext } from '@open-design/contracts';

import { isMovieNotFound, movieRequest } from '../../providers/movie';
import { isMovieBusy } from './motion-model';

export type MovieDocumentState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ready'; doc: MovieDocument };

export function useMovieDocument(
  projectId: string,
  options: {
    enabled: boolean;
    workspaceContext?: WorkspaceCollabContext | null;
    /** Refetch when it changes (movie-studio.json mtime). */
    version?: number;
    /** Default 4000; polls only while `isMovieBusy(doc)`. */
    busyPollMs?: number;
  },
): MovieDocumentState & { reload(): void } {
  const { enabled, workspaceContext, version, busyPollMs = 4000 } = options;
  const [state, setState] = useState<MovieDocumentState>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const generation = useRef(0);
  const context = useRef(workspaceContext);
  context.current = workspaceContext;
  const workspaceKey = workspaceContext ? `${workspaceContext.workspaceId}:${workspaceContext.workspaceMemberId}` : '';

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  // The project (or identity) changed: start over.
  useEffect(() => {
    setState({ status: 'loading' });
  }, [projectId, workspaceKey]);

  useEffect(() => {
    if (!enabled || !projectId) return;
    const request = ++generation.current;
    movieRequest(projectId, context.current)
      .then((doc) => {
        if (request === generation.current) setState({ status: 'ready', doc });
      })
      .catch((error: unknown) => {
        if (request !== generation.current) return;
        if (isMovieNotFound(error)) setState({ status: 'missing' });
        else setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      // A newer request (or unmount) retires this one.
      if (request === generation.current) generation.current += 1;
    };
  }, [enabled, projectId, workspaceKey, version, nonce]);

  const busy = state.status === 'ready' && isMovieBusy(state.doc);
  useEffect(() => {
    if (!enabled || !busy || !(busyPollMs > 0)) return;
    const timer = setTimeout(reload, busyPollMs);
    return () => clearTimeout(timer);
  }, [enabled, busy, busyPollMs, reload, state]);

  return { ...state, reload } as MovieDocumentState & { reload(): void };
}
