// SPDX-License-Identifier: AGPL-3.0-only
// Filmstrip for covers (spec 07 §3.3): `GET /movie/review-assets?renderId` once per render, shared
// by every cover through a module-level promise cache. Failures are not cached (a later mount retries).
import { useEffect, useState } from 'react';
import type { MovieReviewAssets, WorkspaceCollabContext } from '@open-design/contracts';

import { getMovieReviewAssets } from '../../providers/movie';

const cache = new Map<string, Promise<MovieReviewAssets>>();
const settled = new Map<string, MovieReviewAssets>();

function stripKey(projectId: string, renderId: string): string {
  return `${projectId}:${renderId}`;
}

/** Shared request for one render's review assets. */
export function loadMovieStrip(
  projectId: string,
  renderId: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<MovieReviewAssets> {
  const key = stripKey(projectId, renderId);
  let pending = cache.get(key);
  if (!pending) {
    pending = getMovieReviewAssets(projectId, renderId, workspaceContext).then(
      (assets) => {
        settled.set(key, assets);
        return assets;
      },
      (error: unknown) => {
        cache.delete(key);
        throw error;
      },
    );
    cache.set(key, pending);
  }
  return pending;
}

export function useMovieStrip(
  projectId: string,
  renderId: string | null,
  options: { enabled: boolean; workspaceContext?: WorkspaceCollabContext | null },
): MovieReviewAssets | null {
  const { enabled, workspaceContext } = options;
  const key = renderId ? stripKey(projectId, renderId) : '';
  const [assets, setAssets] = useState<MovieReviewAssets | null>(() => (key ? settled.get(key) ?? null : null));

  useEffect(() => {
    if (!enabled || !renderId) {
      setAssets(null);
      return;
    }
    const known = settled.get(stripKey(projectId, renderId));
    setAssets(known ?? null);
    if (known) return;
    let active = true;
    loadMovieStrip(projectId, renderId, workspaceContext).then(
      (loaded) => {
        if (active) setAssets(loaded);
      },
      () => {
        if (active) setAssets(null);
      },
    );
    return () => {
      active = false;
    };
    // The identity object may be recreated with the same ids; the request only needs the first one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, projectId, renderId]);

  return enabled && renderId ? assets : null;
}

export function resetMovieStripCacheForTests(): void {
  cache.clear();
  settled.clear();
}
