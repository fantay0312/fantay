// SPDX-License-Identifier: AGPL-3.0-only
// The transcript (spec §6.2, §6.5): turns from buildTurns with time separators, group clusters, one tail per task
// turn. It follows the end only when the reader was already near it; otherwise new content raises a "new
// messages" pill. Scroll positions are remembered per conversation; first open lands on the end. Things that
// arrive after the first render enter with a short rise; history renders still.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';

import { usePresence } from '../../hooks/usePresence';
import { useI18n, useT } from '../../i18n';
import { Button, Icon, cn } from '../ui';
import { PaEmptyChat } from './PaEmptyChat';
import { PaMessage } from './PaMessage';
import { PaReceipt, PaTurnTail, tailKindOf } from './PaTurnTail';
import { usePa } from './pa-context';
import { buildTurns, needsSeparator, separatorLabel } from './pa-model';
import type { PaConversation, PaGroup, PaMessage as PaMessageRecord, PaTurn } from './pa-types';
import styles from './PaConversation.module.css';

/** The reader counts as "at the end" within this many pixels of the bottom (spec §6.5). */
const FOLLOW_SLACK = 120;
/** An element first seen within this window of the current render plays its entrance. */
const ENTER_WINDOW = 400;

function flash(node: HTMLElement) {
  node.removeAttribute('data-flash');
  void node.offsetWidth;
  node.setAttribute('data-flash', '');
  window.setTimeout(() => node.removeAttribute('data-flash'), 650);
}

function findBy(root: HTMLElement | null, attribute: 'taskId' | 'messageId', value: string): HTMLElement | null {
  if (!root) return null;
  const selector = attribute === 'taskId' ? '[data-task-id]' : '[data-message-id]';
  for (const node of root.querySelectorAll<HTMLElement>(selector)) if (node.dataset[attribute] === value) return node;
  return null;
}

function roleOf(group: PaGroup | null, turn: PaTurn, senderId: string): 'moderator' | 'reviewer' | null {
  if (!group || senderId === 'owner') return null;
  const task = turn.task;
  if (task?.kind === 'project' && task.participantIds.length > 1) {
    if (task.participantIds[task.participantIds.length - 1] === senderId) return 'reviewer';
  }
  if (group.moderatorId === senderId) return 'moderator';
  const reviewer =
    group.reviewerId ??
    (group.mode === 'review' ? [...group.memberIds].reverse().find((id) => id !== group.moderatorId) ?? null : null);
  return reviewer === senderId ? 'reviewer' : null;
}

export function PaTranscript({ conversation, followNonce }: { conversation: PaConversation; followNonce: number }) {
  const t = useT();
  const { locale } = useI18n();
  const { index, ui, now, layout } = usePa();
  const turns = useMemo(() => buildTurns(index, conversation.id), [index, conversation.id]);
  const group =
    index.groupByConversation.get(conversation.id) ??
    (conversation.groupId ? index.groups.get(conversation.groupId) ?? null : null);
  const clustered = group != null;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const forceFollow = useRef(false);
  const positions = useRef(new Map<string, { top: number; atEnd: boolean }>());
  const shownConversation = useRef<string | null>(null);
  const shownCount = useRef(0);
  const handledFocus = useRef<number | null>(null);
  const [pill, setPill] = useState(false);
  const jump = usePresence(pill, 150);

  /* Entrance bookkeeping: the first render of a conversation marks everything as history. */
  const seen = useRef<{ conversationId: string | null; at: Map<string, number> }>({ conversationId: null, at: new Map() });
  const renderAt = Date.now();
  const history = seen.current.conversationId !== conversation.id;
  if (history) seen.current = { conversationId: conversation.id, at: new Map() };
  const entering = (key: string): boolean => {
    const map = seen.current.at;
    let at = map.get(key);
    if (at === undefined) {
      at = history ? 0 : renderAt;
      map.set(key, at);
    }
    return renderAt - at < ENTER_WINDOW;
  };

  const messageCount = turns.reduce((count, turn) => count + turn.messages.length, 0);
  const signature = turns
    .map((turn) => `${turn.key}:${turn.messages.length}:${turn.task?.status ?? ''}:${turn.task?.updatedAt ?? ''}:${turn.attempts.length}`)
    .join('|');

  const scrollToEnd = useCallback((smooth = false) => {
    endRef.current?.scrollIntoView?.({ block: 'end', behavior: smooth ? 'smooth' : 'auto' });
    nearBottom.current = true;
  }, []);

  /* Conversation switch: restore the remembered position, or land on the end the first time. */
  useLayoutEffect(() => {
    const saved = positions.current.get(conversation.id);
    const scroller = scrollerRef.current;
    if (saved && !saved.atEnd && scroller) {
      scroller.scrollTop = saved.top;
      nearBottom.current = false;
    } else {
      scrollToEnd();
    }
    setPill(false);
    shownConversation.current = conversation.id;
    shownCount.current = messageCount;
    // messageCount is read as of the switch; later growth is the content effect's business.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id, scrollToEnd]);

  /* New content: follow when the reader was at the end (or just sent); otherwise offer the pill. */
  useLayoutEffect(() => {
    if (shownConversation.current !== conversation.id) return;
    const grew = messageCount > shownCount.current;
    shownCount.current = messageCount;
    if (forceFollow.current) {
      scrollToEnd();
      if (grew) forceFollow.current = false;
    } else if (nearBottom.current) {
      scrollToEnd();
    } else if (grew) {
      setPill(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  /* A successful send always brings the reader to the end, and keeps following until the message lands. */
  useEffect(() => {
    if (followNonce === 0) return;
    forceFollow.current = true;
    setPill(false);
    scrollToEnd();
  }, [followNonce, scrollToEnd]);

  /* Growth that is not new data (a card unfolding, the composer growing) keeps an end-reader at the end. */
  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) scrollToEnd();
    });
    observer.observe(scroller);
    observer.observe(content);
    return () => observer.disconnect();
  }, [conversation.id, scrollToEnd]);

  /* nav.openTaskTurn: scroll the turn into view and flash it, once per request. */
  const focus = ui.focusTurn;
  useEffect(() => {
    if (!focus || handledFocus.current === focus.nonce) return;
    const node = findBy(scrollerRef.current, 'taskId', focus.taskId);
    if (!node) return;
    handledFocus.current = focus.nonce;
    node.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    flash(node);
  }, [focus, signature]);

  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    nearBottom.current = distance <= FOLLOW_SLACK;
    positions.current.set(conversation.id, { top: scroller.scrollTop, atEnd: nearBottom.current });
    if (nearBottom.current && pill) setPill(false);
  };

  const onJump = useCallback((messageId: string) => {
    const node = findBy(scrollerRef.current, 'messageId', messageId);
    if (!node) return;
    node.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    flash(node);
  }, []);

  let previousAt: number | null = null;
  const lastIndex = turns.length - 1;
  const items = turns.map((turn, turnIndex) => {
    const firstAt = turn.messages[0]?.createdAt ?? turn.startedAt;
    const separator = needsSeparator(previousAt, firstAt) ? separatorLabel(firstAt, now, locale, t) : null;
    previousAt = turn.messages[turn.messages.length - 1]?.createdAt ?? firstAt;
    const latest = turnIndex === lastIndex;
    const tailKind = turn.task ? tailKindOf(turn.task) : null;
    const tailEntering = turn.task ? entering(`tail:${turn.key}:${tailKind}`) : false;
    const lastMessage = turn.messages[turn.messages.length - 1];
    // A discussion receipt joins the last reply's footer row instead of adding a row of its own under it.
    const receiptInline = tailKind === 'receipt' && lastMessage != null && lastMessage.senderId !== 'owner';
    return (
      <Fragment key={turn.key}>
        {separator ? <p className={cn('text-caption text-ink-faint', styles.separator)}>{separator}</p> : null}
        <section
          className={styles.turn}
          data-testid="pa-turn"
          data-task-id={turn.task?.id}
          data-latest={latest ? '' : undefined}
        >
          {turn.messages.map((message: PaMessageRecord, i) => (
            <PaMessage
              key={message.id}
              message={message}
              conversationId={conversation.id}
              clustered={clustered}
              clusterStart={i === 0 || turn.messages[i - 1]!.senderId !== message.senderId}
              role={roleOf(group, turn, message.senderId)}
              attempts={turn.attempts}
              entering={entering(`m:${message.id}`)}
              onJump={onJump}
              receipt={
                receiptInline && turn.task && message === lastMessage ? (
                  <PaReceipt task={turn.task} turn={turn} latest={latest} entering={tailEntering} />
                ) : undefined
              }
            />
          ))}
          {turn.task ? (
            <PaTurnTail
              turn={turn}
              conversation={conversation}
              latest={latest}
              entering={tailEntering}
              receiptInline={receiptInline}
            />
          ) : null}
        </section>
      </Fragment>
    );
  });

  return (
    <div className={styles.transcriptWrap}>
      <div ref={scrollerRef} className={styles.transcript} data-testid="pa-transcript" onScroll={onScroll}>
        <div
          key={conversation.id}
          ref={contentRef}
          className={styles.column}
          data-narrow={layout.width < 900 ? '' : undefined}
          data-switch=""
        >
          {turns.length === 0 ? <PaEmptyChat conversation={conversation} /> : items}
          <div ref={endRef} className={styles.endAnchor} aria-hidden />
        </div>
      </div>
      {jump.mounted ? (
        <div className={styles.jump} data-state={jump.closing ? 'closed' : 'open'}>
          <Button
            size="sm"
            variant="default"
            className={styles.jumpButton}
            data-testid="pa-jump-latest"
            onClick={() => {
              setPill(false);
              scrollToEnd(true);
            }}
          >
            <Icon icon={ArrowDown} size="sm" />
            {t('pa.chat.jumpLatest')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
