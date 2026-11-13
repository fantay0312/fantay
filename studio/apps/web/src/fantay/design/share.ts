// SPDX-License-Identifier: AGPL-3.0-only
// Share = "save as web page" (spec 06 §6.1 share.ts, §6.7, §8.2). A design is shared as a sibling HTML
// snapshot `<path without .fig/.op>.html` written into the project, which the existing project-file share
// (TokenToSeaSharePanel { projectId, fileName }) publishes. No TokenToSea code changes.
import { DesignBridgeFailure, type WorkspaceCollabContext } from '@open-design/contracts';

import { DESIGN_HTML_SNAPSHOT_MAX_BYTES, projectFileExists, writeProjectTextAsFile } from './design-api';
import type { DesignEditorHandle } from './types';

/** `designs/首页.fig` → `designs/首页.html`. */
export function designHtmlPathFor(path: string): string {
  return /\.(?:fig|op)$/i.test(path) ? path.replace(/\.(?:fig|op)$/i, '.html') : `${path}.html`;
}

export interface ShareDesignResult {
  htmlPath: string;
  /** False when the snapshot overwrote an earlier one. */
  created: boolean;
}

/** `exportHtml('page')`, then writes the snapshot through `POST /api/projects/:id/files` (20 MB cap). */
export async function shareDesignAsWebPage(
  handle: Pick<DesignEditorHandle, 'exportHtml'>,
  opts: { projectId: string; path: string; workspaceContext?: WorkspaceCollabContext | null },
): Promise<ShareDesignResult> {
  const html = await handle.exportHtml('page');
  if (!html.trim()) throw new DesignBridgeFailure('EMPTY_DOCUMENT', 'The design page has nothing to export');
  if (new Blob([html]).size > DESIGN_HTML_SNAPSHOT_MAX_BYTES) {
    throw new DesignBridgeFailure('TOO_LARGE', `The web page is larger than ${DESIGN_HTML_SNAPSHOT_MAX_BYTES} bytes`);
  }
  const target = designHtmlPathFor(opts.path);
  const existed = await projectFileExists(opts.projectId, target, opts.workspaceContext);
  const file = await writeProjectTextAsFile(opts.projectId, target, html, 'text/html', opts.workspaceContext);
  return { htmlPath: file.path ?? file.name ?? target, created: !existed };
}
