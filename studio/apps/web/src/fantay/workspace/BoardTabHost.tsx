// SPDX-License-Identifier: AGPL-3.0-only
// The 画板 surface (spec 02 §7.4): lazy-loads `../board/ProjectBoard` (W1 placeholder, replaced by
// W3-board-assembly) with the host contract props. Rendered once inside FileWorkspace's `.ws-body` by
// `useFantayWorkspace().boardLayer`, which keeps it mounted (hidden) after the first activation.
import { lazy, Suspense } from 'react';

import { useT } from '../../i18n';
import type { FantayBoardHostProps } from './board-host-contract';
import { WorkspaceLoader } from './WorkspaceLoader';

const LazyProjectBoard = lazy(() => import('../board/ProjectBoard').then((module) => ({ default: module.ProjectBoard })));

export function BoardTabHost(props: FantayBoardHostProps) {
  const t = useT();
  return (
    <div
      className="fx"
      data-testid="fantay-board-host"
      data-active={props.active ? 'true' : 'false'}
      style={{ display: 'flex', flex: '1 1 auto', minHeight: 0, minWidth: 0 }}
    >
      <Suspense fallback={<WorkspaceLoader label={t('fantayShell.workspace.boardLoading')} />}>
        <LazyProjectBoard {...props} />
      </Suspense>
    </div>
  );
}
