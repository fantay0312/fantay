/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — the "…" menu every content row and card carries: open the studio, 一键成稿,
 * schedule, change status, open the platform's publish page, move to trash.
 */
import { CalendarClock, ExternalLink, SquarePen, Trash2, WandSparkles } from 'lucide-react';
import type { WorkbenchItem, WorkbenchPlatform, WorkbenchStatus } from '@open-design/contracts';
import { WORKBENCH_STATUSES } from '@open-design/contracts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  MoreHorizontalIcon,
} from '../../ui';
import { useL, useWorkbenchLang } from '../lang';
import { PLATFORM_URL, displayItem, platformName, statusLabel } from '../shared/format';
import { workbench } from '../store';
import page from './page.module.css';

export interface ItemActions {
  openItem(id: string): void;
  produce(id: string, withImages?: boolean): void;
  schedule(item: WorkbenchItem): void;
}

export function setItemStatus(item: WorkbenchItem, status: WorkbenchStatus, label: string): void {
  if (item.status === status) return;
  void workbench.ops([{ op: 'set_status', id: item.id, status }], { label });
}

export function trashItem(item: WorkbenchItem, label: string): void {
  void workbench.ops([{ op: 'trash_items', ids: [item.id] }], { label });
}

export function ItemMenu({ item, actions, className }: { item: WorkbenchItem; actions: ItemActions; className?: string }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const running = item.production?.status === 'running';
  const produced = item.production?.status === 'done';
  const platform = item.platform as WorkbenchPlatform | null | undefined;
  const title = displayItem(item).title;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton size="sm" aria-label={L(`「${title}」的更多操作`, `More for “${title}”`)} tooltip={L('更多操作', 'More')} className={className}>
          <MoreHorizontalIcon />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent width="md" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem icon={<Icon icon={SquarePen} size="sm" />} onSelect={() => actions.openItem(item.id)}>
          {L('打开成稿工作区', 'Open in studio')}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<Icon icon={WandSparkles} size="sm" />}
          disabled={running}
          onSelect={() => actions.produce(item.id)}
        >
          {running ? L('正在成稿…', 'Producing…') : produced ? L('重新一键成稿', 'Produce again') : L('一键成稿', 'Produce draft')}
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Icon icon={CalendarClock} size="sm" />} onSelect={() => actions.schedule(item)}>
          {item.scheduledAt ? L('修改排期…', 'Reschedule…') : L('排期…', 'Schedule…')}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger icon={<span className={page.statusDot} data-status={item.status} />}>
            {L('改状态', 'Status')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={item.status}
              onValueChange={(value) => setItemStatus(item, value as WorkbenchStatus, L('修改状态', 'Change status'))}
            >
              {WORKBENCH_STATUSES.map((status) => (
                <DropdownMenuRadioItem key={status} value={status}>
                  <span className={page.statusDot} data-status={status} style={{ marginInlineEnd: 8 }} />
                  {statusLabel(status, lang)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {platform && PLATFORM_URL[platform] ? (
          <DropdownMenuItem asChild>
            <a href={PLATFORM_URL[platform]} target="_blank" rel="noreferrer">
              <Icon icon={ExternalLink} size="sm" />
              {L(`去${platformName(platform, lang)}发布`, `Publish on ${platformName(platform, lang)}`)}
            </a>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="danger" icon={<Icon icon={Trash2} size="sm" />} onSelect={() => trashItem(item, L('移到废纸篓', 'Move to Trash'))}>
          {L('移到废纸篓', 'Move to Trash')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
