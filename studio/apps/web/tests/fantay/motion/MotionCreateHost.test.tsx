// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// MotionCreateHost: existing-project targets (chat bridge + board insert), amendment C5 (board
// video → footage, imported into an existing film) and amendment C6 (no frame renderer → the
// one-step film is disabled with its reason; storyboard-first stays available).
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMovieDocument, type LibraryAsset, type MovieDocument } from '@open-design/contracts';

import {
  registerProjectChatSender,
  resetProjectChatBridgeForTests,
  type ProjectChatSender,
} from '../../../src/fantay/chat/project-chat-bridge';
import { MotionCreateHost } from '../../../src/fantay/motion/MotionCreateHost';
import { MotionCreatePanel, type MotionCreatePanelProps } from '../../../src/fantay/motion/MotionCreatePanel';
import {
  DEFAULT_MOTION_STYLE,
  createMotionProject,
  initialMotionCreateDraft,
} from '../../../src/fantay/motion/motion-create';
import { openMotionCreate, resetMotionCreateForTests } from '../../../src/fantay/motion/motion-create-store';
import { Toaster, __resetToastsForTests } from '../../../src/fantay/ui';
import {
  resetWorkspaceBusForTests,
  subscribeWorkspaceCommand,
  type WorkspaceCommand,
} from '../../../src/fantay/workspace/workspace-bus';
import { I18nProvider } from '../../../src/i18n';
import {
  MovieRequestError,
  fetchMoviePreviewCapability,
  movieRequest,
  movieStyleRequest,
} from '../../../src/providers/movie';
import { applyLibraryAsset, syncLibrary } from '../../../src/providers/registry';
import { navigate } from '../../../src/router';
import { createProject } from '../../../src/state/projects';

vi.mock('../../../src/providers/movie', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/movie')>()),
  movieRequest: vi.fn(),
  movieStyleRequest: vi.fn(),
  fetchMoviePreviewCapability: vi.fn(),
}));
vi.mock('../../../src/providers/registry', () => ({
  fetchDesignSystems: vi.fn(async () => []),
  applyLibraryAsset: vi.fn(async () => ({ relPath: 'video-sources/clip.mp4' })),
  libraryAssetRawUrl: (id: string) => `/api/library/assets/${id}/raw`,
  syncLibrary: vi.fn(async () => null),
}));
vi.mock('../../../src/state/projects', () => ({ createProject: vi.fn() }));
vi.mock('../../../src/router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/router')>()),
  navigate: vi.fn(),
}));
const pickerAsset = { id: 'source', kind: 'video', sourceTitle: 'Garden' } as LibraryAsset;

vi.mock('../../../src/components/movie/MovieVideoPicker', () => ({
  MovieVideoPicker: ({ onConfirm }: { onConfirm: (assets: LibraryAsset[]) => void }) => (
    <button type="button" onClick={() => onConfirm([pickerAsset])}>
      Pick test video
    </button>
  ),
}));

const clip = {
  id: 'lib-clip',
  kind: 'video',
  originProjectId: 'film-9',
  relPath: 'media/clip.mp4',
  sourceTitle: 'clip.mp4',
  sources: [],
} as unknown as LibraryAsset;

function existingFilm(revision = 5): MovieDocument {
  return { ...createMovieDocument('Existing film'), revision };
}

/** Records the workspace commands the host sends. */
function listen() {
  const commands: WorkspaceCommand[] = [];
  subscribeWorkspaceCommand('board.insert', (command) => {
    commands.push(command);
    return true;
  });
  subscribeWorkspaceCommand('workspace.openEditor', (command) => {
    commands.push(command);
    return true;
  });
  return commands;
}

function renderHost() {
  const onProjectsChanged = vi.fn();
  render(
    <I18nProvider initial="zh-CN">
      <MotionCreateHost projects={[]} workspaceContext={null} onProjectsChanged={onProjectsChanged} />
      <Toaster />
    </I18nProvider>,
  );
  return { onProjectsChanged };
}

let sender: ReturnType<typeof vi.fn<ProjectChatSender>>;
beforeEach(() => {
  vi.mocked(movieRequest).mockReset();
  vi.mocked(movieStyleRequest).mockReset();
  vi.mocked(createProject).mockReset();
  vi.mocked(navigate).mockReset();
  vi.mocked(applyLibraryAsset).mockClear();
  vi.mocked(syncLibrary).mockClear();
  vi.mocked(fetchMoviePreviewCapability).mockReset().mockResolvedValue({ available: true, renderer: 'desktop' });
  sender = vi.fn<ProjectChatSender>(async () => true);
  registerProjectChatSender('film-9', sender, { busy: () => false, reveal: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetMotionCreateForTests();
  resetWorkspaceBusForTests();
  resetProjectChatBridgeForTests();
  __resetToastsForTests();
  localStorage.clear();
  sessionStorage.clear();
});

describe('MotionCreateHost — existing project', () => {
  it('creates the film in the project, sends the prompt through the chat bridge and posts a motion board insert', async () => {
    const commands = listen();
    vi.mocked(movieRequest).mockImplementation(async (_id, _context, action) => {
      if (!action) throw new MovieRequestError('This project has no movie yet', 404, 'MOVIE_NOT_FOUND');
      return { ...createMovieDocument('Teaser'), brief: 'Make a teaser', revision: 1 };
    });
    vi.mocked(movieStyleRequest).mockResolvedValue({ document: { ...createMovieDocument('Teaser'), brief: 'Make a teaser', revision: 2 } });
    act(() => openMotionCreate({ target: { kind: 'existing-project', projectId: 'film-9' }, kind: 'code', source: 'board-insert' }));
    renderHost();
    expect(await screen.findByText('为此项目添加影片')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('创作想法'), { target: { value: 'Make a teaser' } });
    fireEvent.click(screen.getByRole('button', { name: '一句话生成影片' }));
    await waitFor(() => expect(sender).toHaveBeenCalledTimes(1));
    expect(createProject).not.toHaveBeenCalled();
    expect(vi.mocked(movieRequest).mock.calls[1]).toEqual([
      'film-9',
      undefined,
      expect.objectContaining({ expectedRevision: 0, document: expect.objectContaining({ brief: 'Make a teaser' }) }),
    ]);
    expect(movieStyleRequest).toHaveBeenCalledWith('film-9', undefined, 'production/authorize', { enabled: true, expectedRevision: 1 });
    const [prompt, options] = sender.mock.calls[0]!;
    expect(prompt).toContain('Teaser');
    expect(options).toEqual({ skillIds: ['fantay-movie'] });
    expect(commands).toEqual([
      { type: 'workspace.openEditor', projectId: 'film-9', fileName: 'movie-studio.json' },
      {
        type: 'board.insert',
        projectId: 'film-9',
        drafts: [{ kind: 'motion', projectId: 'film-9', path: 'movie-studio.json', title: 'Teaser' }],
      },
    ]);
    expect(sessionStorage.getItem('od:auto-send-first:film-9')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens an existing film without writing anything and says so', async () => {
    const commands = listen();
    vi.mocked(movieRequest).mockResolvedValue(existingFilm());
    act(() => openMotionCreate({ target: { kind: 'existing-project', projectId: 'film-9' }, source: 'editor-empty' }));
    renderHost();
    fireEvent.click(await screen.findByRole('button', { name: '创建空白项目' }));
    expect(await screen.findByText('此项目已有影片，已为你打开')).toBeInTheDocument();
    expect(movieRequest).toHaveBeenCalledTimes(1);
    expect(movieStyleRequest).not.toHaveBeenCalled();
    expect(commands).toEqual([{ type: 'workspace.openEditor', projectId: 'film-9', fileName: 'movie-studio.json' }]);
    expect(sender).not.toHaveBeenCalled();
  });

  it('queues the board insert when no board is mounted and reports a busy chat', async () => {
    subscribeWorkspaceCommand('workspace.openEditor', () => true);
    resetProjectChatBridgeForTests();
    registerProjectChatSender('film-9', sender, { busy: () => true, reveal: vi.fn() });
    vi.mocked(movieRequest).mockImplementation(async (_id, _context, action) => {
      if (!action) throw new MovieRequestError('none', 404, 'MOVIE_NOT_FOUND');
      return { ...createMovieDocument('Queued'), brief: 'Queued brief', revision: 1 };
    });
    act(() => openMotionCreate({ target: { kind: 'existing-project', projectId: 'film-9' }, source: 'board-insert' }));
    renderHost();
    fireEvent.change(await screen.findByLabelText('创作想法'), { target: { value: 'Queued brief' } });
    fireEvent.click(screen.getByRole('button', { name: '先看分镜' }));
    expect(await screen.findByText('AI 正在处理上一条请求')).toBeInTheDocument();
    const { drainQueuedBoardInserts } = await import('../../../src/fantay/workspace/workspace-bus');
    expect(drainQueuedBoardInserts('film-9')).toEqual([
      expect.objectContaining({ type: 'board.insert', drafts: [expect.objectContaining({ kind: 'motion', title: 'Queued' })] }),
    ]);
    expect(sender).not.toHaveBeenCalled();
  });
});

describe('MotionCreateHost — C5 footage from a board video', () => {
  function stubLibrary(responses: Array<LibraryAsset[]>, extra?: (url: string, init?: RequestInit) => Response | null) {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/library/assets?')) {
        return new Response(JSON.stringify({ assets: responses.length > 1 ? responses.shift() : responses[0] }), { status: 200 });
      }
      const handled = extra?.(url, init);
      if (handled) return handled;
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('pre-selects the video and imports it into the film that already exists', async () => {
    const commands = listen();
    const fetchMock = stubLibrary([[clip]]);
    vi.mocked(movieRequest).mockResolvedValue(existingFilm(5));
    vi.mocked(movieStyleRequest).mockImplementation(async (_id, _context, route, body) => ({
      document: { ...existingFilm(Number(body.expectedRevision) + 1) },
    }) as never);
    act(() =>
      openMotionCreate({
        target: { kind: 'existing-project', projectId: 'film-9' },
        kind: 'footage',
        source: 'board-insert',
        footagePaths: ['media/clip.mp4'],
      }),
    );
    renderHost();
    expect(await screen.findByText('clip.mp4')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '视频剪辑' })).toHaveAttribute('aria-checked', 'true');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/library/assets?kind=video&projectId=film-9&limit=1000');
    expect(syncLibrary).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('创作想法'), { target: { value: 'Cut a 15s teaser' } });
    fireEvent.click(screen.getByRole('button', { name: '一句话生成影片' }));
    await waitFor(() => expect(sender).toHaveBeenCalledTimes(1));
    expect(applyLibraryAsset).toHaveBeenCalledWith('lib-clip', 'film-9', 'video-sources', undefined, undefined);
    expect(movieStyleRequest).toHaveBeenNthCalledWith(1, 'film-9', undefined, 'sources', {
      assetId: 'lib-clip',
      path: 'video-sources/clip.mp4',
      expectedRevision: 5,
    });
    expect(movieStyleRequest).toHaveBeenNthCalledWith(2, 'film-9', undefined, 'production/authorize', {
      enabled: true,
      expectedRevision: 6,
    });
    // no new document over the existing film, no new project
    expect(vi.mocked(movieRequest).mock.calls.every((call) => call.length === 2)).toBe(true);
    expect(createProject).not.toHaveBeenCalled();
    expect(sender.mock.calls[0]![0]).toContain('Cut a 15s teaser');
    expect(commands).toContainEqual(expect.objectContaining({ type: 'board.insert', projectId: 'film-9' }));
    expect(screen.queryByText('此项目已有影片，已为你打开')).toBeNull();
  });

  it('reconciles the library once when the video is not indexed yet', async () => {
    stubLibrary([[], [{ ...clip, originProjectId: undefined, relPath: undefined, sources: [{ projectId: 'film-9', relPath: 'media/clip.mp4' }] } as unknown as LibraryAsset]]);
    vi.mocked(movieRequest).mockResolvedValue(existingFilm());
    act(() =>
      openMotionCreate({
        target: { kind: 'existing-project', projectId: 'film-9' },
        kind: 'footage',
        source: 'board-insert',
        footagePaths: ['./media/clip.mp4'],
      }),
    );
    renderHost();
    expect(await screen.findByText('clip.mp4')).toBeInTheDocument();
    expect(syncLibrary).toHaveBeenCalledTimes(1);
  });

  it('uploads a copy when the library cannot index the file', async () => {
    const fetchMock = stubLibrary([[]], (url, init) => {
      if (url === '/api/projects/film-9/raw/media/big%20clip.mp4') {
        return new Response('video-bytes', { headers: { 'Content-Type': 'video/mp4' } });
      }
      if (url === '/api/library/videos?filename=big%20clip.mp4' && init?.method === 'POST') {
        return new Response(JSON.stringify({ asset: { id: 'lib-upload', kind: 'video', sourceTitle: 'big clip.mp4', sources: [] } }));
      }
      return null;
    });
    vi.mocked(movieRequest).mockResolvedValue(existingFilm());
    act(() =>
      openMotionCreate({
        target: { kind: 'existing-project', projectId: 'film-9' },
        kind: 'footage',
        source: 'board-insert',
        footagePaths: ['media/big clip.mp4'],
      }),
    );
    renderHost();
    expect(await screen.findByText('big clip.mp4')).toBeInTheDocument();
    const upload = fetchMock.mock.calls.find((call) => String(call[0]).startsWith('/api/library/videos'));
    expect(upload?.[1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'video/mp4' } });
  });

  it('shows the import error when a video cannot be matched or uploaded', async () => {
    stubLibrary([[]]);
    vi.mocked(movieRequest).mockResolvedValue(existingFilm());
    act(() =>
      openMotionCreate({
        target: { kind: 'existing-project', projectId: 'film-9' },
        kind: 'footage',
        source: 'board-insert',
        footagePaths: ['media/gone.mp4'],
      }),
    );
    renderHost();
    expect(await screen.findByRole('alert')).toHaveTextContent('视频导入失败，请重试。');
    expect(screen.getByRole('button', { name: '创建空白项目' })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('MotionCreateHost — C6 frame renderer availability', () => {
  it('disables the one-step film with its reason and keeps the storyboard path', async () => {
    vi.mocked(fetchMoviePreviewCapability).mockResolvedValue({ available: false, renderer: null });
    vi.mocked(createProject).mockImplementationOnce(() => new Promise(() => {}));
    act(() => openMotionCreate({ target: { kind: 'new-project' }, brief: 'A launch film', source: 'home-chip' }));
    renderHost();
    const reason = '需要桌面版或配置本地预览浏览器才能一句话生成影片';
    await waitFor(() => expect(screen.getByRole('button', { name: '一句话生成影片' })).toHaveAttribute('aria-disabled', 'true'));
    expect(screen.getByTestId('motion-create-produce-hint')).toHaveTextContent(reason);
    fireEvent.click(screen.getByRole('button', { name: '一句话生成影片' }));
    expect(createProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '先看分镜' }));
    expect(createProject).toHaveBeenCalledTimes(1);
  });

  it('keeps the one-step film when availability is unknown', async () => {
    vi.mocked(fetchMoviePreviewCapability).mockResolvedValue(null);
    act(() => openMotionCreate({ target: { kind: 'new-project' }, brief: 'A launch film', source: 'home-chip' }));
    renderHost();
    await waitFor(() => expect(fetchMoviePreviewCapability).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: '一句话生成影片' })).not.toHaveAttribute('aria-disabled');
    expect(screen.getByTestId('motion-create-produce-hint')).toHaveTextContent('自动完成分镜、样张和出片，完成后由你审片。');
  });
});

describe('MotionCreateHost + MotionCreatePanel (ported creation flows)', () => {
  it('creates a neutral blank project for original scene design instead of carrying the selected sample', async () => {
    vi.mocked(createProject).mockResolvedValueOnce({ project: { id: 'original' }, conversationId: 'c' } as Awaited<
      ReturnType<typeof createProject>
    >);
    vi.mocked(movieRequest).mockResolvedValue({ ...createMovieDocument('Original', 'blank'), revision: 1 });
    act(() =>
      openMotionCreate({
        target: { kind: 'new-project' },
        brief: 'A tiny music box assembles itself',
        designSystemId: null,
        source: 'home-chip',
      }),
    );
    const { onProjectsChanged } = renderHost();
    fireEvent.click(await screen.findByRole('radio', { name: '从空白开始' }));
    expect(screen.getByText('镜头与动效由 AI 设计')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '先设计并保存风格' }));
    await waitFor(() =>
      expect(movieRequest).toHaveBeenCalledWith(
        'original',
        undefined,
        expect.objectContaining({
          document: expect.objectContaining({
            startMode: 'blank',
            shots: [],
            style: expect.objectContaining({ id: 'blank', visual: expect.objectContaining({ layers: [] }) }),
          }),
          expectedRevision: 0,
        }),
      ),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        kind: 'project',
        projectId: 'original',
        conversationId: 'c',
        fileName: 'movie-studio.json',
      }),
    );
    expect(onProjectsChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('motion-create-dialog')).toBeNull();
    expect(sessionStorage.getItem('od:auto-send-first:original')).toBe('1');
    expect(sessionStorage.getItem('od:auto-send-prompt:original')).toContain('Original');
  });

  it('authorizes one-pass production only from the explicit generate-film action and not storyboard-first', async () => {
    vi.mocked(createProject).mockResolvedValueOnce({ project: { id: 'one-pass' }, conversationId: 'c' } as Awaited<
      ReturnType<typeof createProject>
    >);
    const doc = { ...createMovieDocument('Garden'), brief: 'A seed grows into a garden', revision: 1 };
    vi.mocked(movieRequest).mockResolvedValue(doc);
    vi.mocked(movieStyleRequest).mockResolvedValue({
      document: {
        ...doc,
        revision: 2,
        production: { id: 'p', status: 'armed', baselineContentRevision: 1, createdAt: new Date().toISOString() },
      },
    });
    act(() =>
      openMotionCreate({ target: { kind: 'new-project' }, brief: 'A seed grows into a garden', designSystemId: null, source: 'home-chip' }),
    );
    renderHost();
    fireEvent.click(await screen.findByRole('button', { name: '一句话生成影片' }));
    await waitFor(() =>
      expect(movieStyleRequest).toHaveBeenCalledWith('one-pass', undefined, 'production/authorize', {
        enabled: true,
        expectedRevision: 1,
      }),
    );
    expect(vi.mocked(createProject).mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(movieRequest).mock.invocationCallOrder[0]!);
    expect(vi.mocked(movieRequest).mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(movieStyleRequest).mock.invocationCallOrder[0]!);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'one-pass', fileName: 'movie-studio.json' })));
    expect(sessionStorage.getItem('od:auto-send-first:one-pass')).toBe('1');
    expect(sessionStorage.getItem('od:auto-send-prompt:one-pass')).toContain('A seed grows into a garden');
  });

  it('does not grant production for the storyboard-first path and keeps film style independent of web design systems', async () => {
    vi.mocked(createProject).mockResolvedValueOnce({ project: { id: 'storyboard' }, conversationId: 'c' } as Awaited<
      ReturnType<typeof createProject>
    >);
    vi.mocked(movieRequest).mockResolvedValue({ ...createMovieDocument('Plan'), brief: 'A six second film', revision: 1 });
    act(() => openMotionCreate({ target: { kind: 'new-project' }, brief: 'A six second film', source: 'home-chip' }));
    renderHost();
    fireEvent.click(await screen.findByRole('button', { name: '先看分镜' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(createProject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        designSystemId: null,
        skillId: 'fantay-movie',
        metadata: { kind: 'video', intent: 'motion-design', videoModel: 'hyperframes-html' },
      }),
    );
    expect(movieStyleRequest).not.toHaveBeenCalled();
  });

  it('keeps the user where they are when an earlier create finishes after the dialog closed and persists draft', async () => {
    let resolveCreate!: (value: Awaited<ReturnType<typeof createProject>>) => void;
    vi.mocked(createProject).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    act(() => openMotionCreate({ target: { kind: 'new-project' }, source: 'home-chip' }));
    renderHost();
    fireEvent.change(await screen.findByLabelText('创作想法'), { target: { value: 'Kept for later' } });
    fireEvent.click(screen.getByRole('button', { name: '一句话生成影片' }));
    expect(createProject).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByTestId('motion-create-dialog')).toBeNull());
    await act(async () => {
      resolveCreate({ project: { id: 'project-a' }, conversationId: 'a' } as Awaited<ReturnType<typeof createProject>>);
    });
    expect(movieRequest).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    act(() => openMotionCreate({ target: { kind: 'new-project' }, source: 'home-chip' }));
    expect(await screen.findByLabelText('创作想法')).toHaveValue('Kept for later');
  });

  it('imports selected footage before granting one-pass production, with the picker shown instead of the modal', async () => {
    vi.mocked(createProject).mockResolvedValueOnce({ project: { id: 'video-project' }, conversationId: 'c' } as Awaited<
      ReturnType<typeof createProject>
    >);
    const doc = { ...createMovieDocument('Video', 'blank'), revision: 1 };
    vi.mocked(movieRequest).mockResolvedValue(doc);
    vi.mocked(movieStyleRequest).mockResolvedValue({
      document: { ...doc, revision: 2, style: { ...doc.style, assets: [{ id: 'source', path: 'video-sources/clip.mp4' }] } },
    });
    act(() => openMotionCreate({ target: { kind: 'new-project' }, source: 'home-chip' }));
    renderHost();
    fireEvent.click(await screen.findByRole('radio', { name: '视频剪辑' }));
    expect(screen.getByRole('button', { name: '创建空白项目' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: '从素材库选视频' }));
    await waitFor(() => expect(screen.queryByTestId('motion-create-dialog')).toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: 'Pick test video' }));
    expect(await screen.findByTestId('motion-create-dialog')).toBeInTheDocument();
    expect(screen.getByText('Garden')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('创作想法'), { target: { value: 'Edit a garden film' } });
    fireEvent.click(screen.getByRole('button', { name: '一句话生成影片' }));
    await waitFor(() =>
      expect(movieStyleRequest).toHaveBeenCalledWith('video-project', undefined, 'production/authorize', {
        enabled: true,
        expectedRevision: 2,
      }),
    );
    expect(applyLibraryAsset).toHaveBeenCalledWith('source', 'video-project', 'video-sources', undefined, undefined);
    const calls = vi.mocked(movieStyleRequest).mock.calls;
    expect(calls.findIndex((call) => call[2] === 'sources')).toBeLessThan(calls.findIndex((call) => call[2] === 'production/authorize'));
  });
});

describe('MotionCreatePanel & createMotionProject', () => {
  function panel(patch: Partial<MotionCreatePanelProps> = {}) {
    const draft = initialMotionCreateDraft({ target: { kind: 'new-project' }, source: 'home-chip' }, null);
    const props: MotionCreatePanelProps = {
      variant: 'embedded',
      target: { kind: 'new-project' },
      draft,
      onDraftChange: vi.fn(),
      personalStyles: [],
      designSystems: [{ id: 'ds-1', title: 'Brand kit' }],
      busy: false,
      error: null,
      onSubmit: vi.fn(),
      onChooseVideos: vi.fn(),
      ...patch,
    };
    render(
      <I18nProvider initial="zh-CN">
        <MotionCreatePanel {...props} />
      </I18nProvider>,
    );
    return props;
  }

  it('handles footage removal, busy/error states, task actions, and style-card selection', () => {
    const base = initialMotionCreateDraft({ target: { kind: 'new-project' }, kind: 'footage', source: 'home-chip' }, null);
    const onDraftChange = vi.fn();
    panel({ draft: { ...base, footage: [pickerAsset] }, onDraftChange });
    expect(screen.queryByRole('button', { name: '让 AI 创作新风格' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '移除 Garden' }));
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ footage: [] }));
    cleanup();

    const codeBase = initialMotionCreateDraft({ target: { kind: 'new-project' }, source: 'home-chip' }, null);
    panel({ draft: { ...codeBase, brief: 'Brief' }, busy: true, error: 'Network down' });
    expect(screen.getByRole('alert')).toHaveTextContent('Network down');
    expect(screen.getByRole('button', { name: '正在创建…' })).toBeDisabled();
    cleanup();

    const onSubmit = vi.fn();
    panel({ draft: { ...codeBase, brief: 'Launch teaser' }, onSubmit, onDraftChange });
    fireEvent.click(screen.getByRole('button', { name: '一句话生成影片' }));
    expect(onSubmit).toHaveBeenLastCalledWith('produce');
    fireEvent.click(screen.getByRole('button', { name: '先看分镜' }));
    expect(onSubmit).toHaveBeenLastCalledWith('storyboard');
    fireEvent.click(screen.getByRole('button', { name: '让 AI 创作新风格' }));
    expect(onSubmit).toHaveBeenLastCalledWith('refine-style');
    fireEvent.click(screen.getByRole('button', { name: '纸上电影' }));
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ style: expect.objectContaining({ id: 'editorial' }) }));
  });

  it('creates the film and reuses animation style in step order without linking a legacy web design system', async () => {
    const personal = { ...DEFAULT_MOTION_STYLE, id: 'my-style', name: 'My style', sourceProjectId: 'src-film' };
    const doc = { ...createMovieDocument('Untitled', 'personal', personal), brief: 'A brand teaser', revision: 1 };
    vi.mocked(createProject).mockResolvedValueOnce({ project: { id: 'ordered' }, conversationId: 'c1' } as Awaited<
      ReturnType<typeof createProject>
    >);
    vi.mocked(movieRequest).mockResolvedValueOnce(doc);
    vi.mocked(movieStyleRequest).mockImplementation(
      async (_id, _context, _route, body) =>
        ({ document: { ...doc, revision: Number((body as { expectedRevision: number }).expectedRevision) + 1 } }) as never,
    );
    const draft = {
      ...initialMotionCreateDraft({ target: { kind: 'new-project' }, source: 'home-chip' }, null),
      startMode: 'personal' as const,
      style: personal,
      bindingDesignSystemId: 'ds-1',
      brief: 'A brand teaser',
    };

    const result = await createMotionProject({
      draft,
      task: 'produce',
      target: { kind: 'new-project' },
      defaultDesignSystemId: 'fantay',
      personalStyles: [personal],
      locale: 'en',
      defaultTitles: { film: 'Untitled', style: 'Style' },
    });

    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Untitled', skillId: 'fantay-movie', designSystemId: null }),
    );
    expect(vi.mocked(movieStyleRequest).mock.calls.map(([, , route, body]) => [route, body])).toEqual([
      ['style-link', { kind: 'reuse', sourceProjectId: 'src-film', styleId: 'my-style', expectedRevision: 1 }],
      ['production/authorize', { enabled: true, expectedRevision: 2 }],
    ]);
    expect(result).toMatchObject({ projectId: 'ordered', conversationId: 'c1', existing: false });
  });
});
