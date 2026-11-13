// SPDX-License-Identifier: AGPL-3.0-only
// Film creation (spec 07 §5.2), moved out of MovieStudio (`create()`, `importVideos`, personal
// styles, `movieStylePreview`) with the same order and validation: createProject (new target) →
// PUT /movie → footage sources → style links → production grant → first prompt. Existing-project
// targets reuse the project; amendment C5: footage from a board video node is imported into an
// existing film instead of stopping at `existing: true`.
import {
  createMovieDocument,
  MOVIE_STYLES,
  movieAssistPrompt,
  type LibraryAsset,
  type MovieDocument,
  type MovieStartMode,
  type MovieStyle,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import type { MovieCreationDraft } from '../../components/movie/movie-draft';
import type { Dict } from '../../i18n/types';
import { isMovieNotFound, movieRequest, movieStyleRequest } from '../../providers/movie';
import { applyLibraryAsset, syncLibrary } from '../../providers/registry';
import { createProject } from '../../state/projects';
import type { Project } from '../../types';
import { stageProjectAutoSend } from '../chat/auto-send';
import type { MotionCreateRequest, MotionCreateTarget } from './motion-create-store';
import { MOTION_SKILL_ID, movieRawUrl, type MovieAspect } from './motion-model';
import { isMotionProject } from './motion-projects';

type DictKey = keyof Dict;

/** A creation step that failed for a reason the UI shows with `t(key)`. */
export class MotionCreateError extends Error {
  readonly key: DictKey;
  constructor(key: DictKey, message?: string) {
    super(message ?? key);
    this.name = 'MotionCreateError';
    this.key = key;
  }
}

/** The create flow was superseded (dialog closed or replaced) while a request was in flight. */
export class MotionCreateCancelled extends Error {
  constructor() {
    super('motion create cancelled');
    this.name = 'MotionCreateCancelled';
  }
}

export interface MotionCreateDraft {
  kind: 'code' | 'footage';
  startMode: MovieStartMode; // footage forces 'blank'
  style: MovieStyle; // selected / remixed / personal (personal carries sourceProjectId)
  title: string;
  brief: string;
  aspect: MovieAspect;
  bindingDesignSystemId: string; // '' = use the style palette
  footage: LibraryAsset[];
  styleQuery: string;
}

/** The first complete built-in animation (MovieStudio's default selection). */
export const DEFAULT_MOTION_STYLE: MovieStyle = MOVIE_STYLES.find((style) => style.demoShots?.length) ?? MOVIE_STYLES[0]!;

/**
 * The dialog's starting draft: the saved creation draft (new films only), the request's brief
 * (the home composer hand-off wins, even when empty) and its kind (footage forces a blank start).
 */
export function initialMotionCreateDraft(request: MotionCreateRequest, saved: MovieCreationDraft | null): MotionCreateDraft {
  const kind = request.kind === 'footage' ? 'footage' : 'code';
  const style = saved?.style ?? DEFAULT_MOTION_STYLE;
  return {
    kind,
    startMode: kind === 'footage' ? 'blank' : (saved?.mode ?? 'library'),
    style,
    title: saved?.title ?? '',
    brief: request.brief !== undefined ? request.brief : (saved?.brief ?? ''),
    aspect: saved?.aspect ?? '16:9',
    bindingDesignSystemId: '',
    footage: [],
    styleQuery: '',
  };
}

/** The persisted part of a draft (`movie-draft.ts`, unchanged). */
export function motionCreationDraftToSave(draft: MotionCreateDraft): MovieCreationDraft {
  return {
    title: draft.title,
    brief: draft.brief,
    mode: draft.startMode,
    aspect: draft.aspect,
    style: draft.style,
    designSystemId: draft.bindingDesignSystemId,
  };
}

export type MotionCreateTask = 'produce' | 'storyboard' | 'refine-style';

export interface MotionCreateResult {
  projectId: string;
  conversationId: string | null; // new project: from createProject; existing: null
  document: MovieDocument;
  prompt: string | null; // movieAssistPrompt(...) when brief.trim() || task === 'refine-style'
  existing: boolean; // existing-project target that already had a film (nothing created)
  /** C5: videos imported into a film that already existed. */
  importedFootage?: number;
}

/** Why the submit buttons are disabled, if they are. */
export function motionCreateBlockedKey(draft: MotionCreateDraft, personalStyles: readonly MovieStyle[]): DictKey | null {
  if (draft.kind === 'footage' && draft.footage.length === 0) return 'motion.create.chooseVideosFirst';
  if (draft.kind === 'code' && draft.startMode === 'personal' && !personalStyles.some((style) => style.id === draft.style.id)) {
    return 'motion.create.chooseSavedStyleFirst';
  }
  return null;
}

function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MotionCreateCancelled();
}

function promptFor(document: MovieDocument, draft: MotionCreateDraft, task: MotionCreateTask, locale: string): string | null {
  return draft.brief.trim() || task === 'refine-style' ? movieAssistPrompt(document, task, locale) : null;
}

export async function createMotionProject(input: {
  draft: MotionCreateDraft;
  task: MotionCreateTask;
  target: MotionCreateTarget;
  defaultDesignSystemId: string | null; // from the request: undefined → 'fantay', null → none
  personalStyles: MovieStyle[];
  locale: string;
  workspaceContext?: WorkspaceCollabContext | null;
  /** Localized default names used when the title is empty. */
  defaultTitles?: { film: string; style: string };
  /** Abort when the flow is superseded; nothing after the in-flight request runs. */
  signal?: AbortSignal;
}): Promise<MotionCreateResult> {
  const { draft, task, target, personalStyles, locale, signal } = input;
  const workspaceContext = input.workspaceContext ?? undefined;
  const blocked = motionCreateBlockedKey(draft, personalStyles);
  if (blocked) throw new MotionCreateError(blocked);
  const footage = draft.kind === 'footage';
  const startMode: MovieStartMode = footage ? 'blank' : draft.startMode;
  const titles = input.defaultTitles ?? { film: 'Untitled film', style: 'My animation style' };
  const name = draft.title.trim() || (task === 'refine-style' ? titles.style : titles.film);

  let projectId: string;
  let conversationId: string | null = null;
  if (target.kind === 'existing-project') {
    projectId = target.projectId;
    let current: MovieDocument | null = null;
    try {
      current = await movieRequest(projectId, workspaceContext);
    } catch (error) {
      if (!isMovieNotFound(error)) throw error;
    }
    checkSignal(signal);
    if (current) {
      if (!footage) return { projectId, conversationId: null, document: current, prompt: null, existing: true };
      // C5: put the board's video into the film that is already there.
      let next = await importVideos(projectId, current, draft.footage, workspaceContext);
      checkSignal(signal);
      if (task === 'produce') {
        next = (
          await movieStyleRequest<{ document: MovieDocument }>(projectId, workspaceContext, 'production/authorize', {
            enabled: true,
            expectedRevision: next.revision,
          })
        ).document;
      }
      const brief = draft.brief.trim();
      const prompt = promptFor(brief ? { ...next, brief } : next, draft, task, locale);
      return { projectId, conversationId: null, document: next, prompt, existing: false, importedFootage: draft.footage.length };
    }
  } else {
    const created = await createProject({
      name,
      skillId: MOTION_SKILL_ID,
      designSystemId: null,
      metadata: { kind: 'video', intent: 'motion-design', videoModel: 'hyperframes-html' },
      workspaceContext,
    });
    checkSignal(signal);
    projectId = created.project.id;
    conversationId = created.conversationId;
  }

  const document = createMovieDocument(name, startMode, draft.style);
  document.brief = draft.brief;
  document.aspect = draft.aspect;
  let saved = await movieRequest(projectId, workspaceContext, { document, expectedRevision: 0 });
  checkSignal(signal);
  if (footage) {
    saved = await importVideos(projectId, saved, draft.footage, workspaceContext);
    checkSignal(signal);
  }
  if (startMode === 'personal' && draft.style.sourceProjectId) {
    saved = (
      await movieStyleRequest<{ document: MovieDocument }>(projectId, workspaceContext, 'style-link', {
        kind: 'reuse',
        sourceProjectId: draft.style.sourceProjectId,
        styleId: draft.style.id,
        expectedRevision: saved.revision,
      })
    ).document;
    checkSignal(signal);
  }
  if (task === 'produce') {
    saved = (
      await movieStyleRequest<{ document: MovieDocument }>(projectId, workspaceContext, 'production/authorize', {
        enabled: true,
        expectedRevision: saved.revision,
      })
    ).document;
    checkSignal(signal);
  }
  const prompt = promptFor(saved, draft, task, locale);
  // The first message of a new project goes to its main chat once the conversation is ready.
  if (target.kind === 'new-project' && prompt) stageProjectAutoSend(projectId, prompt);
  return { projectId, conversationId, document: saved, prompt, existing: false };
}

/** Copies library videos into the film's `video-sources/` and registers each as a source. */
export async function importVideos(
  projectId: string,
  document: MovieDocument,
  videos: LibraryAsset[],
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<MovieDocument> {
  let next = document;
  for (const asset of videos) {
    const applied = await applyLibraryAsset(asset.id, projectId, 'video-sources', undefined, workspaceContext ?? undefined);
    if (!applied) throw new MotionCreateError('motion.common.videoImportFailed');
    next = (
      await movieStyleRequest<{ document: MovieDocument }>(projectId, workspaceContext ?? undefined, 'sources', {
        assetId: asset.id,
        path: applied.relPath,
        expectedRevision: next.revision,
      })
    ).document;
  }
  return next;
}

/** Saved styles of every motion project, each tagged with its source project. */
export async function loadPersonalStyles(
  projects: readonly Project[],
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<MovieStyle[]> {
  const motion = projects.filter(isMotionProject);
  const documents = await Promise.all(
    motion.map((project) => movieRequest(project.id, workspaceContext ?? undefined).catch(() => null)),
  );
  return documents.flatMap((document, index) =>
    (document?.savedStyles ?? []).map((style) => ({ ...style, sourceProjectId: motion[index]!.id })),
  );
}

// Built-in sample copy for styles without demo shots (film content, not UI chrome; spec 07 §10).
const STYLE_PREVIEW_COPY: Record<string, [string, string]> = {
  fantay: ['让想法\n动起来。', '从一个念头，到一部作品。'],
  editorial: ['给故事，\n一点时间。', '字里行间，自有节奏。'],
  signal: ['新观点。\n现在登场。', '清晰、直接，不必绕弯。'],
  blueprint: ['看见复杂，\n背后的秩序。', '把过程，讲清楚。'],
  soft: ['把日常，\n拍成温柔。', '让每个片刻，慢慢发生。'],
  minimal: ['少一点，\n更清楚。', '留下真正想说的。'],
};

/** A one-scene film that shows a style (or its own demo shots). */
export function movieStylePreview(style: MovieStyle): MovieDocument {
  const doc = createMovieDocument(style.name, 'library', style);
  if (style.demoShots?.length) return doc;
  const [title, body] = STYLE_PREVIEW_COPY[style.id] ?? [style.name, style.description];
  doc.shots = [{ id: 'cover', title, body, duration: 4, layout: 'title' }];
  return doc;
}

// ── C5: project videos (board video nodes) → library videos for `importVideos` ──────────────

const LIBRARY_VIDEO_UPLOAD_MAX = 256 * 1024 * 1024;
const VIDEO_PATH = /\.(mp4|mov|webm)$/i;

function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
}

async function listProjectVideoAssets(projectId: string): Promise<LibraryAsset[]> {
  try {
    const params = new URLSearchParams({ kind: 'video', projectId, limit: '1000' });
    const response = await fetch(`/api/library/assets?${params.toString()}`);
    if (!response.ok) return [];
    const body = (await response.json()) as { assets?: LibraryAsset[] };
    return body.assets ?? [];
  } catch {
    return [];
  }
}

/** The library row that indexes `path` of `projectId` (a referenced project file, or a deduped source). */
function assetForPath(assets: readonly LibraryAsset[], projectId: string, path: string): LibraryAsset | undefined {
  return assets.find(
    (asset) =>
      asset.kind === 'video' &&
      ((asset.originProjectId === projectId && asset.relPath === path) ||
        (asset.sources ?? []).some((source) => source.projectId === projectId && source.relPath === path)),
  );
}

/** Fallback for files the library does not index (e.g. above its reference size): upload a copy. */
async function uploadProjectVideo(
  projectId: string,
  path: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<LibraryAsset | null> {
  try {
    const raw = await fetch(movieRawUrl(projectId, path, workspaceContext));
    if (!raw.ok) return null;
    const blob = await raw.blob();
    if (blob.size === 0 || blob.size > LIBRARY_VIDEO_UPLOAD_MAX) return null;
    const filename = path.split('/').pop() || 'video.mp4';
    const response = await fetch(`/api/library/videos?filename=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { asset?: LibraryAsset };
    return body.asset ?? null;
  } catch {
    return null;
  }
}

/**
 * Maps project-relative video paths to library videos, in order: the library's own index of the
 * project (after one reconcile when a path is missing), else an upload of the file.
 */
export async function resolveFootageAssets(
  projectId: string,
  paths: readonly string[],
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<LibraryAsset[]> {
  const wanted = [...new Set(paths.map(normalizeProjectPath).filter((path) => VIDEO_PATH.test(path)))];
  if (wanted.length === 0) return [];
  let assets = await listProjectVideoAssets(projectId);
  if (wanted.some((path) => !assetForPath(assets, projectId, path))) {
    await syncLibrary();
    assets = await listProjectVideoAssets(projectId);
  }
  const resolved: LibraryAsset[] = [];
  for (const path of wanted) {
    const asset = assetForPath(assets, projectId, path) ?? (await uploadProjectVideo(projectId, path, workspaceContext));
    if (!asset) throw new MotionCreateError('motion.common.videoImportFailed');
    if (!resolved.some((item) => item.id === asset.id)) resolved.push(asset);
  }
  return resolved;
}
