// SPDX-License-Identifier: AGPL-3.0-only
// 素材库 drawer (spec 07 §7.2): a non-modal floating panel beside the sidebar. Browse the external material
// archive; drag a card onto the board or use its + action to copy it into the open project and place it on
// that project's board (queued until the board mounts). Esc closes while focus is inside; `/` focuses the
// search while it is open. It stays mounted after the first open so the exit transition plays.
import type { MaterialSummaryItem, WorkspaceCollabContext } from '@open-design/contracts';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';

import { MaterialBrowser } from '../../components/materials/MaterialBrowser';
import { MaterialDetailDialog } from '../../components/materials/MaterialDetailDialog';
import { materialResultCountLabel } from '../../components/materials/material-model';
import { useT } from '../../i18n';
import {
  cn,
  FX,
  FxLegacy,
  IconButton,
  InfoIcon,
  Panel,
  PanelClose,
  PanelHeader,
  PlusIcon,
} from '../ui';
import { writeMaterialDrag } from './material-drag';
import { insertMaterialToBoard } from './material-insert';
import { MATERIALS_DRAWER_MAX_WIDTH, MATERIALS_DRAWER_MIN_WIDTH } from './materials-drawer-store';
import styles from './MaterialsDrawer.module.css';

export interface MaterialsDrawerProps {
  open: boolean;
  /** The project on screen; null off project routes (insert is then disabled with a reason). */
  projectId: string | null;
  /** Scope of that project's requests (team workspaces); null for local projects. */
  workspaceContext?: WorkspaceCollabContext | null;
  width: number;
  onResize: (width: number) => void;
  onClose: () => void;
}

/* The shell's geometry as spec 07 §7.2 names it: FantayShell publishes `--fx-shell-header-h` and
   `--fx-sidebar-w` (the sidebar's current width, 0 in overlay/chromeless) on the document root for surfaces
   mounted outside its root, so the drawer sits right wherever App mounts the host. In legacy mode (shell off)
   MaterialsDrawer.module.css falls back to `--entry-rail-width` when `.entry.entry--rail-open` is present. */
/* The stored width never pushes the panel past the viewport's end edge (12px gutter). */
const PANEL_BOUNDS = { maxWidth: 'calc(100vw - var(--fx-sidebar-w, 0px) - 24px)' } as const;

type InsertStatus =
  | { kind: 'idle' }
  | { kind: 'inserting'; title: string }
  | { kind: 'inserted'; title: string }
  | { kind: 'queued'; title: string }
  | { kind: 'failed'; detail: string };

/** True when a keystroke belongs to something the user is typing into (MaterialsView's guard). */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function MaterialsDrawer({
  open,
  projectId,
  workspaceContext = null,
  width,
  onResize,
  onClose,
}: MaterialsDrawerProps) {
  const t = useT();
  const rootRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const insertSequence = useRef(0);
  // Fetch from the first open on, and keep the loaded pages and filters afterwards.
  const [visited, setVisited] = useState(open);
  const [results, setResults] = useState<{ total: number } | null>(null);
  const [status, setStatus] = useState<InsertStatus>({ kind: 'idle' });
  const [detail, setDetail] = useState<MaterialSummaryItem | null>(null);

  useEffect(() => {
    if (!open) return;
    setVisited(true);
    // A reopened drawer starts without the last session's insert message (late results are dropped).
    insertSequence.current += 1;
    setStatus({ kind: 'idle' });
  }, [open]);

  // Remember what had focus before opening (before the search takes it), and hand it back when the
  // drawer closes with focus inside. React 18 drops a boolean `inert`, so it is set on the node.
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    if (open) {
      node.removeAttribute('inert');
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && !node.contains(active) ? active : null;
      return;
    }
    node.setAttribute('inert', '');
    if (node.contains(document.activeElement)) {
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      else (document.activeElement as HTMLElement | null)?.blur?.();
    }
  }, [open]);

  // Closing the drawer also closes the detail dialog (it portals to <body> and would stay on screen).
  useEffect(() => {
    if (open) return;
    returnFocusRef.current = null;
    setDetail(null);
  }, [open]);

  // `/` jumps to search while the drawer is open — unless the user is typing or the dialog has the keys.
  useEffect(() => {
    if (!open || detail) return;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      const input = searchRef.current;
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, detail]);

  // Once the detail dialog has unmounted, return focus to the control that opened it.
  useEffect(() => {
    if (detail) return;
    const trigger = returnFocusRef.current;
    returnFocusRef.current = null;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }, [detail]);

  const openDetail = useCallback((item: MaterialSummaryItem, trigger: HTMLElement) => {
    returnFocusRef.current = trigger;
    setDetail(item);
  }, []);
  const closeDetail = useCallback(() => setDetail(null), []);

  const insert = useCallback(
    async (item: MaterialSummaryItem) => {
      if (!projectId) return;
      const sequence = ++insertSequence.current;
      setStatus({ kind: 'inserting', title: item.title });
      try {
        const result = await insertMaterialToBoard({ item, projectId, workspaceContext });
        if (sequence !== insertSequence.current) return;
        setStatus(
          result.delivered === 'board'
            ? { kind: 'inserted', title: item.title }
            : { kind: 'queued', title: item.title },
        );
      } catch (error) {
        if (sequence !== insertSequence.current) return;
        setStatus({ kind: 'failed', detail: error instanceof Error ? error.message : String(error) });
      }
    },
    [projectId, workspaceContext],
  );

  const renderCardActions = useCallback(
    (item: MaterialSummaryItem) => (
      <>
        <IconButton
          size="sm"
          variant="frosted"
          aria-label={t('materials.drawer.insert')}
          disabled={!projectId}
          disabledReason={projectId ? undefined : t('materials.drawer.insertNoProject')}
          onClick={() => void insert(item)}
          data-testid="materials-drawer-insert"
        >
          <PlusIcon />
        </IconButton>
        <IconButton
          size="sm"
          variant="frosted"
          aria-label={t('materials.drawer.details')}
          aria-haspopup="dialog"
          onClick={(event) => openDetail(item, event.currentTarget)}
          data-testid="materials-drawer-details"
          data-material-detail-trigger=""
        >
          <InfoIcon />
        </IconButton>
      </>
    ),
    [insert, openDetail, projectId, t],
  );

  const onCardDragStart = useCallback(
    (item: MaterialSummaryItem, event: DragEvent<HTMLElement>) => writeMaterialDrag(event.dataTransfer, item),
    [],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || detail) return;
    // React bubbles events from portals (menus, the detail dialog) through here; only own DOM counts.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    event.preventDefault();
    onClose();
  };

  const statusText =
    status.kind === 'inserting'
      ? t('materials.drawer.inserting')
      : status.kind === 'inserted'
        ? t('materials.drawer.inserted', { title: status.title })
        : status.kind === 'queued'
          ? t('materials.drawer.insertedQueued')
          : status.kind === 'failed'
            ? t('materials.drawer.insertFailed', { detail: status.detail })
            : '';

  return (
    <aside
      ref={rootRef}
      className={cn(FX, styles.drawer)}
      aria-label={t('materials.title')}
      aria-hidden={open ? undefined : true}
      data-state={open ? 'open' : 'closed'}
      data-testid="materials-drawer"
      onKeyDown={onKeyDown}
    >
      <Panel
        surface="floating"
        className={styles.panel}
        style={PANEL_BOUNDS}
        resize={{
          edge: 'end',
          width,
          min: MATERIALS_DRAWER_MIN_WIDTH,
          max: MATERIALS_DRAWER_MAX_WIDTH,
          label: t('materials.drawer.resize'),
          onResize,
        }}
      >
        <PanelHeader className={styles.header}>
          <div className={styles.heading}>
            <h2 className={styles.title}>{t('materials.title')}</h2>
            {results ? (
              <span className={styles.count} data-testid="materials-drawer-count">
                {materialResultCountLabel(results.total, t)}
              </span>
            ) : null}
          </div>
          <PanelClose label={t('materials.drawer.close')} onClick={onClose} />
        </PanelHeader>
        <FxLegacy>
          <MaterialBrowser
            mode="drawer"
            enabled={visited}
            testIdPrefix="materials-drawer"
            searchRef={searchRef}
            autoFocusSearch={open}
            showCategory
            columns={2}
            renderCardActions={renderCardActions}
            onCardDragStart={onCardDragStart}
            onOpenDetail={openDetail}
            onResultsChange={setResults}
          />
        </FxLegacy>
        <footer className={styles.footer}>
          <p className={styles.hint}>
            {projectId ? t('materials.drawer.dragHint') : t('materials.drawer.insertNoProject')}
          </p>
          <p
            className={cn(styles.status, status.kind === 'failed' && styles.statusFailed)}
            role="status"
            aria-live="polite"
            data-testid="materials-drawer-status"
          >
            {statusText}
          </p>
        </footer>
      </Panel>
      {detail ? <MaterialDetailDialog item={detail} onClose={closeDetail} /> : null}
    </aside>
  );
}
