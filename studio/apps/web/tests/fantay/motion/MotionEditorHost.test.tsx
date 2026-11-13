// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// The film editor inside the project workspace (spec 07 §4.1, §4.3, §11): no chat of its own, AI tasks
// through the registered project chat with the movie skill, held while a run is in flight, a refetch per
// new file version, "返回画板" only when the workspace listens, read-only collaborators; and the
// registry descriptor W3 adds to FANTAY_FILE_EDITORS.
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMovieDocument, movieAssistPrompt, type MovieDocument, type ProjectFile } from '@open-design/contracts';

import { SideChatTab } from '../../../src/components/workspace/SideChatTab';
import {
  registerProjectChatSender,
  resetProjectChatBridgeForTests,
  type ProjectChatSender,
} from '../../../src/fantay/chat/project-chat-bridge';
import type { FantayFileEditorContext } from '../../../src/fantay/editors/file-editors';
import { motionFileEditor } from '../../../src/fantay/motion/file-editor';
import { MotionEditorHost } from '../../../src/fantay/motion/MotionEditorHost';
import { resetMovieDraftCacheForTests } from '../../../src/fantay/motion/movie-draft-cache';
import {
  resetWorkspaceBusForTests,
  subscribeWorkspaceCommand,
  type WorkspaceCommand,
} from '../../../src/fantay/workspace/workspace-bus';
import { I18nProvider } from '../../../src/i18n';
import { movieRequest } from '../../../src/providers/movie';

vi.mock('../../../src/providers/movie', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/movie')>()),
  movieRequest: vi.fn(),
  movieStyleRequest: vi.fn(),
}));
vi.mock('../../../src/providers/registry', () => ({ fetchDesignSystems: vi.fn(async () => []) }));
vi.mock('../../../src/state/projects', () => ({ createProject: vi.fn(), listConversations: vi.fn(async () => []) }));
vi.mock('../../../src/components/workspace/SideChatTab', () => ({ SideChatTab: vi.fn(() => null) }));
vi.mock('../../../src/components/movie/MovieConnection', () => ({ MovieConnection: () => null }));
vi.mock('../../../src/components/materials/MaterialPickerDialog', () => ({ MaterialPickerDialog: () => null }));
vi.mock('../../../src/fantay/motion/MovieEmbeddedApp', () => ({ MovieEmbeddedApp: () => null }));

const PROJECT = 'film-1';

function file(mtime: number, name = 'movie-studio.json'): ProjectFile {
  return { name, size: 512, mtime, kind: 'code', mime: 'application/json' } as ProjectFile;
}

function context(overrides: Partial<FantayFileEditorContext> = {}): FantayFileEditorContext {
  return { projectId: PROJECT, file: file(1), active: true, runInFlight: false, viewerOnly: false, ...overrides };
}

function host(overrides: Partial<FantayFileEditorContext> = {}) {
  return (
    <I18nProvider initial="zh-CN">
      <MotionEditorHost {...context(overrides)} />
    </I18nProvider>
  );
}

function film(revision = 3, patch: Partial<MovieDocument> = {}): MovieDocument {
  return { ...createMovieDocument('Garden film'), revision, brief: 'A seed grows into a garden', ...patch };
}

const reads = () => vi.mocked(movieRequest).mock.calls.filter((call) => call.length === 2).length;

let sender: ReturnType<typeof vi.fn<ProjectChatSender>>;
let reveal: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  vi.mocked(movieRequest).mockReset().mockResolvedValue(film());
  vi.mocked(SideChatTab).mockClear();
  sender = vi.fn<ProjectChatSender>(async () => true);
  reveal = vi.fn<() => void>();
  registerProjectChatSender(PROJECT, sender, { busy: () => false, reveal });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetProjectChatBridgeForTests();
  resetWorkspaceBusForTests();
  resetMovieDraftCacheForTests();
  localStorage.clear();
});

describe('MotionEditorHost', () => {
  it('renders the film editor without a chat of its own', async () => {
    render(host());
    const editor = screen.getByTestId('motion-editor');
    expect(editor).toHaveClass('fx');
    await screen.findByLabelText('影片名称');
    expect(SideChatTab).not.toHaveBeenCalled();
    expect(screen.queryByRole('tab', { name: '与 AI 对话' })).toBeNull();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['剪辑', '方案', '制作', '审片', '意见', '编辑', '制作设置']);
  });

  it('sends 根据需求生成分镜 to the project chat with the movie skill and the movie prompt', async () => {
    render(host());
    fireEvent.click(await screen.findByRole('button', { name: '根据需求生成分镜' }));
    await waitFor(() => expect(sender).toHaveBeenCalledOnce());
    expect(sender).toHaveBeenCalledWith(movieAssistPrompt(film(), 'storyboard', 'zh-CN'), { skillIds: ['fantay-movie'] });
    fireEvent.click(await screen.findByRole('button', { name: '查看对话' }));
    expect(reveal).toHaveBeenCalledOnce();
  });

  it('holds the AI actions with the busy reason while the chat runs (runInFlight)', async () => {
    render(host({ runInFlight: true }));
    const generate = await screen.findByRole('button', { name: '根据需求生成分镜' });
    expect(generate).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(generate);
    act(() => generate.focus());
    expect((await screen.findByRole('tooltip')).textContent).toContain('AI 正在处理上一条请求');
    expect(sender).not.toHaveBeenCalled();
  });

  it('refetches the film once per new file version', async () => {
    const view = render(host());
    await screen.findByLabelText('影片名称');
    expect(reads()).toBe(1);
    vi.mocked(movieRequest).mockResolvedValue(film(4, { title: 'Edited by the agent' }));
    view.rerender(host({ file: file(2) }));
    await waitFor(() => expect(screen.getByLabelText('影片名称')).toHaveValue('Edited by the agent'));
    expect(reads()).toBe(2);
    view.rerender(host({ file: file(2) }));
    await act(async () => {});
    expect(reads()).toBe(2);
  });

  it('offers 返回画板 only while the workspace handles workspace.view', async () => {
    const first = render(host());
    await screen.findByLabelText('影片名称');
    expect(screen.queryByRole('button', { name: '返回画板' })).toBeNull();
    first.unmount();

    const commands: WorkspaceCommand[] = [];
    subscribeWorkspaceCommand('workspace.view', (command) => {
      commands.push(command);
      return true;
    });
    render(host());
    await screen.findByLabelText('影片名称');
    fireEvent.click(screen.getByRole('button', { name: '返回画板' }));
    expect(commands).toEqual([{ type: 'workspace.view', projectId: PROJECT, view: 'board', focus: { kind: 'motion' } }]);
  });

  it('finds the workspace that subscribes after the editor mounted (parent effects run later)', async () => {
    vi.useFakeTimers();
    await act(async () => {
      render(host());
    });
    subscribeWorkspaceCommand('workspace.view', () => true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole('button', { name: '返回画板' })).toBeInTheDocument();
  });

  it('disables editing for a read-only collaborator', async () => {
    render(host({ viewerOnly: true }));
    expect(await screen.findByText('只读：你没有编辑此项目的权限')).toBeInTheDocument();
    expect(screen.getByLabelText('影片名称')).toBeDisabled();
    expect(screen.getByRole('button', { name: '根据需求生成分镜' })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('motionFileEditor', () => {
  it('matches only the root movie-studio.json and renders the host there', () => {
    expect(motionFileEditor.id).toBe('motion');
    expect(motionFileEditor.matches(file(1))).toBe(true);
    expect(motionFileEditor.matches(file(1, 'clips/movie-studio.json'))).toBe(false);
    expect(motionFileEditor.matches(file(1, 'index.html'))).toBe(false);
    expect(motionFileEditor.matches({ ...file(1), type: 'dir' })).toBe(false);
    render(<I18nProvider initial="zh-CN">{motionFileEditor.render(context())}</I18nProvider>);
    expect(screen.getByTestId('motion-editor')).toBeInTheDocument();
  });
});
