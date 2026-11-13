// SPDX-License-Identifier: AGPL-3.0-only
// Create-flow host (spec 07 §5.2), mounted once in App (plan R18). Owns the open request, the
// draft (the saved new-film draft via movie-draft.ts), a 'form' | 'videos' step — the library
// picker is shown instead of the Modal, never inside it — and the submit. New project → the film
// editor URL (first prompt staged for the main chat); existing project → the in-workspace editor,
// the prompt through the project chat bridge and a motion `board.insert`. Amendment C5: board video
// paths (`footagePaths`) are matched to library videos and pre-selected as footage. Amendment C6:
// "一句话生成影片" is disabled when the daemon reports no frame renderer.
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { MOVIE_DOCUMENT_FILE, type LibraryAsset, type MovieStyle, type WorkspaceCollabContext } from '@open-design/contracts';

import { workspaceIdentityCacheKey } from '../../collab/workspace-identity';
import { clearMovieDraft, readMovieDraft, saveMovieDraft } from '../../components/movie/movie-draft';
import { useI18n } from '../../i18n';
import { fetchMoviePreviewCapability } from '../../providers/movie';
import { navigate } from '../../router';
import type { Project } from '../../types';
import { sendToProjectChat } from '../chat/project-chat-bridge';
import { FxLegacy, toast } from '../ui';
import { queueBoardInsert, sendWorkspaceCommand, type WorkspaceCommandOf } from '../workspace/workspace-bus';
import {
  MotionCreateCancelled,
  MotionCreateError,
  createMotionProject,
  initialMotionCreateDraft,
  loadPersonalStyles,
  motionCreationDraftToSave,
  resolveFootageAssets,
  type MotionCreateDraft,
  type MotionCreateTask,
} from './motion-create';
import { closeMotionCreate, useMotionCreateRequest, type MotionCreateRequest } from './motion-create-store';
import { MOTION_SKILL_ID } from './motion-model';
import { motionEditorRoute, openMotionEditor } from './motion-projects';

const LazyMotionCreateDialog = lazy(() =>
  import('./MotionCreateDialog').then((mod) => ({ default: mod.MotionCreateDialog })),
);
const LazyMovieVideoPicker = lazy(() =>
  import('../../components/movie/MovieVideoPicker').then((mod) => ({ default: mod.MovieVideoPicker })),
);

export interface MotionCreateHostProps {
  projects: Project[];
  workspaceContext: WorkspaceCollabContext | null;
  onProjectsChanged: () => void; // App.refreshProjects
}

function mergeFootage(current: readonly LibraryAsset[], added: readonly LibraryAsset[]): LibraryAsset[] {
  const merged = [...current];
  for (const asset of added) if (!merged.some((item) => item.id === asset.id)) merged.push(asset);
  return merged;
}

export function MotionCreateHost({ projects, workspaceContext, onProjectsChanged }: MotionCreateHostProps) {
  const { t, locale } = useI18n();
  const request = useMotionCreateRequest();
  const scope = workspaceIdentityCacheKey(workspaceContext);
  // The last opened request stays rendered while the Modal plays its exit.
  const [shown, setShown] = useState<MotionCreateRequest | null>(null);
  const [draft, setDraft] = useState<MotionCreateDraft | null>(null);
  const [step, setStep] = useState<'form' | 'videos'>('form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [footageLoading, setFootageLoading] = useState(false);
  const [personalStyles, setPersonalStyles] = useState<MovieStyle[]>([]);
  const [generateUnavailable, setGenerateUnavailable] = useState(false);
  const run = useRef<AbortController | null>(null);
  const env = useRef({ scope, workspaceContext, projects, t });
  env.current = { scope, workspaceContext, projects, t };

  const messageFor = useCallback(
    (cause: unknown) =>
      cause instanceof MotionCreateError ? env.current.t(cause.key) : cause instanceof Error ? cause.message : String(cause),
    [],
  );

  // Each request (re)starts the form; closing it retires anything in flight.
  useEffect(() => {
    run.current?.abort();
    run.current = null;
    setBusy(false);
    setError(null);
    setStep('form');
    setFootageLoading(false);
    if (!request) return;
    setShown(request);
    const saved = request.target.kind === 'new-project' ? readMovieDraft(env.current.scope) : null;
    const footagePaths = request.target.kind === 'existing-project' ? (request.footagePaths ?? []) : [];
    const initial = initialMotionCreateDraft(request, saved);
    setDraft(footagePaths.length ? { ...initial, kind: 'footage', startMode: 'blank' } : initial);
    if (request.target.kind !== 'existing-project' || footagePaths.length === 0) return;
    let active = true;
    setFootageLoading(true);
    resolveFootageAssets(request.target.projectId, footagePaths, env.current.workspaceContext)
      .then(
        (assets) => {
          if (active) setDraft((current) => (current ? { ...current, footage: mergeFootage(current.footage, assets) } : current));
        },
        (cause: unknown) => {
          if (active) setError(messageFor(cause));
        },
      )
      .finally(() => {
        if (active) setFootageLoading(false);
      });
    return () => {
      active = false;
    };
  }, [request, messageFor]);

  // Renderer capability, once per opened request. Movie styles are independent of web design systems.
  useEffect(() => {
    if (!request) return;
    let active = true;
    void fetchMoviePreviewCapability().then((capability) => {
      if (active) setGenerateUnavailable(capability?.available === false);
    });
    return () => {
      active = false;
    };
  }, [request]);

  // "用我的风格" needs the saved styles of every motion project.
  const wantsPersonal = request !== null && draft?.kind === 'code' && draft.startMode === 'personal';
  useEffect(() => {
    if (!wantsPersonal) return;
    let active = true;
    void loadPersonalStyles(env.current.projects, env.current.workspaceContext).then((saved) => {
      if (!active) return;
      setPersonalStyles(saved);
      if (saved.length) {
        setDraft((current) =>
          current ? { ...current, style: saved.find((style) => style.id === current.style.id) ?? saved[0]! } : current,
        );
      }
    });
    return () => {
      active = false;
    };
  }, [wantsPersonal, projects]);

  // The new-film draft is kept on this device until a film is created.
  useEffect(() => {
    if (!request || request.target.kind !== 'new-project' || !draft) return;
    saveMovieDraft(scope, motionCreationDraftToSave(draft));
  }, [request, draft, scope]);

  const close = useCallback(() => {
    run.current?.abort();
    run.current = null;
    closeMotionCreate();
  }, []);

  const submit = async (task: MotionCreateTask) => {
    if (!request || !draft || busy) return;
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await createMotionProject({
        draft,
        task,
        target: request.target,
        defaultDesignSystemId: request.designSystemId !== undefined ? request.designSystemId : 'fantay',
        personalStyles,
        locale,
        workspaceContext,
        defaultTitles: { film: t('motion.create.defaultFilmTitle'), style: t('motion.create.defaultStyleTitle') },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      run.current = null;
      if (request.target.kind === 'new-project') clearMovieDraft(scope);
      closeMotionCreate();
      onProjectsChanged();
      if (result.existing) {
        openMotionEditor(result.projectId);
        toast({ title: t('motion.create.existingHasFilm') });
        return;
      }
      if (request.target.kind === 'new-project') {
        navigate(motionEditorRoute(result.projectId, result.conversationId));
        return;
      }
      openMotionEditor(result.projectId);
      if (result.prompt) {
        const sent = await sendToProjectChat(result.projectId, result.prompt, {
          skillIds: [MOTION_SKILL_ID],
          source: 'motion-create',
        });
        if (!sent.accepted) {
          toast({
            title: t(
              sent.reason === 'no-chat'
                ? 'motion.editor.chatUnavailable'
                : sent.reason === 'busy'
                  ? 'motion.editor.aiBusy'
                  : 'motion.editor.agentUnavailable',
            ),
            tone: 'danger',
          });
        }
      } else if (result.importedFootage) {
        toast({ title: t('motion.editor.videosImported') });
      }
      const insert: WorkspaceCommandOf<'board.insert'> = {
        type: 'board.insert',
        projectId: result.projectId,
        drafts: [{ kind: 'motion', projectId: result.projectId, path: MOVIE_DOCUMENT_FILE, title: result.document.title }],
      };
      if (!sendWorkspaceCommand(insert)) queueBoardInsert(insert);
    } catch (cause) {
      if (controller.signal.aborted || cause instanceof MotionCreateCancelled) return;
      setError(messageFor(cause));
    } finally {
      if (run.current === controller) run.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  if (!shown || !draft) return null;
  return (
    <Suspense fallback={null}>
      <LazyMotionCreateDialog
        open={request !== null && step === 'form'}
        onClose={close}
        target={shown.target}
        draft={draft}
        onDraftChange={setDraft}
        personalStyles={personalStyles}
        busy={busy}
        error={error}
        onSubmit={(task) => void submit(task)}
        onChooseVideos={() => setStep('videos')}
        generateUnavailable={generateUnavailable}
        footageLoading={footageLoading}
        workspaceContext={workspaceContext}
      />
      {request !== null && step === 'videos' ? (
        <FxLegacy>
          <LazyMovieVideoPicker
            onClose={() => setStep('form')}
            onConfirm={(assets) => {
              setDraft((current) =>
                current ? { ...current, footage: mergeFootage(current.footage, assets), kind: 'footage', startMode: 'blank' } : current,
              );
              setStep('form');
            }}
          />
        </FxLegacy>
      ) : null}
    </Suspense>
  );
}
