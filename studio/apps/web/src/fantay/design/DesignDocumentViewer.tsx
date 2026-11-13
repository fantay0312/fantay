// SPDX-License-Identifier: AGPL-3.0-only
// A `.fig` / `.op` project file open in the 文件 root (spec 06 §6.1, plan R10): the design editor host for
// that file, with the project's workspace authority, the design Share in the workspace header, and the
// editor selection reported as chat context (amendment C2: the editor-context store keyed by the file's
// tab, plus the file-editor context callback). Switching between design tabs reuses the editor iframe.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectFile, WorkspaceContextItem } from '@open-design/contracts';

import { useProjectCollabContext } from '../../collab/collab-context';
import { setEditorContext } from '../editors/editor-context-store';
import type { FantayEditorFlushHandler } from '../editors/file-editors';
import { runFantayCommand, type FantayCommandId } from '../shell/commands';
import { designSelectionToWorkspaceItem } from './context';
import { openDesignDocument } from './design-workspace';
import { DesignEditorHost } from './DesignEditorHost';
import { DesignShareCta } from './DesignShareCta';
import { rememberDesignWorkspaceContext } from './new-design-store';
import type { DesignEditorDocument, DesignEditorHandle, DesignEditorState, DesignSelectionChange } from './types';

/** App shortcuts the editor iframe forwards instead of swallowing (keybinding → shell command). */
const FORWARDED_SHORTCUTS: Readonly<Record<string, Extract<FantayCommandId, 'fantay.search' | 'fantay.openSettings'>>> = {
  '$mod+KeyK': 'fantay.search',
  '$mod+Comma': 'fantay.openSettings',
};
const FORWARDED_COMBOS = Object.keys(FORWARDED_SHORTCUTS);

function runForwardedShortcut(combo: string): void {
  const command = FORWARDED_SHORTCUTS[combo];
  if (command) runFantayCommand(command);
}

export interface DesignDocumentViewerProps {
  projectId: string;
  file: ProjectFile;
  viewerOnly?: boolean;
  /** FileWorkspace `workspaceActive`; false while the tab is retained but hidden. Default true. */
  active?: boolean;
  /** A chat run is streaming for this project (Share waits). */
  runInFlight?: boolean;
  /** C2: the editor selection as chat context (null clears). */
  onActiveContextChange?(item: WorkspaceContextItem | null): void;
  /** B19: register a flush handler invoked before the retained tab unmounts on close/eviction. */
  onRegisterFlush?(handler: FantayEditorFlushHandler | null): void;
}

export function DesignDocumentViewer({
  projectId,
  file,
  viewerOnly = false,
  active = true,
  runInFlight = false,
  onActiveContextChange,
  onRegisterFlush,
}: DesignDocumentViewerProps) {
  const collab = useProjectCollabContext();
  const workspaceContext = collab.workspaceContext;
  const readOnly = viewerOnly || collab.viewerOnly;
  const path = file.path ?? file.name;
  const tabId = file.name;
  const handleRef = useRef<DesignEditorHandle | null>(null);
  const [editorState, setEditorState] = useState<Pick<DesignEditorState, 'phase' | 'readOnly'>>({ phase: 'booting', readOnly: false });

  const document = useMemo<DesignEditorDocument>(() => ({ kind: 'project', projectId, path, readOnly }), [path, projectId, readOnly]);

  useEffect(() => {
    rememberDesignWorkspaceContext(projectId, workspaceContext);
  }, [projectId, workspaceContext]);

  useEffect(() => {
    if (!onRegisterFlush) return;
    onRegisterFlush((reason = 'close') => handleRef.current?.flush(reason));
    return () => {
      onRegisterFlush(null);
    };
  }, [onRegisterFlush]);

  const forwardRef = useRef(onActiveContextChange);
  forwardRef.current = onActiveContextChange;
  const reportContext = useCallback(
    (item: WorkspaceContextItem | null) => {
      setEditorContext(projectId, tabId, item);
      forwardRef.current?.(item);
    },
    [projectId, tabId],
  );
  // Clear the file's context when the viewer leaves it (another file in this slot, or unmount).
  useEffect(() => () => reportContext(null), [reportContext]);

  const onSelectionChange = useCallback(
    (selection: DesignSelectionChange) => {
      reportContext(designSelectionToWorkspaceItem(selection, { projectId, path: selection.path, tabId }));
    },
    [projectId, reportContext, tabId],
  );

  const onStateChange = useCallback((state: DesignEditorState) => {
    setEditorState((previous) =>
      previous.phase === state.phase && previous.readOnly === state.readOnly ? previous : { phase: state.phase, readOnly: state.readOnly },
    );
  }, []);

  return (
    <DesignEditorHost
      ref={handleRef}
      document={document}
      active={active}
      workspaceContext={workspaceContext}
      forwardShortcuts={FORWARDED_COMBOS}
      onShortcut={runForwardedShortcut}
      onSelectionChange={onSelectionChange}
      onStateChange={onStateChange}
      onDocumentReplaced={(next) => openDesignDocument(next.projectId, next.path)}
      headerEnd={
        <DesignShareCta
          projectId={projectId}
          path={path}
          handle={handleRef}
          active={active}
          ready={editorState.phase === 'editing'}
          readOnly={readOnly || editorState.readOnly}
          runInFlight={runInFlight}
          workspaceContext={workspaceContext}
        />
      }
    />
  );
}
