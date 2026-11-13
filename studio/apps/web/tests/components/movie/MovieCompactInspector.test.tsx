// @vitest-environment jsdom
import '../../fantay/helpers/radix-jsdom';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createMovieDocument, type MovieDocument, type MovieEditOperation, type MovieShot, type MovieVideoSource } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { MovieCompactInspector, movieSpeedOperations } from '../../../src/components/movie/MovieCompactInspector';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  const d = createMovieDocument('Test', 'blank');
  d.shots = [{ id: 's', title: 'Footage', body: '', duration: 5.733333333333333, layout: 'split', clip: { assetId: 'a', in: 0, rate: 1, volume: 0.333, fit: 'contain' } }];
  const onApply = vi.fn(async () => true);
  render(<I18nProvider initial="en"><MovieCompactInspector document={d} selectedShotId="s" busy={false} readOnly={false} onApply={onApply} onDirtyChange={() => {}} /></I18nProvider>);
  return onApply;
}
it('shows frame timecodes and preserves exact timing when only the title changes', () => {
  const apply = setup();
  expect(screen.getByLabelText('Duration')).toHaveValue('00:00:05:22');
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
  fireEvent.click(screen.getByRole('button', { name: /^Apply$/ }));
  expect(apply).toHaveBeenCalledWith('Edit clip', [{ op: 'update-shot', shotId: 's', changes: { title: 'Renamed' } }]);
});
it('rejects invalid frames without sending a partial edit', () => {
  const apply = setup();
  fireEvent.change(screen.getByLabelText('Duration'), { target: { value: '00:00:05:30' } });
  fireEvent.click(screen.getByRole('button', { name: /^Apply$/ }));
  expect(apply).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('HH:MM:SS:FF');
});

type Clip = NonNullable<MovieShot['clip']>;

function film(clip: Partial<Clip> = {}): MovieDocument {
  const d = createMovieDocument('Tabs', 'blank');
  d.style.assets = [{ id: 'a', path: 'garden.mp4' }, { id: 'p', path: 'still.png' }];
  d.shots = [
    { id: 'clip', title: 'Garden', body: '', duration: 6, layout: 'split', clip: { assetId: 'a', in: 0, rate: 1, volume: 1, fit: 'contain', fadeIn: 1, ...clip }, captions: [{ id: 'c', start: 2, end: 4, text: 'Hello' }] },
    { id: 'title', kind: 'text', title: 'Hi', body: '', duration: 3, layout: 'title', placement: { start: 0, track: 1 }, visual: { composition: 'minimal', copy: { x: 10, y: 78, width: 80, align: 'center', titleSize: 3.5, bodySize: 2 }, layers: [], transition: 'cut', copyMode: 'caption', foreground: '#FFFFFF' } },
    { id: 'music', title: 'Music', body: '', duration: 4, layout: 'split', placement: { start: 0, track: 2 }, clip: { assetId: 'a', in: 0, rate: 1, volume: 1, fit: 'contain', audioOnly: true } },
    { id: 'still', title: 'Still', body: '', duration: 2, layout: 'split', placement: { start: 0, track: 3 }, clip: { assetId: 'p', in: 0, rate: 1, volume: 1, fit: 'contain' } },
  ];
  return d;
}

type InspectorProps = ComponentProps<typeof MovieCompactInspector>;

function renderTabs(selectedShotId?: string, props: Partial<InspectorProps> = {}) {
  const onApply = vi.fn(async (_label: string, _operations: MovieEditOperation[]) => true);
  const view = (next: Partial<InspectorProps>) => (
    <I18nProvider initial="en">
      <MovieCompactInspector layout="tabs" document={film()} selectedShotId={selectedShotId} busy={false} readOnly={false} onApply={onApply} onDirtyChange={() => {}} onProjectSettings={() => {}} {...props} {...next} />
    </I18nProvider>
  );
  const rendered = render(view({}));
  return { apply: onApply, rerender: (next: Partial<InspectorProps>) => rendered.rerender(view(next)) };
}

const tabNames = () => screen.getAllByRole('tab').map(tab => tab.textContent);

it('shows 全片设置, not the first clip, when nothing is selected, and drills into its pages', () => {
  renderTabs();
  expect(screen.queryAllByRole('tab')).toEqual([]);
  expect(screen.getByRole('heading', { name: 'Project settings' })).toBeTruthy();
  expect(screen.getByText(/· 4 clips ·/)).toHaveTextContent('1920×1080');
  expect(screen.queryByLabelText('Name')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /^Canvas/ }));
  expect(screen.getByRole('radiogroup', { name: 'Project aspect' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Project' }));
  expect(screen.getByRole('button', { name: /^Canvas/ })).toHaveFocus();
});

it('sets every transition from 全片设置 in one batch', () => {
  const d = createMovieDocument('Film', 'blank');
  d.shots = ['a', 'b'].map(id => ({ id, title: id, body: '', duration: 3, layout: 'split' as const, clip: { assetId: 'a', in: 0, rate: 1, volume: 1, fit: 'contain' as const } }));
  const { apply } = renderTabs(undefined, { document: d });
  fireEvent.click(screen.getByRole('button', { name: /^Transitions/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Crossfade' }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply to all' }));
  expect(apply).toHaveBeenCalledWith('Set all transitions', [
    { op: 'update-shot', shotId: 'a', changes: { visual: expect.objectContaining({ transition: 'crossfade', transitionDuration: 0.45 }) } },
  ]);
});

it('opens export and Jianying drafts from 全片设置', () => {
  const onOpenExport = vi.fn();
  const onOpenJianying = vi.fn();
  renderTabs(undefined, { onOpenExport, onOpenJianying });
  fireEvent.click(screen.getByRole('button', { name: /^Export/ }));
  expect(onOpenExport).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: /^Jianying draft/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Create Jianying draft' }));
  expect(onOpenJianying).toHaveBeenCalledWith('create');
});

it('offers CapCut-style tabs for a video clip and changes speed in one batch from a chip', async () => {
  const { apply } = renderTabs('clip');
  expect(tabNames()).toEqual(['Video', 'Audio', 'Speed', 'Animation', 'Adjust', 'Captions']);
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Speed' }));
  fireEvent.click(await screen.findByRole('radio', { name: '2×' }));
  expect(apply).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledWith('Change speed', [
    { op: 'update-shot', shotId: 'clip', changes: { duration: 3 } },
    { op: 'update-clip', shotId: 'clip', changes: { rate: 2, fadeIn: 0.5 } },
    { op: 'update-caption', shotId: 'clip', captionId: 'c', changes: { start: 1, end: 2 } },
  ]);
});

it('gives each selection type its own tabs', () => {
  const source = (hasAudio: boolean): MovieVideoSource => ({ assetId: 'a', path: 'garden.mp4', label: 'Garden', duration: 6, width: 1920, height: 1080, fps: 30, hasAudio, frames: [] });
  const { rerender } = renderTabs('music');
  expect(tabNames()).toEqual(['Basics', 'Audio', 'Speed']);
  rerender({ selectedShotId: 'still' });
  expect(tabNames()).toEqual(['Video', 'Animation', 'Adjust', 'Captions']);
  rerender({ selectedShotId: 'clip', selectionKind: 'audio' });
  expect(tabNames()).toEqual(['Audio']);
  expect(screen.getByText('Linked to video')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Detach audio' })).toBeTruthy();
  rerender({ selectedShotId: 'clip', selectionKind: 'video', sources: [source(false)] });
  expect(tabNames()).toEqual(['Video', 'Speed', 'Animation', 'Adjust', 'Captions']);
});

it('remembers the last tab per selection type', async () => {
  const { rerender } = renderTabs('clip');
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Adjust' }));
  expect(await screen.findByRole('tab', { name: 'Adjust', selected: true })).toBeTruthy();
  rerender({ selectedShotId: 'title' });
  expect(screen.getByRole('tab', { name: 'Text', selected: true })).toBeTruthy();
  rerender({ selectedShotId: undefined });
  rerender({ selectedShotId: 'clip' });
  expect(screen.getByRole('tab', { name: 'Adjust', selected: true })).toBeTruthy();
});

it('opens a requested tab and focuses the caption cue or section it names', () => {
  const { rerender } = renderTabs('clip', { requested: { tab: 'captions', cueId: 'c', nonce: 1 } });
  expect(screen.getByRole('tab', { name: 'Captions', selected: true })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Caption 1' })).toHaveFocus();
  rerender({ requested: { tab: 'video', section: 'transition', nonce: 2 } });
  expect(screen.getByRole('tab', { name: 'Video', selected: true })).toBeTruthy();
  expect(document.activeElement?.closest('[data-section="transition"]')).not.toBeNull();
});

it('does not replay a settled request when the inspector mounts again', () => {
  const requested = { tab: 'captions' as const, cueId: 'c', nonce: 1 };
  renderTabs('clip', { requested });
  expect(screen.getByRole('tab', { name: 'Captions', selected: true })).toBeTruthy();
  cleanup();
  renderTabs('clip', { requested });
  expect(screen.getByRole('tab', { name: 'Video', selected: true })).toBeTruthy();
});

it('commits a slider once on release instead of on every step', async () => {
  const { apply } = renderTabs('clip');
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Audio' }));
  const volume = await screen.findByRole('slider', { name: 'Volume' });
  fireEvent.change(volume, { target: { value: '80' } });
  fireEvent.change(volume, { target: { value: '40' } });
  expect(screen.getByRole('spinbutton', { name: 'Volume' })).toHaveValue(40);
  expect(apply).not.toHaveBeenCalled();
  fireEvent.pointerUp(volume);
  fireEvent.blur(volume);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledWith('Change volume', [{ op: 'update-clip', shotId: 'clip', changes: { volume: 0.4 } }]);
});

it('mutes from the Audio tab switch', async () => {
  const { apply } = renderTabs('clip');
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Audio' }));
  fireEvent.click(await screen.findByRole('switch', { name: 'Mute' }));
  expect(apply).toHaveBeenCalledWith('Mute', [{ op: 'update-clip', shotId: 'clip', changes: { muted: true } }]);
});

it('keeps the draft flow in the tabs layout behind a sticky apply bar', () => {
  const { apply } = renderTabs('clip');
  expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
  expect(screen.getByText('Unapplied changes')).toBeTruthy();
  expect(screen.getByRole('slider', { name: 'Opacity' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(apply).toHaveBeenCalledWith('Edit clip', [{ op: 'update-shot', shotId: 'clip', changes: { title: 'Renamed' } }]);
});

it('keys a pose row at the playhead from its ◇ and removes it again', () => {
  const { apply, rerender } = renderTabs('clip', { time: 3 });
  fireEvent.click(screen.getByRole('button', { name: 'Position keyframe' }));
  expect(apply).toHaveBeenLastCalledWith('Add keyframe', [{ op: 'update-clip', shotId: 'clip', changes: { keyframes: [{ at: 0.5, x: 0, y: 0 }] } }]);
  rerender({ document: film({ keyframes: [{ at: 0.5, x: 10, y: 20, opacity: 0.5 }] }) });
  const toggle = screen.getByRole('button', { name: 'Position keyframe' });
  expect(toggle).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(toggle);
  expect(apply).toHaveBeenLastCalledWith('Remove keyframe', [{ op: 'update-clip', shotId: 'clip', changes: { keyframes: [{ at: 0.5, opacity: 0.5 }], x: 10, y: 20 } }]);
});

it('auto-keys an animated field instead of disabling it', () => {
  const { apply } = renderTabs('clip', { time: 3, document: film({ keyframes: [{ at: 0, opacity: 0 }, { at: 1, opacity: 1 }] }) });
  const opacity = screen.getByRole('slider', { name: 'Opacity' });
  expect(opacity).not.toBeDisabled();
  expect(screen.getByRole('spinbutton', { name: 'Opacity' })).toHaveValue(50);
  fireEvent.change(opacity, { target: { value: '80' } });
  fireEvent.pointerUp(opacity);
  expect(apply).toHaveBeenCalledWith('Change opacity', [{
    op: 'update-clip',
    shotId: 'clip',
    changes: { keyframes: [{ at: 0, opacity: 0 }, { at: 0.5, opacity: 0.8 }, { at: 1, opacity: 1 }] },
  }]);
});

it('applies quick layouts and section resets as single edits', () => {
  const { apply } = renderTabs('clip', { document: film({ crop: { top: 0.1, right: 0, bottom: 0, left: 0 } }) });
  fireEvent.click(screen.getByRole('button', { name: 'Top right' }));
  expect(apply).toHaveBeenLastCalledWith('Apply layout', [{ op: 'update-clip', shotId: 'clip', changes: { x: 62, y: 4, width: 34, height: 34 } }]);
  expect(screen.getByRole('button', { name: 'Reset position and size' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Reset crop' }));
  expect(apply).toHaveBeenLastCalledWith('Reset crop', [{ op: 'update-clip', shotId: 'clip', changes: { crop: { top: 0, right: 0, bottom: 0, left: 0 } } }]);
});

it('colours a text clip from a swatch', () => {
  const { apply } = renderTabs('title');
  fireEvent.click(within(screen.getByRole('group', { name: 'Text color presets' })).getByRole('button', { name: 'Yellow' }));
  expect(apply).toHaveBeenCalledWith('Change text color', [{ op: 'update-shot', shotId: 'title', changes: { visual: expect.objectContaining({ foreground: '#FFD54A' }) } }]);
});

it('keeps every scaled caption and fade inside the new duration of a speed change', () => {
  const shot: MovieShot = {
    id: 's', title: 'Talk', body: '', duration: 5, layout: 'split',
    clip: { assetId: 'a', in: 0, rate: 1, volume: 1, fit: 'contain', fadeOut: 5 },
    captions: [{ id: 'last', start: 4, end: 5, text: 'Bye' }],
  };
  const operations = movieSpeedOperations(shot, 1.5);
  const duration = (operations[0] as Extract<MovieEditOperation, { op: 'update-shot' }>).changes.duration!;
  expect(duration).toBeCloseTo(10 / 3);
  expect(operations).toContainEqual({ op: 'update-clip', shotId: 's', changes: { rate: 1.5, fadeOut: duration } });
  const caption = operations.find(op => op.op === 'update-caption') as Extract<MovieEditOperation, { op: 'update-caption' }>;
  expect(caption.changes.end).toBe(duration);
  expect(caption.changes.start).toBeLessThan(duration);
});

it('keeps an audio fade set on its own when a picture fade changes', () => {
  const { apply } = renderTabs('clip', { document: film({ audioFadeIn: 2 }) });
  const fadeIn = screen.getByRole('slider', { name: 'Fade in' });
  fireEvent.change(fadeIn, { target: { value: '0.5' } });
  fireEvent.pointerUp(fadeIn);
  expect(apply).toHaveBeenCalledWith('Fade in', [{ op: 'update-clip', shotId: 'clip', changes: { fadeIn: 0.5, audioFadeIn: 2 } }]);
  // A scaled picture fade carries the audio fade too, even when scaling leaves that one unchanged.
  const shot = film({ audioFadeIn: 0 }).shots[0]!;
  expect(movieSpeedOperations(shot, 2)).toContainEqual({ op: 'update-clip', shotId: 'clip', changes: { rate: 2, fadeIn: 0.5, audioFadeIn: 0 } });
});

it('trims the last loop copy to the film end so its fades fit', async () => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
  const d = film();
  d.shots[2]!.clip!.audioFadeOut = 3;
  const { apply } = renderTabs('music', { document: d });
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Audio' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Loop to film end' }));
  expect(apply).toHaveBeenCalledWith('Repeat audio to film end', [
    { op: 'duplicate-clip', shotId: 'music', at: 4, track: 2, newShotId: '00000000-0000-4000-8000-000000000001' },
    { op: 'trim-clip', shotId: '00000000-0000-4000-8000-000000000001', start: 0, end: 2 },
  ]);
});

it('cuts captions at the new end when the duration draft shortens the clip', () => {
  const d = film();
  d.shots[0]!.captions = [{ id: 'c', start: 2, end: 4, text: 'Hello' }, { id: 'late', start: 4, end: 6, text: 'Later' }];
  const { apply } = renderTabs('clip', { document: d });
  fireEvent.change(screen.getByLabelText('Duration'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(apply).toHaveBeenCalledWith('Edit clip', [
    { op: 'update-shot', shotId: 'clip', changes: { duration: 3 } },
    { op: 'update-clip', shotId: 'clip', changes: { fadeIn: 0.5 } },
    { op: 'update-caption', shotId: 'clip', captionId: 'c', changes: { end: 3 } },
    { op: 'remove-caption', shotId: 'clip', captionId: 'late' },
  ]);
});

it('reports dirty only for a real edit, never for a new selection or revision', () => {
  const onDirtyChange = vi.fn();
  const { rerender } = renderTabs('clip', { onDirtyChange });
  rerender({ selectedShotId: 'still' });
  rerender({ selectedShotId: 'still', document: { ...film(), contentRevision: 2 } });
  rerender({ selectedShotId: 'clip' });
  expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
});

it('disables 应用到全部 with a reason past the edit limit instead of splitting it', () => {
  const d = createMovieDocument('Long', 'blank');
  d.shots = Array.from({ length: 101 }, (_, i) => ({ id: `s${i}`, title: `s${i}`, body: '', duration: 1, layout: 'split' as const, clip: { assetId: 'a', in: 0, rate: 1, volume: 1, fit: 'contain' as const } }));
  const { apply } = renderTabs(undefined, { document: d });
  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
  fireEvent.click(screen.getByRole('button', { name: 'B&W' }));
  const button = screen.getByRole('button', { name: 'Apply to all' });
  expect(button).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(button);
  expect(apply).not.toHaveBeenCalled();
});

it('animates a text clip entrance from visual chips', async () => {
  const { apply } = renderTabs('title');
  expect(tabNames()).toEqual(['Text', 'Animation']);
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Animation' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Typewriter' }));
  expect(apply).toHaveBeenCalledWith('Animate text', [{ op: 'update-shot', shotId: 'title', changes: { textAnimation: 'typewriter' } }]);
});
