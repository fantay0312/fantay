// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMovieDocument, type WorkspaceCollabContext } from '@open-design/contracts';

import { MoviePreviewFrame, type MoviePreviewFrameHandle } from '../../../src/fantay/motion/MoviePreviewFrame';

const workspace = { workspaceId: 'ws 1', workspaceMemberId: 'member-2' } as WorkspaceCollabContext;

function documentWithMedia() {
  const doc = createMovieDocument('Preview film');
  doc.shots = doc.shots.map((shot, index) => (index === 0 ? { ...shot, media: 'media/hero shot.png' } : shot));
  return doc;
}

function frameOf(container: HTMLElement): HTMLIFrameElement {
  const frame = container.querySelector('iframe');
  if (!frame) throw new Error('no iframe');
  return frame;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MoviePreviewFrame', () => {
  it('accepts text selection only from its own iframe and a valid unlocked source identity', () => {
    const doc = documentWithMedia(), edit = vi.fn();
    const { container } = render(<MoviePreviewFrame document={doc} title="t" onEditText={edit} />);
    const frame = frameOf(container);
    const data = { type: 'fantay-movie-text', shotId: doc.shots[0]!.id, field: 'title' };
    act(() => window.dispatchEvent(new MessageEvent('message', { source: window, data })));
    expect(edit).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { ...data, shotId: 'missing' } })));
    expect(edit).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data })));
    expect(edit).toHaveBeenCalledWith({ shotId: data.shotId, field: 'title' });
  });
  it('renders a sandboxed srcdoc iframe with project assets and the workspace query', () => {
    const { container } = render(
      <MoviePreviewFrame document={documentWithMedia()} projectId="film 1" workspaceContext={workspace} title="Preview film" />,
    );
    const frame = frameOf(container);
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(frame).toHaveAttribute('tabindex', '-1');
    expect(frame).toHaveAttribute('aria-hidden', 'true');
    expect(frame).toHaveAttribute('title', 'Preview film');
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('/api/projects/film%201/raw/media/hero%20shot.png');
    // `&` is escaped inside the media `src` attribute of the built document.
    expect(srcdoc).toContain('?workspaceId=ws%201&amp;workspaceMemberId=member-2');
    expect(srcdoc).toContain('/api/movie/gsap.js');
    expect(screen.getByTestId('movie-preview-frame')).toHaveAttribute('data-variant', 'fill');
  });

  it('posts exactly the handle messages, re-syncs on load and stays silent on re-render', () => {
    const ref = createRef<MoviePreviewFrameHandle>();
    const doc = documentWithMedia();
    const { container, rerender } = render(<MoviePreviewFrame ref={ref} document={doc} projectId="p" title="t" />);
    const frame = frameOf(container);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');

    act(() => ref.current!.seek(2.5));
    act(() => ref.current!.play({ loop: true }));
    act(() => ref.current!.pause());
    expect(post.mock.calls).toEqual([
      [{ type: 'fantay-movie', action: 'seek', time: 2.5 }, '*'],
      [{ type: 'fantay-movie', action: 'play', loop: true }, '*'],
      [{ type: 'fantay-movie', action: 'pause' }, '*'],
    ]);

    post.mockClear();
    act(() => ref.current!.play());
    expect(post.mock.calls).toEqual([[{ type: 'fantay-movie', action: 'play', loop: false }, '*']]);

    post.mockClear();
    const onReady = vi.fn();
    rerender(<MoviePreviewFrame ref={ref} document={doc} projectId="p" title="t" onReady={onReady} />);
    expect(post).not.toHaveBeenCalled();

    fireEvent.load(frame);
    expect(post.mock.calls).toEqual([
      [{ type: 'fantay-movie', action: 'seek', time: 2.5 }, '*'],
      [{ type: 'fantay-movie', action: 'play', loop: false }, '*'],
    ]);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('keeps the srcdoc for an identical document and rebuilds it for a new one', () => {
    const doc = documentWithMedia();
    const { container, rerender } = render(<MoviePreviewFrame document={doc} title="t" />);
    const before = frameOf(container).getAttribute('srcdoc');
    rerender(<MoviePreviewFrame document={doc} title="t" />);
    expect(frameOf(container).getAttribute('srcdoc')).toBe(before);
    rerender(<MoviePreviewFrame document={{ ...doc, title: 'Renamed' }} title="t" />);
    expect(frameOf(container).getAttribute('srcdoc')).not.toBe(before);
  });

  it('mounts lazily only after the box intersects the viewport', () => {
    let notify: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    const observe = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void, options: { rootMargin?: string }) {
          notify = callback;
          expect(options.rootMargin).toBe('200px');
        }
        observe = observe;
        disconnect() {}
      },
    );
    const { container } = render(<MoviePreviewFrame document={documentWithMedia()} lazy variant="card" title="t" />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByTestId('motion-cover')).toHaveAttribute('data-kind', 'poster');
    expect(observe).toHaveBeenCalledTimes(1);
    act(() => notify!([{ isIntersecting: true }]));
    expect(container.querySelector('iframe')).not.toBeNull();
    act(() => notify!([{ isIntersecting: false }]));
    expect(container.querySelector('iframe')).toBeNull();
  });
});
