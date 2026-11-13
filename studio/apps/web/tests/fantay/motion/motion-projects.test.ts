// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { navigate } from '../../../src/router';
import { getActiveProjectSession, type FantayProjectSession } from '../../../src/fantay/shell/project-bridge';
import {
  getMotionCreateRequest,
  resetMotionCreateForTests,
} from '../../../src/fantay/motion/motion-create-store';
import {
  filterMotionProjects,
  insertMotionFromBoard,
  isMotionProject,
  isOpenMotionStudioCommand,
  motionEditorRoute,
  motionOpenFileName,
  motionProjectOpenRoute,
  openMotionEditor,
} from '../../../src/fantay/motion/motion-projects';
import {
  resetWorkspaceBusForTests,
  subscribeWorkspaceCommand,
} from '../../../src/fantay/workspace/workspace-bus';
import type { Project, ProjectMetadata } from '../../../src/types';

vi.mock('../../../src/router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/router')>()),
  navigate: vi.fn(),
}));

vi.mock('../../../src/fantay/shell/project-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/fantay/shell/project-bridge')>()),
  getActiveProjectSession: vi.fn(() => null),
}));

function project(id: string, updatedAt: number, skillId: string | null, metadata?: ProjectMetadata): Project {
  return { id, name: id, skillId, designSystemId: null, createdAt: 0, updatedAt, ...(metadata ? { metadata } : {}) };
}

describe('motion projects', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    vi.mocked(navigate).mockClear();
    vi.mocked(getActiveProjectSession).mockReset();
    vi.mocked(getActiveProjectSession).mockReturnValue(null);
    resetWorkspaceBusForTests();
    resetMotionCreateForTests();
    window.history.replaceState({}, '', '/');
  });

  it('recognizes motion projects', () => {
    expect(isMotionProject({ skillId: 'fantay-movie' })).toBe(true);
    expect(isMotionProject({ skillId: null, metadata: { kind: 'prototype', intent: 'motion-design' } })).toBe(true);
    expect(isMotionProject({ skillId: null, metadata: { kind: 'prototype', intent: 'hyperframes' } })).toBe(true);
    expect(isMotionProject({ skillId: 'other', metadata: { kind: 'video' } })).toBe(true);
    expect(isMotionProject({ skillId: 'web-prototype', metadata: { kind: 'prototype', intent: 'marketing' } })).toBe(false);
    expect(isMotionProject({ skillId: null })).toBe(false);
  });

  it('filters motion projects, most recently updated first', () => {
    const projects = [
      project('web', 50, null, { kind: 'prototype' }),
      project('old-film', 10, 'fantay-movie'),
      project('clip', 30, null, { kind: 'video' }),
      project('new-film', 40, 'fantay-movie'),
      project('tie', 30, null, { kind: 'prototype', intent: 'hyperframes' }),
    ];
    expect(filterMotionProjects(projects).map((p) => p.id)).toEqual(['new-film', 'clip', 'tie', 'old-film']);
    expect(projects.map((p) => p.id)).toEqual(['web', 'old-film', 'clip', 'new-film', 'tie']);
  });

  it('opens fantay-movie projects on the film editor and other motion projects on the board', () => {
    expect(motionOpenFileName({ skillId: 'fantay-movie' })).toBe('movie-studio.json');
    expect(motionOpenFileName({ skillId: 'web-prototype' })).toBeUndefined();
    expect(motionOpenFileName(null)).toBeUndefined();
    expect(motionOpenFileName()).toBeUndefined();

    expect(motionEditorRoute('p1')).toEqual({ kind: 'project', projectId: 'p1', conversationId: null, fileName: 'movie-studio.json' });
    expect(motionEditorRoute('p1', 'c1')).toEqual({ kind: 'project', projectId: 'p1', conversationId: 'c1', fileName: 'movie-studio.json' });

    expect(motionProjectOpenRoute({ id: 'p1', skillId: 'fantay-movie' })).toEqual(motionEditorRoute('p1'));
    expect(motionProjectOpenRoute({ id: 'p2', skillId: null })).toEqual({
      kind: 'project', projectId: 'p2', conversationId: null, fileName: null,
    });
  });

  it('matches the home open-studio command (zh/en) and nothing longer', () => {
    for (const prompt of ['打开动画工作台', ' 进入 fantay 影片 ', '启动做片。', 'open movie studio', 'Open Fantay animation!', '打开 movie']) {
      expect(isOpenMotionStudioCommand(prompt)).toBe(true);
    }
    for (const prompt of ['open movie studio please do X', '帮我做一个动画', '打开设计工作台', '']) {
      expect(isOpenMotionStudioCommand(prompt)).toBe(false);
    }
  });

  it('opens the editor through the shell command when a subscriber handles it', () => {
    const handler = vi.fn(() => true);
    subscribeWorkspaceCommand('workspace.openEditor', handler);
    openMotionEditor('p1', { conversationId: 'c1' });
    expect(handler).toHaveBeenCalledWith({ type: 'workspace.openEditor', projectId: 'p1', fileName: 'movie-studio.json' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates to the canonical editor URL when no subscriber handles it', () => {
    subscribeWorkspaceCommand('workspace.openEditor', () => false);
    openMotionEditor('p1', { conversationId: 'c1' });
    expect(navigate).toHaveBeenCalledWith(motionEditorRoute('p1', 'c1'));

    resetWorkspaceBusForTests();
    openMotionEditor('p2');
    expect(navigate).toHaveBeenLastCalledWith(motionEditorRoute('p2'));
  });

  describe('insertMotionFromBoard', () => {
    it('opens the existing film and returns the status text key', () => {
      const result = insertMotionFromBoard({
        projectId: 'p1',
        kind: 'code',
        files: [{ name: 'index.html' }, { name: 'movie-studio.json' }],
      });
      expect(result).toEqual({ status: 'opened-editor', projectId: 'p1', statusKey: 'motion.create.existingHasFilm' });
      expect(navigate).toHaveBeenCalledWith(motionEditorRoute('p1'));
      expect(getMotionCreateRequest()).toBeNull();
    });

    it('opens the create dialog for the board project when there is no film', () => {
      const result = insertMotionFromBoard({
        projectId: 'p1',
        kind: 'footage',
        files: [{ name: 'index.html' }, { name: 'docs/movie-studio.json' }],
      });
      const expected = { target: { kind: 'existing-project', projectId: 'p1' }, kind: 'footage', source: 'board-insert' };
      expect(result).toEqual({ status: 'create-dialog', projectId: 'p1', request: expected });
      expect(getMotionCreateRequest()).toEqual(expected);
      expect(navigate).not.toHaveBeenCalled();
    });

    it('seeds footage from a video node (C5) using the current route project', () => {
      window.history.replaceState({}, '', '/projects/p9/files/index.html');
      const path = 'clips/intro.mp4';
      const result = insertMotionFromBoard({ kind: 'footage', files: [path] });
      expect(result).toMatchObject({ status: 'create-dialog', projectId: 'p9' });
      expect(getMotionCreateRequest()).toEqual({
        target: { kind: 'existing-project', projectId: 'p9' },
        kind: 'footage',
        source: 'board-insert',
        footagePaths: ['clips/intro.mp4'],
      });
    });

    it('never drops footage, even when the film already exists', () => {
      const result = insertMotionFromBoard({
        projectId: 'p1',
        kind: 'footage',
        files: [{ name: 'movie-studio.json' }, 'clips/a.MOV', 'notes.md'],
      });
      expect(result.status).toBe('create-dialog');
      expect(getMotionCreateRequest()?.footagePaths).toEqual(['clips/a.MOV']);
      expect(navigate).not.toHaveBeenCalled();
    });

    it('ignores footage strings for code animations and non-video strings', () => {
      insertMotionFromBoard({ projectId: 'p1', kind: 'code', files: ['clips/a.mp4'] });
      expect(getMotionCreateRequest()).not.toHaveProperty('footagePaths');
      insertMotionFromBoard({ projectId: 'p1', kind: 'footage', files: ['notes.md', '.od/cache.mp4'] });
      expect(getMotionCreateRequest()).not.toHaveProperty('footagePaths');
    });

    it('prefers the live project session over the route', () => {
      window.history.replaceState({}, '', '/projects/route-project');
      vi.mocked(getActiveProjectSession).mockReturnValue({ projectId: 'session-project' } as FantayProjectSession);
      expect(insertMotionFromBoard({ kind: 'footage', files: ['a.mp4'] })).toMatchObject({ projectId: 'session-project' });
      expect(insertMotionFromBoard({ projectId: 'explicit', kind: 'footage', files: ['a.mp4'] })).toMatchObject({ projectId: 'explicit' });
    });

    it('does nothing without a project', () => {
      expect(insertMotionFromBoard({ kind: 'footage', files: ['a.mp4'] })).toEqual({ status: 'no-project' });
      expect(getMotionCreateRequest()).toBeNull();
      expect(navigate).not.toHaveBeenCalled();
    });
  });
});
