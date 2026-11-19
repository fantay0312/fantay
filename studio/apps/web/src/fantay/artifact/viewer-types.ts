// SPDX-License-Identifier: AGPL-3.0-only
// What every artifact viewer receives. A viewer is one default-exported component that renders an
// `ArtifactShell` and fills it; it is loaded on demand, so its decoder stays out of the first bundle.
import type { ProjectFile } from '../../types';
import type { ArtifactFileFamily } from './file-family';

export interface ArtifactViewerProps {
  projectId: string;
  file: ProjectFile;
  /** The classification that picked this viewer; `format` says how to read the bytes. */
  family: ArtifactFileFamily;
  /**
   * False while the tab is mounted but not the visible one. Start decoding only when true, and
   * pause playback and animation when it turns false.
   */
  active: boolean;
}
