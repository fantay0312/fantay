import { describe, expect, it } from 'vitest';
import { createMovieDocument, type MovieDocument, type MovieShot, type MovieVisual } from '@open-design/contracts';
import {
  MOVIE_CAPTION_STYLE_PRESETS,
  MOVIE_CLIP_ANIMATIONS,
  MOVIE_DEFAULT_CAPTION_STYLE,
  MOVIE_DEFAULT_VISUAL,
  MOVIE_FILTER_PRESETS,
  MOVIE_TEXT_PRESETS,
  MOVIE_TEXT_VISUAL,
  clampTransitionSeconds,
  movieApplyAllBlocked,
  movieCaptionEntries,
  movieCaptionStyleMatch,
  movieCaptionStyleOperations,
  movieCaptionStylePresetFor,
  movieCaptionTargets,
  movieCaptionTextOperations,
  movieClearClipAnimationOperations,
  movieClipAnimationFor,
  movieClipAnimationKeyframes,
  movieClipAnimationOperations,
  movieColorFilter,
  movieFilterMatch,
  movieFilterOperations,
  movieFilterPresetFor,
  movieFilterTargets,
  movieTextAnimationOperations,
  movieTextInsertOperations,
  movieTextTrack,
  movieTransitionOperations,
  movieTransitionReady,
  movieTransitionTargets,
  type MovieVisualShot,
} from '../../../src/components/movie/movie-editor-presets';

const preset = (id: string) => MOVIE_TEXT_PRESETS.find(item => item.id === id)!;

function clip(id: string, duration: number, extra: Partial<MovieShot> = {}, clipExtra: Partial<NonNullable<MovieShot['clip']>> = {}): MovieShot {
  return { id, title: id, body: '', layout: 'split', duration, clip: { assetId: 'source', in: 0, rate: 1, volume: 1, fit: 'contain', ...clipExtra }, ...extra };
}

function film(shots: MovieShot[], visual?: MovieVisual): MovieDocument {
  const d = createMovieDocument('Presets');
  d.style = { ...d.style, visual };
  d.shots = shots;
  return d;
}

describe('text presets', () => {
  it('puts new text above every clip and never above track 7', () => {
    expect(movieTextTrack(film([]))).toBe(1);
    expect(movieTextTrack(film([clip('a', 2, { placement: { start: 0, track: 2 } })]))).toBe(3);
    expect(movieTextTrack(film([clip('a', 2, { placement: { start: 0, track: 7 } })]))).toBe(7);
  });

  it('inserts plain text with insert-text only', () => {
    const d = film([clip('a', 4)]);
    expect(movieTextInsertOperations(d, preset('default'), { text: '默认文字', at: 1.5, newShotId: 'text' })).toEqual([
      { op: 'insert-text', text: '默认文字', at: 1.5, duration: 3, track: 1, newShotId: 'text' },
    ]);
  });

  it('styles a preset in the same batch, spreading the inserted visual', () => {
    const d = film([clip('a', 4, { placement: { start: 0, track: 7 } })]);
    const operations = movieTextInsertOperations(d, preset('headline'), { text: 'Headline', at: -2, newShotId: 'text' });
    expect(operations[0]).toEqual({ op: 'insert-text', text: 'Headline', at: 0, duration: 3, track: 7, newShotId: 'text' });
    expect(operations[1]).toEqual({
      op: 'update-shot',
      shotId: 'text',
      changes: {
        visual: { ...MOVIE_TEXT_VISUAL, copy: preset('headline').copy, foreground: '#FFFFFF' },
        textAnimation: 'rise',
      },
    });
    const visual = (operations[1] as { changes: { visual: MovieVisual } }).changes.visual;
    expect(visual).toMatchObject({ composition: 'minimal', layers: [], copyMode: 'caption', transition: 'cut' });
  });

  it('keeps every preset inside the model limits', () => {
    for (const item of MOVIE_TEXT_PRESETS) {
      expect(item.foreground).toMatch(/^#[0-9a-f]{6}$/i);
      expect(item.copy.titleSize).toBeGreaterThanOrEqual(1);
      expect(item.copy.titleSize).toBeLessThanOrEqual(20);
      expect(item.copy.width).toBeGreaterThanOrEqual(5);
      expect(item.copy.width).toBeLessThanOrEqual(120);
    }
  });

  it('animates text entrance through update-shot', () => {
    expect(movieTextAnimationOperations(clip('t', 3, { kind: 'text' }), 'typewriter')).toEqual([
      { op: 'update-shot', shotId: 't', changes: { textAnimation: 'typewriter' } },
    ]);
  });
});

describe('caption styles', () => {
  const bold = MOVIE_CAPTION_STYLE_PRESETS.find(item => item.id === 'bold')!;

  it('keeps the clip position and everything the preset does not set', () => {
    const styled = clip('a', 4, { captionStyle: { ...MOVIE_DEFAULT_CAPTION_STYLE, y: 60, align: 'left', background: '#112233' } });
    expect(movieCaptionStyleOperations([styled, clip('b', 2)], bold)).toEqual([
      { op: 'update-shot', shotId: 'a', changes: { captionStyle: { ...MOVIE_DEFAULT_CAPTION_STYLE, y: 60, align: 'left', background: '#112233', ...bold.style } } },
      { op: 'update-shot', shotId: 'b', changes: { captionStyle: { ...MOVIE_DEFAULT_CAPTION_STYLE, ...bold.style } } },
    ]);
  });

  it('recognises the preset a style was made by', () => {
    expect(movieCaptionStylePresetFor({ ...MOVIE_DEFAULT_CAPTION_STYLE, ...bold.style, color: '#ffdd55' })?.id).toBe('bold');
    expect(movieCaptionStylePresetFor(MOVIE_DEFAULT_CAPTION_STYLE)).toBeUndefined();
  });

  it('matches a style to the preset it reads as, exact or nearest', () => {
    expect(movieCaptionStyleMatch({ ...MOVIE_DEFAULT_CAPTION_STYLE, ...bold.style })).toEqual({ preset: bold, exact: true });
    expect(movieCaptionStyleMatch({ ...MOVIE_DEFAULT_CAPTION_STYLE, ...bold.style, fontSize: 48, color: '#FFE066' })).toEqual({ preset: bold, exact: false });
    // The default box style is the clean preset at a slightly larger size.
    expect(movieCaptionStyleMatch(MOVIE_DEFAULT_CAPTION_STYLE)?.preset.id).toBe('clean');
    expect(movieCaptionStyleMatch({ ...MOVIE_DEFAULT_CAPTION_STYLE, fontSize: 110, color: '#FF0000', backgroundOpacity: 0, outline: 0 })).toBeUndefined();
  });

  it('edits caption text by id, or rewrites the clip captions for a cue without one', () => {
    const withId = { id: 'c1', start: 0, end: 1, text: 'Hi' };
    expect(movieCaptionTextOperations(clip('a', 2, { captions: [withId] }), withId, 'Hello')).toEqual([
      { op: 'update-caption', shotId: 'a', captionId: 'c1', changes: { text: 'Hello' } },
    ]);
    const legacy = { start: 1, end: 2, text: 'Old' };
    const shot = clip('b', 3, { captions: [withId, legacy] });
    expect(movieCaptionTextOperations(shot, legacy, 'New')).toEqual([
      { op: 'replace-captions', shotId: 'b', captions: [withId, { start: 1, end: 2, text: 'New' }] },
    ]);
  });

  it('applies to all only on unlocked clips that have captions', () => {
    const caption = { id: 'c', start: 0, end: 1, text: 'Hi' };
    const d = film([clip('a', 2, { captions: [caption] }), clip('b', 2), clip('c', 2, { captions: [caption], locked: true }), clip('d', 2, { captions: [] })]);
    expect(movieCaptionTargets(d).map(shot => shot.id)).toEqual(['a']);
  });

  it('lists every caption at its output time in playback order', () => {
    const d = film([
      clip('a', 4, { captions: [{ id: 'a2', start: 2, end: 3, text: 'second' }, { id: 'a1', start: 0, end: 1, text: 'first' }] }),
      clip('b', 2, { placement: { start: 1, track: 1 }, captions: [{ id: 'b1', start: 0.5, end: 1, text: 'overlay' }] }),
    ]);
    expect(movieCaptionEntries(d).map(entry => [entry.caption.text, entry.start, entry.end])).toEqual([
      ['first', 0, 1],
      ['overlay', 1.5, 2],
      ['second', 2, 3],
    ]);
  });
});

describe('transitions', () => {
  it('spreads the clip visual instead of replacing it', () => {
    const own: MovieVisual = { ...MOVIE_DEFAULT_VISUAL, composition: 'poster', background: '#101010', layers: [{ id: 'l', type: 'rect', x: 0, y: 0, width: 10, height: 10, color: 'accent' }] };
    const d = film([clip('a', 3, { visual: own }), clip('b', 3)]);
    expect(movieTransitionOperations(d, [d.shots[0]!], 'wipe', 0.6)).toEqual([
      { op: 'update-shot', shotId: 'a', changes: { visual: { ...own, transition: 'wipe', transitionDuration: 0.6 } } },
    ]);
  });

  it('falls back to the style visual, then the default visual', () => {
    const styleVisual: MovieVisual = { ...MOVIE_DEFAULT_VISUAL, composition: 'editorial' };
    const styled = film([clip('a', 3), clip('b', 3)], styleVisual);
    expect(movieTransitionOperations(styled, [styled.shots[0]!], 'iris', 0.4)[0]).toMatchObject({ changes: { visual: { ...styleVisual, transition: 'iris', transitionDuration: 0.4 } } });
    const bare = film([clip('a', 3), clip('b', 3)]);
    expect(movieTransitionOperations(bare, [bare.shots[0]!], 'crossfade', 0.45)[0]).toMatchObject({ changes: { visual: { ...MOVIE_DEFAULT_VISUAL, transition: 'crossfade', transitionDuration: 0.45 } } });
  });

  it('clamps the duration to 0.05–1.5 s', () => {
    expect(clampTransitionSeconds(3)).toBe(1.5);
    expect(clampTransitionSeconds(0)).toBe(0.05);
    expect(clampTransitionSeconds(Number.NaN)).toBe(0.45);
  });

  it('applies to all only on unlocked picture clips followed by an adjacent clip', () => {
    const d = film([
      clip('a', 2),
      clip('locked', 2, { locked: true }),
      clip('b', 2),
      clip('music', 6, { placement: { start: 0, track: 1 } }, { audioOnly: true }),
      clip('last', 2, { placement: { start: 6, track: 0 } }),
      clip('gap', 2, { placement: { start: 10, track: 0 } }),
    ]);
    expect(movieTransitionTargets(d).map(shot => shot.id)).toEqual(['a', 'b']);
    expect(movieTransitionReady(d, d.shots[0]!)).toBe(true);
    expect(movieTransitionReady(d, d.shots.at(-1)!)).toBe(false);
  });
});

describe('filters', () => {
  it('matches the renderer CSS filter', () => {
    expect(movieColorFilter({ exposure: 1, contrast: 1.2, saturation: 0.5, blur: 10, grayscale: 0.25 }, 0.5)).toBe('brightness(2) contrast(1.2) saturate(0.5) blur(5px) grayscale(0.25)');
  });

  it('keeps every preset inside the model limits and recognises it', () => {
    for (const item of MOVIE_FILTER_PRESETS) {
      expect(item.color.exposure).toBeGreaterThanOrEqual(-3);
      expect(item.color.exposure).toBeLessThanOrEqual(3);
      for (const field of ['contrast', 'saturation'] as const) {
        expect(item.color[field]).toBeGreaterThanOrEqual(0);
        expect(item.color[field]).toBeLessThanOrEqual(3);
      }
      expect(item.color.blur).toBeGreaterThanOrEqual(0);
      expect(item.color.blur).toBeLessThanOrEqual(30);
      expect(item.color.grayscale).toBeGreaterThanOrEqual(0);
      expect(item.color.grayscale).toBeLessThanOrEqual(1);
      expect(movieFilterPresetFor({ ...item.color })?.id).toBe(item.id);
    }
    expect(movieFilterPresetFor({ exposure: 2, contrast: 1, saturation: 1, blur: 0, grayscale: 0 })).toBeUndefined();
  });

  it('matches a hand-tuned colour to the preset it reads as', () => {
    const mono = MOVIE_FILTER_PRESETS.find(item => item.id === 'mono')!;
    expect(movieFilterMatch({ ...mono.color })).toEqual({ preset: mono, exact: true });
    // Saturation no longer shows once the picture is gray, and a little blur or contrast stays close.
    expect(movieFilterMatch({ exposure: 0, contrast: 1, saturation: 0, blur: 2, grayscale: 1 })).toEqual({ preset: mono, exact: false });
    expect(movieFilterMatch({ exposure: 0.05, contrast: 1, saturation: 1, blur: 0, grayscale: 0 })?.preset.id).toBe('original');
    expect(movieFilterMatch({ exposure: 2, contrast: 1, saturation: 1, blur: 12, grayscale: 0 })).toBeUndefined();
  });

  it('writes a copy of the color per clip', () => {
    const color = MOVIE_FILTER_PRESETS[1]!.color;
    const operations = movieFilterOperations([clip('a', 2), clip('b', 2)], color);
    expect(operations).toEqual([
      { op: 'update-clip', shotId: 'a', changes: { color } },
      { op: 'update-clip', shotId: 'b', changes: { color } },
    ]);
    expect((operations[0] as { changes: { color: unknown } }).changes.color).not.toBe(color);
  });

  it('applies to all only on unlocked picture clips', () => {
    const d = film([
      clip('video', 2),
      clip('music', 2, {}, { audioOnly: true }),
      clip('locked', 2, { locked: true }),
      { id: 'text', kind: 'text', title: 'Hi', body: '', layout: 'title', duration: 2 },
    ]);
    expect(movieFilterTargets(d).map(shot => shot.id)).toEqual(['video']);
  });
});

describe('apply to all', () => {
  it('runs up to the edit API limit and gives a reason past it', () => {
    expect(movieApplyAllBlocked(100, true)).toBeUndefined();
    expect(movieApplyAllBlocked(101, true)).toBe('一次最多统一 100 个片段，当前有 101 个');
    expect(movieApplyAllBlocked(101, false)).toMatch(/at most 100 clips/);
  });
});

describe('clip animation', () => {
  const pip = clip('pip', 4, {}, { x: 60, y: 60, width: 30, height: 30 }) as MovieVisualShot;

  it('builds presets from the resting pose, ignoring existing keyframes', () => {
    const animated = { ...pip.clip, keyframes: [{ at: 0, x: 0 }, { at: 1, x: 90 }] };
    expect(movieClipAnimationKeyframes(animated, 'zoom-in')).toEqual([
      { at: 0, x: 60, y: 60, width: 30, height: 30, rotation: 0, opacity: 1 },
      { at: 1, x: 57.75, y: 57.75, width: 34.5, height: 34.5, rotation: 0, opacity: 1 },
    ]);
    expect(movieClipAnimationKeyframes(pip.clip, 'slide-left')[0]).toMatchObject({ at: 0, x: -30 });
    expect(movieClipAnimationKeyframes(pip.clip, 'slide-right')[0]).toMatchObject({ at: 0, x: 100 });
    expect(movieClipAnimationKeyframes(pip.clip, 'fade-out').map(frame => [frame.at, frame.opacity])).toEqual([[0, 1], [0.85, 1], [1, 0]]);
  });

  it('keeps every keyframe inside the model limits', () => {
    const huge = { ...pip.clip, x: -140, width: 380, height: 380 };
    for (const { id } of MOVIE_CLIP_ANIMATIONS) {
      for (const frame of movieClipAnimationKeyframes(huge, id)) {
        expect(frame.width!).toBeLessThanOrEqual(400);
        expect(frame.height!).toBeLessThanOrEqual(400);
        expect(frame.x!).toBeGreaterThanOrEqual(-150);
        expect(frame.y!).toBeGreaterThanOrEqual(-150);
      }
    }
  });

  it('writes keyframes through update-clip and recognises the preset afterwards', () => {
    const [operation] = movieClipAnimationOperations(pip, 'zoom-out');
    expect(operation).toEqual({ op: 'update-clip', shotId: 'pip', changes: { keyframes: movieClipAnimationKeyframes(pip.clip, 'zoom-out') } });
    const keyframes = (operation as { changes: { keyframes: NonNullable<NonNullable<MovieShot['clip']>['keyframes']> } }).changes.keyframes;
    expect(movieClipAnimationFor({ ...pip.clip, keyframes })).toBe('zoom-out');
    expect(movieClipAnimationFor({ ...pip.clip, keyframes: [{ at: 0, x: 1 }, { at: 1, x: 2 }] })).toBeUndefined();
    expect(movieClipAnimationFor(pip.clip)).toBeUndefined();
  });

  it('clears the animation with empty keyframes', () => {
    expect(movieClearClipAnimationOperations(pip)).toEqual([{ op: 'update-clip', shotId: 'pip', changes: { keyframes: [] } }]);
  });
});
