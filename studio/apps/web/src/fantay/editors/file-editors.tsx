// SPDX-License-Identifier: AGPL-3.0-only
// In-workspace file editors (spec 07 §2.1(d), plan R10, amendments C2, B19). One registry, wired once in
// FileWorkspace.renderFileViewer: `renderFantayFileEditor(ctx) ?? <FileViewer …/>`.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isDesignDocumentPath, type ProjectFile, type WorkspaceContextItem } from '@open-design/contracts';

import { designFileEditor } from '../design/file-editor';
import { motionFileEditor } from '../motion/file-editor';
import { setEditorContext } from './editor-context-store';

export type FantayEditorFlushHandler = (reason?: 'close' | 'switch' | 'hidden') => Promise<unknown> | unknown;

export interface FantayFileEditorContext {
  projectId: string;
  file: ProjectFile;
  /** FileWorkspace `workspaceActive`; false while the tab is retained but hidden. */
  active: boolean;
  /** FileWorkspace `runInFlight` (chat run streaming or active for the current conversation). */
  runInFlight: boolean;
  viewerOnly: boolean;
  /**
   * C2: the editor reports its selection as chat context (null clears). Inside `render`, this is
   * always set: it records the item in `editor-context-store` for (projectId, file.name), then calls
   * the callback FileWorkspace passed, if any. Stable identity per (projectId, file, caller callback).
   */
  onActiveContextChange?(item: WorkspaceContextItem | null): void;
  /**
   * B19: optional flush callback invoked (with a bounded wait) before a retained editor unmounts on tab
   * close or keep-alive eviction.
   */
  onRegisterFlush?(handler: FantayEditorFlushHandler | null): void;
}

export interface FantayFileEditor {
  id: 'motion' | (string & {});
  matches(file: ProjectFile): boolean;
  render(context: FantayFileEditorContext): ReactNode;
}

/** Static list of in-workspace Fantay file editors (R10). */
export const FANTAY_FILE_EDITORS: readonly FantayFileEditor[] = [motionFileEditor, designFileEditor];

/** Spec 06 §5.2 & B19: at most 1 active + 1 warm retained design editor per workspace. */
export const FANTAY_DESIGN_KEEPALIVE_CAP = 2;

/** Bounded wait when flushing a closing/evicted retained design tab (B19; > 1200 ms autosave debounce). */
export const FANTAY_EDITOR_CLOSE_FLUSH_MS = 1500;

type ContextCallback = (item: WorkspaceContextItem | null) => void;
type FlushRegistrar = (handler: FantayEditorFlushHandler | null) => void;

const contextWriters = new Map<string, { forward: ContextCallback | undefined; write: ContextCallback }>();
const flushRegistrars = new Map<string, FlushRegistrar>();
const flushHandlers = new Map<string, FantayEditorFlushHandler>();

function slotKey(projectId: string, fileName: string): string {
  return `${projectId}\u0000${fileName}`;
}

function editorContextWriter(projectId: string, fileName: string, forward: ContextCallback | undefined): ContextCallback {
  const key = slotKey(projectId, fileName);
  const cached = contextWriters.get(key);
  if (cached && cached.forward === forward) return cached.write;
  const write: ContextCallback = (item) => {
    setEditorContext(projectId, fileName, item);
    forward?.(item);
  };
  contextWriters.set(key, { forward, write });
  return write;
}

export function registerEditorFlush(
  projectId: string,
  fileName: string,
  handler: FantayEditorFlushHandler | null,
): () => void {
  const key = slotKey(projectId, fileName);
  if (handler) flushHandlers.set(key, handler);
  else flushHandlers.delete(key);
  return () => {
    if (flushHandlers.get(key) === handler) flushHandlers.delete(key);
  };
}

function editorFlushRegistrar(projectId: string, fileName: string): FlushRegistrar {
  const key = slotKey(projectId, fileName);
  const cached = flushRegistrars.get(key);
  if (cached) return cached;
  const register: FlushRegistrar = (handler) => {
    registerEditorFlush(projectId, fileName, handler);
  };
  flushRegistrars.set(key, register);
  return register;
}

export async function flushRetainedEditor(
  projectId: string,
  fileName: string,
  timeoutMs: number = FANTAY_EDITOR_CLOSE_FLUSH_MS,
): Promise<void> {
  const handler = flushHandlers.get(slotKey(projectId, fileName));
  const boundedMs = Math.max(0, timeoutMs);
  if (!handler) {
    await new Promise<void>((resolve) => setTimeout(resolve, boundedMs));
    return;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    let flushPromise: Promise<void>;
    try {
      flushPromise = Promise.resolve(handler('close')).then(
        () => undefined,
        () => undefined,
      );
    } catch {
      flushPromise = Promise.resolve();
    }
    await Promise.race([
      flushPromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, boundedMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export function resetEditorFlushesForTests(): void {
  flushHandlers.clear();
  flushRegistrars.clear();
}

export function isRetainedFantayEditorPath(path: string): boolean {
  return isDesignDocumentPath(path);
}

export function isRetainedFantayEditorFile(file: ProjectFile | null | undefined): boolean {
  return Boolean(file && file.type !== 'dir' && isDesignDocumentPath(file.path ?? file.name));
}

export function resolveRetainedFantayEditorFile(name: string, files: readonly ProjectFile[]): ProjectFile | null {
  const existing = files.find((candidate) => candidate.name === name);
  if (existing) return existing.type === 'dir' ? null : existing;
  if (!isRetainedFantayEditorPath(name)) return null;
  return {
    name,
    path: name,
    type: 'file',
    size: 0,
    mtime: 0,
    kind: 'binary',
    mime: 'application/octet-stream',
  };
}

export interface UseRetainedFantayEditorsInput {
  enabled: boolean;
  projectId: string;
  activeTab: string;
  persistedTabs: readonly string[];
  files: readonly ProjectFile[];
  cap?: number;
  closeFlushMs?: number;
}

/**
 * B19: keeps open `.fig`/`.op` tabs mounted (hidden while inactive) across tab switches and the 画板/文件
 * roots, and flushes with a bounded wait before unmounting when a design tab closes or is evicted.
 */
export function useRetainedFantayEditors({
  enabled,
  projectId,
  activeTab,
  persistedTabs,
  files,
  cap = FANTAY_DESIGN_KEEPALIVE_CAP,
  closeFlushMs = FANTAY_EDITOR_CLOSE_FLUSH_MS,
}: UseRetainedFantayEditorsInput): ProjectFile[] {
  const [liveNames, setLiveNames] = useState<string[]>([]);
  const [, bumpClosingRevision] = useState(0);

  const snapshotsRef = useRef<{ projectId: string; files: Map<string, ProjectFile> }>({
    projectId,
    files: new Map(),
  });
  const previousActiveSetRef = useRef<{ projectId: string; names: Set<string> }>({
    projectId,
    names: new Set(),
  });
  const closingRef = useRef<{ projectId: string; names: Set<string>; inFlight: Map<string, { cancel: () => void }> }>({
    projectId,
    names: new Set(),
    inFlight: new Map(),
  });

  if (snapshotsRef.current.projectId !== projectId) {
    snapshotsRef.current = { projectId, files: new Map() };
  }
  if (previousActiveSetRef.current.projectId !== projectId) {
    previousActiveSetRef.current = { projectId, names: new Set() };
  }
  if (closingRef.current.projectId !== projectId) {
    for (const task of closingRef.current.inFlight.values()) task.cancel();
    closingRef.current = { projectId, names: new Set(), inFlight: new Map() };
  }

  useEffect(() => {
    setLiveNames([]);
  }, [projectId]);

  const activeRetainedName =
    enabled && isRetainedFantayEditorPath(activeTab) && persistedTabs.includes(activeTab) ? activeTab : null;

  useEffect(() => {
    if (!activeRetainedName) return;
    setLiveNames((current) => [activeRetainedName, ...current.filter((name) => name !== activeRetainedName)].slice(0, cap));
  }, [activeRetainedName, cap, projectId]);

  const openRetainedTabs = useMemo(
    () => (enabled ? persistedTabs.filter(isRetainedFantayEditorPath) : []),
    [enabled, persistedTabs],
  );

  const activeRetainedSet = useMemo(() => {
    if (!enabled) return new Set<string>();
    const openSet = new Set(openRetainedTabs);
    const orderedCandidates = activeRetainedName
      ? [activeRetainedName, ...liveNames.filter((name) => name !== activeRetainedName && openSet.has(name))]
      : liveNames.filter((name) => openSet.has(name));
    return new Set(orderedCandidates.slice(0, cap));
  }, [activeRetainedName, cap, enabled, liveNames, openRetainedTabs]);

  // Update file snapshots for every open or active retained design tab.
  const snapshots = snapshotsRef.current.files;
  for (const name of activeRetainedSet) {
    const resolved = resolveRetainedFantayEditorFile(name, files);
    if (resolved) snapshots.set(name, resolved);
  }

  // Synchronously bridge any tab leaving `activeRetainedSet` into `closingRef` on the same render frame
  // so the editor never unmounts before its close-flush runs.
  const closing = closingRef.current;
  for (const name of activeRetainedSet) {
    if (closing.names.has(name)) {
      closing.names.delete(name);
      closing.inFlight.get(name)?.cancel();
      closing.inFlight.delete(name);
    }
  }
  for (const prevName of previousActiveSetRef.current.names) {
    if (!activeRetainedSet.has(prevName)) {
      closing.names.add(prevName);
    }
  }
  previousActiveSetRef.current = { projectId, names: activeRetainedSet };

  useEffect(() => {
    const currentClosing = closingRef.current;
    for (const name of [...currentClosing.names]) {
      if (currentClosing.inFlight.has(name)) continue;
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
      };
      currentClosing.inFlight.set(name, { cancel });
      void flushRetainedEditor(projectId, name, closeFlushMs).then(() => {
        if (cancelled || closingRef.current !== currentClosing) return;
        currentClosing.inFlight.delete(name);
        if (currentClosing.names.delete(name)) {
          if (!persistedTabs.includes(name)) snapshotsRef.current.files.delete(name);
          bumpClosingRevision((rev) => rev + 1);
        }
      });
    }
  });

  useEffect(
    () => () => {
      for (const task of closingRef.current.inFlight.values()) task.cancel();
      closingRef.current.inFlight.clear();
    },
    [],
  );

  const orderedNames: string[] = [];
  const seen = new Set<string>();
  for (const name of persistedTabs) {
    if ((activeRetainedSet.has(name) || closing.names.has(name)) && !seen.has(name)) {
      orderedNames.push(name);
      seen.add(name);
    }
  }
  for (const name of closing.names) {
    if (!seen.has(name)) {
      orderedNames.push(name);
      seen.add(name);
    }
  }

  return orderedNames
    .map((name) => resolveRetainedFantayEditorFile(name, files) ?? snapshots.get(name) ?? null)
    .filter((file): file is ProjectFile => file !== null);
}

/** First editor of `editors` whose `matches(file)` is true renders; null when none matches. */
export function renderFileEditorFrom(
  editors: readonly FantayFileEditor[],
  context: FantayFileEditorContext,
): ReactNode | null {
  const editor = editors.find((candidate) => candidate.matches(context.file));
  if (!editor) return null;
  return editor.render({
    ...context,
    onActiveContextChange: editorContextWriter(context.projectId, context.file.name, context.onActiveContextChange),
    onRegisterFlush: context.onRegisterFlush ?? editorFlushRegistrar(context.projectId, context.file.name),
  });
}

export function renderFantayFileEditor(context: FantayFileEditorContext): ReactNode | null {
  return renderFileEditorFrom(FANTAY_FILE_EDITORS, context);
}
