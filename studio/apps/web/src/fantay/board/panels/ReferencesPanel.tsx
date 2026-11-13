'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// 参考: everything this project draws on (files in `references/`, chat attachments, canvas uploads, links). Items drag
// onto the canvas, or feed the selected generator. Adding goes through the existing doors: the project upload, the
// material picker (which copies into `references/`), and the connector settings.
import { Check, FileText, Film, Link2, ListFilter, Plug, Plus, Shapes, Sparkles, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MaterialSummaryItem } from '@open-design/contracts';

import { MaterialPickerDialog } from '../../../components/materials/MaterialPickerDialog';
import { useT } from '../../../i18n';
import { applyMaterialItem } from '../../../providers/materials';
import {
  fetchProjectFileText,
  invalidateProjectFilesCache,
  projectRawUrl,
  uploadProjectFiles,
  writeProjectTextFile,
} from '../../../providers/registry';
import { runProjectCommand } from '../../shell/project-bridge';
import { Button } from '../../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { IconButton } from '../../ui/icon-button';
import { toast } from '../../ui/toast';
import { UrlDialog } from '../chrome/UrlDialog';
import { useBoardHost, useBoardSelector } from '../context';
import { useBoardStoreState } from '../data/BoardDataProvider';
import { writePanelDrag } from './panel-drag';
import {
  REFERENCES_DIR,
  REFERENCE_LINKS_FILE,
  deriveReferences,
  parseReferenceLinks,
  serializeReferenceLinks,
  type ReferenceFilter,
  type ReferenceItem,
  type ReferenceLink,
} from './references-model';
import { usePanelActions } from './use-panel-actions';
import styles from './panels.module.css';

const FILTERS: ReadonlyArray<{ id: ReferenceFilter; key: 'board.refs.filterAll' | 'board.refs.filterImage' | 'board.refs.filterVideo' | 'board.refs.filterFile' | 'board.refs.link' }> = [
  { id: 'all', key: 'board.refs.filterAll' },
  { id: 'image', key: 'board.refs.filterImage' },
  { id: 'video', key: 'board.refs.filterVideo' },
  { id: 'file', key: 'board.refs.filterFile' },
  { id: 'link', key: 'board.refs.link' },
];

function Thumb({ item, projectId }: { item: ReferenceItem; projectId: string }) {
  if (item.kind === 'image') return <img className={styles.cover} src={projectRawUrl(projectId, item.path)} alt="" loading="lazy" draggable={false} />;
  if (item.kind === 'video') return <div className={styles.glyph}><Film strokeWidth={1.5} /></div>;
  if (item.kind === 'link') return <div className={styles.glyph}><Link2 strokeWidth={1.5} /></div>;
  return <div className={styles.glyph}><FileText strokeWidth={1.5} /></div>;
}

export function ReferencesPanel({ readOnly }: { readOnly: boolean }) {
  const t = useT();
  const { data, env } = useBoardHost();
  const actions = usePanelActions();
  const board = useBoardStoreState(data.store, (state) => state.board);
  const docNodes = useBoardSelector((state) => state.doc.nodes);
  const input = useRef<HTMLInputElement | null>(null);
  const [links, setLinks] = useState<readonly ReferenceLink[]>([]);
  const [filter, setFilter] = useState<ReferenceFilter>('all');
  const [linkOpen, setLinkOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { projectId, workspaceContext, files, messages } = env;

  const linksFile = files.find((file) => file.name === REFERENCE_LINKS_FILE);
  useEffect(() => {
    if (!linksFile) {
      setLinks([]);
      return undefined;
    }
    let live = true;
    void fetchProjectFileText(projectId, REFERENCE_LINKS_FILE, { cacheBustKey: linksFile.mtime, workspaceContext }).then((text) => {
      if (live) setLinks(parseReferenceLinks(text));
    });
    return () => {
      live = false;
    };
  }, [projectId, workspaceContext, linksFile?.mtime]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(
    () => deriveReferences({ files, nodes: board?.nodes ?? [], messages, links }),
    [files, board?.nodes, messages, links],
  );
  const shown = filter === 'all' ? items : items.filter((item) => item.kind === filter);

  const refresh = useCallback(() => {
    invalidateProjectFilesCache(projectId, workspaceContext);
    env.onRefreshFiles?.();
  }, [projectId, workspaceContext, env.onRefreshFiles]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = useCallback((detail: string) => toast({ title: t('board.assets.failed', { detail }), tone: 'danger' }), [t]);

  const upload = async (picked: File[]): Promise<void> => {
    setBusy(true);
    try {
      const result = await uploadProjectFiles(projectId, picked, REFERENCES_DIR, workspaceContext);
      for (const failure of result.failed) fail(failure.name);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const saveLinks = async (next: readonly ReferenceLink[]): Promise<void> => {
    setLinks(next);
    const written = await writeProjectTextFile(projectId, REFERENCE_LINKS_FILE, serializeReferenceLinks(next), undefined, workspaceContext);
    if (!written) fail(REFERENCE_LINKS_FILE);
    refresh();
  };

  const addMaterials = async (picked: MaterialSummaryItem[]): Promise<void> => {
    const applied = await Promise.allSettled(
      picked.map((item) => applyMaterialItem(item.id, { projectId }, workspaceContext)),
    );
    for (const result of applied) if (result.status === 'rejected') fail(String(result.reason?.message ?? result.reason));
    refresh();
  };

  const openConnectors = (): void => {
    runProjectCommand(projectId, { kind: 'openSettings', section: 'composio' });
  };

  const doors: ReadonlyArray<{ id: string; label: string; icon: ReactNode; run(): void }> = [
    { id: 'upload', label: t('board.refs.upload'), icon: <Upload strokeWidth={1.5} />, run: () => input.current?.click() },
    { id: 'link', label: t('board.refs.link'), icon: <Link2 strokeWidth={1.5} />, run: () => setLinkOpen(true) },
    { id: 'materials', label: t('board.refs.materials'), icon: <Shapes strokeWidth={1.5} />, run: () => setPickerOpen(true) },
    { id: 'connectors', label: t('board.refs.connectors'), icon: <Plug strokeWidth={1.5} />, run: openConnectors },
  ];

  const place = (item: ReferenceItem): void => {
    if (item.kind === 'link') actions.placeLink(item.url);
    else if (item.placeable) actions.placeFile(item.path);
  };
  const connectItem = (item: ReferenceItem): void => {
    const id = item.kind === 'link' ? actions.placeLink(item.url) : item.placeable ? actions.placeFile(item.path)[0] : null;
    if (id) actions.connectToGenerator([id]);
  };

  return (
    <>
      <header className={styles.header}>
        <h2 className={styles.title}>{t('board.panel.references')}</h2>
        {items.length > 0 ? (
          <div className={styles.headerActions}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton size="sm" aria-label={t('board.refs.filter')} on={filter !== 'all'}><ListFilter strokeWidth={1.5} /></IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup value={filter} onValueChange={(value) => setFilter(value as ReferenceFilter)}>
                  {FILTERS.map((entry) => <DropdownMenuRadioItem key={entry.id} value={entry.id}>{t(entry.key)}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {readOnly ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton size="sm" aria-label={t('board.refs.add')}><Plus strokeWidth={1.5} /></IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {doors.map((door) => <DropdownMenuItem key={door.id} icon={door.icon} onSelect={door.run}>{door.label}</DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ) : null}
      </header>

      {items.length === 0 ? (
        <div className={styles.empty} data-testid="board-refs-empty">
          <div className={styles.stack} aria-hidden>
            <span><FileText strokeWidth={1.25} /></span>
            <span><Sparkles strokeWidth={1.25} /></span>
            <span><Film strokeWidth={1.25} /></span>
          </div>
          <h3 className={styles.emptyTitle}>{t('board.refs.emptyTitle')}</h3>
          <p className={styles.emptyBody}>{t('board.refs.emptyBody')}</p>
          {readOnly ? null : (
            <div className={styles.doors}>
              {doors.map((door) => (
                <Button key={door.id} variant="default" size="md" block disabled={busy} data-testid={`board-refs-${door.id}`} onClick={door.run}>
                  {door.icon}
                  {door.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      ) : shown.length === 0 ? (
        <p className={styles.note}>{t('board.refs.noMatch')}</p>
      ) : (
        <ul className={styles.grid} data-testid="board-refs-grid">
          {shown.map((item) => {
            const canPlace = !readOnly && (item.kind === 'link' || item.placeable);
            const onCanvas = item.kind !== 'link' && [...docNodes.values()].some((node) => (node.data as { ref?: { path?: string } | null }).ref?.path === item.path);
            return (
              <li key={item.key} className={styles.card}>
                <div
                  className={styles.thumb}
                  draggable={canPlace}
                  onDragStart={(event) => writePanelDrag(
                    event.dataTransfer,
                    item.kind === 'link' ? { kind: 'link', url: item.url } : { kind: 'file', path: item.path },
                    item.title,
                  )}
                >
                  <Thumb item={item} projectId={projectId} />
                  {onCanvas ? <span className={styles.badge}><Check strokeWidth={2} /></span> : null}
                  {canPlace ? (
                    <div className={styles.overlay}>
                      <IconButton size="sm" variant="frosted" aria-label={t('board.refs.place')} data-testid="board-refs-place" onClick={() => place(item)}>
                        <Plus strokeWidth={1.5} />
                      </IconButton>
                      {actions.generatorId ? (
                        <IconButton size="sm" variant="frosted" aria-label={t('board.refs.useReference')} data-testid="board-refs-connect" onClick={() => connectItem(item)}>
                          <Sparkles strokeWidth={1.5} />
                        </IconButton>
                      ) : null}
                      {item.kind === 'link' ? (
                        <IconButton size="sm" variant="frosted" aria-label={t('board.refs.removeLink')} onClick={() => void saveLinks(links.filter((link) => link.url !== item.url))}>
                          <X strokeWidth={1.5} />
                        </IconButton>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <p className={styles.cardTitle} title={item.title}>{item.title}</p>
              </li>
            );
          })}
        </ul>
      )}

      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden
        data-testid="board-refs-input"
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (picked.length > 0) void upload(picked);
        }}
      />
      <UrlDialog
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        onSubmit={(url) => {
          setLinkOpen(false);
          if (!links.some((link) => link.url === url)) void saveLinks([{ url, addedAt: Date.now() }, ...links]);
        }}
      />
      {pickerOpen ? (
        <MaterialPickerDialog onClose={() => setPickerOpen(false)} onConfirm={(picked) => addMaterials(picked)} attachOnly />
      ) : null}
    </>
  );
}
