// SPDX-License-Identifier: AGPL-3.0-only
// Board comment pins (first slice of the board annotation layer). Pure mapping between the frame selection bridge
// (`FrameCommentTarget`), the per-conversation preview comments (`PreviewComment`, contracts `api/comments.ts`) and
// world-space pins on frame nodes. A frame shows one project page at 1 CSS px = 1 world px (`message-router.ts`),
// so a stored bridge position maps onto the node by adding the node origin; pins sit on the element's top-right
// corner, clamped into the frame. Numbers follow the daemon: `pinSeq` when assigned, else the creation rank.
import { provisionalNextPinNumber, targetFromSnapshot, type PreviewCommentSnapshot } from '../../../comments';
import type { PreviewComment, PreviewCommentStatus, PreviewCommentTarget } from '../../../types';
import type { FrameCommentTarget } from '../engine/message-router';
import type { Rect } from '../model/types';

/** Bridge / stored element box in the page viewport (CSS px). */
export type PreviewCommentPosition = PreviewComment['position'];

/** A frame node that can carry comments: its world rect and the project page it shows. */
export interface BoardCommentFrame {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  path: string;
}

/** Status buckets the board UI distinguishes (the contract has six statuses). */
export type BoardCommentStatusGroup = 'open' | 'working' | 'review' | 'resolved' | 'failed';

export interface BoardCommentPin {
  commentId: string;
  nodeId: string;
  filePath: string;
  number: number;
  /** world px: the commented element's top-right corner, clamped into the frame */
  x: number;
  y: number;
  /** the commented element in world px, clipped to the frame; null for a file-level comment or an empty box */
  box: Rect | null;
  status: BoardCommentStatusGroup;
  /** the anchor is lost (contract `anchorState: 'lost'`): drawn as a ghost at the last known-good position */
  ghost: boolean;
}

export interface BoardCommentPinsInput {
  comments: readonly PreviewComment[];
  frames: readonly BoardCommentFrame[];
  /** include resolved comments (default false) */
  showResolved?: boolean;
  /** vertical scroll of a live frame document, by node id (stored positions are viewport px) */
  scrollY?: ReadonlyMap<string, number>;
}

export function commentStatusGroup(status: PreviewCommentStatus): BoardCommentStatusGroup {
  switch (status) {
    case 'attached':
    case 'applying':
      return 'working';
    case 'needs_review':
      return 'review';
    case 'resolved':
      return 'resolved';
    case 'failed':
      return 'failed';
    default:
      return 'open';
  }
}

/** A comment can be handed to the agent unless it is already with it or resolved. */
export function canSendCommentToAgent(status: PreviewCommentStatus): boolean {
  const group = commentStatusGroup(status);
  return group === 'open' || group === 'review' || group === 'failed';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finitePosition(position: PreviewCommentPosition | undefined | null): PreviewCommentPosition | null {
  if (!position) return null;
  const { x, y, width, height } = position;
  if (![x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  if (width < 0 || height < 0) return null;
  return { x, y, width, height };
}

/** Creation order: `createdAt`, then id (legacy rows with createdAt 0 sort first, as the daemon backfill does). */
function byCreation(a: PreviewComment, b: PreviewComment): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function commentsByFile(comments: readonly PreviewComment[]): Map<string, PreviewComment[]> {
  const byFile = new Map<string, PreviewComment[]>();
  for (const comment of comments) {
    const list = byFile.get(comment.filePath);
    if (list) list.push(comment);
    else byFile.set(comment.filePath, [comment]);
  }
  for (const list of byFile.values()) list.sort(byCreation);
  return byFile;
}

/**
 * Pin number of every comment: `pinSeq` when the daemon assigned one, else its creation rank within its file
 * (`index + 1`, every status counted — pin numbers are permanent, see `provisionalNextPinNumber`).
 */
export function boardCommentPinNumbers(comments: readonly PreviewComment[]): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const list of commentsByFile(comments).values()) {
    list.forEach((comment, index) => {
      numbers.set(comment.id, typeof comment.pinSeq === 'number' ? comment.pinSeq : index + 1);
    });
  }
  return numbers;
}

/** The number a new comment on `filePath` will most likely get (one past the highest number handed out). */
export function nextBoardCommentPinNumber(comments: readonly PreviewComment[], filePath: string): number {
  return provisionalNextPinNumber(commentsByFile(comments).get(filePath) ?? []);
}

/** World point of a pin: the element's top-right corner, clamped into the frame. */
export function commentPinPoint(
  frame: Pick<BoardCommentFrame, 'x' | 'y' | 'w' | 'h'>,
  position: PreviewCommentPosition,
  scrollY = 0,
): { x: number; y: number } {
  return {
    x: frame.x + clamp(position.x + position.width, 0, frame.w),
    y: frame.y + clamp(position.y - scrollY, 0, frame.h),
  };
}

/** The element box in world px, clipped to the frame; null when nothing of it is inside or it has no area. */
export function commentTargetWorldBox(
  frame: Pick<BoardCommentFrame, 'x' | 'y' | 'w' | 'h'>,
  position: PreviewCommentPosition,
  scrollY = 0,
): Rect | null {
  if (!(position.width > 0) || !(position.height > 0)) return null;
  const left = clamp(position.x, 0, frame.w);
  const top = clamp(position.y - scrollY, 0, frame.h);
  const right = clamp(position.x + position.width, 0, frame.w);
  const bottom = clamp(position.y - scrollY + position.height, 0, frame.h);
  if (right <= left || bottom <= top) return null;
  return { x: frame.x + left, y: frame.y + top, w: right - left, h: bottom - top };
}

/** The position a pin is drawn at: the last known-good anchor when the daemon has one, else the creation one. */
export function commentPinPosition(comment: Pick<PreviewComment, 'position' | 'lastGoodPosition'>): PreviewCommentPosition {
  return finitePosition(comment.lastGoodPosition) ?? finitePosition(comment.position) ?? { x: 0, y: 0, width: 0, height: 0 };
}

/**
 * Pins of the comments whose page is on the board, in number order. A page shown by several frames (should not
 * happen, invariant I1) pins onto the first. Resolved comments are left out unless `showResolved`.
 */
export function boardCommentPins(input: BoardCommentPinsInput): BoardCommentPin[] {
  const framesByPath = new Map<string, BoardCommentFrame>();
  for (const frame of input.frames) if (!framesByPath.has(frame.path)) framesByPath.set(frame.path, frame);
  const numbers = boardCommentPinNumbers(input.comments);
  const pins: BoardCommentPin[] = [];
  for (const comment of input.comments) {
    const frame = framesByPath.get(comment.filePath);
    if (!frame) continue;
    const status = commentStatusGroup(comment.status);
    if (status === 'resolved' && !input.showResolved) continue;
    const position = commentPinPosition(comment);
    const scrollY = input.scrollY?.get(frame.id) ?? 0;
    const point = commentPinPoint(frame, position, scrollY);
    pins.push({
      commentId: comment.id,
      nodeId: frame.id,
      filePath: comment.filePath,
      number: numbers.get(comment.id) ?? 0,
      x: point.x,
      y: point.y,
      box: commentTargetWorldBox(frame, position, scrollY),
      status,
      ghost: comment.anchorState === 'lost',
    });
  }
  pins.sort((a, b) => a.number - b.number || (a.commentId < b.commentId ? -1 : a.commentId > b.commentId ? 1 : 0));
  return pins;
}

/** The bridge target of a frame as a comment snapshot (what the composer shows and the save target is made of). */
export function frameTargetSnapshot(target: FrameCommentTarget, filePath: string): PreviewCommentSnapshot {
  return {
    filePath,
    elementId: target.elementId,
    selector: target.selector,
    label: target.label,
    text: target.text,
    position: { ...target.position },
    htmlHint: target.htmlHint ?? '',
    selectionKind: 'element',
    ...(target.style ? { style: target.style } : {}),
    ...(target.hoverPoint ? { hoverPoint: { ...target.hoverPoint } } : {}),
    ...(typeof target.slideIndex === 'number' ? { slideIndex: target.slideIndex } : {}),
  };
}

/** The persisted target of a board comment (`selectionKind: 'element'`, trimmed like FileViewer's). */
export function boardCommentTarget(target: FrameCommentTarget, filePath: string): PreviewCommentTarget {
  return targetFromSnapshot(frameTargetSnapshot(target, filePath));
}
