// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  buildMovieHtml,
  createMovieDocument,
  type MovieDocument,
  type MovieRender,
  type MovieReviewAssets,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import {
  MOTION_NODE_FOOTER_H,
  formatMotionTime,
  isMovieBusy,
  latestDoneRender,
  motionCaptureCapability,
  motionFrameSize,
  motionModeBarCapabilities,
  motionNodeSize,
  motionRenderCapability,
  motionStatus,
  motionStatusLabel,
  resolveMotionCover,
  stripBackgroundPosition,
  stripBackgroundSize,
  stripFrameIndex,
} from '../../../src/fantay/motion/motion-model';

function film(patch: Partial<MovieDocument> = {}): MovieDocument {
  return { ...createMovieDocument('Film'), revision: 3, ...patch };
}

function render(id: string, patch: Partial<MovieRender> = {}): MovieRender {
  return {
    id,
    contentRevision: 1,
    status: 'done',
    createdAt: '2026-10-29T00:00:00.000Z',
    sourcePath: `motion-source/movie-${id}/index.html`,
    file: `movie-${id}.mp4`,
    ...patch,
  };
}

const strip = (renderId: string): MovieReviewAssets => ({
  renderId,
  duration: 12,
  fps: 30,
  thumbnailFile: `movie-review/${renderId}-abc/strip.jpg`,
  thumbnailCount: 12,
  audio: 'none',
  peaks: [],
  shots: [],
});

describe('motion frame and node sizes', () => {
  it('matches the frame size buildMovieHtml renders for every aspect', () => {
    for (const aspect of ['16:9', '9:16', '1:1'] as const) {
      const html = buildMovieHtml(film({ aspect }));
      const { width, height } = motionFrameSize(aspect);
      expect(html).toContain(`data-width="${width}" data-height="${height}"`);
    }
  });

  it('adds the 44px footer under a stage at the film aspect', () => {
    expect(MOTION_NODE_FOOTER_H).toBe(44);
    expect(motionNodeSize('16:9')).toEqual({ w: 480, h: 314 });
    expect(motionNodeSize('9:16')).toEqual({ w: 270, h: 524 });
    expect(motionNodeSize('1:1')).toEqual({ w: 360, h: 404 });
  });
});

describe('motionStatus precedence', () => {
  it('reads a fresh film as a draft with its shot count', () => {
    expect(motionStatus(film())).toEqual({ kind: 'draft', shots: 3 });
  });

  it('puts a running production before a running render', () => {
    const doc = film({
      production: { id: 'p', status: 'preparing', createdAt: 'x', baselineContentRevision: 1 },
      renders: [render('r1', { status: 'running', progress: 'Frames 3/9' })],
    });
    expect(motionStatus(doc)).toEqual({ kind: 'producing', phase: 'preparing' });
    expect(isMovieBusy(doc)).toBe(true);
  });

  it('reports a running render with its progress', () => {
    const doc = film({ renders: [render('r1', { status: 'running', progress: 'Frames 3/9' })] });
    expect(motionStatus(doc)).toEqual({ kind: 'rendering', progress: 'Frames 3/9' });
    expect(isMovieBusy(doc)).toBe(true);
  });

  it('puts delivery before approval and numbers versions from 1', () => {
    const doc = film({
      renders: [render('r1'), render('r2')],
      approvedRenderId: 'r2',
      delivery: { renderId: 'r2', createdAt: 'x', files: [] },
    });
    expect(motionStatus(doc)).toEqual({ kind: 'delivered', version: 2 });
    expect(motionStatus({ ...doc, delivery: null })).toEqual({ kind: 'approved', version: 2 });
    expect(motionStatus({ ...doc, delivery: null, approvedRenderId: null })).toEqual({ kind: 'rendered', version: 2 });
  });

  it('marks a finished render stale once the content changed', () => {
    const doc = film({ contentRevision: 2, renders: [render('r1', { contentRevision: 1 })] });
    expect(motionStatus(doc)).toEqual({ kind: 'stale', version: 1 });
    expect(isMovieBusy(doc)).toBe(false);
  });

  it('reports the last render failing when nothing current exists', () => {
    const doc = film({ renders: [render('r1', { status: 'failed', error: 'boom', file: undefined })] });
    expect(motionStatus(doc)).toEqual({ kind: 'failed', error: 'boom' });
  });

  it('labels producing/rendering as brand, failure as danger and approval as success', () => {
    expect(motionStatusLabel({ kind: 'producing', phase: 'armed' })).toEqual({ key: 'motion.node.status.producing', tone: 'brand' });
    expect(motionStatusLabel({ kind: 'rendering' }).tone).toBe('brand');
    expect(motionStatusLabel({ kind: 'failed' }).tone).toBe('danger');
    expect(motionStatusLabel({ kind: 'approved', version: 2 })).toEqual({
      key: 'motion.node.status.approved',
      vars: { version: 2 },
      tone: 'success',
    });
    expect(motionStatusLabel({ kind: 'delivered', version: 1 }).tone).toBe('success');
    expect(motionStatusLabel({ kind: 'stale', version: 1 }).tone).toBe('neutral');
    expect(motionStatusLabel({ kind: 'draft', shots: 4 })).toEqual({
      key: 'motion.node.status.draft',
      vars: { shots: 4 },
      tone: 'neutral',
    });
  });
});

describe('resolveMotionCover precedence', () => {
  const workspace = { workspaceId: 'w 1', workspaceMemberId: 'm' } as WorkspaceCollabContext;

  it('prefers the loaded strip of the latest finished render', () => {
    const doc = film({ renders: [render('r1')] });
    expect(resolveMotionCover({ projectId: 'p 1', doc, strip: strip('r1'), workspaceContext: workspace })).toEqual({
      kind: 'strip',
      url: '/api/projects/p%201/raw/movie-review/r1-abc/strip.jpg?workspaceId=w%201&workspaceMemberId=m',
      frames: 12,
      renderId: 'r1',
    });
  });

  it('uses a cached strip only while its render is still the latest', () => {
    const cached = { url: '/cached.jpg', frames: 8, renderId: 'r1' };
    const doc = film({ renders: [render('r1')] });
    expect(resolveMotionCover({ projectId: 'p', doc, strip: null, cached })).toEqual({ kind: 'strip', ...cached });
    const newer = film({ renders: [render('r1'), render('r2')] });
    expect(resolveMotionCover({ projectId: 'p', doc: newer, strip: null, cached })?.kind).toBe('poster');
    expect(resolveMotionCover({ projectId: 'p', doc: null, strip: null, cached })).toEqual({ kind: 'strip', ...cached });
    expect(resolveMotionCover({ projectId: 'p', doc: null, strip: null })).toBeNull();
  });

  it('falls back to the current style sample, then a production frame, then a poster', () => {
    const doc = film({
      contentRevision: 4,
      stylePreview: { contentRevision: 4, assetDigest: 'd', frames: ['samples/a.png'], times: [0.5] },
      production: { id: 'p', status: 'done', createdAt: 'x', baselineContentRevision: 1, frames: ['prod/b.png'] },
    });
    expect(resolveMotionCover({ projectId: 'p', doc, strip: null })).toEqual({ kind: 'image', url: '/api/projects/p/raw/samples/a.png' });
    const stale = { ...doc, stylePreview: { ...doc.stylePreview!, contentRevision: 3 } };
    expect(resolveMotionCover({ projectId: 'p', doc: stale, strip: null })).toEqual({ kind: 'image', url: '/api/projects/p/raw/prod/b.png' });
    const plain = film();
    expect(resolveMotionCover({ projectId: 'p', doc: plain, strip: null })).toEqual({
      kind: 'poster',
      background: plain.style.background,
      foreground: plain.style.foreground,
      accent: plain.style.accent,
      title: plain.shots[0]!.title,
    });
  });
});

describe('strip helpers and time', () => {
  it('clamps the strip frame index', () => {
    expect(stripFrameIndex(0, 12, 12)).toBe(0);
    expect(stripFrameIndex(6, 12, 12)).toBe(6);
    expect(stripFrameIndex(12, 12, 12)).toBe(11);
    expect(stripFrameIndex(-3, 12, 12)).toBe(0);
    expect(stripFrameIndex(3, 0, 12)).toBe(0);
    expect(stripFrameIndex(3, 12, 1)).toBe(0);
  });

  it('positions 16:9 tiles as index / (frames - 1) and narrows other aspects to the film', () => {
    expect(stripBackgroundPosition(0, 9)).toBe('0% 0');
    expect(stripBackgroundPosition(4, 9)).toBe('50% 0');
    expect(stripBackgroundPosition(8, 9)).toBe('100% 0');
    expect(stripBackgroundPosition(0, 1)).toBe('0% 0');
    expect(stripBackgroundSize(9)).toBe('900% 100%');
    // a 1:1 film fills 90 of each 160px tile, centred
    expect(stripBackgroundSize(2, '1:1')).toBe(`${Math.round(((2 * 160 * 100) / 90) * 1000) / 1000}% 100%`);
    expect(stripBackgroundPosition(1, 2, '1:1')).toBe(`${Math.round(((160 + 35) / (320 - 90)) * 100 * 1000) / 1000}% 0`);
  });

  it('formats minutes, seconds and tenths', () => {
    expect(formatMotionTime(3.24, { tenths: true })).toBe('0:03.2');
    expect(formatMotionTime(3.24)).toBe('0:03');
    expect(formatMotionTime(62)).toBe('1:02');
    expect(formatMotionTime(-1)).toBe('0:00');
    expect(formatMotionTime(Number.NaN, { tenths: true })).toBe('0:00.0');
  });
});

describe('render and capture capabilities', () => {
  it('allows rendering only with current samples approved and nothing running', () => {
    expect(motionRenderCapability(film())).toEqual({ available: false, reasonKey: 'motion.node.renderBlocked' });
    expect(motionRenderCapability(film({ samplesApproved: 1 }))).toEqual({ available: true });
    expect(motionRenderCapability(film({ samplesApproved: 1, renders: [render('r', { status: 'running' })] }))).toEqual({
      available: false,
      reasonKey: 'motion.node.renderRunning',
    });
  });

  it('captures only from a finished render', () => {
    expect(motionCaptureCapability(film())).toEqual({ available: false, reasonKey: 'motion.node.captureUnavailable' });
    const done = film({ renders: [render('r1'), render('r2', { status: 'failed', file: undefined })] });
    expect(motionCaptureCapability(done)).toEqual({ available: true });
    expect(latestDoneRender(done)).toMatchObject({ render: { id: 'r1' }, version: 1 });
    expect(motionModeBarCapabilities(done)).toEqual({ edit: true, capture: true });
    expect(motionModeBarCapabilities(film())).toEqual({ edit: true, capture: false });
  });
});
