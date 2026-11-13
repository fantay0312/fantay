// SPDX-License-Identifier: AGPL-3.0-only
// The film entry of the in-workspace file editor registry (spec 07 §2.1(d), plan R10;
// W3-app-integration adds it to `FANTAY_FILE_EDITORS` in apps/web/src/fantay/editors/file-editors.tsx):
// the project's root movie-studio.json opens in place with the film editor instead of the JSON viewer.
import { MOVIE_DOCUMENT_FILE } from '@open-design/contracts';

import type { FantayFileEditor } from '../editors/file-editors';
import { MotionEditorHost } from './MotionEditorHost';

export const motionFileEditor: FantayFileEditor = {
  id: 'motion',
  matches: (file) => file.type !== 'dir' && file.name === MOVIE_DOCUMENT_FILE,
  render: (context) => (
    <MotionEditorHost
      projectId={context.projectId}
      file={context.file}
      active={context.active}
      runInFlight={context.runInFlight}
      viewerOnly={context.viewerOnly}
    />
  ),
};
