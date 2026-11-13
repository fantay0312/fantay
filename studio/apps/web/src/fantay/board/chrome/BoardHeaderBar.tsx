// fx-governance-allow-raw: a page tab pairs its label with a menu and renames on double click, which the Tabs primitive does not model
'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// The board's part of the workspace header row: the two side panel toggles, then the canvas pages. It lives in the
// board's providers and portals into `BoardHeaderSlot`. Double click renames a page; the active tab's menu has rename
// and delete.
import { ChevronDown, Images, Plus, Shapes } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { boardNodesOnPage, BOARD_LIMITS, type BoardPage } from '@open-design/contracts';

import { useT } from '../../../i18n';
import { useBoardHeaderSlot } from '../../workspace/board-header-slot';
import { ConfirmDialog } from '../../ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { IconButton } from '../../ui/icon-button';
import { Input } from '../../ui/input';
import { useBoardEngine, useBoardHost, useBoardSelector } from '../context';
import { useBoardStoreState } from '../data/BoardDataProvider';
import type { BoardSidePanel, DictKey } from '../model/types';
import { CHROME_ICON_STROKE } from './icons';
import styles from './BoardHeaderBar.module.css';

const PANELS: ReadonlyArray<{ id: BoardSidePanel; key: DictKey; icon: typeof Images }> = [
  { id: 'references', key: 'board.panel.references', icon: Images },
  { id: 'assets', key: 'board.panel.assets', icon: Shapes },
];

function PageName({ page, onDone }: { page: BoardPage; onDone(title: string | null): void }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(page.title);
  useEffect(() => {
    input.current?.select();
  }, []);
  return (
    <Input
      ref={input}
      variant="bare"
      inputSize="auto"
      className={styles.rename}
      value={value}
      size={Math.max(4, value.length)}
      maxLength={BOARD_LIMITS.maxPageTitleLength}
      autoFocus
      data-testid="board-page-rename"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onDone(value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') onDone(value);
        if (event.key === 'Escape') onDone(null);
      }}
    />
  );
}

function Bar({ readOnly }: { readOnly: boolean }) {
  const engine = useBoardEngine();
  const { data } = useBoardHost();
  const t = useT();
  const { commands } = engine;
  const pages = useBoardStoreState(data.store, (state) => state.pages);
  const activePageId = useBoardStoreState(data.store, (state) => state.activePageId);
  const sidePanel = useBoardSelector((state) => state.ui.sidePanel);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ page: BoardPage; count: number } | null>(null);

  const askRemove = (page: BoardPage): void => {
    const count = boardNodesOnPage(data.store.getState().board?.nodes ?? [], pages, page.id).length;
    if (count === 0) commands.removePage(page.id);
    else setRemoving({ page, count });
  };

  return (
    <div className={styles.bar} data-testid="board-header-bar">
      {PANELS.map(({ id, key, icon: Glyph }) => (
        <IconButton
          key={id}
          size="sm"
          aria-label={t(key)}
          tooltipSide="bottom"
          on={sidePanel === id}
          data-testid={`board-panel-toggle-${id}`}
          onClick={() => engine.store.setUi({ sidePanel: sidePanel === id ? null : id })}
        >
          <Glyph strokeWidth={CHROME_ICON_STROKE} />
        </IconButton>
      ))}
      <span className={styles.divider} aria-hidden />
      <div className={styles.pages} role="tablist" aria-label={t('board.pages.label')} data-testid="board-pages">
        {pages.map((page) => {
          const selected = page.id === activePageId;
          return (
            <div key={page.id} className={styles.tab} data-active={selected ? '' : undefined}>
              {renaming === page.id ? (
                <PageName
                  page={page}
                  onDone={(title) => {
                    setRenaming(null);
                    if (title !== null) commands.renamePage(page.id, title);
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={styles.tabLabel}
                  data-testid="board-page-tab"
                  onClick={() => commands.showPage(page.id)}
                  onDoubleClick={() => {
                    if (!readOnly) setRenaming(page.id);
                  }}
                >
                  {page.title}
                </button>
              )}
              {selected && !readOnly && renaming !== page.id ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton size="xs" aria-label={t('board.pages.more')} tooltip={false} data-testid="board-page-more">
                      <ChevronDown strokeWidth={CHROME_ICON_STROKE} />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem data-testid="board-page-rename-item" onSelect={() => setRenaming(page.id)}>
                      {t('board.pages.rename')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      tone="danger"
                      disabled={pages.length < 2}
                      data-testid="board-page-delete"
                      onSelect={() => askRemove(page)}
                    >
                      {t('board.pages.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          );
        })}
      </div>
      {readOnly ? null : (
        <IconButton
          size="sm"
          aria-label={t('board.pages.add')}
          tooltipSide="bottom"
          disabled={pages.length >= BOARD_LIMITS.maxPages}
          data-testid="board-page-add"
          onClick={() => commands.addPage()}
        >
          <Plus strokeWidth={CHROME_ICON_STROKE} />
        </IconButton>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t('board.pages.deleteTitle', { name: removing?.page.title ?? '' })}
        description={t('board.pages.deleteBody', { count: removing?.count ?? 0 })}
        confirmLabel={t('board.pages.delete')}
        cancelLabel={t('common.cancel')}
        destructive
        onConfirm={() => {
          if (removing) commands.removePage(removing.page.id);
          setRemoving(null);
        }}
      />
    </div>
  );
}

export function BoardHeaderBar({ readOnly, active }: { readOnly: boolean; active: boolean }) {
  const slot = useBoardHeaderSlot();
  return active && slot ? createPortal(<Bar readOnly={readOnly} />, slot) : null;
}
