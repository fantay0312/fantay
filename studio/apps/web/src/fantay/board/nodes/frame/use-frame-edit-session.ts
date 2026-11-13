// SPDX-License-Identifier: AGPL-3.0-only
// Edit = a board-native session on the existing manual-edit bridge (spec 03 §5.3, decision 1.9). State machine
// idle → loading → mounting → active ⇄ saving → exiting → idle. The frame loads its source, mounts an editing
// srcdoc (`buildSrcdoc({ editBridge: true })`) as the pending iframe, turns the bridge on, and every committed edit is
// `applyManualEditPatch` on the source + `writeProjectTextFileDetailed(…, versionSource: 'manual')`. An external file
// change ends the session (the edit would be applied to a stale source). FileViewer is not touched: the draft and
// content-patch rules below mirror its `manualEditDraftForTarget` / `manualEditContentPatchForDraft`.
import { emptyManualEditDraft, manualEditPatchSummary, type ManualEditDraft } from '../../../../components/ManualEditPanel';
import {
  applyManualEditPatch,
  readManualEditAttributes,
  readManualEditFields,
  readManualEditOuterHtml,
  readManualEditStyles,
} from '../../../../edit-mode/source-patches';
import {
  MANUAL_EDIT_STYLE_PROPS,
  type ManualEditBridgeMessage,
  type ManualEditHistoryEntry,
  type ManualEditPatch,
  type ManualEditStyles,
  type ManualEditTarget,
} from '../../../../edit-mode/types';
import { FRAME_SOURCE_MAX_BYTES } from '../../engine/frame-transport';
import type { DictKey, NodeEditSessionState } from '../../model/types';

export interface FrameEditSessionState {
  nodeId: string;
  path: string;
  phase: NodeEditSessionState;
  targets: ManualEditTarget[];
  selected: ManualEditTarget | null;
  draft: ManualEditDraft;
  history: ManualEditHistoryEntry[];
  undone: ManualEditHistoryEntry[];
  error: string | null;
  busy: boolean;
}

export type FrameEditWriteResult = { ok: true; mtime: number | null } | { ok: false; message: string };

export interface FrameEditNotice {
  key: DictKey;
  vars?: Record<string, string | number>;
  tone?: 'default' | 'success' | 'danger';
}

export type FrameEditEndReason = 'exit' | 'refused' | 'conflict' | 'failed';

export interface FrameEditSessionDeps {
  nodeId: string;
  path: string;
  readOnly: boolean;
  /** mtime of the file when the session starts (later changes that are not ours end the session) */
  initialMtime?: number | undefined;
  /** size of the file on disk, when known */
  sizeBytes(): number | undefined;
  loadSource(): Promise<string | null>;
  /** mounts an editing srcdoc built from `source`; the face calls `frameLoaded()` once that document loaded */
  mountEditing(source: string): void;
  write(content: string, versionLabel: string): Promise<FrameEditWriteResult>;
  post(message: unknown): void;
  notify(notice: FrameEditNotice): void;
  /** the session is over: the face leaves Edit and returns to its passive transport */
  onEnded(reason: FrameEditEndReason): void;
  /** version labels (ManualEditPanel semantics): content and HTML edits */
  labels: { content: string; html: string; undo: string; redo: string };
  wait?(ms: number): Promise<void>;
  now?(): number;
}

export interface FrameEditSession {
  readonly nodeId: string;
  getState(): FrameEditSessionState;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  /** the editing document loaded: turns the bridge on */
  frameLoaded(): void;
  handleMessage(message: ManualEditBridgeMessage): void;
  selectTarget(target: ManualEditTarget): void;
  clearSelection(): void;
  setDraft(draft: ManualEditDraft): void;
  previewStyles(id: string, styles: Partial<ManualEditStyles>): void;
  applyPatch(patch: ManualEditPatch, label: string): Promise<boolean>;
  saveDraft(): Promise<void>;
  cancelDraft(): void;
  resetDraft(): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
  setError(message: string | null): void;
  /** the file list reports a new mtime for the edited file */
  fileChanged(mtime: number): void;
  exit(): Promise<void>;
  dispose(): void;
}

/** Inspector styles: the source's inline value, else what the bridge measured on the element. */
export function mergeInspectorStyles(source: ManualEditStyles, measured: ManualEditStyles): ManualEditStyles {
  return MANUAL_EDIT_STYLE_PROPS.reduce<ManualEditStyles>((acc, key) => {
    acc[key] = source[key]?.trim() || measured[key]?.trim() || '';
    return acc;
  }, {} as ManualEditStyles);
}

/** The panel draft of a picked element, read from the source first (FileViewer `manualEditDraftForTarget`). */
export function draftForTarget(target: ManualEditTarget, source: string): ManualEditDraft {
  const fields = readManualEditFields(source, target.id);
  return {
    text: fields.text ?? target.fields.text ?? target.text,
    href: fields.href ?? target.fields.href ?? '',
    src: fields.src ?? target.fields.src ?? '',
    alt: fields.alt ?? target.fields.alt ?? '',
    styles: mergeInspectorStyles(readManualEditStyles(source, target.id), target.styles),
    attributesText: JSON.stringify(readManualEditAttributes(source, target.id), null, 2),
    outerHtml: readManualEditOuterHtml(source, target.id) || target.outerHtml,
    fullSource: source,
  };
}

/** The content patch a panel draft implies (FileViewer `manualEditContentPatchForDraft`), or null. */
export function contentPatchForDraft(
  target: ManualEditTarget,
  draft: ManualEditDraft,
  source: string,
  labels: { content: string; html: string },
): { patch: ManualEditPatch; label: string } | null {
  const fields = readManualEditFields(source, target.id);
  if (target.kind === 'text' || target.kind === 'token') {
    const current = fields.text ?? target.fields.text ?? target.text;
    return draft.text !== current ? { patch: { id: target.id, kind: 'set-text', value: draft.text }, label: labels.content } : null;
  }
  if (target.kind === 'link') {
    const currentText = fields.text ?? target.fields.text ?? target.text;
    const currentHref = fields.href ?? target.fields.href ?? '';
    return draft.text !== currentText || draft.href !== currentHref
      ? { patch: { id: target.id, kind: 'set-link', text: draft.text, href: draft.href }, label: labels.content }
      : null;
  }
  if (target.kind === 'image') {
    const currentSrc = fields.src ?? target.fields.src ?? '';
    const currentAlt = fields.alt ?? target.fields.alt ?? '';
    return draft.src !== currentSrc || draft.alt !== currentAlt
      ? { patch: { id: target.id, kind: 'set-image', src: draft.src, alt: draft.alt }, label: labels.content }
      : null;
  }
  const currentOuter = readManualEditOuterHtml(source, target.id) || target.outerHtml;
  return draft.outerHtml !== currentOuter ? { patch: { id: target.id, kind: 'set-outer-html', html: draft.outerHtml }, label: labels.html } : null;
}

/** Patches the live bridge cannot mirror in the DOM: the editing document is rebuilt after them. */
export function patchNeedsRebuild(patch: ManualEditPatch): boolean {
  return patch.kind !== 'set-text' && patch.kind !== 'set-style';
}

const MTIME_TOLERANCE_MS = 1;

export function createFrameEditSession(deps: FrameEditSessionDeps): FrameEditSession {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const listeners = new Set<() => void>();
  let state: FrameEditSessionState = {
    nodeId: deps.nodeId,
    path: deps.path,
    phase: 'idle',
    targets: [],
    selected: null,
    draft: emptyManualEditDraft(),
    history: [],
    undone: [],
    error: null,
    busy: false,
  };
  let source: string | null = null;
  let ended = false;
  let conflicted = false;
  let previewVersion = 0;
  /** element id → preview styles not saved yet */
  let pendingStyles: { id: string; styles: Partial<ManualEditStyles> } | null = null;
  /** mtimes this session wrote (the file list echoes them back) */
  const ours: number[] = [];
  let knownMtime: number | null = deps.initialMtime !== undefined && Number.isFinite(deps.initialMtime) ? deps.initialMtime : null;
  let saving: Promise<unknown> = Promise.resolve();

  const set = (patch: Partial<FrameEditSessionState>): void => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const isOurs = (mtime: number): boolean => ours.some((value) => Math.abs(value - mtime) <= MTIME_TOLERANCE_MS);

  function end(reason: FrameEditEndReason): void {
    if (ended) return;
    ended = true;
    pendingStyles = null;
    set({ phase: 'idle', busy: false, selected: null });
    deps.onEnded(reason);
  }

  function editable(): boolean {
    return !ended && !conflicted && (state.phase === 'active' || state.phase === 'saving' || state.phase === 'exiting');
  }

  async function write(next: string, label: string): Promise<boolean> {
    const result = await deps.write(next, label);
    if (!result.ok) {
      set({ error: result.message });
      deps.notify({ key: 'board.edit.failed', vars: { reason: result.message }, tone: 'danger' });
      return false;
    }
    if (result.mtime !== null) {
      ours.push(result.mtime);
      knownMtime = result.mtime;
    }
    return true;
  }

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = saving.then(task, task);
    saving = run.catch(() => undefined);
    return run;
  }

  async function applyPatchNow(patch: ManualEditPatch, label: string): Promise<boolean> {
    if (!editable() || source === null) return false;
    const base = source;
    const result = applyManualEditPatch(base, patch);
    if (!result.ok) {
      set({ error: result.error ?? 'Could not apply edit.' });
      return false;
    }
    // nothing changed: no write, no history entry, and no rebuild (an identical document never loads again, so the
    // session would wait in `mounting` for good)
    if (result.source === base) return true;
    const exiting = state.phase === 'exiting';
    if (!exiting) set({ phase: 'saving', busy: true, error: null });
    const ok = await write(result.source, label || manualEditPatchSummary(patch));
    if (ended || conflicted) return false;
    if (!ok) {
      if (!exiting) set({ phase: 'active', busy: false });
      return false;
    }
    source = result.source;
    const entry: ManualEditHistoryEntry = {
      id: `${now()}-${state.history.length}`,
      label,
      patch,
      beforeSource: base,
      afterSource: result.source,
      createdAt: now(),
    };
    let selected = state.selected;
    let draft = { ...state.draft, fullSource: result.source };
    if (patch.kind === 'set-text' && selected?.id === patch.id) {
      selected = { ...selected, text: patch.value, fields: { ...selected.fields, text: patch.value } };
      draft = { ...draft, text: patch.value };
    }
    if (patch.kind === 'remove-element' && selected?.id === patch.id) {
      selected = null;
      draft = emptyManualEditDraft(result.source);
    }
    set({
      history: [entry, ...state.history],
      undone: [],
      selected,
      draft,
      ...(exiting ? {} : { phase: 'active' as const, busy: false }),
    });
    if (patchNeedsRebuild(patch) && !exiting) {
      set({ phase: 'mounting' });
      deps.mountEditing(result.source);
    }
    return true;
  }

  function revertPreview(): void {
    if (!pendingStyles) return;
    const target = state.targets.find((entry) => entry.id === pendingStyles?.id) ?? state.selected;
    const original: Partial<ManualEditStyles> = {};
    for (const key of Object.keys(pendingStyles.styles) as Array<keyof ManualEditStyles>) {
      original[key] = target?.id === pendingStyles.id ? (readManualEditStyles(source ?? '', target.id)[key] ?? '') : '';
    }
    previewVersion += 1;
    deps.post({ type: 'od-edit-preview-style', id: pendingStyles.id, styles: original, version: previewVersion });
    pendingStyles = null;
  }

  const session: FrameEditSession = {
    nodeId: deps.nodeId,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start() {
      if (state.phase !== 'idle' || ended) return;
      if (deps.readOnly) {
        deps.notify({ key: 'board.mode.reason.readOnly' });
        end('refused');
        return;
      }
      const size = deps.sizeBytes();
      if (size !== undefined && size > FRAME_SOURCE_MAX_BYTES) {
        deps.notify({ key: 'board.mode.reason.tooLarge' });
        end('refused');
        return;
      }
      set({ phase: 'loading', busy: true });
      const loaded = await deps.loadSource().catch(() => null);
      if (ended) return;
      if (loaded === null) {
        deps.notify({ key: 'board.edit.failed', vars: { reason: deps.path }, tone: 'danger' });
        end('failed');
        return;
      }
      source = loaded;
      set({ phase: 'mounting', draft: emptyManualEditDraft(loaded) });
      deps.mountEditing(loaded);
    },
    frameLoaded() {
      if (ended || (state.phase !== 'mounting' && state.phase !== 'active')) return;
      deps.post({ type: 'od-edit-mode', enabled: true });
      if (state.selected) deps.post({ type: 'od-edit-selected-target', id: state.selected.id });
      set({ phase: 'active', busy: false });
    },
    handleMessage(message) {
      if (ended) return;
      switch (message.type) {
        case 'od-edit-targets':
          set({ targets: message.targets });
          return;
        case 'od-edit-select':
          session.selectTarget(message.target);
          return;
        case 'od-edit-background':
          session.clearSelection();
          return;
        case 'od-edit-text-commit':
          void serialize(() => applyPatchNow({ id: message.id, kind: 'set-text', value: message.value }, deps.labels.content));
          return;
        case 'od-edit-drag-commit': {
          const styles: Partial<ManualEditStyles> = { transform: message.transform };
          if (message.display) styles.display = message.display;
          void serialize(() => applyPatchNow({ id: message.id, kind: 'set-style', styles }, deps.labels.content));
          return;
        }
        default:
          return;
      }
    },
    selectTarget(target) {
      if (ended || source === null) return;
      if (pendingStyles && pendingStyles.id !== target.id) revertPreview();
      set({ selected: target, draft: draftForTarget(target, source), error: null });
      deps.post({ type: 'od-edit-selected-target', id: target.id });
    },
    clearSelection() {
      revertPreview();
      set({ selected: null, draft: emptyManualEditDraft(source ?? ''), error: null });
      deps.post({ type: 'od-edit-selected-target', id: null });
    },
    setDraft(draft) {
      set({ draft });
    },
    previewStyles(id, styles) {
      if (!editable()) return;
      pendingStyles = { id, styles: { ...(pendingStyles?.id === id ? pendingStyles.styles : {}), ...styles } };
      previewVersion += 1;
      deps.post({ type: 'od-edit-preview-style', id, styles, version: previewVersion });
    },
    applyPatch(patch, label) {
      return serialize(() => applyPatchNow(patch, label));
    },
    async saveDraft() {
      const target = state.selected;
      if (!target || source === null) return;
      let changed = false;
      const content = contentPatchForDraft(target, state.draft, source, deps.labels);
      if (content) {
        const ok = await session.applyPatch(content.patch, content.label);
        if (!ok) return;
        changed = true;
      }
      if (pendingStyles && pendingStyles.id === target.id) {
        const styles = pendingStyles.styles;
        pendingStyles = null;
        const ok = await session.applyPatch({ id: target.id, kind: 'set-style', styles }, deps.labels.content);
        if (!ok) return;
        changed = true;
      }
      if (changed) deps.notify({ key: 'board.edit.saved', vars: { file: deps.path.split('/').pop() ?? deps.path }, tone: 'success' });
      session.clearSelection();
    },
    cancelDraft() {
      session.clearSelection();
    },
    resetDraft() {
      if (!state.selected || source === null) return;
      revertPreview();
      set({ draft: draftForTarget(state.selected, source), error: null });
    },
    async undo() {
      const entry = state.history[0];
      if (!entry || !editable()) return;
      await serialize(async () => {
        set({ phase: 'saving', busy: true });
        const ok = await write(entry.beforeSource, deps.labels.undo);
        if (ended || conflicted) return;
        if (!ok) {
          set({ phase: 'active', busy: false });
          return;
        }
        source = entry.beforeSource;
        set({ history: state.history.slice(1), undone: [entry, ...state.undone], selected: null, draft: emptyManualEditDraft(source), phase: 'mounting', busy: false });
        deps.mountEditing(source);
      });
    },
    async redo() {
      const entry = state.undone[0];
      if (!entry || !editable()) return;
      await serialize(async () => {
        set({ phase: 'saving', busy: true });
        const ok = await write(entry.afterSource, deps.labels.redo);
        if (ended || conflicted) return;
        if (!ok) {
          set({ phase: 'active', busy: false });
          return;
        }
        source = entry.afterSource;
        set({ undone: state.undone.slice(1), history: [entry, ...state.history], selected: null, draft: emptyManualEditDraft(source), phase: 'mounting', busy: false });
        deps.mountEditing(source);
      });
    },
    setError(message) {
      set({ error: message && message.length > 0 ? message : null });
    },
    fileChanged(mtime) {
      if (ended || !Number.isFinite(mtime)) return;
      if (knownMtime === null) {
        knownMtime = mtime;
        return;
      }
      if (Math.abs(mtime - knownMtime) <= MTIME_TOLERANCE_MS || isOurs(mtime)) {
        knownMtime = mtime;
        return;
      }
      if (state.phase === 'idle' || state.phase === 'loading') {
        knownMtime = mtime;
        return;
      }
      // someone else wrote the file: an edit now would land on a stale source, so the session ends without saving
      conflicted = true;
      deps.post({ type: 'od-edit-text-finish', commit: false });
      deps.post({ type: 'od-edit-mode', enabled: false });
      deps.notify({ key: 'board.edit.conflict', tone: 'danger' });
      end('conflict');
    },
    async exit() {
      if (ended) return;
      if (state.phase === 'idle' || state.phase === 'loading') {
        end('exit');
        return;
      }
      set({ phase: 'exiting' });
      revertPreview();
      // commit a pending inline text edit, then turn the bridge off (bridge.ts: mode false also commits)
      deps.post({ type: 'od-edit-text-finish', commit: true });
      deps.post({ type: 'od-edit-mode', enabled: false });
      // the commit arrives as a message: give it a turn, then wait for every save
      await wait(60);
      await saving;
      end('exit');
    },
    dispose() {
      listeners.clear();
      ended = true;
    },
  };
  return session;
}
