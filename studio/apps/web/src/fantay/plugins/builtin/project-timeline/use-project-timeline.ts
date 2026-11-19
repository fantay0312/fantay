// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import type { Project, WorkspaceCollabContext } from '@open-design/contracts';

import { listRunsForProject, RUNS_CHANGED_EVENT } from '../../../../providers/daemon';
import { listProjects } from '../../../../state/projects';
import type { ProjectRunHistory } from './timeline-model';

const RUN_REQUEST_BATCH = 6;
const REFRESH_MS = 15_000;
const ACTIVE_REFRESH_MS = 1_800;

interface TimelineSnapshot {
  projects: Project[];
  histories: ReadonlyMap<string, ProjectRunHistory | null>;
  error: boolean;
  partial: boolean;
}

function activeProjects(snapshot: TimelineSnapshot | null): Project[] {
  return snapshot?.projects.filter(project => snapshot.histories.get(project.id)?.runs.some(
    run => run.status === 'running' || run.status === 'queued',
  )) ?? [];
}

export function useProjectTimeline(context: WorkspaceCollabContext | null) {
  const contextRef = useRef(context);
  contextRef.current = context;
  const [snapshot, setSnapshot] = useState<TimelineSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const refresh = useRef(() => {});
  // The caller keys this hook's subtree to the exact workspace identity.
  useEffect(() => {
    const controller = new AbortController();
    let latest: TimelineSnapshot | null = null;
    let fullRefreshAt = 0;
    let running = false;
    let requestedFullRefresh = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const fullIn = Math.max(0, fullRefreshAt - Date.now());
      const active = activeProjects(latest).length > 0;
      timer = active && fullIn > ACTIVE_REFRESH_MS
        ? setTimeout(() => void load(false), ACTIVE_REFRESH_MS)
        : setTimeout(() => void load(true), fullIn);
    };
    const load = async (full: boolean) => {
      if (controller.signal.aborted || document.visibilityState === 'hidden') return;
      if (running) {
        requestedFullRefresh ||= full;
        return;
      }
      running = true;
      clearTimeout(timer);
      if (full) setRefreshing(true);
      const identity = contextRef.current;
      try {
        const projects = full || !latest
          ? await listProjects({ workspaceContext: identity, workspaceView: 'all', throwOnError: true })
          : latest.projects;
        const histories = new Map<string, ProjectRunHistory | null>(full ? undefined : latest?.histories);
        const refreshProjects = full ? projects : activeProjects(latest);
        for (let offset = 0; offset < refreshProjects.length && !controller.signal.aborted; offset += RUN_REQUEST_BATCH) {
          const batch = refreshProjects.slice(offset, offset + RUN_REQUEST_BATCH);
          const results = await Promise.all(batch.map(project => listRunsForProject(project.id, identity, controller.signal)));
          batch.forEach((project, index) => histories.set(project.id, results[index] ?? null));
        }
        if (!controller.signal.aborted) {
          latest = { projects, histories, error: false, partial: [...histories.values()].includes(null) };
          setSnapshot(latest);
        }
      } catch {
        if (!controller.signal.aborted) {
          latest = { projects: [], histories: new Map(), error: true, partial: false };
          setSnapshot(latest);
        }
      } finally {
        running = false;
        if (!controller.signal.aborted) {
          if (full) {
            fullRefreshAt = Date.now() + REFRESH_MS;
            setRefreshing(false);
          }
          if (requestedFullRefresh) {
            requestedFullRefresh = false;
            void load(true);
          } else {
            schedule();
          }
        }
      }
    };
    const loadAll = () => void load(true);
    refresh.current = loadAll;
    window.addEventListener(RUNS_CHANGED_EVENT, loadAll);
    document.addEventListener('visibilitychange', loadAll);
    loadAll();
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener(RUNS_CHANGED_EVENT, loadAll);
      document.removeEventListener('visibilitychange', loadAll);
    };
  }, []);
  return { snapshot, refreshing, refresh: () => refresh.current() };
}
