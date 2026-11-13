// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// MovieStudio as the in-workspace film editor (spec 07 §4.2, §11). The creation flows that used to
// live here moved to tests/fantay/motion/MotionCreatePanel.test.tsx with the create dialog; the
// remaining cases render `presentation="project"` with the main-chat contract instead of routes.
import '../../fantay/helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor, type RenderResult } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMovieDocument, movieAssistPrompt, type MovieDocument } from '@open-design/contracts';

import { MovieStudio, type MovieStudioChat } from '../../../src/components/movie/MovieStudio';
import type { ProjectChatSendResult } from '../../../src/fantay/chat/project-chat-bridge';
import { getMotionCreateRequest, resetMotionCreateForTests } from '../../../src/fantay/motion/motion-create-store';
import { resetMovieDraftCacheForTests } from '../../../src/fantay/motion/movie-draft-cache';
import { I18nProvider } from '../../../src/i18n';
import { MovieRequestError, movieRequest } from '../../../src/providers/movie';
import type { AppConfig } from '../../../src/types';

vi.mock('../../../src/providers/movie', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/movie')>()),
  movieRequest: vi.fn(),
  movieStyleRequest: vi.fn(),
}));
vi.mock('../../../src/providers/registry', () => ({ fetchDesignSystems: vi.fn(async () => []) }));
vi.mock('../../../src/state/projects', () => ({ createProject: vi.fn(), listConversations: vi.fn(async () => []), listProjects: vi.fn(async () => []) }));
vi.mock('../../../src/components/workspace/SideChatTab', () => ({ SideChatTab: () => null }));
vi.mock('../../../src/components/movie/MovieConnection', () => ({ MovieConnection: () => null }));
vi.mock('../../../src/components/materials/MaterialPickerDialog', () => ({ MaterialPickerDialog: () => null }));
vi.mock('../../../src/fantay/motion/MovieEmbeddedApp', () => ({
  MovieEmbeddedApp: () => <div data-testid="movie-embedded-app-stub" />,
}));

function film(revision = 1, patch: Partial<MovieDocument> = {}): MovieDocument {
  return { ...createMovieDocument('Existing title'), revision, ...patch };
}

function mainChat(overrides: Partial<Extract<MovieStudioChat, { mode: 'main' }>> = {}) {
  return {
    mode: 'main' as const,
    busy: false,
    send: vi.fn(async (): Promise<ProjectChatSendResult> => ({ accepted: true })),
    reveal: vi.fn(),
    ...overrides,
  };
}

function editor(props: { chat?: MovieStudioChat; fileVersion?: number; readOnly?: boolean; isActive?: boolean; styleWorkspace?: boolean } = {}) {
  return (
    <I18nProvider initial="zh-CN">
      <MovieStudio
        presentation="project"
        projectId="film-1"
        isActive={props.isActive ?? true}
        chat={props.chat ?? mainChat()}
        fileVersion={props.fileVersion}
        readOnly={props.readOnly}
        styleWorkspace={props.styleWorkspace}
      />
    </I18nProvider>
  );
}

const getCalls = () => vi.mocked(movieRequest).mock.calls.filter((call) => call.length === 2);

beforeEach(() => {
  vi.mocked(movieRequest).mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetMovieDraftCacheForTests();
  resetMotionCreateForTests();
  localStorage.clear();
});

describe('MovieStudio (project editor)', () => {
  it('defers an external version during a live text draft and fetches it after cancel', async () => {
    const doc = film(1);
    vi.mocked(movieRequest).mockResolvedValue(doc);
    const view = render(editor({ fileVersion: 1 }));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '剪辑' }), { button: 0 });
    fireEvent.click(await screen.findByRole('button', { name: '编辑画面文字' }));
    fireEvent.change(await screen.findByLabelText('画面文字内容'), { target: { value: 'Unsaved text' } });
    const before = getCalls().length;
    vi.mocked(movieRequest).mockResolvedValue(film(2, { shots: doc.shots.map((s, i) => i ? s : { ...s, title: 'External checkpoint' }) }));
    view.rerender(editor({ fileVersion: 2 }));
    expect(getCalls()).toHaveLength(before);
    expect(screen.getByLabelText('画面文字内容')).toHaveValue('Unsaved text');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(getCalls()).toHaveLength(before + 1));
    await waitFor(() => expect(view.container.querySelector('[data-testid="movie-preview-frame"] iframe')?.getAttribute('srcdoc')).toContain('External checkpoint'));
  });
  it('defaults to standard export and forwards an explicitly selected FrameVelo mode', async () => {
    const doc = film(5, { storyboardApproved: 1, samplesApproved: 1 });
    vi.mocked(movieRequest).mockResolvedValue(doc);
    render(editor());
    const select = await screen.findByRole('combobox', { name: '导出方式' });
    expect(select).toHaveTextContent('标准导出');
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'FrameVelo 动效加速' }));
    fireEvent.click(screen.getByRole('button', { name: '渲染成片' }));
    await waitFor(() => expect(vi.mocked(movieRequest).mock.calls.some(call => {
      const action = call[2];
      return action && 'action' in action && action.action === 'render' && action.htmlRenderer === 'framevelo';
    })).toBe(true));
  });
  it('has a separate animation style workspace without film-stage or web-design selectors', async () => {
    vi.mocked(movieRequest).mockResolvedValue(film(1));
    render(editor({ styleWorkspace: true }));
    await screen.findByTestId('movie-style-catalog');
    expect(screen.queryByTestId('movie-stage-bar')).toBeNull();
    expect(screen.getByRole('combobox', { name: '风格库' })).toBeTruthy();
    expect(screen.queryByText('关联设计系统')).toBeNull();
    expect(screen.queryByLabelText('影片名称')).toBeNull();
  });
  it('does not replace edits made while a background read is in flight', async () => {
    const request = vi.mocked(movieRequest);
    request.mockResolvedValueOnce(film(1));
    let resolvePoll!: (value: MovieDocument) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => (resolvePoll = resolve)));
    vi.useFakeTimers();
    // The main chat is running, so the editor polls the film every 3.5 s (07 §4.2).
    await act(async () => {
      render(editor({ chat: mainChat({ busy: true }) }));
    });
    expect(screen.getByLabelText('影片名称')).toHaveValue('Existing title');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    fireEvent.change(screen.getByLabelText('影片名称'), { target: { value: 'My unsaved edit' } });
    await act(async () => {
      resolvePoll(film(2, { title: 'Background revision' }));
    });
    expect(screen.getByLabelText('影片名称')).toHaveValue('My unsaved edit');
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
  });

  it('does not poll at idle in the workspace; a new file version refetches once while the film is clean', async () => {
    vi.mocked(movieRequest).mockResolvedValue(film(1));
    vi.useFakeTimers();
    let view!: RenderResult;
    await act(async () => {
      view = render(editor({ fileVersion: 1 }));
    });
    expect(getCalls()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(getCalls()).toHaveLength(1);

    vi.mocked(movieRequest).mockResolvedValue(film(2, { title: 'Agent title' }));
    await act(async () => view.rerender(editor({ fileVersion: 2 })));
    expect(getCalls()).toHaveLength(2);
    expect(screen.getByLabelText('影片名称')).toHaveValue('Agent title');

    fireEvent.change(screen.getByLabelText('影片名称'), { target: { value: 'Mine' } });
    await act(async () => view.rerender(editor({ fileVersion: 3 })));
    expect(getCalls()).toHaveLength(2);
    expect(screen.getByLabelText('影片名称')).toHaveValue('Mine');
  });

  it('keeps unsaved edits across an unmount (tab switch) and restores them with a notice', async () => {
    vi.mocked(movieRequest).mockResolvedValue(film(4));
    const first = render(editor());
    fireEvent.change(await screen.findByLabelText('影片名称'), { target: { value: 'Draft title' } });
    first.unmount();

    render(editor());
    await waitFor(() => expect(screen.getByLabelText('影片名称')).toHaveValue('Draft title'));
    expect(screen.getByText('已恢复未保存的修改')).toBeInTheDocument();
    expect(screen.getByText('有未保存的修改')).toBeInTheDocument();
  });

  it('drops a stashed draft when the film changed in the meantime', async () => {
    vi.mocked(movieRequest).mockResolvedValueOnce(film(4));
    const first = render(editor());
    fireEvent.change(await screen.findByLabelText('影片名称'), { target: { value: 'Stale draft' } });
    first.unmount();

    vi.mocked(movieRequest).mockResolvedValueOnce(film(5, { title: 'Newer revision' }));
    render(editor());
    await waitFor(() => expect(screen.getByLabelText('影片名称')).toHaveValue('Newer revision'));
    expect(screen.queryByText('已恢复未保存的修改')).toBeNull();
  });

  it('sends AI tasks to the main chat with the movie prompt and offers to show the chat', async () => {
    const doc = film(2, { brief: 'A seed grows into a garden' });
    vi.mocked(movieRequest).mockResolvedValue(doc);
    const chat = mainChat();
    render(editor({ chat }));
    fireEvent.click(await screen.findByRole('button', { name: '根据需求生成分镜' }));
    await waitFor(() => expect(chat.send).toHaveBeenCalledWith(movieAssistPrompt(doc, 'storyboard', 'zh-CN')));
    expect(await screen.findByText('已发送到对话，AI 的回复会出现在对话栏')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看对话' }));
    expect(chat.reveal).toHaveBeenCalledOnce();
  });

  it('explains why the chat refused a task', async () => {
    vi.mocked(movieRequest).mockResolvedValue(film(2, { brief: 'A seed grows' }));
    const chat = mainChat({ send: vi.fn(async (): Promise<ProjectChatSendResult> => ({ accepted: false, reason: 'no-chat' })) });
    render(editor({ chat }));
    fireEvent.click(await screen.findByRole('button', { name: '根据需求生成分镜' }));
    expect(await screen.findByText('对话还没准备好，请稍后再试')).toBeInTheDocument();
  });

  it('holds AI actions with the busy reason while a chat run is in flight', async () => {
    vi.mocked(movieRequest).mockResolvedValue(film(2, { brief: 'A seed grows' }));
    const chat = mainChat({ busy: true });
    render(editor({ chat }));
    const generate = await screen.findByRole('button', { name: '根据需求生成分镜' });
    expect(generate).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(generate);
    expect(chat.send).not.toHaveBeenCalled();
    act(() => generate.focus());
    expect((await screen.findByRole('tooltip')).textContent).toContain('AI 正在处理上一条请求');
    expect(screen.getByTestId('movie-ai-status')).toHaveTextContent('AI 正在制作');
  });

  it('offers the create dialog when the project has no film', async () => {
    vi.mocked(movieRequest).mockRejectedValue(new MovieRequestError('no movie', 404, 'MOVIE_NOT_FOUND'));
    render(editor());
    expect(await screen.findByText('这个项目还没有影片')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '创建影片' }));
    expect(getMotionCreateRequest()).toEqual({ target: { kind: 'existing-project', projectId: 'film-1' }, source: 'editor-empty' });
  });

  it('keeps the reload path for other load errors', async () => {
    vi.mocked(movieRequest).mockRejectedValueOnce(new MovieRequestError('daemon offline', 503)).mockResolvedValueOnce(film(1));
    render(editor());
    expect(await screen.findByRole('alert')).toHaveTextContent('daemon offline');
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    await waitFor(() => expect(screen.getByLabelText('影片名称')).toHaveValue('Existing title'));
  });

  it('disables every editing control for a read-only collaborator', async () => {
    vi.mocked(movieRequest).mockResolvedValue(film(2, { brief: 'A seed grows' }));
    render(editor({ readOnly: true }));
    expect(await screen.findByText('只读：你没有编辑此项目的权限')).toBeInTheDocument();
    expect(screen.getByLabelText('影片名称')).toBeDisabled();
    expect(screen.getByRole('button', { name: '根据需求生成分镜' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: '确认分镜，看样张' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: '视频素材' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('names the running production on the storyboard actions it holds', async () => {
    vi.mocked(movieRequest).mockResolvedValue(
      film(3, {
        brief: 'A seed grows',
        production: { id: 'p1', status: 'preparing', createdAt: 'now', baselineContentRevision: 1 },
      }),
    );
    render(editor());
    // The production moved the editor to its samples; the storyboard view stays reachable.
    fireEvent.click(await screen.findByRole('radio', { name: '分镜' }));
    const add = screen.getByRole('button', { name: '添加镜头' });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    act(() => add.focus());
    expect((await screen.findByRole('tooltip')).textContent).toContain('正在检查真实样张');
  });

  it('has no chat of its own in the workspace and one primary action in the stage footer', async () => {
    vi.mocked(movieRequest).mockResolvedValue(film(2, { brief: 'A seed grows' }));
    render(editor());
    await screen.findByLabelText('影片名称');
    expect(screen.queryByRole('tab', { name: '与 AI 对话' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'AI 对话' })).toBeNull();
    const footer = screen.getByTestId('movie-stage-footer');
    expect(footer.querySelectorAll('[data-slot="button"][data-variant="primary"]')).toHaveLength(1);
  });
});

describe('MovieStudio legacy route props (W2 → W3 bridge)', () => {
  const legacy = { config: { mode: 'daemon' } as AppConfig, agents: [], projects: [], executionSwitcher: null, onRefresh: () => {} };

  it('renders nothing while the view is hidden and the embedded app once it shows', () => {
    const view = render(
      <I18nProvider initial="zh-CN">
        <MovieStudio isActive={false} presentation="workspace" {...legacy} />
      </I18nProvider>,
    );
    expect(view.container).toBeEmptyDOMElement();
    expect(movieRequest).not.toHaveBeenCalled();
    view.rerender(
      <I18nProvider initial="zh-CN">
        <MovieStudio isActive presentation="embedded" {...legacy} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('movie-embedded-app-stub')).toBeInTheDocument();
  });
});
