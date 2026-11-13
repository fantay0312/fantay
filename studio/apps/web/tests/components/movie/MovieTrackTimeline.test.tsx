// @vitest-environment jsdom
import '../../fantay/helpers/radix-jsdom';
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMovieDocument, type MovieDocument, type MovieShot, type MovieVideoSource } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { MovieEditorLayoutContext, movieClipSpans, type MovieEditorLayout } from '../../../src/components/movie/movie-editor-layout';
import { resetMoviePrefsForTests, setMoviePref } from '../../../src/components/movie/movie-editor-prefs';
import { MOVIE_DEFAULT_VISUAL } from '../../../src/components/movie/movie-editor-presets';
import {
  MovieTrackTimeline,
  TIMELINE_GEOMETRY,
  TIMELINE_ORIGIN,
  TIMELINE_ZOOM,
  buildLanes,
  clipWaveform,
  rulerInterval,
  sliderFromZoom,
  snapEditTime,
  zoomFromSlider,
  type MovieTrackTimelineProps,
} from '../../../src/components/movie/MovieTrackTimeline';

beforeEach(() => {
  window.localStorage.clear();
  resetMoviePrefsForTests();
});
afterEach(cleanup);

function shot(id: string, title: string, start: number, duration: number, track = 0, extra: Partial<MovieShot> = {}): MovieShot {
  return {
    id,
    title,
    body: '',
    duration,
    layout: 'split',
    placement: { start, track },
    clip: { assetId: 'a', in: 0, rate: 1, volume: 1, fit: 'contain' },
    ...extra,
  };
}

const music = (id: string, title: string, start: number, duration: number, track: number) =>
  shot(id, title, start, duration, track, { clip: { assetId: 'm', in: 0, rate: 1, volume: 1, fit: 'contain', audioOnly: true } });

function film(shots: MovieShot[]): MovieDocument {
  const d = createMovieDocument('Test', 'blank');
  d.shots = shots;
  return d;
}

const source = (hasAudio: boolean) =>
  ({ assetId: 'a', label: 'Footage', duration: 10, hasAudio, frames: [], audioPeaks: [0, 0.5, 1] }) as unknown as MovieVideoSource;
const song = { assetId: 'm', label: 'Song', duration: 20, hasAudio: true, kind: 'audio', frames: [], audioPeaks: [0.2, 0.8] } as unknown as MovieVideoSource;

/** Pixel x of a time at the default 38 px/s (jsdom has no layout, so the canvas starts at 0). */
const x = (seconds: number) => TIMELINE_ORIGIN + seconds * TIMELINE_ZOOM.initial;

/** jsdom has no DragEvent, so the pointer position is attached to the generic drop event by hand. */
function dropMedia(target: HTMLElement, clientX: number, clientY: number, assetId = 'a') {
  const event = createEvent.drop(target, { dataTransfer: { getData: () => assetId, types: ['application/x-fantay-source'] } });
  Object.defineProperties(event, { clientX: { value: clientX }, clientY: { value: clientY } });
  fireEvent(target, event);
}

/** Renders at the default 38 px/s (jsdom has no width, so the timeline never auto-fits). */
function renderTimeline(props: Partial<MovieTrackTimelineProps> & { document: MovieDocument }, layout: MovieEditorLayout = 'full') {
  const handlers = {
    onSelect: vi.fn(),
    onSeek: vi.fn(),
    onEdit: vi.fn(async () => true),
    onAddSource: vi.fn(),
    onHoverPreview: vi.fn(),
    onRequestInspector: vi.fn(),
    onOpenInspector: vi.fn(),
  };
  const tree = (current: typeof props) => (
    <I18nProvider initial="en">
      <MovieEditorLayoutContext.Provider value={layout}>
        <MovieTrackTimeline sources={[]} projectId="p" time={0} disabled={false} {...handlers} {...current} />
      </MovieEditorLayoutContext.Provider>
    </I18nProvider>
  );
  const view = render(tree(props));
  const lanes = screen.getByTestId('movie-timeline-lanes');
  /** Re-renders with `next` merged over the first props, keeping the same handlers. */
  const rerender = (next: Partial<MovieTrackTimelineProps>) => view.rerender(tree({ ...props, ...next }));
  return { ...handlers, lanes, scroll: lanes.parentElement!.parentElement!.parentElement!, rerender };
}

it('snaps only within an eight-pixel threshold and stays frame aligned', () => {
  expect(snapEditTime(1.1, [0, 1, 3], 38, true)).toBe(1);
  expect(snapEditTime(1.4, [0, 1, 3], 38, true)).toBeCloseTo(1.4);
  expect(snapEditTime(1.1, [0, 1, 3], 38, false)).toBeCloseTo(1.1);
});

it('does not fabricate waveforms and uses source peaks and volume', () => {
  expect(clipWaveform(undefined, 0, 3, 1)).toBe('');
  const peaks = { duration: 3, audioPeaks: [0, 0.5, 1] } as MovieVideoSource;
  expect(clipWaveform(peaks, 0, 3, 1)).not.toBe(clipWaveform(peaks, 0, 3, 0));
});

it('draws a sound at the pixel of its time on the ruler, whatever window of the clip is drawn', () => {
  // 10 s source, silent except one loud 10 ms bin at 5.00 s.
  const audioPeaks = Array.from({ length: 1000 }, (_, index) => (index === 500 ? 1 : 0));
  const source = { duration: 10, audioPeaks } as MovieVideoSource;
  const loudest = (path: string) => {
    const points = [...path.matchAll(/L([\d.]+),([\d.]+)/g)].map(match => [Number(match[1]), Number(match[2])] as const);
    return points.reduce((best, point) => (point[1] < best[1] ? point : best))[0];
  };
  // Whole clip at 100 px/s: the burst sits at x = 500.
  expect(Math.abs(loudest(clipWaveform(source, 0, 10, 1, { width: 1000, height: 10, baseline: true, pxPerSecond: 100 })) - 500)).toBeLessThanOrEqual(2);
  // A window starting at 4 s (a trimmed head or a scrolled view): the same burst lands at x = 100.
  expect(Math.abs(loudest(clipWaveform(source, 4, 2, 1, { width: 200, height: 10, baseline: true, pxPerSecond: 100 })) - 100)).toBeLessThanOrEqual(2);
  // Silence keeps a 1 px line at the bottom of the row instead of vanishing.
  expect(clipWaveform(source, 0, 2, 1, { width: 200, height: 10, baseline: true, pxPerSecond: 100 })).toContain(',9L');
});

it('labels the ruler at least 64 px apart with even minor ticks between labels', () => {
  for (const scale of [4, 10, 38, 64, 150, 400]) {
    const { major, minor } = rulerInterval(scale);
    expect([1, 2, 5, 10, 15, 30, 60, 120, 300]).toContain(major);
    expect(major * scale).toBeGreaterThanOrEqual(64);
    expect(Number.isInteger(Math.round((major / minor) * 1000) / 1000)).toBe(true);
  }
  expect(rulerInterval(38)).toEqual({ major: 2, minor: 0.5 });
  expect(rulerInterval(400)).toEqual({ major: 1, minor: 0.1 });
});

it('maps the zoom slider logarithmically between 4 and 400 px/s', () => {
  expect(zoomFromSlider(0)).toBeCloseTo(TIMELINE_ZOOM.min);
  expect(zoomFromSlider(50)).toBeCloseTo(40);
  expect(zoomFromSlider(100)).toBeCloseTo(TIMELINE_ZOOM.max);
  expect(zoomFromSlider(-20)).toBe(TIMELINE_ZOOM.min);
  expect(sliderFromZoom(zoomFromSlider(37))).toBeCloseTo(37);
});

it('builds lanes per kind with per-variant heights, audio lanes only for detached audio', () => {
  const spans = movieClipSpans(film([
    shot('v', 'Video', 0, 3),
    shot('t', 'Title', 0, 2, 2, { kind: 'text', clip: undefined }),
    music('m', 'Music', 0, 4, 1),
  ]));
  const full = buildLanes(spans, TIMELINE_GEOMETRY.full, { zh: true, full: true });
  expect(full.map(lane => [lane.name, lane.kind, lane.track, lane.top, lane.height])).toEqual([
    ['字幕', 'caption', 0, 0, 28],
    ['文字', 'text', 2, 28, 32],
    ['V2', 'video', 1, 60, 56],
    ['主轨', 'video', 0, 116, 80],
    ['A1', 'audio', 1, 196, 44],
  ]);

  const pictureOnly = movieClipSpans(film([shot('v', 'Video', 0, 3)]));
  // Both layouts show the empty audio lane, so music always has a visible target.
  expect(buildLanes(pictureOnly, TIMELINE_GEOMETRY.compact, { zh: false, full: false }).map(lane => [lane.key, lane.role])).toEqual([
    ['caption', undefined],
    ['v0', undefined],
    ['audio-drop', 'drop'],
  ]);
  expect(buildLanes(pictureOnly, TIMELINE_GEOMETRY.full, { zh: false, full: true }).map(lane => [lane.key, lane.role])).toEqual([
    ['caption', undefined],
    ['v0', undefined],
    ['audio-drop', 'drop'],
  ]);
  const dragging = buildLanes(pictureOnly, TIMELINE_GEOMETRY.compact, { zh: false, full: false, ghost: 'above' });
  expect(dragging[1]).toMatchObject({ key: 'ghost-above', track: 1, top: 24, height: 20, role: 'ghost' });
  // Sound dragged below the stack lands on the empty audio lane instead of offering a second new track.
  expect(buildLanes(pictureOnly, TIMELINE_GEOMETRY.compact, { zh: false, full: false, ghost: 'below' }).at(-1)).toMatchObject({ key: 'audio-drop', kind: 'audio', track: 1, role: 'drop' });
  const withMusic = movieClipSpans(film([shot('v', 'Video', 0, 3), music('m', 'Music', 0, 4, 1)]));
  expect(buildLanes(withMusic, TIMELINE_GEOMETRY.compact, { zh: false, full: false, ghost: 'below' }).at(-1)).toMatchObject({ key: 'ghost-below', kind: 'audio', track: 2 });
});

it('commits one edit on trim release and cancels without modifying content', () => {
  const { onEdit } = renderTimeline({ document: film([shot('s', 'Footage', 0, 3)]), selectedId: 's' });
  const handle = screen.getByRole('button', { name: 'Trim end Footage' });
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 114 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 76 });
  expect(onEdit).not.toHaveBeenCalled();
  expect(screen.getByText('−0:01.00')).toBeTruthy();
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: 76 });
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit).toHaveBeenCalledWith('Trim clip', [{ op: 'trim-clip', shotId: 's', start: 0, end: 2 }]);
  fireEvent.pointerDown(handle, { pointerId: 2, clientX: 114 });
  fireEvent.pointerMove(handle, { pointerId: 2, clientX: 76 });
  fireEvent.pointerCancel(handle, { pointerId: 2 });
  expect(onEdit).toHaveBeenCalledTimes(1);
});

it('draws linked audio as a band inside the clip that selects as audio and mutes on delete', () => {
  const { onEdit, onSelect } = renderTimeline({ document: film([shot('s', 'Footage', 0, 3)]), sources: [source(true)], selectedId: 's' });
  const band = screen.getByRole('button', { name: 'Audio Footage' });
  expect(band.closest('[data-shot-id="s"]')).toHaveAttribute('data-kind', 'video');
  expect(document.querySelectorAll('[data-lane="audio"]')).toHaveLength(1);
  fireEvent.click(band);
  expect(band).toHaveAttribute('aria-pressed', 'true');
  expect(onSelect).toHaveBeenLastCalledWith('s', 'audio');
  expect(screen.getByRole('button', { name: 'Split at playhead' })).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Delete clip' }));
  expect(onEdit).toHaveBeenCalledWith('Mute clip audio', [{ op: 'update-clip', shotId: 's', changes: { muted: true } }]);
  fireEvent.click(screen.getByRole('radio', { name: 'Waveform' }));
  expect(screen.getByRole('button', { name: 'Audio Footage' })).toHaveAttribute('data-expanded', 'true');
});

it('clears the selection and moves the playhead when the empty track area is clicked', () => {
  const { onSelect, onSeek, lanes } = renderTimeline({ document: film([shot('s', 'Footage', 0, 3)]), selectedId: 's' });
  fireEvent.click(lanes, { clientX: x(2) });
  expect(onSelect).toHaveBeenLastCalledWith(null);
  expect(onSeek).toHaveBeenLastCalledWith(2);
});

it('cuts the clip under the playhead from the toolbar with 主轨磁吸 and leaves the keys to the editor', () => {
  const { onEdit } = renderTimeline({ document: film([shot('a', 'First', 0, 3), shot('b', 'Second', 3, 3), shot('c', 'Third', 6, 2)]), time: 4 });
  fireEvent.click(screen.getByRole('button', { name: 'Split at playhead' }));
  expect(onEdit).toHaveBeenLastCalledWith('Split clip', [{ op: 'split-clip', shotId: 'b', at: 1 }]);
  fireEvent.click(screen.getByRole('button', { name: 'Trim left' }));
  expect(onEdit).toHaveBeenLastCalledWith('Trim left', [
    { op: 'trim-clip', shotId: 'b', start: 1, end: 3 },
    { op: 'move-clip', shotId: 'b', at: 3, track: 0 },
    { op: 'move-clip', shotId: 'c', at: 5, track: 0 },
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Trim right' }));
  expect(onEdit).toHaveBeenLastCalledWith('Trim right', [
    { op: 'trim-clip', shotId: 'b', start: 0, end: 1 },
    { op: 'move-clip', shotId: 'c', at: 4, track: 0 },
  ]);
  const magnet = screen.getByRole('button', { name: 'Main track magnet' });
  expect(magnet).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(magnet);
  expect(magnet).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'Trim left' }));
  expect(onEdit).toHaveBeenLastCalledWith('Trim left', [{ op: 'trim-clip', shotId: 'b', start: 1, end: 3 }]);
  const timeline = screen.getByTestId('movie-track-timeline');
  fireEvent.keyDown(timeline, { key: 'b', ctrlKey: true });
  fireEvent.keyDown(timeline, { key: 'q' });
  expect(onEdit).toHaveBeenCalledTimes(4);
});

it('cuts only the selected clip, and explains why while the playhead is outside it', () => {
  renderTimeline({ document: film([shot('a', 'First', 0, 3), shot('b', 'Second', 3, 3)]), time: 4, selectedId: 'a' });
  expect(screen.getByRole('button', { name: 'Split at playhead' })).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByRole('button', { name: 'Trim left' })).toHaveAttribute('aria-disabled', 'true');
});

it('keeps compact to quick cuts and gives full mode every tool and track header', () => {
  const d = film([shot('a', 'First', 0, 3)]);
  renderTimeline({ document: d }, 'compact');
  for (const name of ['Split at playhead', 'Trim left', 'Trim right', 'Delete clip', 'Main track magnet', 'Snapping', 'Skimming', 'Fit timeline', 'Track options V1']) {
    expect(screen.getByRole('button', { name })).toBeTruthy();
  }
  for (const name of ['Duplicate clip', 'Detach audio', 'Blade tool', 'Lock track V1', 'Mute track A1']) {
    expect(screen.queryByRole('button', { name })).toBeNull();
  }
  cleanup();
  renderTimeline({ document: d }, 'full');
  for (const name of ['Blade tool', 'Ripple delete', 'Duplicate clip', 'Detach audio', 'Lock clip', 'Mute clip', 'Fit timeline', 'Main track magnet', 'Snapping', 'Skimming', 'Lock track V1']) {
    expect(screen.getByRole('button', { name })).toBeTruthy();
  }
  // The empty A1 drop lane is a placeholder: nothing on it to lock or mute.
  expect(screen.queryByRole('button', { name: 'Mute track A1' })).toBeNull();
  for (const name of ['Add track', 'Show thumbnails', 'Show waveforms', 'Select tool']) {
    expect(screen.queryByRole('button', { name })).toBeNull();
  }
  expect(screen.getByRole('radio', { name: 'Frames' })).toHaveAttribute('aria-checked', 'true');
});

it('locks or mutes a whole track in one batch and reflects the track state', () => {
  const shots = [shot('a', 'A', 0, 2), shot('b', 'B', 2, 2), shot('c', 'C', 0, 2, 1)];
  const { onEdit } = renderTimeline({ document: film(shots), sources: [source(true)] });
  fireEvent.click(screen.getByRole('button', { name: 'Lock track V1' }));
  expect(onEdit).toHaveBeenLastCalledWith('Lock track V1', [
    { op: 'lock-clip', shotId: 'a', locked: true },
    { op: 'lock-clip', shotId: 'b', locked: true },
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Mute track V2' }));
  expect(onEdit).toHaveBeenLastCalledWith('Mute track V2', [{ op: 'update-clip', shotId: 'c', changes: { muted: true } }]);
  fireEvent.click(screen.getByRole('button', { name: 'Mute track V1' }));
  expect(onEdit).toHaveBeenLastCalledWith('Mute original sound', [
    { op: 'update-clip', shotId: 'a', changes: { muted: true } },
    { op: 'update-clip', shotId: 'b', changes: { muted: true } },
  ]);
  expect(onEdit).toHaveBeenCalledTimes(3);
  cleanup();
  renderTimeline({ document: film(shots.map(item => (item.id === 'c' ? item : { ...item, locked: true }))) });
  expect(screen.getByRole('button', { name: 'Lock track V1' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Lock track V2' })).toHaveAttribute('aria-pressed', 'false');
});

it('locks a track from the compact header menu', async () => {
  const { onEdit } = renderTimeline({ document: film([shot('a', 'A', 0, 2)]) }, 'compact');
  fireEvent.keyDown(screen.getByRole('button', { name: 'Track options V1' }), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Lock track' }));
  expect(onEdit).toHaveBeenLastCalledWith('Lock track V1', [{ op: 'lock-clip', shotId: 'a', locked: true }]);
});

it('disables track lock and mute, with the reason, when the batch exceeds the edit limit', async () => {
  const crowded = film(Array.from({ length: 101 }, (_, index) => shot(`s${index}`, `S${index}`, index, 1)));
  const { onEdit } = renderTimeline({ document: crowded, sources: [source(true)] });
  for (const name of ['Lock track V1', 'Mute track V1']) {
    const button = screen.getByRole('button', { name });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button);
  }
  expect(onEdit).not.toHaveBeenCalled();
  cleanup();
  renderTimeline({ document: crowded }, 'compact');
  fireEvent.keyDown(screen.getByRole('button', { name: 'Track options V1' }), { key: 'Enter' });
  const item = await screen.findByRole('menuitem', { name: /^Lock track/ });
  expect(item).toHaveAttribute('aria-disabled', 'true');
  expect(item.textContent).toContain('Too many clips on this track for one edit (limit 100)');
});

it('pins a sequential film in the same batch when locking a clip or a track', () => {
  const sequential = film([shot('a', 'First', 0, 2), shot('b', 'Second', 0, 3)].map(item => ({ ...item, placement: undefined })));
  const { onEdit } = renderTimeline({ document: sequential, selectedId: 'b' });
  fireEvent.click(screen.getByRole('button', { name: 'Lock clip' }));
  expect(onEdit).toHaveBeenLastCalledWith('Lock clip', [
    { op: 'move-clip', shotId: 'a', at: 0, track: 0 },
    { op: 'lock-clip', shotId: 'b', locked: true },
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Lock track V1' }));
  expect(onEdit).toHaveBeenLastCalledWith('Lock track V1', [
    { op: 'move-clip', shotId: 'a', at: 0, track: 0 },
    { op: 'lock-clip', shotId: 'a', locked: true },
    { op: 'lock-clip', shotId: 'b', locked: true },
  ]);
});

it('offers the clip actions on right-click', () => {
  const { onEdit, onSelect } = renderTimeline({ document: film([shot('a', 'First', 0, 3), shot('b', 'Second', 3, 3)]) });
  fireEvent.contextMenu(screen.getByRole('button', { name: /^2\. Second/ }));
  expect(onSelect).toHaveBeenLastCalledWith('b', 'video');
  fireEvent.click(screen.getByRole('menuitem', { name: /^Ripple delete/ }));
  expect(onEdit).toHaveBeenCalledWith('Ripple delete', [{ op: 'remove-shot', shotId: 'b' }]);
});

it('duplicates right after the clip when that stretch is free, else at the film end, and selects the copy', async () => {
  const { onEdit, onSelect } = renderTimeline({ document: film([shot('a', 'First', 0, 3), shot('b', 'Second', 3, 3), shot('c', 'Third', 9, 2)]), selectedId: 'b' });
  fireEvent.click(screen.getByRole('button', { name: 'Duplicate clip' }));
  expect(onEdit).toHaveBeenLastCalledWith('Duplicate clip', [{ op: 'duplicate-clip', shotId: 'b', newShotId: expect.any(String), at: 6, track: 0 }]);
  const copy = (onEdit.mock.lastCall as unknown as [string, Array<{ newShotId: string }>])[1][0]!.newShotId;
  await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(copy, 'video'));
  // From the right-click menu, A's copy would cover B: it goes to the film end instead.
  fireEvent.contextMenu(screen.getByRole('button', { name: /^1\. First/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: /^Duplicate/ }));
  expect(onEdit).toHaveBeenLastCalledWith('Duplicate clip', [{ op: 'duplicate-clip', shotId: 'a', newShotId: expect.any(String), at: 11, track: 0 }]);
});

it('adds text at the pointer on the empty lane under a right-click', () => {
  const { onEdit, lanes } = renderTimeline({ document: film([shot('a', 'Base', 0, 3), shot('o', 'Overlay', 0, 3, 1)]) });
  const geometry = TIMELINE_GEOMETRY.full;
  fireEvent.contextMenu(lanes, { clientX: x(5), clientY: geometry.caption + 10 });
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add text here' }));
  expect(onEdit).toHaveBeenLastCalledWith('Add text', [
    { op: 'insert-text', text: 'Your text', at: 5, duration: 3, track: 1, newShotId: expect.any(String) },
  ]);
});

it('opens the inspector from caption chips, transition badges and double-clicks', () => {
  const crossfade = { ...MOVIE_DEFAULT_VISUAL, transition: 'crossfade' as const, transitionDuration: 0.5 };
  const shots = [
    shot('a', 'First', 0, 3, 0, { visual: crossfade, captions: [{ id: 'c1', start: 0.5, end: 1.5, text: 'Hello' }] }),
    shot('b', 'Second', 3, 3),
    shot('c', 'Third', 6, 3),
  ];
  const { onSelect, onSeek, onRequestInspector, onOpenInspector } = renderTimeline({ document: film(shots) });
  fireEvent.click(screen.getByRole('button', { name: 'Hello' }));
  expect(onSelect).toHaveBeenLastCalledWith('a', 'video');
  expect(onSeek).toHaveBeenLastCalledWith(0.5);
  expect(onRequestInspector).toHaveBeenLastCalledWith({ tab: 'captions', cueId: 'c1' });
  fireEvent.click(screen.getByRole('button', { name: 'Add transition after Second' }));
  expect(onSelect).toHaveBeenLastCalledWith('b', 'video');
  fireEvent.click(screen.getByRole('button', { name: 'Transition after First' }));
  expect(onSelect).toHaveBeenLastCalledWith('a', 'video');
  expect(onRequestInspector).toHaveBeenLastCalledWith({ tab: 'video', section: 'transition' });
  fireEvent.doubleClick(screen.getByRole('button', { name: /^3\. Third/ }));
  expect(onOpenInspector).toHaveBeenCalledTimes(1);
});

it('marks keyframes on the selected clip and seeks to one on click', () => {
  const animated = shot('a', 'First', 1, 4, 0, { clip: { assetId: 'a', in: 0, rate: 1.5, volume: 1, fit: 'contain', keyframes: [{ at: 0, x: 0 }, { at: 0.5, x: 20 }] } });
  const { onSeek } = renderTimeline({ document: film([animated]), selectedId: 'a', time: 3 });
  const keys = screen.getAllByRole('button', { name: /^Keyframe/ });
  expect(keys).toHaveLength(2);
  expect(keys[1]).toHaveAttribute('data-current', 'true');
  fireEvent.click(keys[0]!);
  expect(onSeek).toHaveBeenLastCalledWith(1);
  expect(screen.getByRole('button', { name: /^1\. First/ }).textContent).toContain('1.5×');
});

it('outlines clips changed from outside the editor', () => {
  renderTimeline({ document: film([shot('a', 'First', 0, 3), shot('b', 'Second', 3, 3)]), highlightIds: ['b'] });
  expect(document.querySelector('[data-shot-id="b"]')).toHaveAttribute('data-changed', 'true');
  expect(document.querySelector('[data-shot-id="a"]')).toHaveAttribute('data-changed', 'false');
});

it('previews the hovered frame with 预览轴 only while paused, and restores on leave', async () => {
  setMoviePref('skim', true);
  const d = film([shot('a', 'First', 0, 6)]);
  const { onHoverPreview, lanes, scroll } = renderTimeline({ document: d });
  fireEvent.pointerMove(lanes, { clientX: x(4) });
  await waitFor(() => expect(onHoverPreview).toHaveBeenLastCalledWith(4));
  fireEvent.pointerLeave(scroll);
  await waitFor(() => expect(onHoverPreview).toHaveBeenLastCalledWith(null));
  cleanup();
  const paused = renderTimeline({ document: d, playing: true });
  fireEvent.pointerMove(paused.lanes, { clientX: x(4) });
  await new Promise(resolve => requestAnimationFrame(resolve));
  expect(paused.onHoverPreview).not.toHaveBeenCalled();
});

it('zooms with = and -, ⌘+wheel, fits with backslash or ⇧Z, and toggles the blade with B', () => {
  const { scroll } = renderTimeline({ document: film([shot('a', 'First', 0, 3)]) });
  const slider = screen.getByRole('slider', { name: 'Timeline zoom' }) as HTMLInputElement;
  const timeline = screen.getByTestId('movie-track-timeline');
  const start = Number(slider.value);
  expect(start).toBe(Math.round(sliderFromZoom(TIMELINE_ZOOM.initial)));
  fireEvent.keyDown(timeline, { key: '=' });
  expect(Number(slider.value)).toBeGreaterThan(start);
  fireEvent.keyDown(timeline, { key: '-' });
  fireEvent.keyDown(timeline, { key: '-' });
  expect(Number(slider.value)).toBeLessThan(start);
  fireEvent.keyDown(slider, { key: '=' });
  expect(Number(slider.value)).toBeLessThan(start);
  const before = Number(slider.value);
  fireEvent.wheel(scroll, { ctrlKey: true, deltaY: -100 });
  expect(Number(slider.value)).toBeGreaterThan(before);
  fireEvent.keyDown(timeline, { key: '\\' });
  expect(slider.value).toBe('0');
  fireEvent.keyDown(timeline, { key: '=' });
  fireEvent.keyDown(timeline, { key: 'Z', shiftKey: true });
  expect(slider.value).toBe('0');
  const blade = screen.getByRole('button', { name: 'Blade tool' });
  fireEvent.keyDown(timeline, { key: 'b' });
  expect(blade).toHaveAttribute('aria-pressed', 'true');
});

it('keeps a pointer-anchored zoom in place and pages to the playhead only while it plays', () => {
  const { scroll, rerender } = renderTimeline({ document: film([shot('a', 'Long', 0, 120)]) });
  const header = TIMELINE_GEOMETRY.full.header;
  Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: header + 400 });
  scroll.scrollLeft = 1000;
  // The playhead (0 s) is off-screen; ⌘+wheel at 30 s must keep 30 s under the pointer.
  const offset = x(30) - scroll.scrollLeft;
  fireEvent.wheel(scroll, { ctrlKey: true, deltaY: -100, clientX: x(30) });
  const scale = TIMELINE_ZOOM.initial * Math.exp(100 * 0.002);
  expect(scroll.scrollLeft).toBeGreaterThan(1000);
  expect(TIMELINE_ORIGIN + 30 * scale - scroll.scrollLeft).toBeCloseTo(offset);
  const anchored = scroll.scrollLeft;
  rerender({ playing: true });
  expect(scroll.scrollLeft).toBe(anchored);
  rerender({ playing: true, time: 1 });
  expect(scroll.scrollLeft).toBeLessThan(100);
});

it.each(['compact', 'full'] as const)('positions %s lanes from the JS geometry and drops media on the lane under the pointer', layout => {
  const geometry = TIMELINE_GEOMETRY[layout];
  const media = source(false);
  const { onAddSource, lanes } = renderTimeline({ document: film([shot('a', 'Base', 0, 3), shot('o', 'Overlay', 0, 3, 1)]), sources: [media] }, layout);
  const overlay = screen.getByRole('button', { name: /^2\. Overlay/ }).parentElement!;
  const base = screen.getByRole('button', { name: /^1\. Base/ }).parentElement!;
  expect(overlay.style.top).toBe(`${geometry.caption + geometry.inset}px`);
  expect(base.style.top).toBe(`${geometry.caption + geometry.video + geometry.inset}px`);
  expect(base.style.height).toBe(`${geometry.main - 2 * geometry.inset}px`);
  dropMedia(lanes, x(5), geometry.caption + geometry.video + 5);
  expect(onAddSource).toHaveBeenLastCalledWith(media, 2, { start: 5, track: 0 });
  dropMedia(lanes, x(5), geometry.caption + 5);
  expect(onAddSource).toHaveBeenLastCalledWith(media, 2, { start: 5, track: 1 });
  // Above the top video lane (over the caption row) a drop creates a new track.
  dropMedia(lanes, x(5), 2);
  expect(onAddSource).toHaveBeenLastCalledWith(media, 2, { start: 5, track: 2 });
});

it('sends sound to audio lanes and refuses pictures there', () => {
  const media = source(false);
  const compact = renderTimeline({ document: film([shot('a', 'Base', 0, 3)]), sources: [media, song] }, 'compact');
  dropMedia(compact.lanes, x(5), 10, 'm');
  expect(compact.onAddSource).toHaveBeenLastCalledWith(song, 1, { start: 5, track: 1 });
  cleanup();
  const full = renderTimeline({ document: film([shot('a', 'Base', 0, 3)]), sources: [media, song] });
  const dropLane = TIMELINE_GEOMETRY.full.caption + TIMELINE_GEOMETRY.full.main + 5;
  dropMedia(full.lanes, x(5), dropLane, 'a');
  expect(full.onAddSource).not.toHaveBeenCalled();
  dropMedia(full.lanes, x(5), dropLane, 'm');
  expect(full.onAddSource).toHaveBeenLastCalledWith(song, 1, { start: 5, track: 1 });
});

it('moves a clip into a new track when dragged above the video lanes', () => {
  const { onEdit } = renderTimeline({ document: film([shot('a', 'Base', 0, 3)]) });
  const body = screen.getByRole('button', { name: /^1\. Base/ });
  fireEvent.pointerDown(body, { pointerId: 1, clientX: x(1), clientY: 60 });
  fireEvent.pointerMove(body, { pointerId: 1, clientX: x(1), clientY: 4 });
  expect(screen.getAllByText('New track').length).toBeGreaterThan(0);
  fireEvent.pointerUp(body, { pointerId: 1 });
  expect(onEdit).toHaveBeenLastCalledWith('Move clip', [{ op: 'move-clip', shotId: 'a', at: 0, track: 1 }]);
  expect(screen.queryByText('New track')).toBeNull();
});

it('cancels a trim or move on Esc without committing, deselecting or letting the key through', () => {
  const outer = vi.fn();
  document.addEventListener('keydown', outer);
  try {
    const { onEdit, onSelect, onSeek } = renderTimeline({ document: film([shot('s', 'Footage', 0, 3)]), selectedId: 's' });
    const handle = screen.getByRole('button', { name: 'Trim end Footage' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 114 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 76 });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByText('−0:01.00')).toBeNull();
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 76 });

    const body = screen.getByRole('button', { name: /^1\. Footage/ });
    fireEvent.pointerDown(body, { pointerId: 2, clientX: x(1), clientY: 60 });
    fireEvent.pointerMove(body, { pointerId: 2, clientX: x(1), clientY: 4 });
    expect(screen.getAllByText('New track').length).toBeGreaterThan(0);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByText('New track')).toBeNull();
    fireEvent.pointerUp(body, { pointerId: 2 });
    fireEvent.click(body, { detail: 1, clientX: x(1) });

    expect(onEdit).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onSeek).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    // Without a gesture, Esc goes on to the editor (which deselects).
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(outer).toHaveBeenCalledTimes(1);
  } finally {
    document.removeEventListener('keydown', outer);
  }
});

it('selects a clip from the keyboard without moving the playhead or splitting with the blade', () => {
  const { onEdit, onSelect, onSeek } = renderTimeline({ document: film([shot('a', 'First', 0, 3)]), time: 2 });
  const body = screen.getByRole('button', { name: /^1\. First/ });
  fireEvent.click(screen.getByRole('button', { name: 'Blade tool' }));
  fireEvent.click(body, { detail: 0 });
  expect(onSelect).toHaveBeenLastCalledWith('a', 'video');
  expect(onSeek).not.toHaveBeenCalled();
  expect(onEdit).not.toHaveBeenCalled();
  fireEvent.click(body, { detail: 1, clientX: x(1.5) });
  expect(onSeek).toHaveBeenLastCalledWith(1.5);
  expect(onEdit).toHaveBeenLastCalledWith('Split clip', [{ op: 'split-clip', shotId: 'a', at: 1.5 }]);
});

it('marks the ruler so the editor keeps its shortcuts while the ruler has focus', () => {
  renderTimeline({ document: film([shot('a', 'First', 0, 3)]) });
  expect(screen.getByRole('slider', { name: 'Playhead position' })).toHaveAttribute('data-timeline-ruler', '');
});
