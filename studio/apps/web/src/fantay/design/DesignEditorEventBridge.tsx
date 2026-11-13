// SPDX-License-Identifier: AGPL-3.0-only
// Serves the generation tools' "在设计编辑器中打开" (`fantay:open-design-editor`, kind new-from-image; spec
// 05 §6.5, plan R10). W3-board-assembly mounts it with the board. For its own project it acks at once
// (the sender reports "unavailable" after 1500 ms without an ack) and queues a creation job: a new
// `designs/<title>.fig` with the image placed in it, a `design` board node with a lineage edge from the
// image node, then the editor opens in the 文件 root. Progress and failure show as toasts.
import { useEffect, useRef } from 'react';
import { designNameFromPath, type WorkspaceCollabContext } from '@open-design/contracts';

import { useI18n } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { FANTAY_OPEN_DESIGN_EDITOR_EVENT, type OpenDesignEditorDetail } from '../workspace/design-editor-events';
import { dismissToast, toast } from '../ui';
import { DesignCreationRunner } from './DesignCreationRunner';
import { hasDesignCreationRunner, rememberDesignWorkspaceContext, startDesignCreation, watchDesignCreationJob } from './new-design-store';

type Translate = (key: keyof Dict, vars?: Record<string, string | number>) => string;

export interface DesignEditorEventBridgeProps {
  projectId: string;
  workspaceContext?: WorkspaceCollabContext | null;
  /** Viewer-only projects cannot create designs: the request is declined (the sender shows its message). */
  readOnly?: boolean;
}

/** Details already answered (several bridges may be mounted, e.g. two boards during a transition). */
const answered = new WeakSet<object>();

function isOpenDesignEditorDetail(value: unknown): value is OpenDesignEditorDetail {
  if (typeof value !== 'object' || value === null) return false;
  const detail = value as Partial<OpenDesignEditorDetail>;
  return typeof detail.projectId === 'string' && typeof detail.ack === 'function' && typeof detail.request === 'object' && detail.request !== null;
}

function safeAck(detail: OpenDesignEditorDetail, result: { ok: boolean; message?: string }): void {
  try {
    detail.ack(result);
  } catch {
    /* the sender went away */
  }
}

/** Toasts a creation job: busy while it runs, nothing on success (the editor opens), the reason on failure. */
export function toastDesignCreation(jobId: string, t: Translate): void {
  const toastId = toast({ title: t('designEditor.new.creating'), busy: true, duration: 0 });
  watchDesignCreationJob(jobId, (job) => {
    if (!job || job.status === 'done') dismissToast(toastId);
    else if (job.status === 'failed') {
      toast({ id: toastId, title: t('designEditor.loadFailed', { reason: job.error ?? '' }), tone: 'danger' });
    }
  });
}

export function DesignEditorEventBridge({ projectId, workspaceContext = null, readOnly = false }: DesignEditorEventBridgeProps) {
  const { t } = useI18n();
  const latest = useRef({ projectId, workspaceContext, readOnly, t });
  latest.current = { projectId, workspaceContext, readOnly, t };

  useEffect(() => {
    rememberDesignWorkspaceContext(projectId, workspaceContext);
  }, [projectId, workspaceContext]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      const current = latest.current;
      if (!isOpenDesignEditorDetail(detail) || detail.projectId !== current.projectId || answered.has(detail)) return;
      answered.add(detail);
      const { request } = detail;
      if (request.kind !== 'new-from-image' || !request.image || typeof request.image.path !== 'string') {
        safeAck(detail, { ok: false, message: current.t('fantay.media.designUnavailable') });
        return;
      }
      if (current.readOnly) {
        safeAck(detail, { ok: false, message: current.t('designEditor.status.readOnly') });
        return;
      }
      if (!hasDesignCreationRunner()) {
        safeAck(detail, { ok: false });
        return;
      }
      const jobId = startDesignCreation({
        projectId: current.projectId,
        workspaceContext: current.workspaceContext,
        title: request.title?.trim() || designNameFromPath(request.image.path) || current.t('designEditor.new.defaultName'),
        source: { kind: 'new-from-image', image: request.image },
        ...(request.sourceNodeId ? { sourceNodeId: request.sourceNodeId } : {}),
        origin: 'event',
      });
      safeAck(detail, { ok: true });
      toastDesignCreation(jobId, current.t);
    };
    window.addEventListener(FANTAY_OPEN_DESIGN_EDITOR_EVENT, onOpen);
    return () => window.removeEventListener(FANTAY_OPEN_DESIGN_EDITOR_EVENT, onOpen);
  }, []);

  return <DesignCreationRunner />;
}
