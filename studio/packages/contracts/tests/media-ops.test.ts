import { describe, expect, it } from 'vitest';

import {
  MEDIA_OP_KINDS,
  MEDIA_OP_LIMITS,
  MEDIA_OP_SCALE_FACTORS,
  mediaOpInputClass,
  validateMediaOpRequest,
  type MediaOpValidationResult,
} from '../src/api/media-ops';

// Amendment C7: contract for POST /api/projects/:id/media/ops (daemon ffmpeg ops for agents/CLI).

function issuesOf(result: MediaOpValidationResult): Array<[string, string | undefined]> {
  return result.ok ? [] : result.issues.map((issue) => [issue.path, issue.code]);
}

describe('media op constants', () => {
  it('pins kinds and limits', () => {
    expect(MEDIA_OP_KINDS).toEqual(['crop', 'split', 'scale', 'frame']);
    expect(MEDIA_OP_LIMITS).toMatchObject({ maxSplitRows: 8, maxSplitCols: 8, maxScaleFactor: 4, maxOutputEdge: 8192 });
    expect(MEDIA_OP_SCALE_FACTORS).toEqual([2, 3, 4]);
  });

  it('classifies inputs by extension', () => {
    expect(mediaOpInputClass('board-media/a.PNG')).toBe('image');
    expect(mediaOpInputClass('clips/b.mov')).toBe('video');
    expect(mediaOpInputClass('doc.pdf')).toBeNull();
    expect(mediaOpInputClass('noext')).toBeNull();
  });
});

describe('validateMediaOpRequest — crop', () => {
  it('accepts image and video crops in source pixels', () => {
    expect(
      validateMediaOpRequest({ op: 'crop', input: 'images/a.png', params: { x: 0, y: 10, width: 640, height: 480 } }),
    ).toEqual({ ok: true, value: { op: 'crop', input: 'images/a.png', params: { x: 0, y: 10, width: 640, height: 480 } } });
    expect(
      validateMediaOpRequest({
        op: 'crop',
        input: ' ./clips/b.mp4 ',
        params: { x: 4, y: 4, width: 1280, height: 720 },
        output: 'clips/b-crop.webm',
      }),
    ).toEqual({
      ok: true,
      value: { op: 'crop', input: 'clips/b.mp4', params: { x: 4, y: 4, width: 1280, height: 720 }, output: 'clips/b-crop.webm' },
    });
  });

  it('reports every invalid crop field', () => {
    const result = validateMediaOpRequest({ op: 'crop', input: 'a.png', params: { x: -1, y: 1.5, width: 0, height: 9000 } });
    expect(issuesOf(result)).toEqual([
      ['params.x', 'out_of_range'],
      ['params.y', 'invalid_type'],
      ['params.width', 'out_of_range'],
      ['params.height', 'out_of_range'],
    ]);
    expect(issuesOf(validateMediaOpRequest({ op: 'crop', input: 'a.png', params: { x: 0, y: 0, width: 10 } }))).toEqual([
      ['params.height', 'required'],
    ]);
    expect(
      issuesOf(validateMediaOpRequest({ op: 'crop', input: 'a.png', params: { x: 0, y: 0, width: 10, height: 10 }, output: 'a.mp4' })),
    ).toEqual([['output', 'invalid_value']]);
  });
});

describe('validateMediaOpRequest — split', () => {
  it('accepts 1..8 rows and cols on images, with an optional outputPrefix', () => {
    expect(
      validateMediaOpRequest({ op: 'split', input: 'a.webp', params: { rows: 8, cols: 8 }, outputPrefix: 'board-media/splits/a' }),
    ).toEqual({
      ok: true,
      value: { op: 'split', input: 'a.webp', params: { rows: 8, cols: 8 }, outputPrefix: 'board-media/splits/a' },
    });
    expect(validateMediaOpRequest({ op: 'split', input: 'a.png', params: { rows: 1, cols: 3 } }).ok).toBe(true);
  });

  it('rejects out-of-range grids, video input and an output field', () => {
    expect(issuesOf(validateMediaOpRequest({ op: 'split', input: 'a.png', params: { rows: 9, cols: 0 } }))).toEqual([
      ['params.rows', 'out_of_range'],
      ['params.cols', 'out_of_range'],
    ]);
    expect(issuesOf(validateMediaOpRequest({ op: 'split', input: 'a.mp4', params: { rows: 2, cols: 2 } }))).toEqual([
      ['input', 'unsupported_input'],
    ]);
    expect(
      issuesOf(validateMediaOpRequest({ op: 'split', input: 'a.png', params: { rows: 2, cols: 2 }, output: 'x.png' })),
    ).toEqual([['output', 'unknown_key']]);
  });
});

describe('validateMediaOpRequest — scale', () => {
  it('accepts exactly one of factor or width/height', () => {
    expect(validateMediaOpRequest({ op: 'scale', input: 'a.png', params: { factor: 2 } })).toEqual({
      ok: true,
      value: { op: 'scale', input: 'a.png', params: { factor: 2 } },
    });
    expect(validateMediaOpRequest({ op: 'scale', input: 'v.mp4', params: { width: 1920 } })).toEqual({
      ok: true,
      value: { op: 'scale', input: 'v.mp4', params: { width: 1920 } },
    });
    expect(validateMediaOpRequest({ op: 'scale', input: 'a.jpg', params: { width: 4096, height: 2048 }, output: 'a@2x.jpg' }).ok).toBe(
      true,
    );
  });

  it('rejects both forms, neither form, bad factors and oversized edges', () => {
    expect(issuesOf(validateMediaOpRequest({ op: 'scale', input: 'a.png', params: { factor: 2, width: 100 } }))).toEqual([
      ['params', 'conflict'],
    ]);
    expect(issuesOf(validateMediaOpRequest({ op: 'scale', input: 'a.png', params: {} }))).toEqual([['params', 'required']]);
    expect(issuesOf(validateMediaOpRequest({ op: 'scale', input: 'a.png', params: { factor: 5 } }))).toEqual([
      ['params.factor', 'invalid_value'],
    ]);
    expect(issuesOf(validateMediaOpRequest({ op: 'scale', input: 'a.png', params: { factor: 1.5 } }))).toEqual([
      ['params.factor', 'invalid_value'],
    ]);
    expect(issuesOf(validateMediaOpRequest({ op: 'scale', input: 'a.png', params: { width: 8193, height: 0 } }))).toEqual([
      ['params.width', 'out_of_range'],
      ['params.height', 'out_of_range'],
    ]);
  });
});

describe('validateMediaOpRequest — frame', () => {
  it('accepts a video frame at a time, written as PNG', () => {
    expect(validateMediaOpRequest({ op: 'frame', input: 'v.webm', params: { timeSec: 1.25 }, output: 'frames/v-1.png' })).toEqual({
      ok: true,
      value: { op: 'frame', input: 'v.webm', params: { timeSec: 1.25 }, output: 'frames/v-1.png' },
    });
    expect(validateMediaOpRequest({ op: 'frame', input: 'v.mp4', params: { timeSec: 0 } }).ok).toBe(true);
  });

  it('rejects image input, non-PNG output and invalid times', () => {
    expect(issuesOf(validateMediaOpRequest({ op: 'frame', input: 'a.png', params: { timeSec: 1 } }))).toEqual([
      ['input', 'unsupported_input'],
    ]);
    expect(
      issuesOf(validateMediaOpRequest({ op: 'frame', input: 'v.mp4', params: { timeSec: 1 }, output: 'frames/v.jpg' })),
    ).toEqual([['output', 'invalid_value']]);
    expect(issuesOf(validateMediaOpRequest({ op: 'frame', input: 'v.mp4', params: { timeSec: -0.5 } }))).toEqual([
      ['params.timeSec', 'out_of_range'],
    ]);
    expect(issuesOf(validateMediaOpRequest({ op: 'frame', input: 'v.mp4', params: { timeSec: '2' } }))).toEqual([
      ['params.timeSec', 'invalid_type'],
    ]);
    expect(issuesOf(validateMediaOpRequest({ op: 'frame', input: 'v.mp4', params: {} }))).toEqual([['params.timeSec', 'required']]);
  });
});

describe('validateMediaOpRequest — envelope and paths', () => {
  it('rejects bodies that are not objects or lack a known op', () => {
    expect(issuesOf(validateMediaOpRequest(null))).toEqual([['', 'invalid_type']]);
    expect(issuesOf(validateMediaOpRequest([]))).toEqual([['', 'invalid_type']]);
    expect(issuesOf(validateMediaOpRequest({ input: 'a.png' }))).toEqual([['op', 'required']]);
    expect(issuesOf(validateMediaOpRequest({ op: 'upscale', input: 'a.png', params: {} }))).toEqual([['op', 'invalid_value']]);
  });

  it('requires params as an object and rejects unknown keys', () => {
    expect(issuesOf(validateMediaOpRequest({ op: 'crop', input: 'a.png' }))).toEqual([['params', 'required']]);
    expect(issuesOf(validateMediaOpRequest({ op: 'crop', input: 'a.png', params: [1, 2] }))).toEqual([['params', 'invalid_type']]);
    expect(
      issuesOf(
        validateMediaOpRequest({ op: 'split', input: 'a.png', params: { rows: 2, cols: 2, colums: 3 }, projectId: 'p1' }),
      ),
    ).toEqual([
      ['projectId', 'unknown_key'],
      ['params.colums', 'unknown_key'],
    ]);
  });

  it('accepts only canonical project-relative paths', () => {
    const crop = (input: unknown) =>
      validateMediaOpRequest({ op: 'crop', input, params: { x: 0, y: 0, width: 1, height: 1 } });
    expect(crop('./a/b.png')).toMatchObject({ ok: true, value: { input: 'a/b.png' } });
    for (const bad of ['/etc/a.png', '../a.png', 'a/../../b.png', 'a//b.png', 'a/./b.png', 'a\\b.png', 'https://x/a.png', 'C:/a.png', 'a\u0000.png', `${'d/'.repeat(300)}a.png`]) {
      const result = crop(bad);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      expect(issuesOf(result)[0]?.[0]).toBe('input');
    }
    expect(issuesOf(crop(''))).toEqual([['input', 'required']]);
    expect(issuesOf(crop(undefined))).toEqual([['input', 'required']]);
    expect(issuesOf(crop(7))).toEqual([['input', 'invalid_type']]);
    expect(issuesOf(crop('a.pdf'))).toEqual([['input', 'unsupported_input']]);
    expect(
      issuesOf(validateMediaOpRequest({ op: 'crop', input: 'a.png', params: { x: 0, y: 0, width: 1, height: 1 }, output: '../out.png' })),
    ).toEqual([['output', 'invalid_value']]);
  });

  it('reports issues from every part of the request at once', () => {
    const result = validateMediaOpRequest({ op: 'frame', input: 'a.gif', params: { timeSec: -1, extra: true }, output: 'x.png', foo: 1 });
    expect(issuesOf(result)).toEqual([
      ['foo', 'unknown_key'],
      ['input', 'unsupported_input'],
      ['params.extra', 'unknown_key'],
      ['params.timeSec', 'out_of_range'],
    ]);
    expect(result.ok ? [] : result.issues.every((issue) => typeof issue.message === 'string' && issue.message.length > 0)).toBe(true);
  });
});
