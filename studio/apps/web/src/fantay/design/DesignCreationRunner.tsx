// SPDX-License-Identifier: AGPL-3.0-only
// Runs design creation jobs (plan R10). FileWorkspace renders a viewer only for files that exist
// (`activeFile = visibleFiles.find(...)`), so a new design is created *before* its tab opens: the job puts
// the pending-open request for the target path, a hidden headless `DesignEditorHost` takes it (blank /
// converted page / imported file / blank + image), the editor's first save creates the file and queues
// the `design` board draft, and once that document is flushed the runner opens the saved path in the 文件
// root. `.fig` / `.op` imports need no editor: their bytes are stored as they are.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  designNameFromPath,
  isDesignDocumentPath,
  toDesignBridgeError,
  uniqueDesignPath,
  type DesignBridgeError,
  type DesignDocumentFormat,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { useI18n } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { designDirOf, listDesigns, saveDesign, suggestDesignPath } from './design-api';
import { cancelDesignOpenRequest, putDesignOpenRequest, type DesignOpenRequest } from './design-open-requests';
import { insertDesignOnBoard, openDesignDocument } from './design-workspace';
import { DesignEditorHost, describeDesignError } from './DesignEditorHost';
import {
  nextDesignCreationJob,
  registerDesignCreationRunner,
  updateDesignCreationJob,
  useDesignCreationJobs,
  useIsActiveDesignCreationRunner,
  type DesignCreationJob,
  type DesignCreationSource,
} from './new-design-store';
import type { DesignEditorHandle, DesignEditorState } from './types';

type Translate = (key: keyof Dict, vars?: Record<string, string | number>) => string;

/** Upper bound for one creation (engine boot + conversion + first save). */
export const DESIGN_CREATION_TIMEOUT_MS = 120_000;
/** The editor saves a new document right after opening it; after this long the runner asks it to flush. */
export const DESIGN_CREATION_SAVE_NUDGE_MS = 5_000;
const CREATE_RENAME_ATTEMPTS = 5;

/** The format a creation produces: `.op` imports stay `.op`, everything else becomes `.fig`. */
export function designCreationFormat(source: DesignCreationSource): DesignDocumentFormat {
  return source.kind === 'import-file' && /\.op$/i.test(source.file.name) ? 'op' : 'fig';
}

function openRequestFor(job: DesignCreationJob): DesignOpenRequest {
  const { source, title, sourceNodeId } = job.input;
  const common = { ...(title.trim() ? { title: title.trim() } : {}), ...(sourceNodeId ? { sourceNodeId } : {}) };
  switch (source.kind) {
    case 'blank':
      return { kind: 'blank', ...common };
    case 'convert-html':
      return { kind: 'convert-html', sourcePath: source.sourcePath, ...common };
    case 'import-file':
      return { kind: 'import-file', file: source.file, ...common };
    case 'new-from-image':
      return { kind: 'new-from-image', image: source.image, ...common };
  }
}

async function freeDesignPath(projectId: string, title: string, format: DesignDocumentFormat, ctx: WorkspaceCollabContext | null): Promise<string> {
  let existing: string[] = [];
  try {
    existing = (await listDesigns(projectId, ctx)).map((design) => design.path);
  } catch {
    /* the create-only save moves on to the next free name if needed */
  }
  return suggestDesignPath(title, existing, format);
}

/** Stores a `.fig` / `.op` file as it is (create-only; a taken name moves on to `-2`, `-3`, …). */
async function storeDesignFile(
  projectId: string,
  path: string,
  file: File,
  ctx: WorkspaceCollabContext | null,
  t: Translate,
): Promise<string> {
  const bytes = await file.arrayBuffer();
  const format: DesignDocumentFormat = /\.op$/i.test(path) ? 'op' : 'fig';
  const taken = [path];
  let candidate = path;
  for (let attempt = 0; attempt <= CREATE_RENAME_ATTEMPTS; attempt += 1) {
    const outcome = await saveDesign(projectId, candidate, bytes, { create: true }, ctx);
    if (outcome.ok) return outcome.response.design.path || candidate;
    if (outcome.status !== 409) {
      throw new Error(outcome.status === 413 ? t('designEditor.tooLarge') : outcome.message);
    }
    candidate = uniqueDesignPath(designNameFromPath(path), format, taken, designDirOf(path));
    taken.push(candidate);
  }
  throw new Error(t('designEditor.conflict.title'));
}

function CreationSession({ job }: { job: DesignCreationJob }) {
  const { t } = useI18n();
  const tRef = useRef<Translate>(t);
  tRef.current = t;
  const { projectId } = job.input;
  const ctx = job.input.workspaceContext ?? null;
  const [path, setPath] = useState<string | null>(null);
  const handleRef = useRef<DesignEditorHandle | null>(null);
  const settledRef = useRef(false);
  const progressRef = useRef<{ editing: boolean; savedPath: string | null; completing: boolean }>({
    editing: false,
    savedPath: null,
    completing: false,
  });
  const nudgeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (nudgeRef.current !== null) clearTimeout(nudgeRef.current);
    },
    [],
  );
  const pathRef = useRef<string | null>(null);

  const finish = useCallback(
    (result: { ok: true; path: string } | { ok: false; error: string }) => {
      if (settledRef.current) return;
      settledRef.current = true;
      if (result.ok) {
        updateDesignCreationJob(job.id, { status: 'done', path: result.path, error: null });
        if (job.input.openAfter !== false) openDesignDocument(projectId, result.path);
        return;
      }
      if (pathRef.current) cancelDesignOpenRequest(projectId, pathRef.current);
      updateDesignCreationJob(job.id, { status: 'failed', error: result.error });
    },
    [job.id, job.input.openAfter, projectId],
  );

  useEffect(() => {
    let cancelled = false;
    updateDesignCreationJob(job.id, { status: 'running' });
    void (async () => {
      try {
        const { source, title, sourceNodeId } = job.input;
        const format = designCreationFormat(source);
        const target = job.input.path ?? (await freeDesignPath(projectId, title, format, ctx));
        if (cancelled) return;
        if (source.kind === 'import-file' && isDesignDocumentPath(source.file.name)) {
          const saved = await storeDesignFile(projectId, target, source.file, ctx, tRef.current);
          if (cancelled) return;
          insertDesignOnBoard(projectId, { path: saved, ...(title.trim() ? { title: title.trim() } : {}), ...(sourceNodeId ? { sourceNodeId } : {}) });
          finish({ ok: true, path: saved });
          return;
        }
        putDesignOpenRequest(projectId, target, openRequestFor(job));
        pathRef.current = target;
        setPath(target);
      } catch (error) {
        if (!cancelled) finish({ ok: false, error: describeDesignError(toDesignBridgeError(error), tRef.current) || tRef.current('designEditor.engineFailed') });
      }
    })();
    const timer = setTimeout(() => finish({ ok: false, error: tRef.current('designEditor.engineFailed') }), DESIGN_CREATION_TIMEOUT_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // One run per job (the session is keyed by the job id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);

  const maybeComplete = useCallback(() => {
    const progress = progressRef.current;
    if (!progress.editing || progress.savedPath === null || progress.completing || settledRef.current) return;
    progress.completing = true;
    const handle = handleRef.current;
    const done = (flushError?: DesignBridgeError) => {
      if (flushError) finish({ ok: false, error: describeDesignError(flushError, tRef.current) });
      else finish({ ok: true, path: progressRef.current.savedPath ?? pathRef.current ?? '' });
    };
    if (!handle) {
      done();
      return;
    }
    void handle.flush('switch').then(
      (result) => done(!result.saved && result.dirty ? (result.error ?? { code: 'INTERNAL', message: tRef.current('designEditor.status.unsaved') }) : undefined),
      (error: unknown) => done(toDesignBridgeError(error)),
    );
  }, [finish]);

  const onStateChange = useCallback(
    (state: DesignEditorState) => {
      if (settledRef.current) return;
      if (state.phase === 'failed') {
        finish({ ok: false, error: describeDesignError(state.error, tRef.current) || tRef.current('designEditor.engineFailed') });
        return;
      }
      // A save that cannot succeed by retrying (too large, forbidden, invalid) ends the job; network errors
      // are retried by the editor's autosave.
      if (state.phase === 'editing' && state.error && progressRef.current.savedPath === null && state.error.code !== 'NETWORK') {
        finish({ ok: false, error: describeDesignError(state.error, tRef.current) });
        return;
      }
      if (state.phase === 'editing' && !progressRef.current.editing) {
        progressRef.current.editing = true;
        maybeComplete();
        // Normally the editor's convert save has arrived by now; if not, ask for it once.
        nudgeRef.current = setTimeout(() => {
          nudgeRef.current = null;
          if (settledRef.current || progressRef.current.savedPath !== null) return;
          void handleRef.current?.flush('switch').then((result) => {
            if (settledRef.current || progressRef.current.savedPath !== null) return;
            finish({ ok: false, error: describeDesignError(result.error, tRef.current) || tRef.current('designEditor.status.unsaved') });
          });
        }, DESIGN_CREATION_SAVE_NUDGE_MS);
      }
    },
    [finish, maybeComplete],
  );

  const editorDocument = useMemo(() => (path ? ({ kind: 'project', projectId, path } as const) : null), [path, projectId]);
  if (!editorDocument) return null;
  return (
    <div
      aria-hidden
      data-testid="design-creation-runner"
      data-job={job.id}
      className="pointer-events-none fixed left-[-200vw] top-0 h-[800px] w-[1280px] opacity-0"
    >
      <DesignEditorHost
        ref={handleRef}
        mode="headless"
        header="none"
        document={editorDocument}
        workspaceContext={ctx}
        keepAliveMs={Number.POSITIVE_INFINITY}
        onStateChange={onStateChange}
        onSaved={(event) => {
          if (progressRef.current.savedPath !== null) {
            progressRef.current.savedPath = event.path;
            return;
          }
          progressRef.current.savedPath = event.path;
          maybeComplete();
        }}
        onDocumentReplaced={(next) => {
          progressRef.current.savedPath = next.path;
        }}
      />
    </div>
  );
}

/**
 * Processes queued design creation jobs, one at a time. Mount it where creation can start (the global
 * NewDesignDialogHost, the board's DesignEditorEventBridge); only the first mounted instance works.
 */
export function DesignCreationRunner() {
  const token = useMemo(() => ({}), []);
  useEffect(() => registerDesignCreationRunner(token), [token]);
  const owns = useIsActiveDesignCreationRunner(token);
  const jobs = useDesignCreationJobs();
  const job = owns ? nextDesignCreationJob(jobs) : null;
  return job ? <CreationSession key={job.id} job={job} /> : null;
}
