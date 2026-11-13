// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Edit history and the localized shot editor inside the film editor (spec 07 §4.2, §6.3): unapplied
// caption edits hold the rest of the editor and the page, undo/redo run against the saved revision,
// and the selected shot keeps its identity through history.
import '../../fantay/helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMovieDocument } from '@open-design/contracts';

import { MovieStudio } from '../../../src/components/movie/MovieStudio';
import { resetMovieDraftCacheForTests } from '../../../src/fantay/motion/movie-draft-cache';
import { I18nProvider } from '../../../src/i18n';
import { getMovieReviewAssets, movieRequest, movieStyleRequest } from '../../../src/providers/movie';

vi.mock('../../../src/providers/movie', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/movie')>()),
  movieRequest: vi.fn(),
  movieStyleRequest: vi.fn(),
  getMovieReviewAssets: vi.fn(),
}));
vi.mock('../../../src/state/projects', () => ({ listConversations: vi.fn(async () => []) }));
vi.mock('../../../src/components/workspace/SideChatTab', () => ({ SideChatTab: () => null }));
vi.mock('../../../src/components/movie/MovieConnection', () => ({ MovieConnection: () => null }));
vi.mock('../../../src/providers/registry', () => ({ fetchDesignSystems: vi.fn(async () => []) }));
vi.mock('../../../src/fantay/motion/MovieEmbeddedApp', () => ({ MovieEmbeddedApp: () => null }));

function renderEditor() {
  render(
    <I18nProvider initial="zh-CN">
      <MovieStudio
        presentation="project"
        projectId="history"
        isActive
        chat={{ mode: 'main', busy: false, send: vi.fn(async () => ({ accepted: true as const })), reveal: vi.fn() }}
      />
    </I18nProvider>,
  );
}

/** Opens a Radix Select by its accessible name and picks an option. */
function choose(label: string, option: string) {
  fireEvent.keyDown(screen.getByRole('combobox', { name: label }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('option', { name: option }));
}

beforeEach(() => {
  vi.mocked(movieRequest).mockReset();
  vi.mocked(movieStyleRequest).mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetMovieDraftCacheForTests();
  localStorage.clear();
});

it('protects unapplied captions when changing plan views or closing the page', async () => {
  const d = createMovieDocument('Caption draft', 'blank');
  d.shots = [
    { id: 'first', title: 'First', body: '', duration: 3, layout: 'title', captions: [{ id: 'caption', start: 0, end: 2, text: 'Original' }] },
  ];
  vi.mocked(movieRequest).mockResolvedValue(d);
  renderEditor();
  fireEvent.mouseDown(await screen.findByRole('tab', { name: '编辑' }), { button: 0 });
  fireEvent.change(screen.getByLabelText('字幕内容 1'), { target: { value: 'Unsaved caption' } });
  expect(screen.getByRole('radio', { name: '样张' })).toBeDisabled();
  expect(screen.getByRole('tab', { name: '审片' })).toBeDisabled();
  const closing = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(closing);
  expect(closing.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
  expect(screen.getByRole('radio', { name: '样张' })).toBeEnabled();
  const clean = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
});

it('keeps unapplied shot edits when the storyboard or the review would take the panel away', async () => {
  const d = createMovieDocument('Held edits');
  d.brief = 'A seed grows';
  d.shots = [
    { id: 'first', title: 'First', body: '', duration: 3, layout: 'title', captions: [{ id: 'caption', start: 0, end: 2, text: 'Original' }] },
    { id: 'second', title: 'Second', body: '', duration: 3, layout: 'title' },
  ];
  vi.mocked(movieRequest).mockResolvedValue(d);
  renderEditor();
  fireEvent.mouseDown(await screen.findByRole('tab', { name: '编辑' }), { button: 0 });
  fireEvent.change(screen.getByLabelText('字幕内容 1'), { target: { value: 'Pending caption' } });
  // Storyboard actions would switch to 意见 or to another shot: they wait, with the reason.
  const feedback = screen.getByRole('button', { name: /^为镜头 2「/ });
  expect(feedback).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(feedback);
  fireEvent.click(screen.getByRole('button', { name: '镜头意见 2' }));
  fireEvent.click(screen.getByRole('button', { name: '编辑镜头 2' }));
  expect(screen.getByRole('tab', { name: '编辑' })).toHaveAttribute('data-state', 'active');
  expect(screen.getByLabelText('字幕内容 1')).toHaveValue('Pending caption');
  expect(screen.getByRole('combobox', { name: '当前镜头' })).toHaveTextContent('1. First');
});

it('keeps unapplied shot edits when a review chapter is picked', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const d = createMovieDocument('Review hold');
  d.revision = 4;
  d.shots = [
    { id: 'first', title: 'First', body: '', duration: 3, layout: 'title', captions: [{ id: 'caption', start: 0, end: 2, text: 'Original' }] },
    { id: 'second', title: 'Second', body: '', duration: 3, layout: 'title' },
  ];
  d.storyboardApproved = d.contentRevision;
  d.samplesApproved = d.contentRevision;
  d.renders = [
    { id: 'r1', contentRevision: d.contentRevision, status: 'done', createdAt: 'now', sourcePath: 'renders/r1/index.html', file: 'renders/r1/film.mp4', duration: 6 },
  ];
  vi.mocked(movieRequest).mockResolvedValue(d);
  vi.mocked(getMovieReviewAssets).mockResolvedValue({
    renderId: 'r1',
    duration: 6,
    fps: 30,
    thumbnailFile: 'strip.jpg',
    thumbnailCount: 6,
    audio: 'none',
    peaks: [],
    shots: [
      { id: 'first', title: 'First', duration: 3 },
      { id: 'second', title: 'Second', duration: 3 },
    ],
  });
  renderEditor();
  fireEvent.mouseDown(await screen.findByRole('tab', { name: '编辑' }), { button: 0 });
  fireEvent.change(screen.getByLabelText('字幕内容 1'), { target: { value: 'Pending caption' } });
  // A chapter targets its shot for feedback; with edits pending it must not change the edited shot.
  fireEvent.click(await screen.findByRole('button', { name: /^02/ }));
  expect(screen.getByRole('tab', { name: '编辑' })).toHaveAttribute('data-state', 'active');
  expect(screen.getByLabelText('字幕内容 1')).toHaveValue('Pending caption');
  expect(screen.getByRole('combobox', { name: '当前镜头' })).toHaveTextContent('1. First');
});

it('undoes using the saved revision and holds history while a draft is unsaved', async () => {
  const d = {
    ...createMovieDocument('Changed'),
    revision: 2,
    editHistory: { undoCount: 1, redoCount: 0, undoLabel: 'Edit title' },
  };
  vi.mocked(movieRequest).mockResolvedValue(d);
  vi.mocked(movieStyleRequest).mockResolvedValue({
    document: { ...d, title: 'Original', revision: 3, editHistory: { undoCount: 0, redoCount: 1 } },
    receipt: { changes: [] },
  });
  renderEditor();
  fireEvent.click(await screen.findByRole('button', { name: '撤销编辑' }));
  await waitFor(() => expect(movieStyleRequest).toHaveBeenCalledWith('history', undefined, 'history/undo', { expectedRevision: 2 }));
  await waitFor(() => expect(screen.getByLabelText('影片名称')).toHaveValue('Original'));
  const redo = screen.getByRole('button', { name: '重做编辑' });
  expect(redo).not.toHaveAttribute('aria-disabled');
  fireEvent.change(screen.getByLabelText('影片名称'), { target: { value: 'Unsaved' } });
  expect(redo).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(redo);
  expect(movieStyleRequest).toHaveBeenCalledTimes(1);
});

it('keeps the selected shot identity through history reordering and falls back after removal', async () => {
  const d = createMovieDocument('Selection', 'blank');
  d.shots = [
    { id: 'first', title: 'First', body: '', duration: 3, layout: 'title' },
    { id: 'second', title: 'Second', body: '', duration: 3, layout: 'title' },
  ];
  d.editHistory = { undoCount: 1, redoCount: 0 };
  vi.mocked(movieRequest).mockResolvedValue(d);
  vi.mocked(movieStyleRequest)
    .mockResolvedValueOnce({
      document: { ...d, revision: 2, contentRevision: 2, shots: [...d.shots].reverse(), editHistory: { undoCount: 0, redoCount: 1 } },
    })
    .mockResolvedValueOnce({
      document: { ...d, revision: 3, contentRevision: 3, shots: [d.shots[0]!], editHistory: { undoCount: 1, redoCount: 0 } },
    });
  renderEditor();
  fireEvent.mouseDown(await screen.findByRole('tab', { name: '编辑' }), { button: 0 });
  choose('当前镜头', '2. Second');
  expect(screen.getByLabelText('镜头标题')).toHaveValue('Second');
  fireEvent.click(screen.getByRole('button', { name: '撤销编辑' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '重做编辑' })).not.toHaveAttribute('aria-disabled'));
  expect(screen.getByRole('combobox', { name: '当前镜头' })).toHaveTextContent('1. Second');
  expect(screen.getByLabelText('镜头标题')).toHaveValue('Second');
  fireEvent.click(screen.getByRole('button', { name: '重做编辑' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '撤销编辑' })).not.toHaveAttribute('aria-disabled'));
  expect(screen.getByRole('combobox', { name: '当前镜头' })).toHaveTextContent('1. First');
  // The shot draft restarts in an effect after the fallback shot renders, so it settles one commit later.
  await waitFor(() => expect(screen.getByLabelText('镜头标题')).toHaveValue('First'));
});
