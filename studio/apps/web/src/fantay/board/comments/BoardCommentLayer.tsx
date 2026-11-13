// fx-governance-allow-raw: a pin is a camera-placed numbered badge and 显示已解决 is a pressed chip in the hint bar, which no button primitive models
'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Board comment layer (first slice of the board annotation layer). Screen-space, inside the stage after the overlay:
// numbered pins on the frames whose page has comments (real buttons marked `data-board-interactive`, ghosts for lost
// anchors), the amber highlight of the element under the Comment tool's pointer and of the active comment, the
// comment card and the new-comment composer. Everything is placed with the camera variables, so pan and zoom never
// re-render it (I2). Read-only boards draw the pins only. Esc closes an open composer or card before the board's
// own Esc runs (capture phase), so the board then steps out of comment mode one level at a time.
import { memo, useEffect, useMemo } from 'react';
import { Check } from 'lucide-react';

import { useT } from '../../../i18n';
import { useBoardEngine, useBoardSelector } from '../context';
import { BOARD_INTERACTIVE_ATTR } from '../extensions';
import { isOverlayOpen } from '../interaction/keyboard';
import { screenBox, screenPoint } from '../layers/screen-space';
import type { DictKey, Rect } from '../model/types';
import type { EngineState } from '../store/board-store';
import { BoardCommentCard, BoardCommentComposer } from './BoardCommentCard';
import {
  boardCommentPins,
  commentPinPoint,
  commentTargetWorldBox,
  nextBoardCommentPinNumber,
  type BoardCommentFrame,
  type BoardCommentPin,
  type PreviewCommentPosition,
} from './board-comment-pins';
import {
  useBoardCommentsHost,
  useBoardCommentState,
  useBoardCommentStore,
  type BoardCommentUiState,
} from './use-board-comment-session';
import styles from './board-comments.module.css';

const INTERACTIVE = { [BOARD_INTERACTIVE_ATTR]: '' } as const;
/** Presses inside these keep an open card (pins, the card itself). */
export const BOARD_COMMENT_KEEP_ATTR = 'data-board-comment-keep';

/* ── selectors (module-level: stable identities) ──────────────────────────────────────── */

/** Frames that can carry comments, at their previewed rects (a drag carries its pins along). */
function selectFrames(state: EngineState): readonly BoardCommentFrame[] {
  const frames: BoardCommentFrame[] = [];
  for (const id of state.doc.order) {
    const node = state.doc.nodes.get(id);
    if (!node || node.kind !== 'frame' || node.hidden) continue;
    const path = node.data.ref?.path;
    if (!path) continue;
    const rect = state.preview?.rects.get(id) ?? node;
    frames.push({ id, x: rect.x, y: rect.y, w: rect.w, h: rect.h, path });
  }
  return frames;
}

function framesEqual(a: readonly BoardCommentFrame[], b: readonly BoardCommentFrame[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (left.id !== right.id || left.path !== right.path || left.x !== right.x || left.y !== right.y || left.w !== right.w || left.h !== right.h) {
      return false;
    }
  }
  return true;
}

const selectReadOnly = (state: EngineState): boolean => state.readOnly;
const selectTool = (state: EngineState) => state.ui.tool;
const selectPickerNode = (state: BoardCommentUiState) => state.nodeId;
const selectReady = (state: BoardCommentUiState) => state.ready;
const selectHover = (state: BoardCommentUiState) => state.hover;
const selectDraft = (state: BoardCommentUiState) => state.draft;
const selectDraftOpen = (state: BoardCommentUiState) => state.draftOpen;
const selectCardId = (state: BoardCommentUiState) => state.cardId;
const selectCardOpen = (state: BoardCommentUiState) => state.cardOpen;
const selectShowResolved = (state: BoardCommentUiState) => state.showResolved;

/* ── pieces ───────────────────────────────────────────────────────────────────────────── */

/** An element box inside its frame (frame-relative world px), clipped to the frame on screen. */
function Highlight({ frame, box, active, testId }: { frame: BoardCommentFrame; box: Rect | null; active?: boolean; testId: string }) {
  if (!box) return null;
  return (
    <div className={styles.clip} style={screenBox(frame)}>
      <div
        className={styles.target}
        data-active={active ? '' : undefined}
        data-testid={testId}
        style={{
          left: `calc(${box.x - frame.x}px * var(--zoom, 1))`,
          top: `calc(${box.y - frame.y}px * var(--zoom, 1))`,
          width: `calc(${box.w}px * var(--zoom, 1))`,
          height: `calc(${box.h}px * var(--zoom, 1))`,
        }}
      />
    </div>
  );
}

function positionBox(frame: BoardCommentFrame, position: PreviewCommentPosition): Rect | null {
  return commentTargetWorldBox(frame, position);
}

interface PinProps {
  pin: BoardCommentPin;
  label: string;
  title: string;
  active: boolean;
  readOnly: boolean;
  onOpen(commentId: string): void;
}

function Pin({ pin, label, title, active, readOnly, onOpen }: PinProps) {
  const common = {
    className: styles.pin,
    style: screenPoint(pin.x, pin.y),
    'data-status': pin.status,
    'data-ghost': pin.ghost ? '' : undefined,
    'data-active': active ? '' : undefined,
    'data-testid': 'board-comment-pin',
    'data-comment-id': pin.commentId,
    title,
  } as const;
  if (readOnly) {
    return (
      <span {...common} role="img" aria-label={label}>
        {pin.number}
      </span>
    );
  }
  return (
    <button
      {...common}
      {...INTERACTIVE}
      {...{ [BOARD_COMMENT_KEEP_ATTR]: '' }}
      type="button"
      aria-label={label}
      aria-expanded={active}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => onOpen(pin.commentId)}
    >
      {pin.number}
    </button>
  );
}

function excerpt(note: string): string {
  const text = note.replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/* ── layer ────────────────────────────────────────────────────────────────────────────── */

export const BoardCommentLayer = memo(function BoardCommentLayer() {
  const engine = useBoardEngine();
  const t = useT();
  const host = useBoardCommentsHost();
  const store = useBoardCommentStore();
  const readOnly = useBoardSelector(selectReadOnly);
  const frames = useBoardSelector(selectFrames, framesEqual);
  const pickerNodeId = useBoardCommentState(store, selectPickerNode);
  const hover = useBoardCommentState(store, selectHover);
  const draft = useBoardCommentState(store, selectDraft);
  const draftOpen = useBoardCommentState(store, selectDraftOpen);
  const cardId = useBoardCommentState(store, selectCardId);
  const cardOpen = useBoardCommentState(store, selectCardOpen);
  const showResolved = useBoardCommentState(store, selectShowResolved);

  const pins = useMemo(
    () => boardCommentPins({ comments: host.comments, frames, showResolved }),
    [host.comments, frames, showResolved],
  );
  const notes = useMemo(() => new Map(host.comments.map((comment) => [comment.id, comment.note])), [host.comments]);
  const cardPin = cardId ? pins.find((pin) => pin.commentId === cardId) ?? null : null;
  const cardComment = cardId ? host.comments.find((comment) => comment.id === cardId) ?? null : null;
  const framesById = useMemo(() => new Map(frames.map((frame) => [frame.id, frame])), [frames]);
  const pickerFrame = pickerNodeId ? framesById.get(pickerNodeId) : undefined;
  const draftFrame = draft ? framesById.get(draft.nodeId) : undefined;
  const draftAnchor = draft && draftFrame ? commentPinPoint(draftFrame, draft.target.position) : null;

  // a card whose comment was deleted or got hidden closes; a draft whose frame left the board too
  useEffect(() => {
    if (cardOpen && (!cardComment || !cardPin)) store.closeCard();
  }, [cardOpen, cardComment, cardPin, store]);
  useEffect(() => {
    if (draftOpen && !draftFrame) store.closeDraft();
  }, [draftOpen, draftFrame, store]);
  // read-only boards only show pins
  useEffect(() => {
    if (!readOnly) return;
    store.closeCard();
    store.closeDraft();
  }, [readOnly, store]);

  // a press anywhere else closes the card (the composer stays: Esc or its close button discards a draft)
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (!store.getState().cardOpen) return;
      const target = event.target;
      if (target instanceof Element && target.closest(`[${BOARD_COMMENT_KEEP_ATTR}]`)) return;
      store.closeCard();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [store]);

  // Esc closes the composer, then the card, before the board's own Esc (deselect → Select tool)
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (isOverlayOpen()) return;
      const state = store.getState();
      if (!state.draftOpen && !state.cardOpen) return;
      const root = engine.camera.elements()?.root;
      const focused = document.activeElement;
      if (!root || !(root.contains(focused) || focused === document.body || focused === null)) return;
      event.preventDefault();
      event.stopPropagation();
      if (state.draftOpen) store.closeDraft();
      else store.closeCard();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [engine, store]);

  const hoverBox = pickerFrame && hover ? positionBox(pickerFrame, hover.position) : null;
  const draftBox = draftOpen && draftFrame && draft ? positionBox(draftFrame, draft.target.position) : null;
  const sameAsDraft = draftOpen && draft && hover ? draft.target.elementId === hover.elementId : false;
  const cardFrame = cardOpen && cardPin ? framesById.get(cardPin.nodeId) : undefined;

  return (
    <div className={styles.layer} data-testid="board-comment-layer">
      {pickerFrame && hoverBox && !sameAsDraft ? <Highlight frame={pickerFrame} box={hoverBox} testId="board-comment-hover" /> : null}
      {draftFrame && draftBox ? <Highlight frame={draftFrame} box={draftBox} active testId="board-comment-target" /> : null}
      {cardFrame && cardPin?.box ? <Highlight frame={cardFrame} box={cardPin.box} active testId="board-comment-target" /> : null}
      {pins.map((pin) => (
        <Pin
          key={pin.commentId}
          pin={pin}
          label={t('board.comment.pin', { n: pin.number })}
          title={excerpt(notes.get(pin.commentId) ?? '')}
          active={cardOpen && cardId === pin.commentId}
          readOnly={readOnly}
          onOpen={(id) => store.openCard(id)}
        />
      ))}
      {draftOpen && draft && draftAnchor ? (
        <span className={styles.pin} data-draft="" style={screenPoint(draftAnchor.x, draftAnchor.y)} aria-hidden data-testid="board-comment-draft-pin">
          {nextBoardCommentPinNumber(host.comments, draft.filePath)}
        </span>
      ) : null}
      {readOnly ? null : (
        <>
          <BoardCommentCard store={store} host={host} comment={cardComment} pin={cardPin} open={cardOpen && cardPin !== null} />
          <BoardCommentComposer store={store} host={host} draft={draft} anchor={draftAnchor} open={draftOpen && draftAnchor !== null} />
        </>
      )}
    </div>
  );
});

/* ── hint bar (bottom toolbar dock) ───────────────────────────────────────────────────── */

/** The Comment tool's hint: what to click next, and the Show resolved toggle. Mounted always, open in the tool. */
export function BoardCommentHintBar() {
  const t = useT();
  const host = useBoardCommentsHost();
  const store = useBoardCommentStore();
  const tool = useBoardSelector(selectTool);
  const pickerNodeId = useBoardCommentState(store, selectPickerNode);
  const ready = useBoardCommentState(store, selectReady);
  const showResolved = useBoardCommentState(store, selectShowResolved);
  const resolvedCount = useMemo(() => host.comments.filter((comment) => comment.status === 'resolved').length, [host.comments]);
  const open = tool === 'comment';
  const key: DictKey = pickerNodeId ? (ready ? 'board.comment.hintPick' : 'board.comment.needsLive') : 'board.comment.hint';
  return (
    <div className={styles.hintBar} data-state={open ? 'open' : 'closed'} aria-hidden={open ? undefined : true} data-testid="board-comment-hint">
      <span className={styles.hintDot} aria-hidden />
      <span role="status">{open ? t(key) : null}</span>
      <button
        type="button"
        className={styles.hintToggle}
        aria-pressed={showResolved}
        tabIndex={open ? 0 : -1}
        data-testid="board-comment-show-resolved"
        onClick={() => store.setShowResolved(!showResolved)}
      >
        {showResolved ? <Check strokeWidth={1.5} aria-hidden /> : null}
        {resolvedCount > 0 ? `${t('board.comment.showResolved')} · ${resolvedCount}` : t('board.comment.showResolved')}
      </button>
    </div>
  );
}
