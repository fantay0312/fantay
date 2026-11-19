// SPDX-License-Identifier: AGPL-3.0-only
// One memory in a scope's list: the opening of its text (two lines at most), one quiet meta line, and a ⋯ menu
// that appears on hover or focus. Clicking the row opens its details. In 已归档 the meta line leads with the
// state in plain words and an archived memory offers 恢复. A memory in use that recall skips (outside its
// validity window) carries a quiet tag saying so.
import { Children, Fragment, isValidElement, memo, type ReactNode } from 'react';
import { Archive, Copy, Eye, GitCompareArrows, History, Pencil, Pin, PinOff } from 'lucide-react';
import type { MemoryItem } from '@open-design/contracts';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  MoreHorizontalIcon,
  cn,
} from '../ui';
import type { MemoryPageKey, MemoryT } from './i18n';
import { formatDay, formatFull, formatWhen, kindLabel, recallHold, statusLabel, type RecallHold } from './labels';
import styles from './MemoryCenterView.module.css';

export interface MemoryItemRowProps {
  item: MemoryItem;
  /** `active` lists what is in use; `archived` lists archived, replaced and declined memories. */
  mode: 'active' | 'archived';
  t: MemoryT;
  locale: string;
  now: number;
  /** A request for this row is in flight: its actions wait. */
  busy?: boolean;
  onOpen(item: MemoryItem): void;
  onEdit(item: MemoryItem): void;
  onTogglePin(item: MemoryItem): void;
  onCopy(item: MemoryItem): void;
  onHistory(item: MemoryItem): void;
  onArchive(item: MemoryItem): void;
  onRestore(item: MemoryItem): void;
  onOpenConflict(conflictId: string): void;
}

const HOLD_KEY: Record<RecallHold, MemoryPageKey> = {
  notYet: 'memory.row.notYet',
  kept: 'memory.row.kept',
  paused: 'memory.row.paused',
};

/** MetaLine's `·` joining in spans, so the line can sit inside the row's button (phrasing content only). */
function MetaParts({ children }: { children: ReactNode }) {
  const parts = Children.toArray(children);
  return (
    <span className={styles.rowMeta}>
      {parts.map((part, index) => (
        <Fragment key={isValidElement(part) && part.key !== null ? part.key : index}>
          {index > 0 ? (
            <span aria-hidden className={styles.metaSep}>
              ·
            </span>
          ) : null}
          {part}
        </Fragment>
      ))}
    </span>
  );
}

function MemoryItemRowImpl({
  item,
  mode,
  t,
  locale,
  now,
  busy = false,
  onOpen,
  onEdit,
  onTogglePin,
  onCopy,
  onHistory,
  onArchive,
  onRestore,
  onOpenConflict,
}: MemoryItemRowProps) {
  const readOnly = item.readOnly || item.backing === 'studio';
  const inConflict = item.openConflictIds.length > 0;
  const firstConflict = item.openConflictIds[0];
  const text = item.redacted ? t('memory.row.redacted') : item.content.trim() || item.title;
  const groupName = item.via?.groupId ? item.via.groupName?.trim() || null : null;
  const canEdit = mode === 'active' && !readOnly && !item.redacted;
  const canPin = mode === 'active' && !readOnly;
  const canArchive = mode === 'active' && !readOnly;
  const canRestore = mode === 'archived' && item.status === 'archived';
  const hold = mode === 'active' ? recallHold(item, now) : null;

  return (
    <div
      className={styles.row}
      data-testid={`memory-row-${item.id}`}
      data-status={item.status}
      data-pinned={item.pinned ? '' : undefined}
      data-conflict={inConflict ? '' : undefined}
      data-hold={hold ?? undefined}
    >
      <Button variant="bare" className={styles.rowMain} onClick={() => onOpen(item)}>
        <span className={cn(styles.rowText, item.redacted && styles.rowRedacted)}>{text}</span>
        <MetaParts>
          {mode === 'archived' ? <span className={styles.metaState}>{statusLabel(t, item.status)}</span> : null}
          <span className={styles.metaKind}>{kindLabel(t, item.kind)}</span>
          {hold ? (
            <span className={styles.quietTag} data-testid={`memory-row-hold-${item.id}`}>
              {t(HOLD_KEY[hold], hold === 'notYet' && item.validFrom !== null ? { date: formatDay(item.validFrom, locale, now) } : undefined)}
            </span>
          ) : null}
          {item.source ? (
            <span className={styles.metaSource} title={item.source}>
              {item.source}
            </span>
          ) : null}
          <time className={styles.metaPart} dateTime={new Date(item.createdAt).toISOString()} title={formatFull(item.createdAt, locale)}>
            {formatWhen(mode === 'archived' ? item.updatedAt : item.createdAt, locale, now)}
          </time>
          {groupName ? <span className={styles.metaSource}>{t('memory.row.viaGroup', { name: groupName })}</span> : null}
          {item.kind === 'promise' && typeof item.dueAt === 'number' && hold !== 'kept' ? (
            <span className={styles.metaPart}>{t('memory.row.due', { date: formatDay(item.dueAt, locale, now) })}</span>
          ) : null}
          {readOnly ? <span className={styles.metaPart}>{t('memory.row.readOnly')}</span> : null}
          {inConflict && mode === 'active' ? <span className={styles.warmTag}>{t('memory.row.conflict')}</span> : null}
          {item.pinned && mode === 'active' ? (
            <span className={styles.pinMark}>
              <Icon icon={Pin} size={11} />
              {t('memory.row.pinned')}
            </span>
          ) : null}
        </MetaParts>
      </Button>
      <div className={styles.rowSide}>
        {canRestore ? (
          <Button
            variant="ghost"
            size="sm"
            className={styles.restoreAction}
            loading={busy}
            data-testid={`memory-row-restore-${item.id}`}
            onClick={() => onRestore(item)}
          >
            {t('memory.restore')}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              size="sm"
              variant="quiet"
              tooltip={false}
              className={styles.rowMenu}
              aria-label={t('memory.row.actions')}
              disabled={busy}
              data-testid={`memory-row-menu-${item.id}`}
            >
              <MoreHorizontalIcon size="sm" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent width="md">
            {canEdit ? (
              <DropdownMenuItem icon={<Icon icon={Pencil} size="sm" />} data-testid="memory-row-action-edit" onSelect={() => onEdit(item)}>
                {t('memory.menu.edit')}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem icon={<Icon icon={Eye} size="sm" />} data-testid="memory-row-action-details" onSelect={() => onOpen(item)}>
                {t('memory.menu.details')}
              </DropdownMenuItem>
            )}
            {canPin ? (
              <DropdownMenuItem
                icon={<Icon icon={item.pinned ? PinOff : Pin} size="sm" />}
                data-testid="memory-row-action-pin"
                onSelect={() => onTogglePin(item)}
              >
                {t(item.pinned ? 'memory.menu.unpin' : 'memory.menu.pin')}
              </DropdownMenuItem>
            ) : null}
            {inConflict && firstConflict && mode === 'active' ? (
              <DropdownMenuItem
                icon={<Icon icon={GitCompareArrows} size="sm" />}
                data-testid="memory-row-action-compare"
                onSelect={() => onOpenConflict(firstConflict)}
              >
                {t('memory.row.conflictOpen')}
              </DropdownMenuItem>
            ) : null}
            {!item.redacted ? (
              <DropdownMenuItem icon={<Icon icon={Copy} size="sm" />} data-testid="memory-row-action-copy" onSelect={() => onCopy(item)}>
                {t('memory.menu.copy')}
              </DropdownMenuItem>
            ) : null}
            {item.backing === 'ledger' ? (
              <DropdownMenuItem icon={<Icon icon={History} size="sm" />} data-testid="memory-row-action-history" onSelect={() => onHistory(item)}>
                {t('memory.menu.history')}
              </DropdownMenuItem>
            ) : null}
            {canArchive ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem icon={<Icon icon={Archive} size="sm" />} data-testid="memory-row-action-archive" onSelect={() => onArchive(item)}>
                  {t('memory.menu.archive')}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** Rows re-render only when their own memory, mode or busy state changes (the handlers are stable). */
export const MemoryItemRow = memo(MemoryItemRowImpl);
