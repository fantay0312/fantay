import { describe, expect, it } from 'vitest';
import {
  MOVIE_STYLES,
  buildMovieHtml,
  createMovieDocument,
  movieDuration,
  movieShotStarts,
} from '../src/index.js';
import { movieEditingSkill } from '../src/runtime/movie-editing-skill.js';
import {
  movieLiveFeedbackPrompt,
  movieTextEdit,
  movieTextTargets,
  movieTextValue,
} from '../src/runtime/movie-live.js';

describe('movieEditingSkill', () => {
  it('exports reusable timing and framing without pinning edits to old project IDs', () => {
    const d = createMovieDocument('Reference', 'blank');
    d.style.assets = [{ id: 'old-asset-id', path: 'video.mp4', label: 'Garden close-up' }];
    d.shots = [
      {
        id: 'old-shot-id',
        title: 'Opening',
        body: '',
        duration: 3,
        layout: 'split',
        clip: { assetId: 'old-asset-id', in: 1.5, rate: 0.8, volume: 0.7, fit: 'cover' },
      },
    ];
    const text = movieEditingSkill(d);
    expect(text).toContain('name: fantay-video-edit');
    expect(text).toContain('"sourceIn": 1.5');
    expect(text).toContain('Garden close-up');
    expect(text).not.toContain('old-asset-id');
    expect(text).not.toContain('old-shot-id');
  });
});

describe('multitrack timing and HTML composition', () => {
  it('preserves old sequential timing and composes independently positioned clips', () => {
    const d = createMovieDocument('Tracks', 'blank');
    d.shots = [
      { id: 'a', title: '', body: '', layout: 'split', duration: 4 },
      { id: 'b', title: '', body: '', layout: 'split', duration: 3 },
    ];
    expect(movieShotStarts(d)).toEqual([0, 4]);
    expect(movieDuration(d)).toBe(7);
    d.shots[0]!.placement = { start: 0, track: 0 };
    d.shots[1]!.placement = { start: 1, track: 1 };
    d.shots[1]!.clip = { assetId: 'v', in: 0, rate: 1, volume: 1, fit: 'contain', x: 55, y: 5, width: 40, muted: true };
    d.style.assets = [{ id: 'v', path: 'source.mp4' }];
    expect(movieDuration(d)).toBe(4);
    const html = buildMovieHtml(d);
    expect(html).toContain('data-start="1"');
    expect(html).toContain('z-index:2');
    expect(html).toContain('left:55%;top:5%;width:40%');
    expect(html).not.toContain('<audio');
  });
});

describe('Animation style recipes', () => {
  it('has distinct art direction rather than one recolored circle template', () => {
    expect(MOVIE_STYLES.length).toBeGreaterThan(0);
    expect(new Set(MOVIE_STYLES.map((s) => JSON.stringify(s.visual?.layers))).size).toBe(MOVIE_STYLES.length);
    for (const style of MOVIE_STYLES) {
      const html = buildMovieHtml(createMovieDocument(style.name, 'library', style));
      expect(html).toContain('data-layer=');
      expect(html).not.toContain('<i></i><i></i>');
      expect(html).toContain('window.__timelines.main');
    }
  });

  it('clones recipes so edits never mutate the library', () => {
    const originalCount = MOVIE_STYLES[0]!.visual!.layers.length;
    const doc = createMovieDocument();
    doc.style.visual!.layers.pop();
    expect(MOVIE_STYLES[0]!.visual!.layers).toHaveLength(originalCount);
  });

  it('uses copied style assets in previews and preserves portrait dimensions', () => {
    const doc = createMovieDocument('Images', 'library', MOVIE_STYLES.find((s) => s.id === 'gallery')!);
    doc.aspect = '9:16';
    doc.style.assets = [{ id: 'cover', path: 'assets/own-image.svg' }];
    const html = buildMovieHtml(doc, { assetBase: '/project/' });
    expect(html).toContain('/project/assets/own-image.svg');
    expect(html).toContain('object-fit:contain');
    expect(html).toContain('data-width="1080" data-height="1920"');
  });
});

describe('live Motion editing', () => {
  it('edits stable text identities without changing timing or unrelated fields', () => {
    const d = createMovieDocument('Film');
    const shot = d.shots[0]!;
    shot.captions = [{ id: 'c1', text: 'Caption', start: 0, end: 1 }];
    const target = { shotId: shot.id, field: 'caption' as const, captionId: 'c1' };
    expect(movieTextValue(d, target)).toBe('Caption');
    expect(movieTextEdit(d, target, '<not markup>')).toEqual({
      op: 'update-caption',
      shotId: shot.id,
      captionId: 'c1',
      changes: { text: '<not markup>' },
    });
    expect(movieTextEdit(d, { ...target, captionId: 'missing' }, 'x')).toBeNull();
    shot.locked = true;
    expect(movieTextEdit(d, target, 'x')).toBeNull();
  });

  it('copies shared artwork into a shot override when editing an artwork text layer', () => {
    const d = createMovieDocument('Film');
    d.style.visual!.layers.push({ id: 'label', type: 'text', text: 'Shared', x: 10, y: 10, width: 30, height: 10, color: 'foreground' });
    const target = { shotId: d.shots[0]!.id, field: 'layer' as const, layerId: 'label' };
    expect(movieTextTargets(d)).toContainEqual(target);
    const edit = movieTextEdit(d, target, 'Edited');
    expect(edit?.op).toBe('update-shot');
    if (edit?.op === 'update-shot') expect(edit.changes.visual?.layers.find((l) => l.id === 'label')?.text).toBe('Edited');
    expect(d.style.visual?.layers.find((l) => l.id === 'label')?.text).toBe('Shared');
  });

  it('only installs the selection bridge in editable previews and escapes source IDs', () => {
    const d = createMovieDocument('Film');
    d.shots[0]!.id = '</script><script>bad()</script>';
    expect(buildMovieHtml(d)).not.toContain('fantay-movie-text');
    const html = buildMovieHtml(d, { editable: true });
    expect(html).toContain('fantay-movie-text');
    expect(html).not.toContain('</script><script>bad()');
  });

  it('hands only selected notes to any agent without authorizing export or closing notes', () => {
    const d = createMovieDocument('Film');
    d.notes = [
      { id: 'chosen', scope: 'time', time: 2, contentRevision: 1, text: 'Move the title', resolved: false },
      { id: 'private', time: 3, text: 'Excluded note', resolved: false },
    ];
    const prompt = movieLiveFeedbackPrompt(d, 'project', ['chosen']);
    expect(prompt).toContain('Move the title');
    expect(prompt).not.toContain('Excluded note');
    expect(prompt).toContain('do not start production');
    expect(d.notes[0]?.resolved).toBe(false);
    expect(() => movieLiveFeedbackPrompt(d, 'project', ['missing'])).toThrow();
  });
});
