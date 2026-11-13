// SPDX-License-Identifier: AGPL-3.0-only
// The film editor inside the project workspace (spec 07 §4.1, §4.3): movie-studio.json opens in place
// in the 文件 root. MovieStudio has no chat of its own here — its AI tasks go to the project's chat
// column with the movie skill, the running chat disables them, and agent edits arrive as a new file
// mtime. "返回画板" is offered only while the workspace listens for `workspace.view`.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useProjectCollabContext } from '../../collab/collab-context';
import { MovieStudio, type MovieStudioChat } from '../../components/movie/MovieStudio';
import { revealProjectChat, sendToProjectChat } from '../chat/project-chat-bridge';
import type { FantayFileEditorContext } from '../editors/file-editors';
import { FX, cn } from '../ui';
import { hasWorkspaceSubscriber, sendWorkspaceCommand } from '../workspace/workspace-bus';
import { MOTION_SKILL_ID } from './motion-model';
import styles from './MotionEditorHost.module.css';

/**
 * Whether a workspace handles `workspace.view`. The workspace subscribes in an effect of its own,
 * which runs after this child's effects on a shared mount, so the check repeats once the commit
 * settles and whenever the editor is shown again.
 */
function useWorkspaceViewHandler(active: boolean): boolean {
  const [handled, setHandled] = useState(() => hasWorkspaceSubscriber('workspace.view'));
  useEffect(() => {
    const check = () => setHandled(hasWorkspaceSubscriber('workspace.view'));
    check();
    const timer = window.setTimeout(check, 0);
    return () => window.clearTimeout(timer);
  }, [active]);
  return handled;
}

export function MotionEditorHost({ projectId, file, active, runInFlight, viewerOnly }: FantayFileEditorContext) {
  const { workspaceContext } = useProjectCollabContext();
  const chat = useMemo<MovieStudioChat>(
    () => ({
      mode: 'main',
      busy: runInFlight,
      send: (prompt) => sendToProjectChat(projectId, prompt, { skillIds: [MOTION_SKILL_ID], source: 'motion-editor' }),
      reveal: () => {
        revealProjectChat(projectId);
      },
    }),
    [projectId, runInFlight],
  );
  const canExit = useWorkspaceViewHandler(active);
  const backToBoard = useCallback(() => {
    sendWorkspaceCommand({ type: 'workspace.view', projectId, view: 'board', focus: { kind: 'motion' } });
  }, [projectId]);

  return (
    <div className={cn(FX, styles.host)} data-testid="motion-editor">
      <MovieStudio
        presentation="project"
        projectId={projectId}
        isActive={active}
        workspaceContext={workspaceContext}
        chat={chat}
        readOnly={viewerOnly}
        fileVersion={file.mtime}
        onExit={canExit ? backToBoard : undefined}
      />
    </div>
  );
}

/** Motion projects own a style workspace; they never render the web-design-system chooser. */
export function MotionStyleHost({ projectId, active, runInFlight, viewerOnly, fileVersion, onExit }: {
  projectId: string; active: boolean; runInFlight: boolean; viewerOnly: boolean;
  fileVersion?: number | undefined; onExit: () => void;
}) {
  const { workspaceContext } = useProjectCollabContext();
  const chat = useMemo<MovieStudioChat>(() => ({
    mode: 'main', busy: runInFlight,
    send: (prompt) => sendToProjectChat(projectId, prompt, { skillIds: [MOTION_SKILL_ID], source: 'motion-editor' }),
    reveal: () => revealProjectChat(projectId),
  }), [projectId, runInFlight]);
  return <div className={cn(FX, styles.host)} data-testid="motion-style-workspace">
    <MovieStudio presentation="project" projectId={projectId} isActive={active} styleWorkspace
      workspaceContext={workspaceContext} chat={chat} readOnly={viewerOnly} fileVersion={fileVersion} onExit={onExit} />
  </div>;
}
