// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Review player, feedback notes and the storyboard grid (spec 07 §6.3) on the Fantay primitives.
import '../../fantay/helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMovieDocument,
  type MovieDocument,
  type MovieNoteTarget,
  type MovieReviewAssets,
  type MovieReviewNote,
} from '@open-design/contracts';

import { MovieReviewNotes } from '../../../src/components/movie/MovieReviewNotes';
import { MovieReviewPlayer } from '../../../src/components/movie/MovieReviewPlayer';
import { MovieStoryboard } from '../../../src/components/movie/MovieStoryboard';
import { I18nProvider } from '../../../src/i18n';
import { getMovieReviewAssets } from '../../../src/providers/movie';

vi.mock('../../../src/providers/movie', () => ({ getMovieReviewAssets: vi.fn() }));

const asset: MovieReviewAssets = {
  renderId: 'v1',
  duration: 10,
  fps: 25,
  thumbnailFile: 'strip.jpg',
  thumbnailCount: 10,
  audio: 'none',
  peaks: [],
  shots: [{ id: 's', title: 'Scene', duration: 10 }],
};
const movieRender = {
  id: 'v1',
  contentRevision: 1,
  status: 'done' as const,
  createdAt: 'now',
  sourcePath: 'source.html',
  file: 'film.mp4',
  duration: 10,
};

function notesFor(d: MovieDocument, props: Partial<Parameters<typeof MovieReviewNotes>[0]> = {}) {
  return (
    <I18nProvider initial="zh-CN">
      <MovieReviewNotes
        document={d}
        target={{ scope: 'time', renderId: 'v1', time: 0 }}
        onTarget={() => {}}
        onFreeze={() => {}}
        onAdd={async () => {}}
        onSubmit={() => {}}
        onResolve={() => {}}
        onLocate={() => {}}
        busy={false}
        aiRunning={false}
        projectId="p"
        onAddMaterial={() => {}}
        {...props}
      />
    </I18nProvider>
  );
}

const openNote = (id: string, text: string): MovieReviewNote => ({ id, renderId: 'v1', scope: 'time', time: 1, text, resolved: false });

beforeEach(() => {
  vi.mocked(getMovieReviewAssets).mockResolvedValue(asset);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.stubGlobal('PointerEvent', MouseEvent);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Review player', () => {
  it('selects a real timeline range and steps with the source frame rate', async () => {
    const selected = vi.fn();
    const time = vi.fn();
    const annotate = vi.fn();
    render(
      <I18nProvider initial="zh-CN">
        <MovieReviewPlayer
          projectId="p"
          render={movieRender}
          notes={[]}
          target={{ scope: 'time', renderId: 'v1', time: 0 }}
          onTarget={selected}
          onTime={time}
          onAnnotate={annotate}
        />
      </I18nProvider>,
    );
    await screen.findByText('无音轨');
    const slider = screen.getByRole('slider', { name: '时间线：点击定位，拖动选择时间段' });
    Object.assign(slider, {
      setPointerCapture: vi.fn(),
      getBoundingClientRect: () => ({ left: 0, width: 100 }),
    });
    fireEvent.pointerDown(slider, { clientX: 20, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 60, pointerId: 1 });
    fireEvent.pointerUp(slider, { clientX: 60, pointerId: 1 });
    expect(selected).toHaveBeenLastCalledWith({ scope: 'range', renderId: 'v1', time: 2, endTime: 6 });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(time).toHaveBeenLastCalledWith(2.04);
    fireEvent.keyDown(slider, { key: 'n' });
    expect(annotate).toHaveBeenCalledOnce();
    expect(screen.getByRole('img', { name: '音频波形' }).querySelectorAll('path')).toHaveLength(1);
  });

  it('keeps the transport on the Fantay controls: frame steps, a round play button, feedback with its key', async () => {
    render(
      <I18nProvider initial="zh-CN">
        <MovieReviewPlayer
          projectId="p"
          render={movieRender}
          notes={[]}
          target={{ scope: 'time', renderId: 'v1', time: 0 }}
          onTarget={() => {}}
          onTime={() => {}}
          onAnnotate={() => {}}
        />
      </I18nProvider>,
    );
    await screen.findByText('无音轨');
    const transport = screen.getByTestId('movie-review-transport');
    for (const name of ['上一帧', '播放', '下一帧', '静音']) {
      expect(transport.querySelector(`[aria-label="${name}"]`)?.getAttribute('data-slot')).toBe('icon-button');
    }
    expect(screen.getByRole('button', { name: '播放' })).toHaveAttribute('data-variant', 'primary');
    expect(screen.getByRole('button', { name: /在这里写意见/ })).toHaveAttribute('aria-keyshortcuts', 'N');
    // Each scene is a chapter chip that targets its shot.
    expect(screen.getByRole('button', { name: /Scene/ })).toHaveAttribute('data-slot', 'chip');
  });

  it('exposes which chapter the feedback targets', async () => {
    const view = (target: MovieNoteTarget) => (
      <I18nProvider initial="zh-CN">
        <MovieReviewPlayer
          projectId="p"
          render={movieRender}
          notes={[]}
          target={target}
          onTarget={() => {}}
          onTime={() => {}}
          onAnnotate={() => {}}
        />
      </I18nProvider>
    );
    const { rerender } = render(view({ scope: 'time', renderId: 'v1', time: 0 }));
    const chapter = await screen.findByRole('button', { name: /Scene/ });
    expect(chapter).toHaveAttribute('aria-pressed', 'false');
    rerender(view({ scope: 'shot', renderId: 'v1', shotId: 's', time: 0, endTime: 10 }));
    expect(screen.getByRole('button', { name: /Scene/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('holds feedback (button, N and the markers) while unapplied shot edits are pending', async () => {
    const annotate = vi.fn();
    render(
      <I18nProvider initial="zh-CN">
        <MovieReviewPlayer
          projectId="p"
          render={movieRender}
          notes={[openNote('n1', 'Too fast')]}
          target={{ scope: 'time', renderId: 'v1', time: 0 }}
          onTarget={() => {}}
          onTime={() => {}}
          onAnnotate={annotate}
          annotateDisabledReason="先保存修改"
        />
      </I18nProvider>,
    );
    await screen.findByText('无音轨');
    const button = screen.getByRole('button', { name: /在这里写意见/ });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole('slider', { name: /时间线/ }), { key: 'n' });
    expect(screen.getByRole('button', { name: /意见 00:01\.00：Too fast/ })).toBeDisabled();
    expect(annotate).not.toHaveBeenCalled();
    act(() => button.focus());
    expect((await screen.findByRole('tooltip')).textContent).toContain('先保存修改');
  });
});

describe('Review notes', () => {
  it('keeps feedback pending until the generated revision is confirmed', () => {
    const d = createMovieDocument();
    d.renders = [movieRender, { ...movieRender, id: 'v2' }];
    d.notes = [
      {
        id: 'n',
        renderId: 'v1',
        scope: 'range',
        time: 1,
        endTime: 2,
        text: 'Change the caption',
        resolved: false,
        addressedRenderId: 'v2',
      },
    ];
    const confirm = vi.fn();
    render(notesFor(d, { target: { scope: 'time', renderId: 'v2', time: 0 }, onResolve: confirm }));
    expect(screen.getByText('Change the caption')).toBeVisible();
    expect(screen.getByText(/已生成，待确认/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '确认已改好' }));
    expect(confirm).toHaveBeenCalledWith(d.notes[0]);
    expect(d.notes[0]!.resolved).toBe(false);
  });

  it('hides the revise action without notes and sends the checked ones', () => {
    const d = createMovieDocument();
    d.renders = [movieRender];
    const empty = render(notesFor(d));
    expect(screen.queryByRole('button', { name: /发给 AI 改并出片/ })).toBeNull();
    expect(screen.getByText('没有待发送的意见')).toBeInTheDocument();
    empty.unmount();

    d.notes = [openNote('a', 'Slower intro'), openNote('b', 'Brighter end')];
    const submit = vi.fn();
    render(notesFor(d, { onSubmit: submit }));
    fireEvent.click(screen.getByRole('checkbox', { name: '发送意见 Brighter end' }));
    const send = screen.getByRole('button', { name: '发给 AI 改并出片（1）' });
    expect(send).toHaveAttribute('data-variant', 'primary');
    fireEvent.click(send);
    expect(submit).toHaveBeenCalledWith(['a']);
  });

  it('switches the feedback scope through the segmented control', () => {
    const d = createMovieDocument();
    d.renders = [movieRender];
    const target = vi.fn();
    render(notesFor(d, { onTarget: target }));
    expect(screen.getByRole('radio', { name: '这一刻' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: '整片' }));
    expect(target).toHaveBeenLastCalledWith({ scope: 'film', renderId: 'v1', time: 0 });
  });

  it('explains the busy revise action instead of a bare disabled bar', async () => {
    const d = createMovieDocument();
    d.renders = [movieRender];
    d.notes = [openNote('a', 'Slower intro')];
    render(notesFor(d, { aiRunning: true }));
    const send = screen.getByRole('button', { name: /正在修改/ });
    expect(send).toHaveAttribute('aria-disabled', 'true');
    act(() => send.focus());
    expect((await screen.findByRole('tooltip')).textContent).toContain('AI 正在处理上一条请求');
  });

  it('names why a note action waits: an empty composer, or read-only access', async () => {
    const d = createMovieDocument();
    d.renders = [movieRender];
    const add = vi.fn(async () => {});
    const editable = render(notesFor(d, { onAdd: add }));
    const addButton = screen.getByRole('button', { name: '添加' });
    expect(addButton).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(addButton);
    expect(add).not.toHaveBeenCalled();
    act(() => addButton.focus());
  expect((await screen.findByRole('tooltip')).textContent).toContain('先写下修改意见');
    fireEvent.change(screen.getByLabelText('修改意见内容'), { target: { value: 'Slower intro' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(add).toHaveBeenCalledWith('Slower intro');
    editable.unmount();

    d.notes = [openNote('a', 'Slower intro')];
    const resolve = vi.fn();
    render(notesFor(d, { readOnly: true, onResolve: resolve }));
    const close = screen.getByRole('button', { name: '关闭' });
    expect(close).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(close);
    expect(resolve).not.toHaveBeenCalled();
    act(() => close.focus());
    expect((await screen.findByRole('tooltip')).textContent).toContain('只读');
  });
});

describe('Storyboard grid', () => {
  it('opens a shot-specific feedback target from a real sample', () => {
    const d = createMovieDocument();
    d.notes = [
      {
        id: 'shot-note',
        renderId: 'v1',
        shotId: d.shots[0]!.id,
        time: 0,
        text: 'Adjust this shot',
        resolved: false,
      },
    ];
    d.stylePreview = { contentRevision: d.contentRevision, assetDigest: 'x', frames: ['frame.png'], times: [2] };
    const selected = vi.fn();
    render(
      <I18nProvider initial="zh-CN">
        <MovieStoryboard document={d} projectId="p" onSelect={selected} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^为镜头 1「/ }));
    expect(selected).toHaveBeenCalledWith(d.shots[0], 0);
    expect(screen.getByRole('img', { name: d.shots[0]!.title })).toHaveAttribute('src', '/api/projects/p/raw/frame.png');
    expect(screen.getByRole('button', { name: '镜头意见 1' })).toHaveTextContent('1');
  });

  it('holds every shot action with its reason while shot edits are pending', () => {
    const d = createMovieDocument();
    const selected = vi.fn();
    const edit = vi.fn();
    render(
      <I18nProvider initial="zh-CN">
        <MovieStoryboard document={d} projectId="p" onSelect={selected} onEdit={edit} lockedReason="先保存修改" />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^为镜头 1「/ }));
    fireEvent.click(screen.getByRole('button', { name: '镜头意见 1' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑镜头 1' }));
    expect(selected).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '编辑镜头 1' })).toHaveAttribute('aria-disabled', 'true');
  });
});
