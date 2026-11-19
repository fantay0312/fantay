// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceCollabContext } from '@open-design/contracts';

import { UPDATE_LIMIT, validTime, type TimelineNote } from './timeline-model';

export function timelineStoragePrefix(context: WorkspaceCollabContext | null, accountId: string | null): string {
  const principal = context ? [context.workspaceId, context.workspaceMemberId] : ['local', accountId];
  return `fantay.project-timeline.v1:${encodeURIComponent(JSON.stringify(principal))}:`;
}

export function readTimelineNotes(storage: Storage, prefix: string): TimelineNote[] {
  const notes: TimelineNote[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    try {
      const note = JSON.parse(storage.getItem(key) ?? 'null') as TimelineNote | null;
      if (note && typeof note.id === 'string' && key === prefix + note.id &&
          (note.projectId === null || typeof note.projectId === 'string') && validTime(note.at) &&
          typeof note.text === 'string' && note.text.trim() && [...note.text].length <= UPDATE_LIMIT) {
        notes.push(note);
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return notes;
}

export function saveTimelineNote(storage: Storage, prefix: string, projectId: string | null, text: string): TimelineNote {
  const note = { id: crypto.randomUUID(), projectId, at: Date.now(), text: text.trim() };
  if (!note.text || [...note.text].length > UPDATE_LIMIT) throw new RangeError('Invalid timeline update length');
  storage.setItem(prefix + note.id, JSON.stringify(note));
  return note;
}
