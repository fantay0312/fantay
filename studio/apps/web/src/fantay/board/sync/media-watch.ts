// SPDX-License-Identifier: AGPL-3.0-only
// Media task watch (spec 04 §7.1 media-watch.ts): while a run is in flight or the board shows queued/running media,
// poll the project's media tasks every 1500 ms and report signature changes, so chat sync turns finished agent tasks
// into board refs. Only tasks with a `runId` count (generator-node tasks are written by the generation UI itself).
import { useEffect, useRef } from 'react';
import type { ProjectMediaTask, WorkspaceCollabContext } from '@open-design/contracts';

import { workspaceIdentityCacheKey } from '../../../collab/workspace-identity';
import { fetchProjectMediaTasks } from '../../../providers/registry';
import { BOARD_MEDIA_POLL_MS } from '../data/constants';

/** Sorted `${taskId}:${status}:${file?.name ?? ''}` of tasks with a runId, joined by `|`. */
export function boardMediaSignature(tasks: readonly ProjectMediaTask[]): string {
  return tasks
    .filter((task) => typeof task.runId === 'string' && task.runId.length > 0)
    .map((task) => `${task.taskId}:${task.status}:${task.file?.name ?? ''}`)
    .sort()
    .join('|');
}

export interface BoardMediaWatchInput {
  projectId: string;
  enabled: boolean;
  workspaceContext: WorkspaceCollabContext | null;
  /** Called with the new signature whenever it differs from the last one seen while enabled (first non-empty included). */
  onSignatureChange: (signature: string) => void;
  /** Test seams. */
  fetchTasks?: typeof fetchProjectMediaTasks;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export function useBoardMediaWatch(input: BoardMediaWatchInput): void {
  const { projectId, enabled } = input;
  const latest = useRef(input);
  latest.current = input;
  const identityKey = workspaceIdentityCacheKey(input.workspaceContext);

  useEffect(() => {
    if (!enabled || !projectId) return undefined;
    const setT = latest.current.setTimeoutFn ?? setTimeout;
    const clearT = latest.current.clearTimeoutFn ?? clearTimeout;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSignature = '';
    const poll = (): void => {
      timer = null;
      const fetchTasks = latest.current.fetchTasks ?? fetchProjectMediaTasks;
      let request: Promise<{ tasks: ProjectMediaTask[] }>;
      try {
        request = fetchTasks(projectId, latest.current.workspaceContext);
      } catch (error) {
        request = Promise.reject(error);
      }
      request
        .then((response) => {
          if (cancelled) return;
          const signature = boardMediaSignature(Array.isArray(response?.tasks) ? response.tasks : []);
          if (signature !== lastSignature) {
            lastSignature = signature;
            latest.current.onSignatureChange(signature);
          }
        })
        .catch(() => {
          // Transient: the next poll tries again.
        })
        .finally(() => {
          if (!cancelled) timer = setT(poll, BOARD_MEDIA_POLL_MS);
        });
    };
    timer = setT(poll, 0);
    return () => {
      cancelled = true;
      if (timer !== null) clearT(timer);
    };
  }, [enabled, projectId, identityKey]);
}
