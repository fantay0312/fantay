// SPDX-License-Identifier: AGPL-3.0-only
// Unsaved film edits across tab switches (spec 07 §4.2): FileWorkspace unmounts a non-HTML viewer
// when another tab becomes active, so the editor stashes its dirty draft here on unmount and takes
// it back when it reopens — only while the stored document is still the revision it was based on.
// In memory, per browser tab.
import type { MovieDocument } from '@open-design/contracts';

export interface CachedMovieDraft {
  projectId: string;
  baseRevision: number;
  draft: MovieDocument;
  savedAt: number;
}

const drafts = new Map<string, CachedMovieDraft>();

export function stashMovieDraft(entry: CachedMovieDraft): void {
  drafts.set(entry.projectId, entry);
}

/** The stashed draft when it was based on `currentRevision`; the entry is removed either way. */
export function takeMovieDraft(projectId: string, currentRevision: number): MovieDocument | null {
  const entry = drafts.get(projectId);
  if (!entry) return null;
  drafts.delete(projectId);
  return entry.baseRevision === currentRevision ? entry.draft : null;
}

export function dropMovieDraft(projectId: string): void {
  drafts.delete(projectId);
}

export function resetMovieDraftCacheForTests(): void {
  drafts.clear();
}
