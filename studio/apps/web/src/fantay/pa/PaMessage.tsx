// SPDX-License-Identifier: AGPL-3.0-only
// One transcript message (spec §6.3). The owner writes in an ink bubble (plain text, never Markdown); agents
// answer as prose on the page. In groups an agent cluster opens with a 20 px header row (avatar, name, role
// badge, model) and its prose is indented under the name. A hover row carries reply / copy / full output / time.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { BookMarked, Check, Copy, CornerUpLeft, FileText, PencilLine } from 'lucide-react';

import { copyToClipboard } from '../../lib/copy-to-clipboard';
import { useI18n, useT } from '../../i18n';
import { Button, Dot, Icon, IconButton, Popover, PopoverContent, PopoverTrigger, Tooltip, cn, toast } from '../ui';
import { PaAvatar } from './PaAvatar';
import { PaMarkdown } from './PaMarkdown';
import { PaViewCard } from './PaViewCard';
import { PaReceipt, PaTurnTail, agentName, tailKindOf } from './PaTurnTail';
import { usePa } from './pa-context';
import { isFantay, memoryScopeName, unwrapStructured } from './pa-model';
import type { PaAttempt, PaConversation, PaGroup, PaMessage as PaMessageRecord, PaTurn } from './pa-types';
import styles from './PaConversation.module.css';

/** Replies longer than this are clamped to 24 lines behind a fade (spec §6.3). */
const LONG_REPLY = 4000;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const timeFormats = new Map<string, { short: Intl.DateTimeFormat; full: Intl.DateTimeFormat }>();
function formatsFor(locale: string) {
  let formats = timeFormats.get(locale);
  if (!formats) {
    formats = {
      short: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
      full: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    };
    timeFormats.set(locale, formats);
  }
  return formats;
}

function plainText(content: string): string {
  const parsed = unwrapStructured(content);
  if (parsed.kind === 'text') return parsed.text;
  return [parsed.summary, ...parsed.issues.map((issue) => `- ${issue}`)].join('\n');
}

/** One readable line from an agent reply, for quotes and the reply chip: no `###`, `**`, fences or link syntax,
 *  and a structured review reads as its summary (the same reduction the roster preview applies). */
export function plainLine(content: string): string {
  const parsed = unwrapStructured(content);
  const text = parsed.kind === 'structured' ? parsed.summary : parsed.text;
  return text
    .replace(/```[\w-]*\n?/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface PaMessageProps {
  message: PaMessageRecord;
  conversationId: string;
  /** Group layout: cluster headers and indented prose. */
  clustered: boolean;
  clusterStart: boolean;
  role: 'moderator' | 'reviewer' | null;
  /** The turn's attempts, for the sender name of an agent that no longer exists. */
  attempts: PaAttempt[];
  entering: boolean;
  onJump(messageId: string): void;
  /** The turn's receipt, when this is the turn's last reply: it shares the footer row with the hover actions,
   *  so an earlier turn does not reserve two invisible rows (spec §6.4 receipt, §6.3 hover row). */
  receipt?: ReactNode;
}

export function PaMessage(props: PaMessageProps) {
  return props.message.senderId === 'owner' ? <OwnerMessage {...props} /> : <AgentMessage {...props} />;
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

export interface PaTurnBodyProps {
  turn: PaTurn;
  conversation: PaConversation;
  group: PaGroup | null;
  latest: boolean;
  /** The transcript's entrance bookkeeping: true while the keyed element is new. */
  entering(key: string): boolean;
  onJump(messageId: string): void;
}

/** One turn's messages and its tail (spec §6.3, §6.4). The work transcript renders every turn with it; a companion
 *  transcript renders its work turns with it inside the task block (Soul UI spec §4.4.14). */
export function PaTurnBody({ turn, conversation, group, latest, entering, onJump }: PaTurnBodyProps) {
  const tailKind = turn.task ? tailKindOf(turn.task) : null;
  const tailEntering = turn.task ? entering(`tail:${turn.key}:${tailKind}`) : false;
  const lastMessage = turn.messages[turn.messages.length - 1];
  // A discussion receipt joins the last reply's footer row instead of adding a row of its own under it.
  const receiptInline = tailKind === 'receipt' && lastMessage != null && lastMessage.senderId !== 'owner';
  return (
    <>
      {turn.messages.map((message, i) => (
        <PaMessage
          key={message.id}
          message={message}
          conversationId={conversation.id}
          clustered={group != null}
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
        <PaTurnTail turn={turn} conversation={conversation} latest={latest} entering={tailEntering} receiptInline={receiptInline} />
      ) : null}
    </>
  );
}

function HoverRow({ message, conversationId, reply }: { message: PaMessageRecord; conversationId: string; reply: boolean }) {
  const t = useT();
  const { locale } = useI18n();
  const { nav } = usePa();
  const formats = formatsFor(locale);
  const at = new Date(message.createdAt);
  const copy = async () => {
    const ok = await copyToClipboard(plainText(message.content));
    if (ok) toast({ tone: 'success', title: t('pa.chat.copied') });
  };
  const taskId = message.taskId;
  const attemptId = message.attemptId;
  return (
    <div className={styles.hoverRow}>
      {reply ? (
        <IconButton
          size="xs"
          variant="quiet"
          aria-label={t('pa.reply')}
          onClick={() => nav.fillComposer(conversationId, { replyTo: message.id, ...(message.dataClass === 'local_only' ? { localOnly: true } : {}) })}
        >
          <Icon icon={CornerUpLeft} size="sm" />
        </IconButton>
      ) : null}
      <IconButton size="xs" variant="quiet" aria-label={t('pa.chat.copy')} onClick={() => void copy()}>
        <Icon icon={Copy} size="sm" />
      </IconButton>
      {attemptId && taskId ? (
        <IconButton
          size="xs"
          variant="quiet"
          aria-label={t('pa.chat.fullOutput')}
          onClick={() => nav.openModal({ kind: 'task', taskId, output: attemptId })}
        >
          <Icon icon={FileText} size="sm" />
        </IconButton>
      ) : null}
      <Tooltip label={formats.full.format(at)}>
        <time dateTime={at.toISOString()} className={cn('text-caption text-ink-faint', styles.time)}>
          {formats.short.format(at)}
        </time>
      </Tooltip>
    </div>
  );
}

function OwnerMessage({ message, conversationId, clusterStart, entering, onJump }: PaMessageProps) {
  const t = useT();
  const { index } = usePa();
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const node = textRef.current;
    if (!node || expanded) return;
    const measure = () => setOverflowing(node.scrollHeight - node.clientHeight > 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [message.content, expanded]);

  const parent = message.replyTo ? index.messages.get(message.replyTo) ?? null : null;
  const parentName = parent
    ? parent.senderId === 'owner'
      ? t('pa.chat.you')
      : index.agents.get(parent.senderId)?.name ?? ''
    : '';
  const targets = message.targetAgentIds.map((id) => index.agents.get(id)?.name).filter(Boolean);

  return (
    <div
      className={styles.ownerMessage}
      data-message-id={message.id}
      data-cluster-start={clusterStart ? '' : undefined}
      data-enter={entering ? '' : undefined}
    >
      <div className={styles.ownerLine}>
        <HoverRow message={message} conversationId={conversationId} reply={false} />
        <div className={styles.bubble}>
          {message.routineId ? <div className="text-caption">{t('pa.work.routineSource')}</div> : null}
          {parent ? (
            <Button variant="bare" className={styles.quote} onClick={() => onJump(parent.id)}>
              {t('pa.chat.replyTo', {
                name: parentName,
                text: clip(parent.senderId === 'owner' ? parent.content : plainLine(parent.content), 60),
              })}
            </Button>
          ) : null}
          <div ref={textRef} className={styles.bubbleText} data-clamped={expanded ? undefined : ''}>
            {message.content}
          </div>
        </div>
      </div>
      {overflowing || expanded ? (
        <Button variant="link" size="sm" className={styles.expandLink} onClick={() => setExpanded((open) => !open)}>
          {expanded ? t('pa.chat.collapse') : t('pa.chat.expand')}
        </Button>
      ) : null}
      {targets.length > 0 ? <p className={styles.toCaption}>{t('pa.chat.to', { names: targets.join('、') })}</p> : null}
    </div>
  );
}

function AgentBody({ content }: { content: string }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const parsed = unwrapStructured(content);
  const long = content.length > LONG_REPLY;
  const clamped = long && !expanded;
  return (
    <>
      <div className={styles.prose} data-clamped={clamped ? '' : undefined}>
        {parsed.kind === 'structured' ? (
          <>
            {parsed.approved !== null ? (
              parsed.approved && parsed.issues.length === 0 ? (
                <p className={styles.verdict} data-tone="passed">
                  <Icon icon={Check} size={14} />
                  {t('pa.chat.reviewPassed')}
                </p>
              ) : (
                <p className={styles.verdict} data-tone="changes">
                  <Icon icon={PencilLine} size={14} />
                  {t('pa.chat.reviewChanges', { count: parsed.issues.length })}
                </p>
              )
            ) : null}
            <PaMarkdown text={parsed.summary} />
            {parsed.issues.length > 0 ? (
              <div className={styles.issues}>
                <p className={styles.issuesHead}>{t('pa.chat.toImprove')}</p>
                <ul className={styles.issueList}>
                  {parsed.issues.map((issue, i) => (
                    <li key={i} className={styles.issue}>
                      <Dot size="sm" className={styles.issueDot} />
                      <span>{issue}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : (
          <PaMarkdown text={parsed.text} />
        )}
      </div>
      {clamped ? (
        <Button variant="link" size="sm" className={styles.expandLink} onClick={() => setExpanded(true)}>
          {t('pa.chat.expandAll')}
        </Button>
      ) : null}
    </>
  );
}

function MemoryEvidence({ refs }: { refs: Array<{ id: string; revision: number }> }) {
  const t = useT();
  const { index, nav, projects } = usePa();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="link" size="sm" className={styles.memoryLink}>
          <Icon icon={BookMarked} size={13} />
          {t('pa.chat.usedMemories', { count: refs.length })}
        </Button>
      </PopoverTrigger>
      <PopoverContent width="md" align="start" className={styles.memoryPopover}>
        <ul className={styles.memoryList}>
          {refs.map((ref) => {
            const memory = index.memories.get(ref.id);
            if (!memory) {
              return (
                <li key={ref.id} className={styles.memoryMissing}>
                  {t('pa.memory.deletedTarget')}
                </li>
              );
            }
            return (
              <li key={ref.id}>
                <Button
                  variant="bare"
                  className={styles.memoryItem}
                  onClick={() => {
                    setOpen(false);
                    nav.openModal({ kind: 'memory', memoryId: memory.id });
                  }}
                >
                  <span className={styles.memoryScope}>
                    {memoryScopeName(index, memory, projects, t)}
                    {memory.revision > ref.revision ? ` · ${t('pa.chat.memoryUpdated')}` : ''}
                  </span>
                  <span className={styles.memoryText}>{memory.content.split('\n').find((line) => line.trim()) ?? ''}</span>
                </Button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function AgentMessage({ message, conversationId, clustered, clusterStart, role, attempts, entering, receipt }: PaMessageProps) {
  const t = useT();
  const { index, nav } = usePa();
  const agent = index.agents.get(message.senderId) ?? null;
  const name = agentName(index, attempts, message.senderId);
  const refs = message.memoryRefs ?? [];
  const openView = message.viewCard?.interactive && message.taskId &&
    index.tasks.get(message.taskId)?.pendingView?.attemptId === message.attemptId &&
    index.tasks.get(message.taskId)?.status === 'waiting';
  return (
    <div
      className={styles.agentMessage}
      data-message-id={message.id}
      data-cluster-start={clusterStart ? '' : undefined}
      data-enter={entering ? '' : undefined}
    >
      {clustered && clusterStart ? (
        <div className={styles.clusterHead}>
          {agent ? (
            <Button
              variant="bare"
              data-testid="pa-message-agent"
              className={styles.clusterAgent}
              onClick={() => nav.inspectAgent(agent.id)}
            >
              <PaAvatar agent={agent} size={20} fantay={isFantay(index, message.senderId)} disc={false} />
              <span className={styles.clusterName}>{name}</span>
            </Button>
          ) : (
            <>
              <PaAvatar agent={null} size={20} fantay={false} disc={false} />
              <span className={styles.clusterName}>{name}</span>
            </>
          )}
          {role ? (
            <span className={styles.roleBadge}>
              {role === 'moderator' ? t('pa.chat.roleModerator') : t('pa.chat.roleReviewer')}
            </span>
          ) : null}
          {message.model?.modelId ? (
            <span className={styles.clusterModel}>
              {/* The same readable label the header and inspector use ("Claude Sonnet"), not the raw id. */}
              {index.models.get(`${message.model.runtime}/${message.model.modelId}`)?.label || message.model.modelId}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className={clustered ? styles.indent : undefined}>
        {message.viewCard
          ? openView ? null : <PaViewCard card={message.viewCard} answer={message.viewAnswer} />
          : <AgentBody content={message.content} />}
        {/* Evidence belongs to the text it supports: its own line under the prose, at the start, always visible,
            never mixed with the hover chrome (an earlier turn's hidden receipt would push it off the edge). */}
        {refs.length > 0 ? (
          <div className={styles.evidence}>
            <MemoryEvidence refs={refs} />
          </div>
        ) : null}
        <div className={styles.agentFoot}>
          {receipt}
          <HoverRow message={message} conversationId={conversationId} reply />
        </div>
      </div>
    </div>
  );
}
