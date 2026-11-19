// SPDX-License-Identifier: AGPL-3.0-only
// The actions every file has, whatever its type: download it, copy its path, open it on its own.
// Viewers put `download` in the bar and spread `menu` into their overflow, so these sit in the same
// place for every file type. `sourceState` turns a load result into the frame's state, so "still
// loading", "could not load" and "too large" also read the same everywhere.
import { Copy, Download, ExternalLink, FileWarning, RotateCw, type LucideIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';

import { useProjectCollabContext } from '../../../collab/collab-context';
import { useT } from '../../../i18n';
import { projectFileUrl } from '../../../providers/registry';
import type { ProjectFile } from '../../../types';
import { copyText, downloadProjectFile } from '../../board/interaction/file-actions';
import { formatBytes, type ArtifactSource } from '../use-artifact-source';
import type { ArtifactAction, ArtifactMenuEntry, ArtifactShellState } from './ArtifactShell';

export interface ArtifactFileActions {
  /** The bar's download button. */
  download: ArtifactAction;
  /** Entries for the overflow menu: copy path, open on its own. */
  menu: ArtifactMenuEntry[];
  /** A "reload" entry for viewers that read the file themselves. */
  reloadEntry(reload: () => void): ArtifactMenuEntry;
  downloadFile(): void;
  /** The frame state for a file the viewer cannot show: a notice with a download button. */
  unsupported(title: string, description?: string, icon?: LucideIcon): ArtifactShellState;
  /** The frame state for a load result; null when there is content to show. */
  sourceState<T>(source: ArtifactSource<T>, reload: () => void): ArtifactShellState | null;
}

export function useArtifactFileActions(projectId: string, file: ProjectFile): ArtifactFileActions {
  const t = useT();
  const { workspaceContext } = useProjectCollabContext();
  const name = file.name;

  const downloadFile = useCallback(() => {
    downloadProjectFile(projectId, name, workspaceContext);
  }, [projectId, name, workspaceContext]);

  return useMemo<ArtifactFileActions>(() => {
    const download: ArtifactAction = {
      id: 'download',
      label: t('fileViewer.download'),
      icon: Download,
      onSelect: downloadFile,
    };
    const menu: ArtifactMenuEntry[] = [
      {
        id: 'copy-path',
        label: t('workspace.code.copyPath'),
        icon: Copy,
        onSelect: () => {
          void copyText(name);
        },
      },
      {
        id: 'open-raw',
        label: t('artifact.action.openInWindow'),
        icon: ExternalLink,
        onSelect: () => {
          window.open(projectFileUrl(projectId, name, workspaceContext), '_blank', 'noopener,noreferrer');
        },
      },
    ];
    const unsupported = (title: string, description?: string, icon: LucideIcon = FileWarning): ArtifactShellState => ({
      kind: 'notice',
      icon,
      title,
      description,
      action: { label: t('fileViewer.download'), onSelect: downloadFile },
    });
    return {
      download,
      menu,
      downloadFile,
      unsupported,
      reloadEntry: (reload) => ({
        id: 'reload',
        label: t('fileViewer.reload'),
        icon: RotateCw,
        onSelect: reload,
        separated: true,
      }),
      sourceState: (source, reload) => {
        if (source.status === 'ready') return null;
        if (source.status === 'loading') {
          return source.slow ? { kind: 'loading', label: t('fileViewer.loading') } : { kind: 'loading', quiet: true };
        }
        if (source.status === 'too-large') {
          return unsupported(
            t('artifact.state.tooLarge'),
            t('artifact.state.tooLargeHint', { size: formatBytes(source.size), limit: formatBytes(source.limit) }),
          );
        }
        return {
          kind: 'notice',
          icon: FileWarning,
          title: t('workspace.code.loadFailed'),
          action: { label: t('fileViewer.reload'), onSelect: reload },
          secondaryAction: { label: t('fileViewer.download'), onSelect: downloadFile },
        };
      },
    };
  }, [t, name, projectId, workspaceContext, downloadFile]);
}
