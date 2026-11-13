// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// The chrome-free MCP Apps surface `/movie-app[/:id]` (spec 07 §4.4, §11): the film library with static
// covers, opening a film keeps the side chat, back returns to the films, a late read for a film the
// user already left is retired, a film created here goes to its editor with the first AI task for the
// side chat (not the workspace chat), and pre-W3 legacy pages keep their own route family.
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMovieDocument, type MovieDocument } from '@open-design/contracts';

import { SideChatTab } from '../../../src/components/workspace/SideChatTab';
import { autoSendFirstMessageKey, autoSendPromptKey } from '../../../src/fantay/chat/auto-send';
import { MovieEmbeddedApp, resetMovieEmbeddedAppForTests } from '../../../src/fantay/motion/MovieEmbeddedApp';
import { resetMovieDraftCacheForTests } from '../../../src/fantay/motion/movie-draft-cache';
import { I18nProvider } from '../../../src/i18n';
import { movieRequest, movieStyleRequest } from '../../../src/providers/movie';
import { createProject, listConversations } from '../../../src/state/projects';
import type { AgentInfo, AppConfig, Conversation, Project } from '../../../src/types';

vi.mock('../../../src/providers/movie', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/movie')>()),
  movieRequest: vi.fn(),
  movieStyleRequest: vi.fn(),
  fetchMoviePreviewCapability: vi.fn(async () => null),
}));
vi.mock('../../../src/providers/registry', () => ({
  fetchDesignSystems: vi.fn(async () => []),
  libraryAssetRawUrl: (id: string) => `/api/library/assets/${id}/raw`,
}));
vi.mock('../../../src/state/projects', () => ({ createProject: vi.fn(), listConversations: vi.fn() }));
vi.mock('../../../src/components/workspace/SideChatTab', () => ({
  SideChatTab: vi.fn((props: { conversationId: string; promptRequest?: { prompt: string } | null }) => (
    <div data-testid="side-chat" data-conversation={props.conversationId} data-prompt={props.promptRequest?.prompt ?? ''} />
  )),
}));
vi.mock('../../../src/components/movie/MovieConnection', () => ({ MovieConnection: () => null }));
vi.mock('../../../src/components/materials/MaterialPickerDialog', () => ({ MaterialPickerDialog: () => null }));
vi.mock('../../../src/components/movie/MovieVideoPicker', () => ({ MovieVideoPicker: () => null }));

const projects = [
  { id: 'film-1', name: 'Garden film', skillId: 'fantay-movie', metadata: { kind: 'video', intent: 'motion-design' }, updatedAt: 2 },
  { id: 'notes', name: 'Notes', skillId: null, metadata: {}, updatedAt: 3 },
] as unknown as Project[];

function film(title: string, revision = 2): MovieDocument {
  return { ...createMovieDocument(title), revision };
}

function app(onRefresh = vi.fn()) {
  return (
    <I18nProvider initial="zh-CN">
      <MovieEmbeddedApp
        config={{ mode: 'daemon' } as AppConfig}
        agents={[] as AgentInfo[]}
        projects={projects}
        workspaceContext={null}
        executionSwitcher={null}
        onRefresh={onRefresh}
      />
    </I18nProvider>
  );
}

beforeEach(() => {
  vi.mocked(movieRequest).mockReset().mockImplementation(async (id: string) => film(id === 'film-1' ? 'Garden film' : id));
  vi.mocked(movieStyleRequest).mockReset();
  vi.mocked(createProject).mockReset();
  vi.mocked(listConversations).mockReset().mockResolvedValue([{ id: 'c1' } as Conversation]);
  vi.mocked(SideChatTab).mockClear();
});
afterEach(() => {
  cleanup();
  resetMovieEmbeddedAppForTests();
  resetMovieDraftCacheForTests();
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  sessionStorage.clear();
});

describe('MovieEmbeddedApp', () => {
  it('lists the motion projects with static covers and opens one in its editor with the side chat', async () => {
    window.history.replaceState(null, '', '/movie-app');
    render(app());
    expect(screen.getByTestId('movie-embedded-app')).toHaveClass('fx');
    expect(screen.getByRole('tab', { name: '片库' })).toHaveAttribute('data-state', 'active');
    const open = await screen.findByRole('button', { name: 'Garden film' });
    expect(screen.queryByRole('button', { name: 'Notes' })).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByTestId('motion-cover')).toBeInTheDocument();

    fireEvent.click(open);
    await waitFor(() => expect(window.location.pathname).toBe('/movie-app/film-1'));
    expect(await screen.findByLabelText('影片名称')).toHaveValue('Garden film');
    expect(screen.getByRole('tab', { name: '与 AI 对话' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /在工作区打开/ })).toHaveAttribute('href', '/projects/film-1/files/movie-studio.json');

    fireEvent.click(screen.getByRole('button', { name: '返回片库' }));
    await waitFor(() => expect(window.location.pathname).toBe('/movie-app'));
    expect(await screen.findByRole('button', { name: 'Garden film' })).toBeInTheDocument();
  });

  it('retires a deep-link read when the user leaves for the film library', async () => {
    window.history.replaceState(null, '', '/movie-app/loading');
    let finish!: (document: MovieDocument) => void;
    vi.mocked(movieRequest).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    render(app());
    expect(screen.getByTestId('movie-studio')).toHaveAttribute('data-state', 'loading');
    fireEvent.click(screen.getByRole('button', { name: '返回片库' }));
    await waitFor(() => expect(window.location.pathname).toBe('/movie-app'));
    await act(async () => {
      finish(film('Late film'));
    });
    expect(screen.queryByDisplayValue('Late film')).toBeNull();
    expect(screen.getByRole('tab', { name: '片库' })).toBeInTheDocument();
  });

  it('creates a film, opens its editor and hands the first task to the side chat only', async () => {
    window.history.replaceState(null, '', '/movie-app');
    const onRefresh = vi.fn();
    vi.mocked(createProject).mockResolvedValue({ project: { id: 'new-film' }, conversationId: 'c1' } as Awaited<
      ReturnType<typeof createProject>
    >);
    let saved: MovieDocument | null = null;
    vi.mocked(movieRequest).mockImplementation(async (id: string, _context, action) => {
      if (action && 'document' in action) {
        saved = { ...action.document, revision: 1 };
        return saved;
      }
      return id === 'new-film' && saved ? { ...saved, revision: 2 } : film('Garden film', 2);
    });
    vi.mocked(movieStyleRequest).mockImplementation(async () => ({ document: { ...saved!, revision: 2 } }));
    render(app(onRefresh));
    fireEvent.mouseDown(screen.getByRole('tab', { name: '新建影片' }));
    fireEvent.change(await screen.findByLabelText('创作想法'), { target: { value: 'A seed grows into a garden' } });
    fireEvent.click(screen.getByRole('button', { name: '一句话生成影片' }));

    await waitFor(() => expect(window.location.pathname).toBe('/movie-app/new-film'));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(movieStyleRequest).toHaveBeenCalledWith('new-film', undefined, 'production/authorize', { enabled: true, expectedRevision: 1 });
    // The side chat sends it; the workspace chat must not send it again later.
    expect(sessionStorage.getItem(autoSendFirstMessageKey('new-film'))).toBeNull();
    expect(sessionStorage.getItem(autoSendPromptKey('new-film'))).toBeNull();
    await waitFor(() => expect(screen.getByTestId('side-chat').dataset.prompt).toContain('A seed grows into a garden'));
    expect(screen.getByTestId('side-chat')).toHaveAttribute('data-conversation', 'c1');
  });

  it('opens a film from the overview in the main project workspace', async () => {
    window.history.replaceState(null, '', '/movies');
    render(app());
    expect(screen.queryByRole('link', { name: '完整工作区' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Garden film' }));
    await waitFor(() => expect(window.location.pathname).toBe('/projects/film-1/files/movie-studio.json'));
  });
});
