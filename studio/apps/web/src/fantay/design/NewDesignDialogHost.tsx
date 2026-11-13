// SPDX-License-Identifier: AGPL-3.0-only
// Global host of the NewDesignDialog (plan R10, R18; App mounts it in W3). Opens on `openNewDesignDialog`
// (board "+" ▸ 设计文档, a frame's 转为可编辑设计, the Files tab) and on the `fantay.design.import` command
// (desktop menu 导入设计文件…, for the open project). Creating starts a design creation job; the dialog
// stays busy until the design is saved and opened in the 文件 root, and shows the reason if it fails.
import { useEffect, useMemo, useState } from 'react';
import { isDesignDocumentPath, type ProjectFile } from '@open-design/contracts';

import { useI18n } from '../../i18n';
import { fetchProjectFiles } from '../../providers/registry';
import { registerFantayCommand } from '../shell/commands';
import { getActiveProjectSession } from '../shell/project-bridge';
import { DesignCreationRunner } from './DesignCreationRunner';
import { NewDesignDialog } from './NewDesignDialog';
import {
  closeNewDesignDialog,
  designWorkspaceContextFor,
  openNewDesignDialog,
  startDesignCreation,
  useDesignCreationJob,
  useNewDesignRequest,
  type DesignCreationSource,
} from './new-design-store';
import type { DesignEditorDocument } from './types';

const HTML_FILE = /\.html?$/i;

interface ProjectFileChoices {
  htmlFiles: Array<{ path: string; name: string }>;
  existingDesignPaths: string[];
}

const NO_CHOICES: ProjectFileChoices = { htmlFiles: [], existingDesignPaths: [] };

export function projectFileChoices(files: readonly ProjectFile[]): ProjectFileChoices {
  const htmlFiles: ProjectFileChoices['htmlFiles'] = [];
  const existingDesignPaths: string[] = [];
  for (const file of files) {
    if (file.type === 'dir') continue;
    const path = file.path ?? file.name;
    if (HTML_FILE.test(path)) htmlFiles.push({ path, name: file.name });
    else if (isDesignDocumentPath(path)) existingDesignPaths.push(path);
  }
  htmlFiles.sort((a, b) => a.name.localeCompare(b.name));
  return { htmlFiles, existingDesignPaths };
}

/** Maps the dialog's document onto a creation source. */
export function creationSourceFor(doc: DesignEditorDocument): DesignCreationSource {
  switch (doc.kind) {
    case 'convert-html':
      return { kind: 'convert-html', sourcePath: doc.sourcePath };
    case 'import-file':
      return { kind: 'import-file', file: doc.file };
    default:
      return { kind: 'blank' };
  }
}

export function NewDesignDialogHost() {
  const { t } = useI18n();
  const request = useNewDesignRequest();
  const [dialogMounted, setDialogMounted] = useState(request !== null);
  const [choices, setChoices] = useState<ProjectFileChoices>(NO_CHOICES);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useDesignCreationJob(jobId);

  useEffect(() => {
    if (request) setDialogMounted(true);
  }, [request]);

  // Desktop menu 导入设计文件… → the dialog's file source for the open project.
  useEffect(
    () =>
      registerFantayCommand('fantay.design.import', () => {
        const session = getActiveProjectSession();
        if (!session || session.readOnly) return false;
        openNewDesignDialog({
          projectId: session.projectId,
          initialSource: 'file',
          origin: 'menu',
          workspaceContext: designWorkspaceContextFor(session.projectId),
        });
        return true;
      }),
    [],
  );

  const nonce = request?.nonce ?? null;
  const projectId = request?.projectId ?? null;
  useEffect(() => {
    setJobId(null);
    if (!request) {
      setChoices(NO_CHOICES);
      return undefined;
    }
    let cancelled = false;
    setChoices(NO_CHOICES);
    fetchProjectFiles(request.projectId, { workspaceContext: request.workspaceContext, fresh: true })
      .then((files) => {
        if (!cancelled) setChoices(projectFileChoices(files));
      })
      .catch(() => {
        if (!cancelled) setChoices(NO_CHOICES);
      });
    return () => {
      cancelled = true;
    };
    // A new request (nonce) reloads the project's pages and designs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, projectId]);

  useEffect(() => {
    if (job?.status !== 'done') return;
    setJobId(null);
    closeNewDesignDialog();
  }, [job?.status]);

  const busy = job?.status === 'queued' || job?.status === 'running';
  const error = job?.status === 'failed' ? job.error ?? t('designEditor.engineFailed') : null;
  const htmlFiles = useMemo(() => {
    const preselected = request?.sourcePath;
    if (!preselected || choices.htmlFiles.some((entry) => entry.path === preselected)) return choices.htmlFiles;
    return [{ path: preselected, name: preselected }, ...choices.htmlFiles];
  }, [choices.htmlFiles, request?.sourcePath]);

  return (
    <>
      {request !== null || dialogMounted ? (
        <NewDesignDialog
          open={request !== null}
          projectId={request?.projectId ?? ''}
          initialSource={request?.initialSource ?? 'blank'}
          {...(request?.initialName ? { initialName: request.initialName } : {})}
          {...(request?.sourcePath ? { initialHtmlPath: request.sourcePath } : {})}
          htmlFiles={htmlFiles}
          existingDesignPaths={choices.existingDesignPaths}
          busy={busy}
          error={error}
          onOpenChange={(open) => {
            if (open || busy) return;
            setJobId(null);
            closeNewDesignDialog();
          }}
          onCreate={(doc, meta) => {
            if (!request) return;
            setJobId(
              startDesignCreation({
                projectId: request.projectId,
                workspaceContext: request.workspaceContext,
                title: meta.title,
                path: doc.path,
                source: creationSourceFor(doc),
                ...(request.sourceNodeId ? { sourceNodeId: request.sourceNodeId } : {}),
                origin: 'dialog',
              }),
            );
          }}
        />
      ) : null}
      <DesignCreationRunner />
    </>
  );
}
