// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMovieDocument, MOVIE_DOCUMENT_FILE, type MovieDocument, type MovieRender } from '@open-design/contracts';

import { MotionNode, MotionNodeBody, type MotionNodeProps } from '../../../src/fantay/motion/MotionNode';
import { getMotionCreateRequest, resetMotionCreateForTests } from '../../../src/fantay/motion/motion-create-store';
import { resetMovieStripCacheForTests } from '../../../src/fantay/motion/useMovieStrip';
import { MovieRequestError, getMovieReviewAssets, movieRequest } from '../../../src/providers/movie';

vi.mock('../../../src/providers/movie', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/movie')>()),
  movieRequest: vi.fn(),
  getMovieReviewAssets: vi.fn(),
}));
vi.mock('../../../src/fantay/motion/capture-frame', () => ({
  captureMotionFrame: vi.fn(async () => new File(['png'], 'film.png', { type: 'image/png' })),
  sendFrameToChat: vi.fn(),
}));

function done(id: string, patch: Partial<MovieRender> = {}): MovieRender {
  return {
    id,
    contentRevision: 1,
    status: 'done',
    createdAt: '2026-10-29T00:00:00.000Z',
    sourcePath: `motion-source/movie-${id}/index.html`,
    file: `movie-${id}.mp4`,
    duration: 12,
    ...patch,
  };
}

function film(patch: Partial<MovieDocument> = {}): MovieDocument {
  return { ...createMovieDocument('Launch film'), revision: 4, ...patch };
}

function props(patch: Partial<MotionNodeProps> = {}): MotionNodeProps {
  return {
    nodeId: 'n_movie',
    data: { projectId: 'film-1', path: MOVIE_DOCUMENT_FILE, title: 'Launch film', aspect: '16:9' },
    width: 480,
    height: 314,
    selected: false,
    live: false,
    onOpenEditor: vi.fn(),
    ...patch,
  };
}

async function ready() {
  await waitFor(() => expect(screen.getByTestId('motion-node-status')).not.toHaveTextContent('Loading film'));
}

/** jsdom has no layout: a 0×0 trigger in a 0×0 viewport reads as detached, and the Fantay menus hide
 *  while their trigger is (`hideWhenDetached`), so a test that reads the menu gives the boxes a size. */
function layoutForMenus() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 40, 200, 28));
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1024 });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 768 });
}

beforeEach(() => {
  vi.mocked(movieRequest).mockReset();
  vi.mocked(getMovieReviewAssets).mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetMotionCreateForTests();
  resetMovieStripCacheForTests();
});

describe('MotionNode', () => {
  it('offers to create the film when the project has none', async () => {
    vi.mocked(movieRequest).mockRejectedValue(new MovieRequestError('This project has no movie yet', 404, 'MOVIE_NOT_FOUND'));
    render(<MotionNode {...props()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create film' }));
    expect(screen.getByText('No film yet')).toBeInTheDocument();
    expect(getMotionCreateRequest()).toEqual({
      target: { kind: 'existing-project', projectId: 'film-1' },
      source: 'board-insert',
    });
  });

  it('shows a load error with a retry', async () => {
    vi.mocked(movieRequest).mockRejectedValueOnce(new MovieRequestError('boom', 500)).mockResolvedValue(film());
    render(<MotionNode {...props()} />);
    expect(await screen.findByText('Could not load the film (boom)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('motion-node-status')).toHaveTextContent('Draft · 3 shots'));
    expect(movieRequest).toHaveBeenCalledTimes(2);
  });

  it('shows the status chip and the duration badge of a ready film', async () => {
    vi.mocked(movieRequest).mockResolvedValue(film({ renders: [done('r1')], samplesApproved: 1 }));
    vi.mocked(getMovieReviewAssets).mockReturnValue(new Promise(() => {}));
    render(<MotionNode {...props()} />);
    await ready();
    expect(screen.getByTestId('motion-node-status')).toHaveTextContent('Rendered v1');
    // The badge text is aria-hidden; the visually hidden label names it (no aria-label on a span).
    expect(screen.getByText('Duration 0:12')).toBeInTheDocument();
    expect(screen.getByText('0:12')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('group', { name: 'Film: Launch film' })).toBeInTheDocument();
  });

  it('renders the strip cover without a live slot and scrubs it on hover', async () => {
    vi.mocked(movieRequest).mockResolvedValue(film({ renders: [done('r1')] }));
    vi.mocked(getMovieReviewAssets).mockResolvedValue({
      renderId: 'r1',
      duration: 12,
      fps: 30,
      thumbnailFile: 'movie-review/r1-x/strip.jpg',
      thumbnailCount: 12,
      audio: 'none',
      peaks: [],
      shots: [],
    });
    const { container } = render(<MotionNode {...props()} />);
    await waitFor(() => expect(screen.getByTestId('motion-cover')).toHaveAttribute('data-kind', 'strip'));
    expect(container.querySelector('iframe')).toBeNull();
    const strip = screen.getByTestId('motion-cover').firstElementChild as HTMLElement;
    expect(strip.style.backgroundImage).toContain('/api/projects/film-1/raw/movie-review/r1-x/strip.jpg');
    const atPoster = strip.style.backgroundPosition;

    const stage = screen.getByTestId('motion-node-stage');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 240, height: 135, right: 240, bottom: 135, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(stage, { clientX: 230 });
    expect(strip.style.backgroundPosition).not.toBe(atPoster);
    expect(strip.getAttribute('data-frame')).toBe('11');
  });

  it('mounts the live preview only with a live slot while hovered, and reports live intent', async () => {
    vi.mocked(movieRequest).mockResolvedValue(film());
    const onLiveIntent = vi.fn();
    const { container, rerender } = render(<MotionNode {...props({ onLiveIntent })} />);
    await ready();
    const node = screen.getByTestId('motion-node');
    fireEvent.pointerEnter(node);
    expect(onLiveIntent).toHaveBeenLastCalledWith(true);
    expect(container.querySelector('iframe')).toBeNull();
    rerender(<MotionNode {...props({ onLiveIntent, live: true })} />);
    expect(container.querySelector('iframe')).not.toBeNull();
    fireEvent.pointerLeave(node);
    expect(onLiveIntent).toHaveBeenLastCalledWith(false);
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('pins playback through onPlayingChange and explains a denied live slot', async () => {
    vi.mocked(movieRequest).mockResolvedValue(film());
    const onPlayingChange = vi.fn();
    render(<MotionNode {...props({ onPlayingChange })} />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(onPlayingChange).toHaveBeenLastCalledWith(true);
    const pause = screen.getByRole('button', { name: 'Pause' });
    // live={false} while playing: the play button explains the flip-book fallback
    act(() => pause.focus());
    expect((await screen.findByRole('tooltip')).textContent).toContain('Live preview limit reached');
    fireEvent.click(pause);
    expect(onPlayingChange).toHaveBeenLastCalledWith(false);
  });

  it('moves the scrubber from the keyboard', async () => {
    vi.mocked(movieRequest).mockResolvedValue(film());
    render(<MotionNode {...props()} />);
    await ready();
    const slider = screen.getByRole('slider', { name: 'Preview position' });
    expect(slider).toHaveAttribute('aria-valuemax', '12');
    expect(slider).toHaveAttribute('aria-valuenow', '4.8');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider).toHaveAttribute('aria-valuenow', '4.9');
    fireEvent.keyDown(slider, { key: 'ArrowLeft', shiftKey: true });
    expect(slider).toHaveAttribute('aria-valuenow', '3.9');
    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider).toHaveAttribute('aria-valuenow', '12');
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    expect(slider).toHaveAttribute('aria-valuetext', '0:00 / 0:12');
  });

  it('opens the editor from the Open button and a stage double-click', async () => {
    vi.mocked(movieRequest).mockResolvedValue(film());
    const onOpenEditor = vi.fn();
    render(<MotionNode {...props({ onOpenEditor })} />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.doubleClick(screen.getByTestId('motion-node-stage'));
    expect(onOpenEditor).toHaveBeenCalledTimes(2);
  });

  it('disables capture and render with their reasons until a film can render', async () => {
    layoutForMenus();
    vi.mocked(movieRequest).mockResolvedValue(film());
    render(<MotionNode {...props()} />);
    await ready();
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    const capture = within(menu).getByRole('menuitem', { name: /Capture frame to chat/ });
    expect(capture).toHaveAttribute('data-disabled');
    expect(capture).toHaveTextContent('Render the film to capture frames');
    const renderItem = within(menu).getByRole('menuitem', { name: /Render film/ });
    expect(renderItem).toHaveAttribute('data-disabled');
    expect(renderItem).toHaveTextContent('Confirm the storyboard and samples in the editor first');
    expect(within(menu).queryByRole('menuitem', { name: /Download MP4/ })).toBeNull();
  });

  it('starts a render from the menu once the samples are approved', async () => {
    layoutForMenus();
    const doc = film({ samplesApproved: 1, renders: [done('r1')] });
    vi.mocked(movieRequest).mockResolvedValue(doc);
    vi.mocked(getMovieReviewAssets).mockReturnValue(new Promise(() => {}));
    render(<MotionNode {...props()} />);
    await ready();
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Download MP4/ })).toHaveAttribute(
      'href',
      '/api/projects/film-1/raw/movie-r1.mp4',
    );
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Render film/ }));
    await waitFor(() =>
      expect(movieRequest).toHaveBeenCalledWith('film-1', null, { action: 'render' }, 4),
    );
  });

  it('keeps pointer presses in the footer away from the board', async () => {
    vi.mocked(movieRequest).mockResolvedValue(film());
    const onBoardPointerDown = vi.fn();
    render(
      <div onPointerDown={onBoardPointerDown}>
        <MotionNode {...props()} />
      </div>,
    );
    await ready();
    const footer = screen.getByTestId('motion-node-footer');
    expect(footer).toHaveAttribute('data-board-interactive');
    fireEvent.pointerDown(screen.getByRole('slider'));
    fireEvent.pointerDown(footer);
    expect(onBoardPointerDown).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByTestId('motion-node-stage'));
    expect(onBoardPointerDown).toHaveBeenCalledTimes(1);
  });

  it('reports the title and aspect of the document, never a cover (R5)', async () => {
    vi.mocked(movieRequest).mockResolvedValue(film({ title: 'Renamed film', aspect: '9:16' }));
    const onDataChange = vi.fn();
    render(<MotionNode {...props({ onDataChange, data: { projectId: 'film-1', path: MOVIE_DOCUMENT_FILE, title: 'Old' } })} />);
    await waitFor(() => expect(onDataChange).toHaveBeenCalledWith({ title: 'Renamed film', aspect: '9:16' }));
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('adapts the board extension props (film from `movie`, playback pins the slot)', async () => {
    vi.mocked(movieRequest).mockResolvedValue(film());
    const requestLive = vi.fn();
    const onOpenEditor = vi.fn();
    const { unmount } = render(
      <MotionNodeBody
        projectId="board-project"
        nodeId="n1"
        kind="motion"
        width={480}
        height={314}
        zoom={1}
        selected
        live={false}
        requestLive={requestLive}
        movie={{ projectId: 'film-1', title: 'Launch film', aspect: '16:9' }}
        onOpenEditor={onOpenEditor}
        onDataChange={vi.fn()}
      />,
    );
    await ready();
    expect(movieRequest).toHaveBeenCalledWith('film-1', null);
    expect(screen.getByTestId('motion-node')).toHaveAttribute('data-selected');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(requestLive).toHaveBeenLastCalledWith(true);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });
    expect(onOpenEditor).toHaveBeenCalledTimes(1);
    // unmounting mid-playback releases the pinned slot
    unmount();
    expect(requestLive).toHaveBeenLastCalledWith(false);
  });
});
