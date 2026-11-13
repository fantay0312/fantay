// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';

import {
  boardCommentPinNumbers,
  boardCommentPins,
  boardCommentTarget,
  canSendCommentToAgent,
  commentPinPoint,
  commentStatusGroup,
  commentTargetWorldBox,
  frameTargetSnapshot,
  nextBoardCommentPinNumber,
  type BoardCommentFrame,
} from '../../../src/fantay/board/comments/board-comment-pins';
import type { FrameCommentTarget } from '../../../src/fantay/board/engine/message-router';
import type { PreviewComment } from '../../../src/types';

const FRAME: BoardCommentFrame = { id: 'n_home', x: 100, y: 200, w: 400, h: 300, path: 'index.html' };
const OTHER: BoardCommentFrame = { id: 'n_about', x: 600, y: 200, w: 400, h: 300, path: 'about.html' };

let seq = 0;
function comment(over: Partial<PreviewComment> = {}): PreviewComment {
  seq += 1;
  return {
    id: `c${seq}`,
    projectId: 'p1',
    conversationId: 'conv1',
    filePath: 'index.html',
    elementId: `el-${seq}`,
    selector: `[data-od-id="el-${seq}"]`,
    label: 'h1.hero',
    text: 'Hello',
    position: { x: 10, y: 20, width: 100, height: 40 },
    htmlHint: '<h1>',
    note: 'Make it bigger',
    status: 'open',
    createdAt: 1_000 + seq,
    updatedAt: 1_000 + seq,
    ...over,
  };
}

describe('commentPinPoint / commentTargetWorldBox', () => {
  it('puts the pin on the element top-right corner in world px', () => {
    expect(commentPinPoint(FRAME, { x: 10, y: 20, width: 100, height: 40 })).toEqual({ x: 210, y: 220 });
  });

  it('clamps the pin into the frame and subtracts the document scroll', () => {
    expect(commentPinPoint(FRAME, { x: 350, y: -30, width: 200, height: 10 })).toEqual({ x: 500, y: 200 });
    expect(commentPinPoint(FRAME, { x: 0, y: 900, width: 10, height: 10 })).toEqual({ x: 110, y: 500 });
    expect(commentPinPoint(FRAME, { x: 0, y: 900, width: 10, height: 10 }, 800)).toEqual({ x: 110, y: 300 });
  });

  it('clips the element box to the frame, null without area or outside', () => {
    expect(commentTargetWorldBox(FRAME, { x: 10, y: 20, width: 100, height: 40 })).toEqual({ x: 110, y: 220, w: 100, h: 40 });
    expect(commentTargetWorldBox(FRAME, { x: 350, y: 280, width: 100, height: 100 })).toEqual({ x: 450, y: 480, w: 50, h: 20 });
    expect(commentTargetWorldBox(FRAME, { x: 0, y: 0, width: 0, height: 0 })).toBeNull();
    expect(commentTargetWorldBox(FRAME, { x: 0, y: 400, width: 50, height: 50 })).toBeNull();
  });
});

describe('boardCommentPinNumbers', () => {
  it('uses pinSeq when assigned and the creation rank per file otherwise', () => {
    const a = comment({ createdAt: 30 });
    const b = comment({ createdAt: 10 });
    const c = comment({ createdAt: 20, pinSeq: 7 });
    const d = comment({ createdAt: 5, filePath: 'about.html' });
    const numbers = boardCommentPinNumbers([a, b, c, d]);
    expect(numbers.get(b.id)).toBe(1);
    expect(numbers.get(c.id)).toBe(7);
    expect(numbers.get(a.id)).toBe(3);
    expect(numbers.get(d.id)).toBe(1);
  });

  it('counts every status (numbers are permanent) and proposes one past the highest', () => {
    const resolved = comment({ createdAt: 1, status: 'resolved' });
    const open = comment({ createdAt: 2 });
    expect(boardCommentPinNumbers([open, resolved]).get(open.id)).toBe(2);
    expect(nextBoardCommentPinNumber([open, resolved], 'index.html')).toBe(3);
    expect(nextBoardCommentPinNumber([comment({ pinSeq: 9 })], 'index.html')).toBe(10);
    expect(nextBoardCommentPinNumber([open], 'missing.html')).toBe(1);
  });
});

describe('boardCommentPins', () => {
  it('pins comments onto the frame that shows their page, in number order', () => {
    const second = comment({ createdAt: 20 });
    const first = comment({ createdAt: 10, position: { x: 0, y: 0, width: 50, height: 50 } });
    const about = comment({ createdAt: 5, filePath: 'about.html' });
    const offBoard = comment({ filePath: 'pricing.html' });
    const pins = boardCommentPins({ comments: [second, first, about, offBoard], frames: [FRAME, OTHER] });
    expect(pins.map((pin) => pin.number)).toEqual([1, 1, 2]);
    expect(pins.filter((pin) => pin.nodeId === 'n_home').map((pin) => [pin.commentId, pin.number])).toEqual([
      [first.id, 1],
      [second.id, 2],
    ]);
    expect(pins.filter((pin) => pin.nodeId === 'n_about').map((pin) => [pin.commentId, pin.number])).toEqual([[about.id, 1]]);
    expect(pins.find((pin) => pin.commentId === first.id)).toMatchObject({ x: 150, y: 200, box: { x: 100, y: 200, w: 50, h: 50 }, status: 'open', ghost: false });
  });

  it('hides resolved comments unless asked, keeping their numbers', () => {
    const resolved = comment({ createdAt: 1, status: 'resolved' });
    const open = comment({ createdAt: 2 });
    expect(boardCommentPins({ comments: [resolved, open], frames: [FRAME] }).map((pin) => pin.number)).toEqual([2]);
    const all = boardCommentPins({ comments: [resolved, open], frames: [FRAME], showResolved: true });
    expect(all.map((pin) => [pin.number, pin.status])).toEqual([[1, 'resolved'], [2, 'open']]);
  });

  it('draws a lost anchor as a ghost at its last known-good position', () => {
    const lost = comment({
      anchorState: 'lost',
      position: { x: 0, y: 0, width: 10, height: 10 },
      lastGoodPosition: { x: 100, y: 100, width: 20, height: 20 },
    });
    const [pin] = boardCommentPins({ comments: [lost], frames: [FRAME] });
    expect(pin).toMatchObject({ ghost: true, x: 220, y: 300 });
  });

  it('places a file-level comment (no element box) at the frame origin without a highlight', () => {
    const fileLevel = comment({ elementId: 'file-comment-x', position: { x: 0, y: 0, width: 0, height: 0 } });
    const [pin] = boardCommentPins({ comments: [fileLevel], frames: [FRAME] });
    expect(pin).toMatchObject({ x: 100, y: 200, box: null });
  });

  it('applies a per-frame scroll and pins a duplicated page onto its first frame', () => {
    const below = comment({ position: { x: 0, y: 600, width: 40, height: 40 } });
    const twin: BoardCommentFrame = { ...FRAME, id: 'n_twin', x: 2000 };
    const [pin] = boardCommentPins({ comments: [below], frames: [FRAME, twin], scrollY: new Map([['n_home', 500]]) });
    expect(pin).toMatchObject({ nodeId: 'n_home', x: 140, y: 300 });
  });
});

describe('status helpers', () => {
  it('groups the six contract statuses', () => {
    expect(['open', 'attached', 'applying', 'needs_review', 'resolved', 'failed'].map((status) => commentStatusGroup(status as PreviewComment['status']))).toEqual([
      'open', 'working', 'working', 'review', 'resolved', 'failed',
    ]);
  });

  it('sends to the agent only what is not already with it or resolved', () => {
    expect(canSendCommentToAgent('open')).toBe(true);
    expect(canSendCommentToAgent('needs_review')).toBe(true);
    expect(canSendCommentToAgent('failed')).toBe(true);
    expect(canSendCommentToAgent('applying')).toBe(false);
    expect(canSendCommentToAgent('attached')).toBe(false);
    expect(canSendCommentToAgent('resolved')).toBe(false);
  });
});

describe('frame target → comment target', () => {
  const target: FrameCommentTarget = {
    elementId: 'hero-title',
    selector: '[data-od-id="hero-title"]',
    label: 'h1.hero',
    text: `  Big   headline ${'x'.repeat(200)}`,
    position: { x: 12.4, y: 30.6, width: 200, height: 48 },
    htmlHint: '<h1 class="hero">',
    style: { color: 'rgb(0, 0, 0)', fontSize: '48px' },
    hoverPoint: { x: 20, y: 40 },
    slideIndex: 2,
  };

  it('keeps the bridge fields for the composer', () => {
    expect(frameTargetSnapshot(target, 'index.html')).toMatchObject({
      filePath: 'index.html',
      elementId: 'hero-title',
      selectionKind: 'element',
      hoverPoint: { x: 20, y: 40 },
      slideIndex: 2,
      style: { fontSize: '48px' },
    });
  });

  it('maps onto the persisted PreviewCommentTarget (element selection, trimmed, rounded)', () => {
    const saved = boardCommentTarget(target, 'index.html');
    expect(saved).toMatchObject({
      filePath: 'index.html',
      elementId: 'hero-title',
      selector: '[data-od-id="hero-title"]',
      label: 'h1.hero',
      position: { x: 12, y: 31, width: 200, height: 48 },
      htmlHint: '<h1 class="hero">',
      selectionKind: 'element',
      slideIndex: 2,
    });
    expect(saved.text.startsWith('Big headline')).toBe(true);
    expect(saved.text.length).toBeLessThanOrEqual(160);
    expect(saved.style).toEqual({ color: 'rgb(0, 0, 0)', fontSize: '48px' });
  });
});
