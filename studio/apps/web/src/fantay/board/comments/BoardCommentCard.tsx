'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Board comment popovers (first slice). The card opens from a pin: number, status, the commented element and page,
// the note and its images, and Resolve / Reopen, Delete, Open in Files and Send to agent through the host
// callbacks. The composer opens on an element picked with the Comment tool; it reuses `BoardComposerPopover`
// (docked, restyled by `board-comments.module.css`): Comment saves, Send saves first and then hands the saved
// comment to the agent (`commentsToAttachments`), so the comment keeps its pin through applying / needs review.
// Both stay mounted after closing (data-state) so the exit animates in place; side is chosen once per opening.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Check, ExternalLink, RotateCcw, Send, Trash2, X } from 'lucide-react';

import { commentsToAttachments, commentTargetDisplayName } from '../../../comments';
import { BoardComposerPopover } from '../../../components/BoardComposerPopover';
import { commentSendSucceeded } from '../../../components/comment-send-result';
import { useT } from '../../../i18n';
import { projectRawUrl } from '../../../providers/registry';
import type { PreviewComment } from '../../../types';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { IconButton } from '../../ui/icon-button';
import { toast } from '../../ui/toast';
import { worldToScreen } from '../camera/camera';
import { useBoardEngine, useBoardHost } from '../context';
import { BOARD_INTERACTIVE_ATTR } from '../extensions';
import { screenPoint } from '../layers/screen-space';
import type { DictKey, Point } from '../model/types';
import { basenameOf } from '../nodes/frame/project-files';
import {
  boardCommentTarget,
  canSendCommentToAgent,
  frameTargetSnapshot,
  type BoardCommentPin,
  type BoardCommentStatusGroup,
} from './board-comment-pins';
import type { BoardCommentDraft, BoardCommentsHost, BoardCommentStore } from './use-board-comment-session';
import styles from './board-comments.module.css';

const INTERACTIVE = { [BOARD_INTERACTIVE_ATTR]: '' } as const;
const POPOVER_WIDTH = 300;
const POPOVER_GAP = 16;
const POPOVER_ESTIMATED_HEIGHT = 240;
/** keep clear of the bottom toolbar */
const STAGE_BOTTOM_INSET = 96;
const NO_NOTES: string[] = [];

export const COMMENT_STATUS_KEYS: Readonly<Record<BoardCommentStatusGroup, DictKey>> = {
  open: 'board.comment.status.open',
  working: 'board.comment.status.working',
  review: 'board.comment.status.review',
  resolved: 'board.comment.status.resolved',
  failed: 'board.comment.status.failed',
};

function noop(): void {}

function stopPointer(event: { stopPropagation(): void }): void {
  event.stopPropagation();
}

type Side = { x: 'right' | 'left'; y: 'down' | 'up' };

/** Which side of the anchor a popover opens on, decided once per opening from the camera at that moment. */
function usePopoverSide(open: boolean, openKey: string | number | null, anchor: Point | null): Side {
  const engine = useBoardEngine();
  const [side, setSide] = useState<Side>({ x: 'right', y: 'down' });
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  useLayoutEffect(() => {
    const point = anchorRef.current;
    if (!open || !point) return;
    const screen = worldToScreen(engine.camera.get(), point);
    const stage = engine.camera.stageSize();
    const x = screen.x + POPOVER_GAP + POPOVER_WIDTH > stage.w - 12 && screen.x - POPOVER_GAP - POPOVER_WIDTH >= 12 ? 'left' : 'right';
    const y = screen.y + POPOVER_ESTIMATED_HEIGHT > stage.h - STAGE_BOTTOM_INSET && screen.y - POPOVER_ESTIMATED_HEIGHT >= 12 ? 'up' : 'down';
    setSide((current) => (current.x === x && current.y === y ? current : { x, y }));
  }, [engine, open, openKey]);
  return side;
}

/** Closing while focus is inside: focus goes back to the board, so its keys work again. */
function useReturnFocusOnClose(open: boolean, container: RefObject<HTMLElement | null>): void {
  const engine = useBoardEngine();
  useEffect(() => {
    if (open) return;
    const element = container.current;
    if (element && typeof document !== 'undefined' && element.contains(document.activeElement)) {
      engine.camera.elements()?.root.focus({ preventScroll: true });
    }
  }, [engine, open, container]);
}

/* ── card ───────────────────────────────────────────────────────────────────────────────── */

export interface BoardCommentCardProps {
  store: BoardCommentStore;
  host: BoardCommentsHost;
  /** the comment and its pin; null once gone (the last ones stay drawn for the exit) */
  comment: PreviewComment | null;
  pin: BoardCommentPin | null;
  open: boolean;
}

type CardBusy = 'status' | 'delete' | 'send' | null;

export function BoardCommentCard({ store, host, comment, pin, open }: BoardCommentCardProps) {
  const t = useT();
  const { env } = useBoardHost();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const last = useRef<{ comment: PreviewComment; pin: BoardCommentPin } | null>(null);
  if (comment && pin) last.current = { comment, pin };
  const shown = last.current;
  const side = usePopoverSide(open, comment?.id ?? null, pin ? { x: pin.x, y: pin.y } : null);
  const [busy, setBusy] = useState<CardBusy>(null);
  useReturnFocusOnClose(open, cardRef);

  // the card takes focus when it opens, so Tab and Esc start from it
  const openId = open ? comment?.id ?? null : null;
  useEffect(() => {
    if (openId) cardRef.current?.focus({ preventScroll: true });
  }, [openId]);

  if (!shown) return null;
  const { comment: current, pin: currentPin } = shown;
  const status = currentPin.status;
  const resolved = status === 'resolved';
  const target = commentTargetDisplayName(current, basenameOf(current.filePath));
  const images = current.attachments ?? [];

  const run = async (kind: Exclude<CardBusy, null>, action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(kind);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };
  const toggleResolved = (): Promise<void> =>
    run('status', async () => {
      if (!host.setStatus) return;
      const ok = await host.setStatus(current.id, resolved ? 'open' : 'resolved');
      if (ok && !resolved && !store.getState().showResolved) store.closeCard();
    });
  const remove = (): Promise<void> =>
    run('delete', async () => {
      if (!host.remove) return;
      if (await host.remove(current.id)) store.closeCard();
    });
  const send = (): Promise<void> =>
    run('send', async () => {
      if (!host.send) return;
      const result = await host.send(commentsToAttachments([current]));
      const ok = commentSendSucceeded(result);
      toast({ title: t(ok ? 'board.comment.sent' : 'board.comment.sendFailed'), tone: ok ? 'success' : 'danger' });
      if (ok) store.closeCard();
    });

  return (
    <div
      ref={cardRef}
      className={cn(styles.popover, styles.card)}
      style={screenPoint(currentPin.x, currentPin.y)}
      data-state={open ? 'open' : 'closed'}
      data-side-x={side.x}
      data-side-y={side.y}
      data-testid="board-comment-card"
      role="dialog"
      aria-modal="false"
      aria-label={t('board.comment.pin', { n: currentPin.number })}
      aria-hidden={open ? undefined : true}
      tabIndex={-1}
      {...INTERACTIVE}
      data-board-comment-keep=""
      onPointerDown={stopPointer}
    >
      <div className={styles.cardHead}>
        <span className={styles.cardNumber} data-status={status} aria-hidden>
          {currentPin.number}
        </span>
        <span className={styles.cardStatus} data-testid="board-comment-card-status">
          {t(COMMENT_STATUS_KEYS[status])}
        </span>
        {currentPin.ghost ? <span className={styles.cardLost}>{t('comment.anchorState.lost')}</span> : null}
        <IconButton
          className={styles.cardClose}
          size="sm"
          aria-label={t('common.close')}
          tooltip={false}
          tabIndex={open ? 0 : -1}
          onClick={() => store.closeCard()}
        >
          <X strokeWidth={1.5} />
        </IconButton>
      </div>
      <div className={styles.cardTarget} title={`${target} · ${current.filePath}`}>
        {target} · {basenameOf(current.filePath)}
      </div>
      {current.note.trim() ? <p className={styles.cardBody}>{current.note}</p> : null}
      {images.length > 0 ? (
        <div className={styles.cardImages}>
          {images.map((image) => (
            <a
              key={image.path}
              className={styles.cardImage}
              href={projectRawUrl(env.projectId, image.path, env.workspaceContext)}
              target="_blank"
              rel="noopener noreferrer"
              title={image.name}
              tabIndex={open ? 0 : -1}
            >
              <img src={projectRawUrl(env.projectId, image.path, env.workspaceContext)} alt={image.name} />
            </a>
          ))}
        </div>
      ) : null}
      <div className={styles.cardActions}>
        <div className={styles.cardActionsStart}>
          {host.remove ? (
            <IconButton
              variant="danger"
              size="sm"
              aria-label={t('common.delete')}
              data-testid="board-comment-delete"
              disabled={busy !== null}
              tabIndex={open ? 0 : -1}
              onClick={() => void remove()}
            >
              <Trash2 strokeWidth={1.5} />
            </IconButton>
          ) : null}
          <IconButton
            size="sm"
            aria-label={t('board.node.openInFiles')}
            data-testid="board-comment-open-in-files"
            tabIndex={open ? 0 : -1}
            onClick={() => env.onOpenInFiles(current.filePath)}
          >
            <ExternalLink strokeWidth={1.5} />
          </IconButton>
        </div>
        <div className={styles.cardActionsEnd}>
          {host.setStatus ? (
            <Button
              size="sm"
              variant="secondary"
              data-testid="board-comment-resolve"
              loading={busy === 'status'}
              disabled={busy !== null && busy !== 'status'}
              tabIndex={open ? 0 : -1}
              onClick={() => void toggleResolved()}
            >
              {resolved ? <RotateCcw strokeWidth={1.5} /> : <Check strokeWidth={1.5} />}
              {t(resolved ? 'board.comment.reopen' : 'board.comment.resolve')}
            </Button>
          ) : null}
          {host.send && canSendCommentToAgent(current.status) ? (
            <Button
              size="sm"
              variant="primary"
              data-testid="board-comment-send"
              loading={busy === 'send'}
              disabled={busy !== null && busy !== 'send'}
              tabIndex={open ? 0 : -1}
              onClick={() => void send()}
            >
              <Send strokeWidth={1.5} />
              {t('board.comment.sendToAgent')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ── composer ───────────────────────────────────────────────────────────────────────────── */

export interface BoardCommentComposerProps {
  store: BoardCommentStore;
  host: BoardCommentsHost;
  /** the picked element (kept after closing for the exit) */
  draft: BoardCommentDraft | null;
  /** world point the composer hangs from (the element's top-right corner); null when its frame is gone */
  anchor: Point | null;
  open: boolean;
}

export function BoardCommentComposer({ store, host, draft, anchor, open }: BoardCommentComposerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const last = useRef<{ draft: BoardCommentDraft; anchor: Point } | null>(null);
  if (draft && anchor) last.current = { draft, anchor };
  const shown = last.current;
  const side = usePopoverSide(open, draft?.key ?? null, anchor);
  useReturnFocusOnClose(open, containerRef);
  if (!shown) return null;
  return (
    <div
      ref={containerRef}
      className={cn(styles.popover, styles.card, styles.composer)}
      style={screenPoint(shown.anchor.x, shown.anchor.y)}
      data-state={open ? 'open' : 'closed'}
      data-side-x={side.x}
      data-side-y={side.y}
      data-testid="board-comment-composer"
      aria-hidden={open ? undefined : true}
      {...INTERACTIVE}
      onPointerDown={stopPointer}
    >
      <ComposerBody key={shown.draft.key} draft={shown.draft} store={store} host={host} />
    </div>
  );
}

function ComposerBody({ draft, store, host }: { draft: BoardCommentDraft; store: BoardCommentStore; host: BoardCommentsHost }) {
  const t = useT();
  const [text, setText] = useState('');
  const [images, setImages] = useState<Array<{ file: File; url: string }>>([]);
  const [sending, setSending] = useState(false);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(
    () => () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.url);
    },
    [],
  );
  const snapshot = useMemo(() => frameTargetSnapshot(draft.target, draft.filePath), [draft]);

  const save = async (): Promise<PreviewComment | null> => {
    if (!host.save) return null;
    return host.save(
      boardCommentTarget(draft.target, draft.filePath),
      text.trim(),
      false,
      images.map((image) => image.file),
    );
  };

  const onSave = async (): Promise<void> => {
    if (sending) return;
    setSending(true);
    try {
      const saved = await save();
      if (!saved) return;
      store.closeDraft();
      toast({ title: t('chat.comments.savedToast'), tone: 'success' });
    } finally {
      setSending(false);
    }
  };

  const onSend = async (): Promise<void> => {
    if (sending || !host.send) return;
    setSending(true);
    try {
      const saved = await save();
      if (!saved) return;
      store.closeDraft();
      const result = await host.send(commentsToAttachments([saved]));
      const ok = commentSendSucceeded(result);
      toast({ title: t(ok ? 'board.comment.sent' : 'board.comment.sendFailed'), tone: ok ? 'success' : 'danger' });
    } finally {
      setSending(false);
    }
  };

  const removeImage = (index: number): void => {
    const removed = imagesRef.current[index];
    if (removed) URL.revokeObjectURL(removed.url);
    setImages((current) => current.filter((_, position) => position !== index));
  };

  return (
    <BoardComposerPopover
      target={snapshot}
      existing={null}
      draft={text}
      notes={NO_NOTES}
      onDraft={setText}
      onAddDraft={noop}
      onRemoveQueuedNote={noop}
      onClose={() => store.closeDraft()}
      onSaveComment={onSave}
      onSendBatch={onSend}
      onRemoveMember={noop}
      images={images}
      onAttachImages={(files) =>
        setImages((current) => [...current, ...files.map((file) => ({ file, url: URL.createObjectURL(file) }))])
      }
      onRemoveImage={removeImage}
      sending={sending}
      canEditComment={Boolean(host.save)}
      allowSendToChat={Boolean(host.save && host.send)}
      t={t}
      docked
    />
  );
}
