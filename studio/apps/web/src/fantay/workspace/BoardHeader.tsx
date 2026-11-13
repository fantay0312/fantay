// SPDX-License-Identifier: AGPL-3.0-only
// Board header pieces (spec 02 §7.5), injected into FileWorkspace's header row only while 画板 is the
// visible surface: zoom + Share at the end of the actions.
import type { ProjectFile } from '../../types';
import { BoardZoomMenu } from './BoardZoomMenu';
import { ShareCta } from './ShareCta';

export interface BoardHeaderActionsProps {
  projectId: string;
  files: readonly ProjectFile[];
  shareTarget: string | null;
  viewerOnly: boolean;
  streaming: boolean;
}

export function BoardHeaderActions({ projectId, files, shareTarget, viewerOnly, streaming }: BoardHeaderActionsProps) {
  return (
    <div className="fx flex flex-none items-center gap-1.5" data-testid="fantay-board-header-actions">
      <BoardZoomMenu projectId={projectId} />
      <ShareCta
        projectId={projectId}
        files={files}
        shareTarget={shareTarget}
        viewerOnly={viewerOnly}
        streaming={streaming}
      />
    </div>
  );
}
