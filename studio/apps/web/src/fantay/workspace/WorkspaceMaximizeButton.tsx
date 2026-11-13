// SPDX-License-Identifier: AGPL-3.0-only
// Gives the workspace the whole window (sidebar and chat step aside) and hands it back. It sits in the header row
// on every root, so 返回 stays reachable after switching between 画板, 文件 and 设计系统.
import { Maximize2, Minimize2 } from 'lucide-react';

import { useT } from '../../i18n';
import { useFantayShell } from '../shell/shell-context';
import { Icon, IconButton } from '../ui';

export function WorkspaceMaximizeButton() {
  const t = useT();
  const shell = useFantayShell();
  if (!shell) return null;
  const { workspaceMaximized, setWorkspaceMaximized } = shell;
  return (
    <IconButton
      size="sm"
      className="fx flex-none"
      aria-label={t(workspaceMaximized ? 'board.node.restoreView' : 'board.node.maximize')}
      aria-pressed={workspaceMaximized}
      tooltipSide="bottom"
      data-testid="fantay-workspace-maximize"
      onClick={() => setWorkspaceMaximized(!workspaceMaximized)}
    >
      <Icon icon={workspaceMaximized ? Minimize2 : Maximize2} size="sm" />
    </IconButton>
  );
}
