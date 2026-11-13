// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's 44 px top row (spec 02 §11.3): the app mark and name (hidden under the macOS traffic lights,
// whose 76 px the row keeps clear), then 搜索 (⌘K) and 收起侧栏 (⌘\). A drag region on desktop.
import { PanelLeftClose, Search } from 'lucide-react';

import { withBrandName } from '../../../components/BrandName';
import { useT } from '../../../i18n';
import { cn } from '../../ui/cn';
import { IconButton } from '../../ui/icon-button';
import { Icon } from '../../ui/icons';
import styles from './Sidebar.module.css';

/** Key caps for the sidebar toggle (formatShortcut: ⌘ \ on macOS, Ctrl \ elsewhere). */
export const SIDEBAR_TOGGLE_SHORTCUT = 'mod+\\';

export interface SidebarHeaderProps {
  onSearch(): void;
  /** Docked: fold to the rail. Overlay: close the sheet. */
  onCollapse(): void;
}

export function SidebarHeader({ onSearch, onCollapse }: SidebarHeaderProps) {
  const t = useT();
  return (
    <div className={cn(styles.header, 'fx flex flex-none items-center gap-2 pe-2')} data-testid="fantay-sidebar-header">
      <span className={cn(styles.brand, 'flex min-w-0 items-center gap-2')}>
        <img src="/app-icon-small.svg" width={20} height={20} alt="" className="size-5 flex-none" draggable={false} />
        <span className="truncate text-label font-medium text-ink">{withBrandName(t('app.brand'))}</span>
      </span>
      <span className="ms-auto flex flex-none items-center gap-0.5">
        <IconButton
          size="sm"
          aria-label={t('fantayShell.sidebar.search')}
          shortcut="mod+k"
          tooltipSide="bottom"
          data-testid="fantay-sidebar-search"
          onClick={onSearch}
        >
          <Icon icon={Search} size={15} />
        </IconButton>
        <IconButton
          size="sm"
          aria-label={t('entry.navCollapse')}
          shortcut={SIDEBAR_TOGGLE_SHORTCUT}
          tooltipSide="bottom"
          data-testid="fantay-sidebar-collapse"
          onClick={onCollapse}
        >
          <Icon icon={PanelLeftClose} size={15} />
        </IconButton>
      </span>
    </div>
  );
}
