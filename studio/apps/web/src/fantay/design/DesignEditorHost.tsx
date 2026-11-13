// SPDX-License-Identifier: AGPL-3.0-only
// React host of the OpenPencil-based design editor (spec 06 §5, §6.1–§6.3). One same-origin editor iframe
// per mounted host (`/canvas-editor/index.html`, built from apps/canvas); the host does every daemon
// request (bytes in and out over the bridge port), saves with sha256 compare-and-swap, shows conflicts,
// exports covers after 2 s of quiet, switches documents without reloading the engine, keeps an inactive
// editor alive for `keepAliveMs`, guards navigation and page unload while edits are unsaved, and follows
// the app theme and locale through bridge events (the iframe `src` never changes).
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Copy, Download, Globe } from 'lucide-react';
import {
  DESIGN_BRIDGE_LIMITS,
  DesignBridgeFailure,
  designEditorUrl,
  designNameFromPath,
  isDesignDocumentPath,
  toDesignBridgeError,
  uniqueDesignPath,
  type DesignBridgeError,
  type DesignCoverResult,
  type DesignDocumentFormat,
  type DesignEditorStatePayload,
  type DesignFlushReason,
  type DesignFlushResult,
  type DesignInitPayload,
  type DesignInsertItem,
  type DesignOpenPayload,
  type DesignSaveRequest,
  type DesignSelection,
  type DesignViewState,
  type EditorToHostEvents,
  type EditorToHostRequests,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { useI18n } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { registerNavigationGuard } from '../../router';
import {
  Button,
  Callout,
  ConfirmDialog,
  FX,
  Icon,
  IconButton,
  Spinner,
  XIcon,
  cn,
  toast,
} from '../ui';
import { ConflictBanner, type ConflictAction } from './ConflictBanner';
import {
  designBaseName,
  designDirOf,
  designDownloadUrl,
  fetchProjectAsset,
  fetchProjectText,
  isSafeProjectAssetPath,
  listDesigns,
  putDesignCover,
  readDesign,
  saveDesign,
  type SaveDesignOutcome,
} from './design-api';
import { takeDesignOpenRequest, type DesignOpenRequest } from './design-open-requests';
import { insertDesignOnBoard, insertFrameOnBoard } from './design-workspace';
import { DesignEditorHeader, type DesignHeaderMenuItem, type DesignSaveStatus } from './DesignEditorHeader';
import { designEditorMessages } from './messages';
import { shareDesignAsWebPage } from './share';
import type {
  DesignEditorDocument,
  DesignEditorHandle,
  DesignEditorHostProps,
  DesignEditorState,
  DesignSavedSource,
} from './types';
import { useDesignBridge, type DesignRequestHandlerResult } from './useDesignBridge';
import { useDocumentTheme } from './useDocumentTheme';

export type {
  DesignEditorDocument,
  DesignEditorHandle,
  DesignEditorHostProps,
  DesignEditorState,
  DesignSavedEvent,
  DesignSavedSource,
  DesignSelectionChange,
} from './types';

type Translate = (key: keyof Dict, vars?: Record<string, string | number>) => string;

/** Quiet period after a save before the cover is exported (spec 06 §5.3). */
export const DESIGN_COVER_QUIET_MS = 2000;
export const DESIGN_COVER_MAX_EDGE_PX = 1600;
const DEFAULT_KEEP_ALIVE_MS = 60_000;
const CREATE_RENAME_ATTEMPTS = 5;

interface OpenedDocument {
  key: string;
  kind: 'project';
  projectId: string | null;
  path: string | null;
  /** Display name with extension. */
  fileName: string;
  format: DesignDocumentFormat;
  readOnly: boolean;
  /** Read-only by permission or origin (viewer, a 403), not only by format (`.op`). */
  writeLocked: boolean;
  source: DesignSavedSource | null;
  /** Queue a `design` board draft after the first successful create (pending / convert / import opens). */
  boardDraft: { title?: string; sourceNodeId?: string } | null;
  boardDraftSent: boolean;
  /** A create that meets an existing file moves on to `-2`, `-3`, … (creation sessions only). */
  allowCreateRename: boolean;
}

interface OpenPlan {
  payload: DesignOpenPayload;
  transfer: Transferable[];
  sha256: string | null;
  opened: OpenedDocument;
  after?: () => Promise<void>;
}

interface DocState {
  dirty: boolean;
  saving: boolean;
  readOnly: boolean;
  lastSavedAt: number | null;
  sha256: string | null;
  conflict: { currentSha256: string | null } | null;
  error: DesignBridgeError | null;
  zoom: number | null;
}

const INITIAL_DOC_STATE: DocState = {
  dirty: false,
  saving: false,
  readOnly: false,
  lastSavedAt: null,
  sha256: null,
  conflict: null,
  error: null,
  zoom: null,
};

type HostPhase = 'idle' | 'opening' | 'editing' | 'failed';

const fileIds = new WeakMap<File, number>();
let fileIdSequence = 0;

function fileIdentity(file: File): number {
  let id = fileIds.get(file);
  if (id === undefined) {
    fileIdSequence += 1;
    id = fileIdSequence;
    fileIds.set(file, id);
  }
  return id;
}

/** The document the editor ends up showing; project-scoped kinds share one key per (project, path). */
export function designDocumentTargetKey(doc: DesignEditorDocument): string {
  return `project:${doc.projectId}:${doc.path}`;
}

/** Changes whenever the requested open differs (a new file, source page or import). */
function documentRequestKey(doc: DesignEditorDocument): string {
  switch (doc.kind) {
    case 'project':
      return `${designDocumentTargetKey(doc)}:${doc.readOnly ? 'ro' : 'rw'}`;
    case 'convert-html':
      return `${designDocumentTargetKey(doc)}:html:${doc.sourcePath}`;
    case 'import-file':
      return `${designDocumentTargetKey(doc)}:file:${fileIdentity(doc.file)}`;
  }
}

/**
 * Localized reason for a bridge error where a key exists (network: the chat's network-failure line,
 * reported as an i18n-extra gap); else the error's own message (e.g. a parse failure from the editor).
 */
export function describeDesignError(error: DesignBridgeError | null | undefined, t: Translate): string {
  if (!error) return '';
  switch (error.code) {
    case 'CONFLICT':
      return t('designEditor.conflict.title');
    case 'TOO_LARGE':
      return t('designEditor.tooLarge');
    case 'READ_ONLY':
    case 'FORBIDDEN':
      return t('designEditor.status.readOnly');
    case 'ENGINE_LOAD_FAILED':
    case 'TIMEOUT':
      return t('designEditor.engineFailed');
    case 'UNSUPPORTED_VERSION':
      return t('designEditor.incompatible');
    case 'NOT_FOUND':
      return t('designEditor.conflict.missing');
    case 'NETWORK':
      return t('designEditor.error.network');
    case 'EMPTY_DOCUMENT':
      return t('designEditor.error.emptyDocument');
    case 'PARSE_FAILED':
      return t('designEditor.error.parseFailed');
    default:
      return error.message;
  }
}

function failureMessage(error: DesignBridgeError, t: Translate): string {
  if (error.code === 'ENGINE_LOAD_FAILED') return t('designEditor.engineFailed');
  if (error.code === 'UNSUPPORTED_VERSION') return t('designEditor.incompatible');
  return t('designEditor.loadFailed', { reason: describeDesignError(error, t) });
}

function saveFailure(outcome: Exclude<SaveDesignOutcome, { ok: true } | { status: 409 }>, t: Translate): DesignBridgeError {
  switch (outcome.status) {
    case 413:
      return { code: 'TOO_LARGE', message: t('designEditor.tooLarge') };
    case 403:
      return { code: 'FORBIDDEN', message: outcome.message };
    case 404:
      return { code: 'NOT_FOUND', message: outcome.message };
    case 400:
      return { code: 'INVALID_REQUEST', message: outcome.message };
    default:
      return { code: 'NETWORK', message: outcome.message };
  }
}

/**
 * `.op` files are read-only by format, not by permission: their one write is the lossy conversion into a
 * new `.fig` beside them (spec 06 §8.3), which the editor sends as a create-only `convert` save.
 */
function isOpConversion(opened: OpenedDocument, req: DesignSaveRequest): boolean {
  return (
    opened.format === 'op' &&
    !opened.writeLocked &&
    req.reason === 'convert' &&
    req.format === 'fig' &&
    req.baseSha256 === null &&
    req.targetPath !== undefined
  );
}

function insertTransfer(items: DesignInsertItem[]): Transferable[] {
  return items.flatMap((item) => (item.kind === 'image' ? [item.bytes] : []));
}

function clickDownload(href: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export const DesignEditorHost = forwardRef<DesignEditorHandle, DesignEditorHostProps>(function DesignEditorHost(props, ref) {
  const {
    document: doc,
    active = true,
    keepAliveMs = DEFAULT_KEEP_ALIVE_MS,
    header = 'compact',
    headerStart,
    headerEnd,
    workspaceContext = null,
    mode = 'interactive',
    className,
  } = props;
  const interactive = mode === 'interactive';
  const visible = interactive && active;
  const { t, locale } = useI18n();
  const theme = useDocumentTheme();

  const propsRef = useRef(props);
  propsRef.current = props;
  const tRef = useRef<Translate>(t);
  tRef.current = t;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const localeRef = useRef<string>(locale);
  localeRef.current = locale;
  const activeRef = useRef(active);
  activeRef.current = active;
  const ctxRef = useRef<WorkspaceCollabContext | null>(workspaceContext);
  ctxRef.current = workspaceContext;

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [iframeMounted, setIframeMounted] = useState(true);
  const [iframeEpoch, setIframeEpoch] = useState(0);

  const [docState, setDocState] = useState<DocState>(INITIAL_DOC_STATE);
  const docRef = useRef<DocState>(docState);
  const patchDoc = useCallback((patch: Partial<DocState>) => {
    const next = { ...docRef.current, ...patch };
    docRef.current = next;
    setDocState(next);
  }, []);

  const [hostPhase, setHostPhase] = useState<HostPhase>('idle');
  const [openError, setOpenError] = useState<DesignBridgeError | null>(null);
  const [openingSource, setOpeningSource] = useState<DesignOpenPayload['source'] | null>(null);
  const [notices, setNotices] = useState<{ foreign: boolean; lossy: boolean }>({ foreign: false, lossy: false });
  const [conflictBusy, setConflictBusy] = useState<ConflictAction | null>(null);
  const [unsaved, setUnsaved] = useState<{ reason: string } | null>(null);
  const unsavedResolveRef = useRef<((discard: boolean) => void) | null>(null);

  const openedRef = useRef<OpenedDocument | null>(null);
  const [openedName, setOpenedName] = useState<string | null>(null);
  const openSeqRef = useRef(0);
  const openingKeyRef = useRef<string | null>(null);
  const openedRequestKeyRef = useRef<string | null>(null);
  /** The request that failed to open; it waits for Retry instead of looping. */
  const failedKeyRef = useRef<string | null>(null);
  const coverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentRef = useRef<{ theme: string | null; locale: string | null; visible: boolean }>({ theme: null, locale: null, visible: true });

  /* ── bridge ──────────────────────────────────────────────────────────────────────────────── */

  const handleRequestRef = useRef<
    <T extends keyof EditorToHostRequests>(type: T, payload: EditorToHostRequests[T]['req']) => Promise<DesignRequestHandlerResult<T>>
  >(async () => {
    throw new DesignBridgeFailure('NOT_INITIALIZED', 'The design host is not ready');
  });
  const handleEventRef = useRef<<T extends keyof EditorToHostEvents>(type: T, payload: EditorToHostEvents[T]) => void>(() => undefined);

  const bridge = useDesignBridge({
    iframe: iframeRef,
    enabled: iframeMounted,
    init: (sessionId): DesignInitPayload => {
      const current = propsRef.current;
      sentRef.current = { theme: themeRef.current, locale: localeRef.current, visible: true };
      return {
        sessionId,
        theme: themeRef.current,
        locale: localeRef.current,
        messages: designEditorMessages(tRef.current),
        forwardShortcuts: [...(current.forwardShortcuts ?? [])],
        closeOnEscape: current.closeOnEscape ?? false,
      };
    },
    onEvent: (type, payload) => handleEventRef.current(type, payload),
    onRequest: (type, payload) => handleRequestRef.current(type, payload),
  });
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;

  const src = useMemo(
    () => designEditorUrl({ theme: themeRef.current, locale: localeRef.current }),
    // Computed once per iframe: later theme/locale changes travel as bridge events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bridge.generation, iframeEpoch],
  );

  // A new iframe (retry, keep-alive remount) has nothing open yet.
  useEffect(() => {
    openedRef.current = null;
    openedRequestKeyRef.current = null;
    openingKeyRef.current = null;
    failedKeyRef.current = null;
    openSeqRef.current += 1;
    setHostPhase('idle');
    setOpenError(null);
  }, [bridge.generation, iframeEpoch]);

  /* ── unsaved-changes dialog ──────────────────────────────────────────────────────────────── */

  const settleUnsaved = useCallback((discard: boolean) => {
    const resolve = unsavedResolveRef.current;
    unsavedResolveRef.current = null;
    setUnsaved(null);
    resolve?.(discard);
  }, []);

  const askDiscard = useCallback(
    (error?: DesignBridgeError | null): Promise<boolean> => {
      if (!interactive) return Promise.resolve(true);
      unsavedResolveRef.current?.(false);
      const reason = describeDesignError(error ?? docRef.current.error, tRef.current) || tRef.current('designEditor.status.unsaved');
      return new Promise<boolean>((resolve) => {
        unsavedResolveRef.current = resolve;
        setUnsaved({ reason });
      });
    },
    [interactive],
  );

  useEffect(() => () => unsavedResolveRef.current?.(false), []);

  /* ── flush / close ───────────────────────────────────────────────────────────────────────── */

  const flushInternal = useCallback(async (reason: DesignFlushReason): Promise<DesignFlushResult> => {
    const current = docRef.current;
    if (bridgeRef.current.status !== 'ready' || !openedRef.current) return { saved: false, dirty: false, sha256: current.sha256 };
    try {
      return await bridgeRef.current.request('document.flush', { reason });
    } catch (error) {
      return { saved: false, dirty: docRef.current.dirty || docRef.current.conflict !== null, sha256: docRef.current.sha256, error: toDesignBridgeError(error) };
    }
  }, []);

  const requestClose = useCallback(async () => {
    const result = await flushInternal('close');
    if (result.saved || !result.dirty || (await askDiscard(result.error))) propsRef.current.onRequestClose?.();
  }, [askDiscard, flushInternal]);

  /* ── covers ──────────────────────────────────────────────────────────────────────────────── */

  const exportCoverNow = useCallback(async () => {
    const opened = openedRef.current;
    if (!opened || opened.kind !== 'project' || opened.readOnly || !opened.projectId || !opened.path) return;
    if (bridgeRef.current.status !== 'ready') return;
    const { projectId, path } = opened;
    let cover: DesignCoverResult;
    try {
      cover = await bridgeRef.current.request('document.exportCover', { maxEdge: DESIGN_COVER_MAX_EDGE_PX });
    } catch {
      return; // EMPTY_DOCUMENT, export failures: the daemon falls back to the embedded thumbnail
    }
    const current = openedRef.current;
    if (current !== opened || current.path !== path) return;
    const sha = cover.sourceSha256 ?? docRef.current.sha256;
    if (!sha) return;
    await putDesignCover(projectId, path, cover.png, sha, ctxRef.current);
  }, []);

  const scheduleCover = useCallback(() => {
    if (!interactive) return;
    if (coverTimerRef.current !== null) clearTimeout(coverTimerRef.current);
    coverTimerRef.current = setTimeout(() => {
      coverTimerRef.current = null;
      void exportCoverNow();
    }, DESIGN_COVER_QUIET_MS);
  }, [exportCoverNow, interactive]);

  useEffect(
    () => () => {
      if (coverTimerRef.current !== null) clearTimeout(coverTimerRef.current);
    },
    [],
  );

  /* ── editor → host requests ──────────────────────────────────────────────────────────────── */

  const handleSave = useCallback(
    async (req: DesignSaveRequest): Promise<DesignRequestHandlerResult<'document.save'>> => {
      const opened = openedRef.current;
      if (!opened || opened.kind !== 'project' || !opened.projectId || !opened.path) {
        throw new DesignBridgeFailure('READ_ONLY', 'Earlier design files open as read-only previews');
      }
      const opConversion = isOpConversion(opened, req);
      if (opened.readOnly && !opConversion) throw new DesignBridgeFailure('READ_ONLY', 'This design is read-only');
      if (req.bytes.byteLength > DESIGN_BRIDGE_LIMITS.maxDocumentBytes) {
        const error: DesignBridgeError = { code: 'TOO_LARGE', message: tRef.current('designEditor.tooLarge') };
        patchDoc({ error });
        throw new DesignBridgeFailure(error.code, error.message);
      }
      if (req.targetPath !== undefined && (!isDesignDocumentPath(req.targetPath) || !isSafeProjectAssetPath(req.targetPath))) {
        throw new DesignBridgeFailure('INVALID_REQUEST', `Not a design path: ${req.targetPath}`);
      }
      const projectId = opened.projectId;
      const previousPath = opened.path;
      const ctx = ctxRef.current;
      const create = req.baseSha256 === null;
      let targetPath = req.targetPath ?? previousPath;
      patchDoc({ saving: true });
      let outcome = await saveDesign(projectId, targetPath, req.bytes, create ? { create: true } : { ifMatch: req.baseSha256 as string }, ctx);
      const mayRename = create && (opened.allowCreateRename || req.reason === 'copy');
      // A copy continues the source's numbering (a.fig → a-2, a-3 …); a creation the target's own.
      const renameBase = designNameFromPath(req.reason === 'copy' ? previousPath : targetPath);
      const renameDir = designDirOf(targetPath);
      const taken = [previousPath, targetPath];
      for (let attempt = 0; mayRename && !outcome.ok && outcome.status === 409 && attempt < CREATE_RENAME_ATTEMPTS; attempt += 1) {
        targetPath = uniqueDesignPath(renameBase, req.format, taken, renameDir);
        taken.push(targetPath);
        outcome = await saveDesign(projectId, targetPath, req.bytes, { create: true }, ctx);
      }
      if (!outcome.ok) {
        if (outcome.status === 409) {
          patchDoc({ saving: false, conflict: { currentSha256: outcome.currentSha256 } });
          throw new DesignBridgeFailure('CONFLICT', 'This design was changed elsewhere', { currentSha256: outcome.currentSha256 });
        }
        const error = saveFailure(outcome, tRef.current);
        if (outcome.status === 403) {
          opened.readOnly = true;
          opened.writeLocked = true;
        }
        patchDoc({ saving: false, error, ...(outcome.status === 403 ? { readOnly: true } : {}) });
        throw new DesignBridgeFailure(error.code, error.message);
      }
      const design = outcome.response.design;
      const savedPath = design.path || targetPath;
      const savedAt = Date.now();
      if (savedPath !== previousPath) {
        opened.path = savedPath;
        opened.key = `project:${projectId}:${savedPath}`;
        opened.fileName = designBaseName(savedPath);
        openedRequestKeyRef.current = `${opened.key}:${opened.writeLocked ? 'ro' : 'rw'}`;
        setOpenedName(opened.fileName);
      }
      if (opConversion) {
        // From here on the host edits the converted `.fig`; the `.op` original stays as it was.
        opened.format = 'fig';
        opened.readOnly = false;
      }
      patchDoc({
        saving: false,
        sha256: design.sha256,
        lastSavedAt: savedAt,
        conflict: null,
        error: null,
        ...(opConversion ? { readOnly: false } : {}),
      });
      const created = outcome.response.created;
      propsRef.current.onSaved?.({
        projectId,
        path: savedPath,
        sha256: design.sha256,
        size: design.size,
        created,
        source: opened.source,
      });
      if (created && opened.boardDraft && !opened.boardDraftSent && req.reason !== 'copy') {
        opened.boardDraftSent = true;
        insertDesignOnBoard(projectId, { path: savedPath, ...opened.boardDraft });
      }
      scheduleCover();
      if (savedPath !== previousPath) propsRef.current.onDocumentReplaced?.({ projectId, path: savedPath });
      return { payload: { path: savedPath, sha256: design.sha256, size: design.size, savedAt } };
    },
    [patchDoc, scheduleCover],
  );

  const handleAssetFetch = useCallback(async (req: { path: string }): Promise<DesignRequestHandlerResult<'asset.fetch'>> => {
    const opened = openedRef.current;
    if (!opened || opened.kind !== 'project' || !opened.projectId) {
      throw new DesignBridgeFailure('FORBIDDEN', 'Assets resolve only inside a project');
    }
    if (!isSafeProjectAssetPath(req.path)) throw new DesignBridgeFailure('INVALID_REQUEST', `Not a project path: ${req.path}`);
    const asset = await fetchProjectAsset(opened.projectId, req.path, ctxRef.current);
    return { payload: asset, transfer: [asset.bytes] };
  }, []);

  handleRequestRef.current = (async <T extends keyof EditorToHostRequests>(type: T, payload: EditorToHostRequests[T]['req']) => {
    if (type === 'document.save') return handleSave(payload as DesignSaveRequest);
    return handleAssetFetch(payload as { path: string });
  }) as typeof handleRequestRef.current;

  /* ── editor → host events ────────────────────────────────────────────────────────────────── */

  handleEventRef.current = (type, payload) => {
    const current = propsRef.current;
    switch (type) {
      case 'state': {
        const next = payload as DesignEditorStatePayload;
        const opened = openedRef.current;
        patchDoc({
          dirty: next.dirty,
          saving: next.saving || docRef.current.saving,
          readOnly: next.readOnly || Boolean(opened?.readOnly),
          sha256: next.sha256 ?? docRef.current.sha256,
          lastSavedAt: next.lastSavedAt ?? docRef.current.lastSavedAt,
          error: next.error && next.error.code === 'CONFLICT' ? docRef.current.error : next.error,
          ...(next.error?.code === 'CONFLICT' && docRef.current.conflict === null
            ? { conflict: { currentSha256: typeof next.error.details?.currentSha256 === 'string' ? next.error.details.currentSha256 : null } }
            : {}),
        });
        return;
      }
      case 'selection': {
        const opened = openedRef.current;
        if (!opened || opened.kind !== 'project' || !opened.projectId || !opened.path) return;
        current.onSelectionChange?.({ ...(payload as DesignSelection), projectId: opened.projectId, path: opened.path });
        return;
      }
      case 'view': {
        const view = payload as DesignViewState;
        if (docRef.current.zoom !== view.zoom) patchDoc({ zoom: view.zoom });
        current.onViewChange?.(view);
        return;
      }
      case 'error': {
        const error = payload as DesignBridgeError;
        if (!interactive) return;
        toast({
          title: error.code === 'EXPORT_FAILED' ? tRef.current('designEditor.toast.exportFailed', { reason: error.message }) : describeDesignError(error, tRef.current),
          tone: 'danger',
        });
        return;
      }
      case 'request-close':
        void requestClose();
        return;
      case 'shortcut':
        current.onShortcut?.((payload as { combo: string }).combo);
        return;
      default:
        return;
    }
  };

  /* ── opening documents ───────────────────────────────────────────────────────────────────── */

  const planFromRequest = useCallback(
    async (projectId: string, path: string, request: DesignOpenRequest, allowCreateRename: boolean): Promise<OpenPlan> => {
      const ctx = ctxRef.current;
      const identity = { kind: 'project' as const, projectId, path };
      const name = request.title?.trim() || designNameFromPath(path);
      const opened: OpenedDocument = {
        key: `project:${projectId}:${path}`,
        kind: 'project',
        projectId,
        path,
        fileName: designBaseName(path),
        format: 'fig',
        readOnly: false,
        writeLocked: false,
        source: null,
        boardDraft: {
          ...(request.title?.trim() ? { title: request.title.trim() } : {}),
          ...(request.sourceNodeId ? { sourceNodeId: request.sourceNodeId } : {}),
        },
        boardDraftSent: false,
        allowCreateRename,
      };
      const blank: DesignOpenPayload = { source: 'blank', identity, name, pageName: tRef.current('designEditor.page.defaultName') };
      switch (request.kind) {
        case 'blank':
          return { payload: blank, transfer: [], sha256: null, opened };
        case 'convert-html': {
          const html = await fetchProjectText(projectId, request.sourcePath, ctx);
          return {
            payload: { source: 'html', identity, name, html, sourcePath: request.sourcePath },
            transfer: [],
            sha256: null,
            opened: { ...opened, source: { kind: 'html', path: request.sourcePath } },
          };
        }
        case 'import-file': {
          if (request.file.size > DESIGN_BRIDGE_LIMITS.maxDocumentBytes) {
            throw new DesignBridgeFailure('TOO_LARGE', tRef.current('designEditor.tooLarge'));
          }
          const bytes = await request.file.arrayBuffer();
          return {
            payload: { source: 'import', identity, name, fileName: request.file.name, bytes },
            transfer: [bytes],
            sha256: null,
            opened: { ...opened, source: { kind: 'file', name: request.file.name } },
          };
        }
        case 'new-from-image': {
          const asset = await fetchProjectAsset(projectId, request.image.path, ctx);
          const item: DesignInsertItem = {
            kind: 'image',
            name: designBaseName(request.image.path),
            mime: request.image.mime || asset.mime,
            bytes: asset.bytes,
          };
          return {
            payload: blank,
            transfer: [],
            sha256: null,
            opened: { ...opened, source: { kind: 'file', name: request.image.path } },
            after: async () => {
              await bridgeRef.current.request('insert', { items: [item] }, { transfer: [asset.bytes] });
            },
          };
        }
      }
    },
    [],
  );

  const planOpen = useCallback(
    async (target: DesignEditorDocument): Promise<OpenPlan> => {
      switch (target.kind) {
        case 'convert-html':
          return planFromRequest(target.projectId, target.path, { kind: 'convert-html', sourcePath: target.sourcePath }, false);
        case 'import-file':
          return planFromRequest(target.projectId, target.path, { kind: 'import-file', file: target.file }, false);
        case 'project': {
          const pending = takeDesignOpenRequest(target.projectId, target.path);
          if (pending) return planFromRequest(target.projectId, target.path, pending, true);
          const read = await readDesign(target.projectId, target.path, ctxRef.current);
          if (!read) {
            if (target.createIfMissing) {
              const plan = await planFromRequest(target.projectId, target.path, { kind: 'blank' }, false);
              return { ...plan, opened: { ...plan.opened, boardDraft: null } };
            }
            throw new DesignBridgeFailure('NOT_FOUND', `${target.path} does not exist`);
          }
          const readOnly = Boolean(target.readOnly);
          return {
            payload: {
              source: 'bytes',
              identity: { kind: 'project', projectId: target.projectId, path: target.path },
              name: designNameFromPath(target.path),
              format: read.format,
              bytes: read.bytes,
              sha256: read.sha256,
              readOnly,
            },
            transfer: [read.bytes],
            sha256: read.sha256,
            opened: {
              key: designDocumentTargetKey(target),
              kind: 'project',
              projectId: target.projectId,
              path: target.path,
                    fileName: designBaseName(target.path),
              format: read.format,
              readOnly,
              writeLocked: readOnly,
              source: null,
              boardDraft: null,
              boardDraftSent: false,
              allowCreateRename: false,
            },
          };
        }
      }
    },
    [planFromRequest],
  );

  const openDocument = useCallback(
    async (target: DesignEditorDocument): Promise<void> => {
      const seq = ++openSeqRef.current;
      const requestKey = documentRequestKey(target);
      openingKeyRef.current = requestKey;
      setHostPhase('opening');
      setOpenError(null);
      setNotices({ foreign: false, lossy: false });
      setOpeningSource(target.kind === 'convert-html' ? 'html' : null);
      try {
        const plan = await planOpen(target);
        if (seq !== openSeqRef.current) return;
        setOpeningSource(plan.payload.source);
        const result = await bridgeRef.current.request('document.open', plan.payload, { transfer: plan.transfer });
        if (seq !== openSeqRef.current) return;
        const opened: OpenedDocument = {
          ...plan.opened,
          format: result.format,
          readOnly: plan.opened.readOnly || result.readOnly,
        };
        openedRef.current = opened;
        openedRequestKeyRef.current = requestKey;
        setOpenedName(opened.fileName);
        patchDoc({ ...INITIAL_DOC_STATE, readOnly: opened.readOnly, sha256: plan.sha256, zoom: docRef.current.zoom });
        // Post-open steps (new-from-image inserts its image) finish before the document counts as open,
        // so a creation session never flushes a document that is still missing its content.
        if (plan.after) await plan.after();
        if (seq !== openSeqRef.current) return;
        setHostPhase('editing');
        if (interactive) {
          setNotices({
            foreign: result.foreign,
            lossy: result.warnings.includes('lossy-html') || result.warnings.includes('images-skipped') || result.warnings.includes('lossy-op-svg'),
          });
        }
      } catch (error) {
        if (seq !== openSeqRef.current) return;
        openedRef.current = null;
        openedRequestKeyRef.current = null;
        failedKeyRef.current = requestKey;
        setOpenError(toDesignBridgeError(error));
        setHostPhase('failed');
      } finally {
        if (seq === openSeqRef.current && openingKeyRef.current === requestKey) openingKeyRef.current = null;
      }
    },
    [interactive, patchDoc, planOpen],
  );

  const requestKey = documentRequestKey(doc);
  const targetKey = designDocumentTargetKey(doc);
  const docLatestRef = useRef(doc);
  docLatestRef.current = doc;
  const declinedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (bridge.status !== 'ready') return;
    const target = docLatestRef.current;
    const opened = openedRef.current;
    if (openingKeyRef.current === requestKey) return;
    if (opened && opened.key === targetKey && target.kind === 'project') {
      const nextReadOnly = Boolean(target.readOnly);
      if (nextReadOnly === opened.writeLocked) {
        declinedKeyRef.current = null;
        return;
      }
      opened.readOnly = nextReadOnly || opened.format === 'op';
      opened.writeLocked = nextReadOnly;
      patchDoc({ readOnly: opened.readOnly });
      void openDocument(target);
      return;
    }
    if (opened && (opened.key === targetKey || openedRequestKeyRef.current === requestKey)) {
      // Back on the open document: a later switch away asks again.
      declinedKeyRef.current = null;
      return;
    }
    if (!opened) {
      // A failed open waits for Retry; another document is tried right away.
      if (hostPhase === 'failed' && failedKeyRef.current === requestKey) return;
      void openDocument(target);
      return;
    }
    if (declinedKeyRef.current === requestKey) return;
    let cancelled = false;
    void (async () => {
      const result = await flushInternal('switch');
      if (cancelled) return;
      if (!result.saved && result.dirty) {
        const discard = await askDiscard(result.error);
        if (cancelled) return;
        if (!discard) {
          declinedKeyRef.current = requestKey;
          const previous = openedRef.current;
          if (previous?.kind === 'project' && previous.projectId && previous.path) {
            propsRef.current.onDocumentReplaced?.({ projectId: previous.projectId, path: previous.path });
          }
          return;
        }
      }
      declinedKeyRef.current = null;
      await openDocument(docLatestRef.current);
    })();
    return () => {
      cancelled = true;
    };
  }, [askDiscard, bridge.status, flushInternal, hostPhase, openDocument, requestKey, targetKey]);

  /* ── theme / locale / visibility events ──────────────────────────────────────────────────── */

  const connected = bridge.status === 'ready';
  useEffect(() => {
    if (!connected || sentRef.current.theme === theme) return;
    sentRef.current.theme = theme;
    bridge.emit('theme', { theme });
  }, [bridge, connected, theme]);

  useEffect(() => {
    if (!connected || sentRef.current.locale === locale) return;
    sentRef.current.locale = locale;
    bridge.emit('locale', { locale, messages: designEditorMessages(t) });
  }, [bridge, connected, locale, t]);

  useEffect(() => {
    if (!connected || sentRef.current.visible === visible) return;
    sentRef.current.visible = visible;
    bridge.emit('visibility', { visible });
  }, [bridge, connected, visible]);

  useEffect(() => {
    if (visible || typeof document === 'undefined') return undefined;
    const iframe = iframeRef.current;
    if (!iframe) return undefined;
    let lastHostFocused: HTMLElement | null =
      document.activeElement instanceof HTMLElement && document.activeElement !== iframe ? document.activeElement : null;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target !== iframe) {
        lastHostFocused = target;
      }
    };
    const onIframeFocus = () => {
      if (lastHostFocused && document.contains(lastHostFocused)) {
        lastHostFocused.focus({ preventScroll: true });
      } else {
        iframe.blur();
      }
    };
    document.addEventListener('focusin', onFocusIn, true);
    iframe.addEventListener('focus', onIframeFocus);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      iframe.removeEventListener('focus', onIframeFocus);
    };
  }, [visible, iframeMounted, iframeEpoch, bridge.generation]);

  /* ── keep-alive ──────────────────────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (active) {
      if (!iframeMounted) {
        setIframeEpoch((value) => value + 1);
        setIframeMounted(true);
      }
      return undefined;
    }
    if (!iframeMounted || !Number.isFinite(keepAliveMs)) return undefined;
    const timer = setTimeout(() => {
      void flushInternal('hidden').then((result) => {
        if (activeRef.current) return;
        if (result.saved || !result.dirty) setIframeMounted(false);
      });
    }, Math.max(0, keepAliveMs));
    return () => clearTimeout(timer);
  }, [active, flushInternal, iframeMounted, keepAliveMs]);

  /* ── guards ──────────────────────────────────────────────────────────────────────────────── */

  const unsavedWork = docState.dirty || docState.saving || docState.conflict !== null;
  useEffect(() => {
    if (!interactive || !active || !unsavedWork) return undefined;
    return registerNavigationGuard(async () => {
      const result = await flushInternal('navigate');
      if (result.saved || !result.dirty) return true;
      return askDiscard(result.error);
    });
  }, [active, askDiscard, flushInternal, interactive, unsavedWork]);

  useEffect(() => {
    if (!interactive || !docState.dirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [docState.dirty, interactive]);

  /* ── state reporting ─────────────────────────────────────────────────────────────────────── */

  const phase: DesignEditorState['phase'] =
    bridge.status === 'failed' || hostPhase === 'failed'
      ? 'failed'
      : bridge.status !== 'ready'
        ? 'booting'
        : hostPhase === 'idle'
          ? 'ready'
          : hostPhase;
  const failure = bridge.error ?? openError;
  const state = useMemo<DesignEditorState>(
    () => ({ phase, ...docState, error: failure ?? docState.error }),
    [docState, failure, phase],
  );
  useEffect(() => {
    propsRef.current.onStateChange?.(state);
  }, [state]);

  /* ── user actions ────────────────────────────────────────────────────────────────────────── */

  const freeCopyPath = useCallback(async (projectId: string, path: string, format: DesignDocumentFormat): Promise<string> => {
    let existing: string[] = [path];
    try {
      existing = [...existing, ...(await listDesigns(projectId, ctxRef.current)).map((design) => design.path)];
    } catch {
      /* the create-only save moves on to the next free name if needed */
    }
    return uniqueDesignPath(designNameFromPath(path), format, existing, designDirOf(path));
  }, []);

  const saveCopy = useCallback(async (): Promise<boolean> => {
    const opened = openedRef.current;
    if (!opened || opened.kind !== 'project' || !opened.projectId || !opened.path) return false;
    const targetPath = await freeCopyPath(opened.projectId, opened.path, opened.format);
    try {
      await bridgeRef.current.request('document.saveCopy', { targetPath });
      patchDoc({ conflict: null });
      return true;
    } catch (error) {
      if (interactive) {
        toast({ title: tRef.current('designEditor.status.saveFailed', { reason: describeDesignError(toDesignBridgeError(error), tRef.current) }), tone: 'danger' });
      }
      return false;
    }
  }, [freeCopyPath, interactive, patchDoc]);

  const runConflictAction = useCallback(
    async (action: ConflictAction) => {
      const opened = openedRef.current;
      if (!opened || opened.kind !== 'project' || !opened.projectId || !opened.path) return;
      setConflictBusy(action);
      try {
        if (action === 'saveCopy') {
          await saveCopy();
          return;
        }
        if (action === 'overwrite') {
          await bridgeRef.current.request('document.forceSave', { baseSha256: docRef.current.conflict?.currentSha256 ?? null });
          patchDoc({ conflict: null });
          return;
        }
        const latest = await readDesign(opened.projectId, opened.path, ctxRef.current);
        if (!latest) {
          patchDoc({ conflict: { currentSha256: null } });
          return;
        }
        await bridgeRef.current.request(
          'document.open',
          {
            source: 'bytes',
            identity: { kind: 'project', projectId: opened.projectId, path: opened.path },
            name: designNameFromPath(opened.path),
            format: latest.format,
            bytes: latest.bytes,
            sha256: latest.sha256,
            readOnly: opened.readOnly,
          },
          { transfer: [latest.bytes] },
        );
        patchDoc({ conflict: null, error: null, dirty: false, sha256: latest.sha256 });
      } catch (error) {
        const bridgeError = toDesignBridgeError(error);
        if (bridgeError.code !== 'CONFLICT') {
          toast({ title: tRef.current('designEditor.loadFailed', { reason: describeDesignError(bridgeError, tRef.current) }), tone: 'danger' });
        }
      } finally {
        setConflictBusy(null);
      }
    },
    [patchDoc, saveCopy],
  );

  const handle = useMemo<DesignEditorHandle>(
    () => ({
      flush: (reason = 'close') => flushInternal(reason),
      exportCover: async (opts) => {
        try {
          const cover = await bridgeRef.current.request('document.exportCover', { maxEdge: opts?.maxEdge ?? DESIGN_COVER_MAX_EDGE_PX });
          return { png: new Blob([cover.png], { type: 'image/png' }), width: cover.width, height: cover.height };
        } catch (error) {
          if (toDesignBridgeError(error).code === 'EMPTY_DOCUMENT') return null;
          throw error;
        }
      },
      exportHtml: async (scope = 'page') => (await bridgeRef.current.request('document.exportHtml', { scope })).html,
      command: async (command) => {
        await bridgeRef.current.request('view.command', { command });
      },
      select: async (nodeIds, reveal) => {
        await bridgeRef.current.request('selection.set', reveal === undefined ? { nodeIds } : { nodeIds, reveal });
      },
      insert: async (items) => (await bridgeRef.current.request('insert', { items }, { transfer: insertTransfer(items) })).nodeIds,
      focus: () => {
        if (!interactive || !activeRef.current) return;
        iframeRef.current?.focus();
        void bridgeRef.current.request('focus', {}).catch(() => undefined);
      },
    }),
    [flushInternal, interactive],
  );
  useImperativeHandle(ref, () => handle, [handle]);

  const saveAsWebPage = useCallback(async () => {
    const opened = openedRef.current;
    if (!opened || opened.kind !== 'project' || !opened.projectId || !opened.path) return;
    const { projectId, path } = opened;
    const toastId = toast({ title: tRef.current('designEditor.menu.saveHtml'), busy: true, duration: 0 });
    try {
      const result = await shareDesignAsWebPage(handle, { projectId, path, workspaceContext: ctxRef.current });
      if (result.created) insertFrameOnBoard(projectId, result.htmlPath, designNameFromPath(result.htmlPath));
      toast({ id: toastId, title: tRef.current('designEditor.menu.htmlSaved', { path: result.htmlPath }), tone: 'success' });
    } catch (error) {
      toast({
        id: toastId,
        title: tRef.current('designEditor.toast.exportFailed', { reason: describeDesignError(toDesignBridgeError(error), tRef.current) }),
        tone: 'danger',
      });
    }
  }, [handle]);

  const downloadCurrent = useCallback(async () => {
    const opened = openedRef.current;
    if (!opened) return;
    if (opened.kind === 'project' && opened.projectId && opened.path) {
      clickDownload(designDownloadUrl(opened.projectId, opened.path, ctxRef.current), opened.fileName);
    }
  }, []);

  /* ── render ──────────────────────────────────────────────────────────────────────────────── */

  const editing = phase === 'editing';
  const opened = openedRef.current;
  const readOnly = docState.readOnly;
  const menuItems: DesignHeaderMenuItem[] = [];
  if (editing && opened?.kind === 'project') {
    menuItems.push(
      { id: 'download', label: t('designEditor.menu.download'), icon: <Icon icon={Download} size="sm" />, onSelect: () => void downloadCurrent() },
      { id: 'save-copy', label: t('designEditor.menu.saveCopy'), icon: <Icon icon={Copy} size="sm" />, disabled: readOnly, onSelect: () => void saveCopy() },
      { id: 'save-html', label: t('designEditor.menu.saveHtml'), icon: <Icon icon={Globe} size="sm" />, disabled: readOnly, onSelect: () => void saveAsWebPage() },
    );
  }

  const status: DesignSaveStatus | null =
    phase === 'failed'
      ? null
      : !editing
        ? 'loading'
        : readOnly
          ? 'readOnly'
          : docState.saving
            ? 'saving'
            : docState.error && docState.error.code !== 'CONFLICT'
              ? 'failed'
              : docState.dirty || docState.conflict
                ? 'unsaved'
                : 'saved';

  const fallbackName = designBaseName(doc.path);
  const loadingLabel = openingSource === 'html' ? t('designEditor.convertHtml.progress') : t('designEditor.loading');
  const hint = typeof failure?.details?.hint === 'string' ? failure.details.hint : null;

  let body: ReactNode = null;
  if (interactive) {
    body = (
      <>
        <div
          data-testid="design-editor-loading"
          aria-hidden={phase === 'failed' || editing ? true : undefined}
          className={cn(
            'absolute inset-0 grid place-items-center bg-paper transition-opacity duration-enter ease-out-quint',
            phase === 'failed' || editing ? 'pointer-events-none opacity-0' : 'opacity-100',
          )}
        >
          <div className="flex items-center gap-2 text-body text-ink-soft">
            <Spinner size="sm" />
            <span>{loadingLabel}</span>
          </div>
        </div>
        {phase === 'failed' && failure ? (
          <div data-testid="design-editor-failed" className="absolute inset-0 grid place-items-center bg-paper px-6">
            <div role="alert" className="flex max-w-[420px] flex-col items-center gap-3 text-center">
              <p className="m-0 text-copy text-ink">{failureMessage(failure, t)}</p>
              {hint ? <p className="m-0 font-mono text-caption text-ink-faint">{hint}</p> : null}
              {failure.code === 'UNSUPPORTED_VERSION' ? null : (
                <Button
                  variant="default"
                  onClick={() => {
                    setOpenError(null);
                    setHostPhase('idle');
                    bridge.retry();
                  }}
                >
                  {t('designEditor.retry')}
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div
      data-testid="design-editor-host"
      data-phase={phase}
      data-mode={mode}
      className={cn(FX, 'relative flex h-full min-h-0 w-full flex-col bg-paper', className)}
    >
      {interactive && header === 'compact' ? (
        <DesignEditorHeader
          fileName={openedName ?? fallbackName}
          status={status}
          statusReason={describeDesignError(docState.error, t)}
          zoom={editing ? docState.zoom : null}
          onZoomCommand={(command) => void handle.command(command).catch(() => undefined)}
          menuItems={menuItems}
          headerStart={headerStart}
          headerEnd={headerEnd}
        />
      ) : null}
      {interactive && docState.conflict && editing ? (
        <ConflictBanner
          currentSha256={docState.conflict.currentSha256}
          busy={conflictBusy}
          onReload={() => void runConflictAction('reload')}
          onSaveCopy={() => void runConflictAction('saveCopy')}
          onOverwrite={() => void runConflictAction('overwrite')}
        />
      ) : null}
      {interactive && editing && notices.foreign ? (
        <Callout className="m-2 mb-0 flex flex-none items-center gap-3" data-testid="design-foreign-notice">
          <span className="min-w-0 flex-1">{t('designEditor.foreignFig')}</span>
          {!readOnly ? (
            <Button size="sm" onClick={() => void saveCopy().then((saved) => saved && setNotices((value) => ({ ...value, foreign: false })))}>
              {t('designEditor.conflict.saveCopy')}
            </Button>
          ) : null}
          <IconButton size="xs" aria-label={t('fantay.ui.close')} onClick={() => setNotices((value) => ({ ...value, foreign: false }))}>
            <XIcon size="xs" />
          </IconButton>
        </Callout>
      ) : null}
      {interactive && editing && notices.lossy ? (
        <Callout className="m-2 mb-0 flex flex-none items-center gap-3" data-testid="design-lossy-notice">
          <span className="min-w-0 flex-1">{t('designEditor.convertHtml.lossy')}</span>
          <IconButton size="xs" aria-label={t('fantay.ui.close')} onClick={() => setNotices((value) => ({ ...value, lossy: false }))}>
            <XIcon size="xs" />
          </IconButton>
        </Callout>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {iframeMounted ? (
          <iframe
            key={`${bridge.generation}:${iframeEpoch}`}
            ref={iframeRef}
            src={src}
            title={t('designEditor.frameTitle')}
            allow="clipboard-read; clipboard-write; local-fonts"
            data-testid="design-editor-frame"
            className="absolute inset-0 size-full border-0"
            {...(visible ? {} : { tabIndex: -1, 'aria-hidden': true })}
          />
        ) : null}
        {body}
      </div>
      {interactive ? (
        <ConfirmDialog
          open={unsaved !== null}
          onOpenChange={(open) => {
            if (!open) settleUnsaved(false);
          }}
          title={t('designEditor.closeUnsaved.title')}
          description={t('designEditor.closeUnsaved.body', { reason: unsaved?.reason ?? '' })}
          confirmLabel={t('designEditor.closeUnsaved.discard')}
          cancelLabel={t('designEditor.closeUnsaved.keep')}
          destructive
          onConfirm={() => settleUnsaved(true)}
        />
      ) : null}
    </div>
  );
});
