// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatRunStatusResponse, Project } from '@open-design/contracts';

export const UPDATE_LIMIT = 140;
export const TIMELINE_ORDERS = ['newest', 'oldest', 'progress'] as const;
export type TimelineOrder = typeof TIMELINE_ORDERS[number];

export interface TimelineNote {
  id: string;
  projectId: string | null;
  at: number;
  text: string;
}

export interface ProjectRunHistory {
  runs: ChatRunStatusResponse[];
  awaitingInputProjectIds: string[];
}

type RunKind = ChatRunStatusResponse['status'] | 'awaiting_input' | 'incomplete';

export interface TimelineEntry {
  id: string;
  kind: 'created' | 'note' | RunKind;
  project: Project | null;
  at: number;
  completedAt?: number;
  text?: string;
  agentId?: string | null;
  conversationId?: string | null;
  files: string[];
}

export function validTime(at: number): boolean {
  return typeof at === 'number' && Number.isFinite(new Date(at).getTime()) && at > 0;
}

export function isProjectFile(path: string): boolean {
  return typeof path === 'string' && !/[\\\u0000-\u001f]/u.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export function mediaKind(path: string): 'image' | 'video' | null {
  if (/\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(path)) return 'image';
  if (/\.(?:m4v|mov|mp4|webm)$/i.test(path)) return 'video';
  return null;
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function buildTimeline(
  projects: readonly Project[],
  histories: ReadonlyMap<string, ProjectRunHistory | null>,
  notes: readonly TimelineNote[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const projectById = new Map(projects.map(project => [project.id, project]));
  for (const project of projects) {
    if (validTime(project.createdAt)) {
      entries.push({ id: `project:${project.id}`, project, kind: 'created', at: project.createdAt, files: [] });
    }
    const history = histories.get(project.id);
    if (!history) continue;
    const runs = history.runs.filter(run => run.projectId === project.id);
    const lastRun = runs.reduce<ChatRunStatusResponse | null>(
      (previous, run) => !previous || run.updatedAt > previous.updatedAt ? run : previous,
      null,
    );
    const waiting = history.awaitingInputProjectIds.includes(project.id);
    for (const run of runs) {
      const active = run.status === 'queued' || run.status === 'running';
      const terminalAt = active ? null : run.terminalAt ?? run.updatedAt;
      const at = validTime(run.createdAt) ? run.createdAt : terminalAt;
      if (at === null || !validTime(at)) continue;
      let kind: RunKind = run.status;
      if (kind === 'succeeded') {
        if (waiting && run.id === lastRun?.id) kind = 'awaiting_input';
        else if (run.endedWithUnfinishedWork || run.strategyTask?.outcome === 'blocked') kind = 'incomplete';
      }
      const completed = kind === 'succeeded' && (!run.strategyTask || run.strategyTask.outcome === 'completed');
      entries.push({
        id: `run:${run.id}`, kind, project, at,
        completedAt: completed && terminalAt !== null && validTime(terminalAt) ? terminalAt : undefined,
        agentId: run.agentId,
        conversationId: run.conversationId,
        files: [...new Set(run.artifactPaths?.filter(isProjectFile) ?? [])],
      });
    }
  }
  for (const note of notes) {
    const project = note.projectId === null ? null : projectById.get(note.projectId);
    if (project !== undefined) {
      entries.push({ id: `note:${note.id}`, project, kind: 'note', at: note.at, text: note.text, files: [] });
    }
  }
  return entries;
}

export function sortTimeline(entries: readonly TimelineEntry[], order: TimelineOrder): TimelineEntry[] {
  return [...entries].sort((a, b) => {
    const timeOrder = order === 'oldest' ? a.at - b.at : b.at - a.at;
    const completionOrder = order === 'progress' ? (b.completedAt ?? 0) - (a.completedAt ?? 0) : 0;
    return completionOrder || timeOrder || (a.id < b.id ? -1 : a.id === b.id ? 0 : 1);
  });
}

export function timelineFollowTarget(entry: TimelineEntry) {
  if (entry.kind === 'note' || !entry.project) return { key: entry.id, kind: 'note' } as const;
  if (entry.conversationId) {
    return { key: `conversation:${JSON.stringify([entry.project.id, entry.conversationId])}`, kind: 'conversation' } as const;
  }
  return { key: `project:${entry.project.id}`, kind: 'project' } as const;
}

export function showsInFollowing(entry: TimelineEntry, follows: ReadonlySet<string>): boolean {
  return follows.has(timelineFollowTarget(entry).key) || Boolean(entry.project && follows.has(`project:${entry.project.id}`));
}

export function groupTimelineDays(entries: readonly TimelineEntry[], locale: string) {
  const calendarDay = new Intl.DateTimeFormat(locale, { dateStyle: 'long' });
  const days = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    const day = calendarDay.format(entry.at);
    const items = days.get(day);
    if (items) items.push(entry);
    else days.set(day, [entry]);
  }
  return [...days].map(([day, items]) => ({ day, items }));
}
