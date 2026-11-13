// SPDX-License-Identifier: AGPL-3.0-only
// Compact header above the design editor (spec 06 §6.1): `headerStart`, the file name, a live save-status
// pill, the zoom level the editor reports, the "更多操作" menu and `headerEnd`. Share lives in the
// workspace header (DesignShareCta), not here.
import type { ReactNode } from 'react';
import type { DesignViewCommand } from '@open-design/contracts';

import { useI18n } from '../../i18n';
import {
  Button,
  Dot,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FX,
  IconButton,
  MoreHorizontalIcon,
  Spinner,
  cn,
} from '../ui';

export type DesignSaveStatus = 'loading' | 'saved' | 'saving' | 'unsaved' | 'readOnly' | 'failed';

export interface DesignHeaderMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect(): void;
}

export interface DesignEditorHeaderProps {
  fileName: string;
  /** null hides the pill (e.g. while the failure panel covers the editor). */
  status: DesignSaveStatus | null;
  /** Shown after "保存失败：" when `status` is 'failed'. */
  statusReason?: string;
  zoom: number | null;
  /** The zoom level becomes a menu of view commands (spec 06 §5.3: header zoom → `view.command`). */
  onZoomCommand?(command: DesignViewCommand): void;
  menuItems: readonly DesignHeaderMenuItem[];
  headerStart?: ReactNode;
  headerEnd?: ReactNode;
  className?: string;
}

function StatusPill({ status, reason }: { status: DesignSaveStatus; reason?: string }) {
  const { t } = useI18n();
  const label =
    status === 'loading'
      ? t('designEditor.loading')
      : status === 'saving'
        ? t('designEditor.status.saving')
        : status === 'unsaved'
          ? t('designEditor.status.unsaved')
          : status === 'readOnly'
            ? t('designEditor.status.readOnly')
            : status === 'failed'
              ? t('designEditor.status.saveFailed', { reason: reason ?? '' })
              : t('designEditor.status.saved');
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="design-save-status"
      data-status={status}
      className={cn(
        'inline-flex h-6 min-w-0 max-w-[min(360px,40vw)] flex-none items-center gap-1.5 rounded-pill bg-paper-deep px-2 text-caption',
        status === 'failed' ? 'text-accent-ink' : 'text-ink-soft',
      )}
    >
      {status === 'saving' || status === 'loading' ? (
        <Spinner size="xs" />
      ) : (
        <Dot tone={status === 'saved' ? 'done' : status === 'failed' ? 'failed' : status === 'unsaved' ? 'idle' : 'muted'} size="sm" />
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}

function ZoomMenu({ zoom, onCommand }: { zoom: number; onCommand(command: DesignViewCommand): void }) {
  const { t } = useI18n();
  const percent = Math.round(zoom * 100);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="bare"
          size="sm"
          data-testid="design-zoom"
          aria-label={t('fantayShell.workspace.zoomMenu', { percent })}
          className="px-1.5 font-mono tabular-nums"
        >
          {`${percent}%`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent width="md">
        <DropdownMenuItem shortcut="mod+=" onSelect={() => onCommand('zoomIn')}>
          {t('fantayShell.workspace.zoomIn')}
        </DropdownMenuItem>
        <DropdownMenuItem shortcut="mod+-" onSelect={() => onCommand('zoomOut')}>
          {t('fantayShell.workspace.zoomOut')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem shortcut="shift+1" onSelect={() => onCommand('zoomFit')}>
          {t('fantayShell.workspace.zoomFit')}
        </DropdownMenuItem>
        <DropdownMenuItem shortcut="shift+2" onSelect={() => onCommand('zoomSelection')}>
          {t('board.zoom.selection')}
        </DropdownMenuItem>
        <DropdownMenuItem shortcut="mod+0" onSelect={() => onCommand('zoom100')}>
          {t('fantayShell.workspace.zoomTo', { percent: 100 })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DesignEditorHeader({
  fileName,
  status,
  statusReason,
  zoom,
  onZoomCommand,
  menuItems,
  headerStart,
  headerEnd,
  className,
}: DesignEditorHeaderProps) {
  const { t } = useI18n();
  return (
    <header
      data-testid="design-editor-header"
      className={cn(FX, 'flex h-10 flex-none items-center gap-2 border-b border-solid border-line bg-surface px-3 font-ui', className)}
    >
      {headerStart}
      <span className="min-w-0 truncate text-body font-medium text-ink" title={fileName}>
        {fileName}
      </span>
      {status ? <StatusPill status={status} {...(statusReason !== undefined ? { reason: statusReason } : {})} /> : null}
      <span className="flex-1" aria-hidden />
      {zoom !== null && onZoomCommand ? <ZoomMenu zoom={zoom} onCommand={onZoomCommand} /> : null}
      {zoom !== null && !onZoomCommand ? (
        <span data-testid="design-zoom" className="flex-none text-caption tabular-nums text-ink-faint">
          {`${Math.round(zoom * 100)}%`}
        </span>
      ) : null}
      {menuItems.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" aria-label={t('designEditor.menu.more')} data-testid="design-more-menu">
              <MoreHorizontalIcon size="sm" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent width="lg">
            {menuItems.map((item) => (
              <DropdownMenuItem
                key={item.id}
                data-testid={`design-menu-${item.id}`}
                icon={item.icon}
                disabled={item.disabled}
                onSelect={() => item.onSelect()}
              >
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {headerEnd}
    </header>
  );
}
