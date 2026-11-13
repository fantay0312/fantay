/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Compact top-left control bar when the docked sidebar is collapsed to 0 px width.
 * Sits inline right after the macOS traffic lights (or at the top-left of the window on web/Windows/Linux)
 * with Expand Sidebar, Search, Back, and Forward actions.
 */
import { ArrowLeft, ArrowRight, PanelLeft, Search } from 'lucide-react';

import { useT } from '../../../i18n';
import { canGoBackInApp, goBack } from '../../../router';
import { cn } from '../../ui/cn';
import { IconButton } from '../../ui/icon-button';
import { Icon } from '../../ui/icons';
import type { SidebarShellApi } from './sidebar-api';
import { SIDEBAR_TOGGLE_SHORTCUT } from './SidebarHeader';
import styles from './Sidebar.module.css';

/** The Navigation API is Chromium-only and absent from the DOM lib here; without it forward stays enabled. */
function canGoForward(): boolean {
  const { navigation } = window as Window & { navigation?: { canGoForward?: boolean } };
  return navigation?.canGoForward ?? true;
}

export function SidebarRail({ api, className }: { api: SidebarShellApi; className?: string }) {
  const t = useT();
  // `api` changes with the route, so both reads below stay current.
  return (
    <div
      data-rail="narrow"
      data-testid="fantay-sidebar-rail"
      className={cn('fx', styles.railBar, className)}
    >
      <IconButton
        size="sm"
        aria-label={t('entry.navExpand')}
        shortcut={SIDEBAR_TOGGLE_SHORTCUT}
        tooltipSide="bottom"
        data-testid="fantay-sidebar-expand"
        onClick={api.toggleSidebar}
      >
        <Icon icon={PanelLeft} size={15} />
      </IconButton>
      <IconButton
        size="sm"
        aria-label={t('fantayShell.sidebar.search')}
        shortcut="mod+k"
        tooltipSide="bottom"
        data-testid="fantay-sidebar-rail-search"
        onClick={api.openSearch}
      >
        <Icon icon={Search} size={15} />
      </IconButton>
      <IconButton
        size="sm"
        aria-label={t('designBrowser.goBack')}
        shortcut="mod+["
        tooltipSide="bottom"
        data-testid="fantay-sidebar-nav-back"
        disabled={!canGoBackInApp()}
        onClick={() => goBack({ kind: 'home', view: 'home' })}
      >
        <Icon icon={ArrowLeft} size={15} />
      </IconButton>
      <IconButton
        size="sm"
        aria-label={t('designBrowser.goForward')}
        shortcut="mod+]"
        tooltipSide="bottom"
        data-testid="fantay-sidebar-nav-forward"
        disabled={!canGoForward()}
        onClick={() => window.history.forward()}
      >
        <Icon icon={ArrowRight} size={15} />
      </IconButton>
    </div>
  );
}
