'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// The board chrome (spec 03 §6; plan R7: no ZoomPill — the workspace header zoom menu is the only zoom control).
// `BoardView` renders it once inside the board root, after the stage, in a `pointer-events: none` container whose
// direct children get `pointer-events: auto` (`BoardView.module.css` `.chrome`), so the gaps between islands still
// reach the stage. It owns the chrome's dialogs (web address, project files, delete file) and the flows behind the
// toolbar and menus: uploads from the file picker, OS drops (§3.13) and pastes (§3.12), file copies for duplicate
// (registered as the engine's `duplicateFileNodes` service), and provides the shared actions to every island.
import { useCallback, useMemo, useRef, useState } from 'react';

import { useT } from '../../../i18n';
import { uploadProjectFiles } from '../../../providers/registry';
import { ConfirmDialog } from '../../ui/dialog';
import { toast } from '../../ui/toast';
import { useBoardEngine, useBoardHost, useRegisterBoardServices } from '../context';
import { BoardContextMenu } from '../interaction/BoardContextMenu';
import { pasteBoardClip, planPaste, readClipboardForPaste, useBoardClipboard, type BoardClip, type PastePlan } from '../interaction/clipboard';
import { uploadAndPlace, useBoardDrop, type DropGhost } from '../interaction/drop';
import {
  copyNameFor,
  deleteNodeFile,
  duplicateFileNodes,
  fetchProjectFileBlob,
  pastedHtmlName,
  writePastedHtml,
} from '../interaction/file-actions';
import { nodeFilePath } from '../model/contract-adapter';
import { NOTE_DEFAULT_COLOR, NOTE_SIZE } from '../model/defaults';
import type { BoardServices, DictKey, EngineNode, Point } from '../model/types';
import { basenameOf, dirnameOf } from '../nodes/frame/project-files';
import { checkWebUrl, currentAppOrigin } from '../nodes/web/url-policy';
import type { BoardEngine } from '../store/board-engine';
import { newBoardId, type EngineOp, type NewNodeDraft } from '../store/ops';
import { BoardHeaderBar } from './BoardHeaderBar';
import { BoardStatus } from './BoardStatus';
import { BottomToolbar } from './BottomToolbar';
import { CaptureOverlay } from './CaptureOverlay';
import { BoardChromeContext, nodeFileLabel, stageCenterWorld, useChromeActionsValue, type ChromeDialogs } from './chrome-context';
import { ConnectionCreateMenu } from './ConnectionCreateMenu';
import { ContextBar } from './ContextBar';
import { DropOverlay, UploadGhosts } from './DropOverlay';
import { EditPanel } from './EditPanel';
import { Minimap } from './Minimap';
import { NodePanelSlot } from './NodePanelSlot';
import { ProjectFilesPicker } from './ProjectFilesPicker';
import { SaveStatus } from './SaveStatus';
import { ShortcutsSheet } from './ShortcutsSheet';
import { UrlDialog } from './UrlDialog';

export interface BoardChromeProps {
  readOnly: boolean;
  /** the 画板 tab is visible */
  active: boolean;
}

interface Notice {
  key: DictKey;
  vars?: Record<string, string | number>;
  tone?: 'default' | 'success' | 'danger';
}

/**
 * Adds uploaded/dropped drafts in one transaction; a path already on the board keeps its node (I1). Resolves the
 * node ids in draft order and selects them.
 */
export function placeDrafts(engine: BoardEngine, drafts: ReadonlyArray<{ draft: NewNodeDraft; path: string }>): string[] {
  const ids: string[] = [];
  const ops: EngineOp[] = [];
  for (const { draft, path } of drafts) {
    const existing = engine.commands.findNodeByPath(path);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const id = draft.id ?? newBoardId('n');
    ops.push({ type: 'add', node: { ...draft, id }, ifAbsent: true });
    ids.push(id);
  }
  if (ops.length > 0) void engine.store.commit({ origin: 'local', label: 'create', ops });
  if (ids.length > 0) engine.commands.select(ids);
  return ids;
}

export function BoardChrome({ readOnly, active }: BoardChromeProps) {
  const engine = useBoardEngine();
  const { env } = useBoardHost();
  const t = useT();
  const { commands } = engine;
  const envRef = useRef(env);
  envRef.current = env;
  const tRef = useRef(t);
  tRef.current = t;

  const [urlOpen, setUrlOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const [ghosts, setGhosts] = useState<readonly DropGhost[]>([]);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const uploadAt = useRef<Point | null>(null);

  const notify = useCallback(({ key, vars, tone }: Notice) => {
    toast({ title: tRef.current(key, vars), ...(tone ? { tone } : {}) });
  }, []);

  /* ── uploads (file picker, OS drop, pasted files) ─────────────────────────────────────── */
  const uploadFiles = useCallback(
    (files: readonly File[], at: Point) => {
      const current = envRef.current;
      void uploadAndPlace({
        projectId: current.projectId,
        workspaceContext: current.workspaceContext,
        files,
        at,
        place: (drafts) => placeDrafts(engine, drafts),
        notify,
        onGhosts: (next) => setGhosts(next ?? []),
        refresh: () => envRef.current.onRefreshFiles?.(),
      }).catch(() => notify({ key: 'board.drop.failed', vars: { name: files[0]?.name ?? '' }, tone: 'danger' }));
    },
    [engine, notify],
  );

  const dialogs = useMemo<ChromeDialogs>(
    () => ({
      openUrlDialog: () => setUrlOpen(true),
      openFilesPicker: () => setFilesOpen(true),
      openUpload: (accept, at) => {
        const input = fileInput.current;
        if (!input) return;
        uploadAt.current = at ?? null;
        input.accept = accept;
        input.value = '';
        input.click();
      },
      confirmDeleteFile: (nodeId) => setDeleteTarget(nodeId),
    }),
    [],
  );
  const actions = useChromeActionsValue(dialogs);

  /* ── duplicate of file-backed nodes (engine service) ──────────────────────────────────── */
  const services = useMemo<BoardServices>(
    () => ({
      duplicateFileNodes: async (nodes: readonly EngineNode[]) => {
        const current = envRef.current;
        const ids = await duplicateFileNodes({
          projectId: current.projectId,
          workspaceContext: current.workspaceContext,
          nodes,
          existingPaths: new Set(current.files.map((file) => file.name)),
          add: (draft) => commands.addNode({ ...draft }, { label: 'duplicate', select: false }),
          onFailed: (name) => notify({ key: 'board.drop.failed', vars: { name }, tone: 'danger' }),
        });
        envRef.current.onRefreshFiles?.();
        return ids;
      },
    }),
    [commands, notify],
  );
  useRegisterBoardServices(services);

  /* ── paste (keyboard / menu) ─────────────────────────────────────────────────────────── */
  const pasteClip = useCallback(
    (clip: BoardClip, at: Point | null) => {
      void pasteBoardClip({
        engine,
        clip,
        at,
        notify,
        copyFile: async (path, fromProjectId) => {
          const current = envRef.current;
          const taken = new Set(current.files.map((file) => file.name.toLowerCase()));
          const name = fromProjectId === current.projectId ? copyNameFor(path, taken) : basenameOf(path);
          const file = await fetchProjectFileBlob(fromProjectId, path, current.workspaceContext, name);
          if (!file) return null;
          const result = await uploadProjectFiles(current.projectId, [file], dirnameOf(path), current.workspaceContext);
          current.onRefreshFiles?.();
          return result.uploaded[0]?.path ?? null;
        },
      });
    },
    [engine, notify],
  );

  const paste = useCallback(
    (plan: PastePlan, at: Point | null) => {
      const current = envRef.current;
      switch (plan.kind) {
        case 'clip':
          pasteClip(plan.clip, at);
          return;
        case 'files':
          uploadFiles(plan.files, at ?? stageCenterWorld(engine));
          return;
        case 'url': {
          const check = checkWebUrl(plan.url, currentAppOrigin());
          if (!check.ok) notify({ key: check.reasonKey, tone: 'danger' });
          else commands.ensureWebNode(check.url, at ? { near: at } : {});
          return;
        }
        case 'html': {
          const now = new Date();
          void writePastedHtml(current.projectId, plan.html, current.workspaceContext, now)
            .catch(() => null)
            .then((path) => {
              if (!path) {
                notify({ key: 'board.drop.failed', vars: { name: pastedHtmlName(now) }, tone: 'danger' });
                return;
              }
              envRef.current.onRefreshFiles?.();
              commands.ensureFileNodes([path], at ? { near: at } : {});
            });
          return;
        }
        case 'note':
          commands.addNode(
            { kind: 'note', at: at ?? stageCenterWorld(engine), w: NOTE_SIZE.w, h: NOTE_SIZE.h, data: { text: plan.text, color: NOTE_DEFAULT_COLOR } },
            { label: 'paste' },
          );
          return;
        default:
          notify({ key: 'board.paste.nothing' });
      }
    },
    [engine, commands, notify, pasteClip, uploadFiles],
  );
  // copy works on read-only boards too; the hook itself refuses cut and paste there
  useBoardClipboard(engine, active, { paste });

  const onMenuPaste = useCallback(
    (at: Point) => {
      void readClipboardForPaste().then(({ text, files }) => paste(planPaste({ text, files }), at));
    },
    [paste],
  );

  /* ── OS drop ─────────────────────────────────────────────────────────────────────────── */
  const getExtensions = useCallback(() => engine.getExtensions(), [engine]);
  const onDropFiles = useCallback((files: File[], world: Point) => uploadFiles(files, world), [uploadFiles]);
  useBoardDrop(engine, { readOnly, getExtensions, onFiles: onDropFiles });

  /* ── delete file (confirmed, I4) ─────────────────────────────────────────────────────── */
  const deleteNode = deleteTarget ? engine.store.getState().doc.nodes.get(deleteTarget) : undefined;
  const confirmDelete = async (): Promise<void> => {
    const id = deleteTarget;
    const node = id ? engine.store.getState().doc.nodes.get(id) : undefined;
    const path = node ? nodeFilePath(node) : null;
    if (!id || !path) {
      deletingRef.current = false;
      setDeleteTarget(null);
      return;
    }
    // set before the dialog's own close request (same click): the dialog stays open while the file is deleted
    deletingRef.current = true;
    setDeleting(true);
    const current = envRef.current;
    const ok = await deleteNodeFile({
      projectId: current.projectId,
      workspaceContext: current.workspaceContext,
      path,
      remove: () => commands.removeNodes([id]),
    }).catch(() => false);
    deletingRef.current = false;
    setDeleting(false);
    setDeleteTarget(null);
    envRef.current.onRefreshFiles?.();
    if (!ok) notify({ key: 'board.deleteFile.failed', vars: { reason: basenameOf(path) }, tone: 'danger' });
  };

  const isOnBoard = useCallback((path: string) => commands.findNodeByPath(path) !== undefined, [commands]);

  return (
    <BoardChromeContext.Provider value={actions}>
      <BoardHeaderBar readOnly={readOnly} active={active} />
      <BoardStatus />
      <UploadGhosts ghosts={ghosts} />
      <CaptureOverlay active={active} />
      <NodePanelSlot />
      <EditPanel />
      <ContextBar readOnly={readOnly} />
      <BottomToolbar readOnly={readOnly} />
      <Minimap />
      <SaveStatus />
      <DropOverlay />
      <ConnectionCreateMenu />
      <BoardContextMenu onPaste={onMenuPaste} />
      <ShortcutsSheet />
      <UrlDialog
        open={urlOpen}
        onClose={() => setUrlOpen(false)}
        onSubmit={(url) => {
          setUrlOpen(false);
          commands.ensureWebNode(url, { near: stageCenterWorld(engine) });
        }}
      />
      <ProjectFilesPicker
        open={filesOpen}
        files={env.files}
        isOnBoard={isOnBoard}
        onClose={() => setFilesOpen(false)}
        onAdd={(paths) => {
          setFilesOpen(false);
          if (paths.length > 0) commands.ensureFileNodes(paths, { origin: 'local', select: true, reveal: true });
        }}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deletingRef.current) setDeleteTarget(null);
        }}
        title={t('board.deleteFile.title', { name: deleteNode ? nodeFileLabel(deleteNode) : '' })}
        description={t('board.deleteFile.body')}
        confirmLabel={t('board.deleteFile.confirm')}
        cancelLabel={t('common.cancel')}
        destructive
        busy={deleting}
        onConfirm={() => void confirmDelete()}
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden
        data-testid="board-upload-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) uploadFiles(files, uploadAt.current ?? stageCenterWorld(engine));
        }}
      />
    </BoardChromeContext.Provider>
  );
}
