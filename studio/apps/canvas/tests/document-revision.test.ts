// SPDX-License-Identifier: Apache-2.0
/**
 * Document revisions (06 §3.8): autosave counts document edits, not renders. Switching pages,
 * layout passes and a page's layers loading move the SDK's sceneVersion without an edit.
 */
import { describe, expect, it } from 'vitest';

import { trackDocumentRevisions } from '../src/fx/editor/document-revision';

function fakeStore() {
  const handlers = new Map<string, Set<() => void>>();
  const graph = { isApplyingLayout: false, isApplyingDerivedLayout: false, isApplyingImportedState: false };
  const store = {
    graph,
    onEditorEvent(event: string, handler: () => void) {
      const set = handlers.get(event) ?? new Set<() => void>();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
  };
  const emit = (event: string) => {
    for (const handler of handlers.get(event) ?? []) handler();
  };
  const revisions = trackDocumentRevisions(store as unknown as Parameters<typeof trackDocumentRevisions>[0]);
  return { graph, emit, handlers, revisions };
}

describe('trackDocumentRevisions', () => {
  it('moves on layer edits and history changes', () => {
    const { emit, revisions } = fakeStore();
    const events = ['node:created', 'node:updated', 'node:deleted', 'node:reparented', 'node:reordered', 'history:changed', 'document:color-space-changed'];
    for (const event of events) emit(event);
    expect(revisions.revision.value).toBe(events.length);
  });

  it('stays put for renders that change nothing: page switches, selection, the viewport', () => {
    const { emit, revisions } = fakeStore();
    for (const event of ['page:changed', 'render:requested', 'repaint:requested', 'selection:changed', 'viewport:changed', 'tool:changed']) emit(event);
    expect(revisions.revision.value).toBe(0);
  });

  it('ignores layout passes and a page loading its layers', () => {
    const { graph, emit, revisions } = fakeStore();
    graph.isApplyingLayout = true;
    emit('node:updated');
    graph.isApplyingLayout = false;
    graph.isApplyingDerivedLayout = true;
    emit('node:updated');
    graph.isApplyingDerivedLayout = false;
    graph.isApplyingImportedState = true;
    for (const event of ['node:created', 'node:updated', 'node:reparented', 'node:reordered', 'node:deleted']) emit(event);
    graph.isApplyingImportedState = false;
    expect(revisions.revision.value).toBe(0);
    // An edit right after a layout pass still counts.
    emit('node:updated');
    expect(revisions.revision.value).toBe(1);
  });

  it('stops listening when disposed', () => {
    const { emit, handlers, revisions } = fakeStore();
    revisions.dispose();
    emit('node:created');
    emit('history:changed');
    expect(revisions.revision.value).toBe(0);
    expect([...handlers.values()].every((set) => set.size === 0)).toBe(true);
  });
});
