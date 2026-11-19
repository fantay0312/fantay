// SPDX-License-Identifier: AGPL-3.0-only
// The one entry for showing a project file that is not a web page: classify it, load the viewer for
// its type on demand, and fall back to the file card when the viewer fails. Web pages, decks,
// React components and Markdown keep their own viewers in FileViewer; everything else comes here.
'use client';

import { Component, Suspense, lazy, useMemo, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';

import { useT } from '../../i18n';
import type { ProjectFile } from '../../types';
import { artifactFileFamily, type ArtifactViewerId } from './file-family';
import { ArtifactShell } from './shell/ArtifactShell';
import type { ArtifactViewerProps } from './viewer-types';
import { FileCard } from './viewers/UnknownViewer';

type LazyViewer = LazyExoticComponent<ComponentType<ArtifactViewerProps>>;

/** Each viewer is its own chunk: a decoder is downloaded the first time a file of its type opens. */
const VIEWERS: Record<ArtifactViewerId, LazyViewer> = {
  image: lazy(() => import('./viewers/ImageViewer')),
  pdf: lazy(() => import('./viewers/PdfViewer')),
  document: lazy(() => import('./viewers/DocumentViewer')),
  sheet: lazy(() => import('./viewers/SheetViewer')),
  slides: lazy(() => import('./viewers/SlidesViewer')),
  text: lazy(() => import('./viewers/TextViewer')),
  notebook: lazy(() => import('./viewers/NotebookViewer')),
  audio: lazy(() => import('./viewers/AudioViewer')),
  video: lazy(() => import('./viewers/VideoViewer')),
  model: lazy(() => import('./viewers/ModelViewer')),
  archive: lazy(() => import('./viewers/ArchiveViewer')),
  font: lazy(() => import('./viewers/FontViewer')),
  ebook: lazy(() => import('./viewers/EbookViewer')),
  email: lazy(() => import('./viewers/EmailViewer')),
  database: lazy(() => import('./viewers/DatabaseViewer')),
  diagram: lazy(() => import('./viewers/DiagramViewer')),
  whiteboard: lazy(() => import('./viewers/WhiteboardViewer')),
  unknown: lazy(() => import('./viewers/UnknownViewer')),
};

interface BoundaryProps {
  /** A new key (file name + version) clears a previous failure. */
  resetKey: string;
  fallback: ReactNode;
  children: ReactNode;
}

/** A viewer that throws (a corrupt file, a decoder chunk that failed to load) becomes the file card. */
class ViewerBoundary extends Component<BoundaryProps, { failedKey: string | null }> {
  state: { failedKey: string | null } = { failedKey: null };

  static getDerivedStateFromProps(props: BoundaryProps, state: { failedKey: string | null }): { failedKey: string | null } | null {
    return state.failedKey !== null && state.failedKey !== props.resetKey ? { failedKey: null } : null;
  }

  componentDidCatch(): void {
    this.setState({ failedKey: this.props.resetKey });
  }

  render(): ReactNode {
    return this.state.failedKey === this.props.resetKey ? this.props.fallback : this.props.children;
  }
}

export interface ArtifactViewerHostProps {
  projectId: string;
  file: ProjectFile;
  /** False while the tab is mounted but hidden. */
  active?: boolean;
}

export function ArtifactViewer({ projectId, file, active = true }: ArtifactViewerHostProps): JSX.Element {
  const t = useT();
  const family = useMemo(() => artifactFileFamily(file.name, file.mime), [file.name, file.mime]);
  const Viewer = VIEWERS[family.viewer];
  const props: ArtifactViewerProps = { projectId, file, family, active };

  return (
    <ViewerBoundary
      resetKey={`${file.name}:${file.mtime}`}
      fallback={<FileCard {...props} reason={t('artifact.state.viewerFailed')} />}
    >
      <Suspense fallback={<ArtifactShell viewer={family.viewer} state={{ kind: 'loading', quiet: true }} />}>
        <Viewer {...props} />
      </Suspense>
    </ViewerBoundary>
  );
}
