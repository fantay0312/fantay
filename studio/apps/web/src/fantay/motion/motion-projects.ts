// SPDX-License-Identifier: AGPL-3.0-only
// Motion projects: the kind helpers (spec 07 §5.1), the in-workspace editor entry and the
// board insert entry (07 §3.5, plan R5). The board planner seeds motion nodes (R5: no `motionNodeSeed`).
import { MOVIE_DOCUMENT_FILE, boardKindForPath, isBoardMovieDocumentPath } from '@open-design/contracts';

import { navigate, parseRoute, type Route } from '../../router';
import type { Project, ProjectFile } from '../../types';
import { getActiveProjectSession } from '../shell/project-bridge';
import { sendWorkspaceCommand } from '../workspace/workspace-bus';
import { openMotionCreate, type MotionCreateRequest } from './motion-create-store';

const MOTION_SKILL = 'fantay-movie';
const OPEN_MOTION_STUDIO_COMMAND = /^\s*(打开|进入|启动|open)\s*(fantay\s*)?(动画|做片|影片|movie|animation)\s*(工作台|studio)?\s*[。.!！]?\s*$/i;

/** skillId === 'fantay-movie' || metadata.intent ∈ {motion-design, hyperframes} || metadata.kind === 'video' */
export function isMotionProject(p: Pick<Project, 'skillId' | 'metadata'>): boolean {
  const metadata = p.metadata;
  return (
    p.skillId === MOTION_SKILL
    || metadata?.intent === 'motion-design'
    || metadata?.intent === 'hyperframes'
    || metadata?.kind === 'video'
  );
}

/** Motion projects, most recently updated first (stable on ties). */
export function filterMotionProjects<T extends Pick<Project, 'skillId' | 'metadata' | 'updatedAt'>>(projects: readonly T[]): T[] {
  return projects.filter(isMotionProject).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** MOVIE_DOCUMENT_FILE for 'fantay-movie' projects (they open on the film editor), else undefined. */
export function motionOpenFileName(p?: Pick<Project, 'skillId'> | null): string | undefined {
  return p?.skillId === MOTION_SKILL ? MOVIE_DOCUMENT_FILE : undefined;
}

/** Canonical editor URL: /projects/:id[/conversations/:cid]/files/movie-studio.json */
export function motionEditorRoute(projectId: string, conversationId?: string | null): Extract<Route, { kind: 'project' }> {
  return { kind: 'project', projectId, conversationId: conversationId ?? null, fileName: MOVIE_DOCUMENT_FILE };
}

/** fantay-movie → the film editor; other motion projects → the project (board). */
export function motionProjectOpenRoute(p: Pick<Project, 'id' | 'skillId'>): Extract<Route, { kind: 'project' }> {
  if (p.skillId === MOTION_SKILL) return motionEditorRoute(p.id);
  return { kind: 'project', projectId: p.id, conversationId: null, fileName: null };
}

/** The home "open the motion studio" command (regex from EntryShell.tsx:1489, verbatim). */
export function isOpenMotionStudioCommand(prompt: string): boolean {
  return OPEN_MOTION_STUDIO_COMMAND.test(prompt);
}

/** Open the in-workspace editor. Uses the shell command when subscribed, else navigates to the canonical URL. */
export function openMotionEditor(projectId: string, options?: { conversationId?: string | null }): void {
  const handled = sendWorkspaceCommand({ type: 'workspace.openEditor', projectId, fileName: MOVIE_DOCUMENT_FILE });
  if (!handled) navigate(motionEditorRoute(projectId, options?.conversationId));
}

export interface InsertMotionFromBoardInput {
  /** Board project. Optional for node actions: defaults to the live project session, then the current route. */
  projectId?: string;
  kind: 'code' | 'footage';
  /**
   * Board "+" menu (动画 / 视频剪辑): the project's file list (`{ name }` rows); a root `movie-studio.json`
   * means the film exists. Video-node "剪辑视频" (amendment C5): `[path]` strings — project-relative
   * video files seeded as footage (non-video strings are ignored).
   */
  files: ReadonlyArray<Pick<ProjectFile, 'name'> | string>;
}

export type InsertMotionFromBoardResult =
  /** The film exists: the editor opened; callers show `t(statusKey)` (e.g. as a toast). */
  | { status: 'opened-editor'; projectId: string; statusKey: 'motion.create.existingHasFilm' }
  /** The create dialog opened for the board's project. */
  | { status: 'create-dialog'; projectId: string; request: MotionCreateRequest }
  /** No project could be resolved; nothing happened. */
  | { status: 'no-project' };

function resolveBoardProjectId(explicit: string | undefined): string | null {
  if (explicit) return explicit;
  const session = getActiveProjectSession();
  if (session) return session.projectId;
  if (typeof window === 'undefined') return null;
  const route = parseRoute(window.location.pathname);
  return route.kind === 'project' ? route.projectId : null;
}

/**
 * Board "+" menu entry for 动画 (kind 'code') and 视频剪辑 (kind 'footage'), and the video-node
 * "剪辑视频" action (C5). Existing film and no footage → `openMotionEditor(projectId)`; otherwise
 * `openMotionCreate({ target: existing project, kind, source: 'board-insert', footagePaths? })`, so
 * footage is never dropped here.
 */
export function insertMotionFromBoard(input: InsertMotionFromBoardInput): InsertMotionFromBoardResult {
  const projectId = resolveBoardProjectId(input.projectId);
  if (!projectId) return { status: 'no-project' };
  const paths = input.files.map((entry) => (typeof entry === 'string' ? entry : entry.name));
  const hasFilm = paths.some((path) => isBoardMovieDocumentPath(path));
  const footagePaths = input.kind === 'footage'
    ? input.files.filter((entry): entry is string => typeof entry === 'string' && boardKindForPath(entry) === 'video')
    : [];
  if (hasFilm && footagePaths.length === 0) {
    openMotionEditor(projectId);
    return { status: 'opened-editor', projectId, statusKey: 'motion.create.existingHasFilm' };
  }
  const request: MotionCreateRequest = {
    target: { kind: 'existing-project', projectId },
    kind: input.kind,
    source: 'board-insert',
    ...(footagePaths.length > 0 ? { footagePaths } : {}),
  };
  openMotionCreate(request);
  return { status: 'create-dialog', projectId, request };
}
