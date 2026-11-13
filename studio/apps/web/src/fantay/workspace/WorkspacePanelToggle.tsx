// SPDX-License-Identifier: AGPL-3.0-only
// Puts the right-hand workspace away and brings it back. It sits at the window's top-right corner either way: at the
// end of the workspace header while the panel is open, at the end of the chat's header row while it is collapsed.
import { PanelRight } from 'lucide-react';

import { useT } from '../../i18n';
import { useFantayShell } from '../shell/shell-context';
import { Icon, IconButton } from '../ui';

export function WorkspacePanelToggle({ className }: { className?: string }) {
  const t = useT();
  const shell = useFantayShell();
  if (!shell || shell.workspaceMaximized) return null;
  const { workspaceCollapsed, setWorkspaceCollapsed } = shell;
  return (
    <IconButton
      size="sm"
      className={['fx flex-none', className].filter(Boolean).join(' ')}
      aria-label={t(workspaceCollapsed ? 'workspace.expandPanel' : 'workspace.collapsePanel')}
      aria-pressed={!workspaceCollapsed}
      tooltipSide="bottom"
      data-testid="fantay-workspace-panel-toggle"
      onClick={() => setWorkspaceCollapsed(!workspaceCollapsed)}
    >
      <Icon icon={PanelRight} size="sm" />
    </IconButton>
  );
}
