// SPDX-License-Identifier: AGPL-3.0-only
// The design entry of the in-workspace file editor registry (plan R10; W3-app-integration adds it to
// `FANTAY_FILE_EDITORS` in apps/web/src/fantay/editors/file-editors.tsx): `.fig` / `.op` project files open
// in place in the 文件 root with the design editor instead of the binary viewer.
import { isDesignDocumentPath } from '@open-design/contracts';

import type { FantayFileEditor } from '../editors/file-editors';
import { DesignDocumentViewer } from './DesignDocumentViewer';

export const designFileEditor: FantayFileEditor = {
  id: 'design',
  matches: (file) => file.type !== 'dir' && isDesignDocumentPath(file.path ?? file.name),
  render: (context) => (
    <DesignDocumentViewer
      projectId={context.projectId}
      file={context.file}
      active={context.active}
      runInFlight={context.runInFlight}
      viewerOnly={context.viewerOnly}
      {...(context.onActiveContextChange ? { onActiveContextChange: context.onActiveContextChange } : {})}
      {...(context.onRegisterFlush ? { onRegisterFlush: context.onRegisterFlush } : {})}
    />
  ),
};
