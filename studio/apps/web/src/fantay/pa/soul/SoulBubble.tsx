// SPDX-License-Identifier: AGPL-3.0-only
// One message of a companion transcript (Soul UI spec §4.4.3–4.4.13): its bubbles (an IM reply split for display,
// narration-only parts unboxed), the hover pill beside the last bubble, the context menu, and the lines that belong to
// the message rather than to a split bubble — the hidden caption, the variant bar (‹ 2/3 ›, 换个说法, 接着说), 想记下,
// the state delta, the failed-turn line and the care card. The stored message always stays whole.
// Stage 2 (STAGE2 5.8): the voice bar of a reply whose audio was really generated (or is being generated after a
// click), inside its last boxed bubble, or on the paper under the parts in the journal and for a narration-only reply.
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore, type KeyboardEvent } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Copy, CornerDownRight, EyeOff, RotateCw, Send, Trash2 } from 'lucide-react';

import { useT } from '../../../i18n';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  cn,
} from '../../ui';
import { PaRequestError, paSoulSpeechUrl } from '../pa-api';
import { errorToast } from '../PaTurnTail';
import { usePa } from '../pa-context';
import { newRequestId } from '../pa-model';
import type { PaConversation, PaGroup, PaMessage, PaTask, TFn } from '../pa-types';
import { paPendingKey } from '../usePaWorkspace';
import { SoulCandidateRow } from './SoulCandidateRow';
import { SoulCareCard } from './SoulCareCard';
import { SoulContextMenu, SoulMessagePill, copySoulText, soulNameFor, useSoulMessageMenu } from './SoulMessageMenu';
import { SoulBubbleFrame, SoulDeltaRow, SoulMetaLine, SoulNarration, SoulVoiceBar } from './SoulPrimitives';
import { SoulRoleplayText, isNarrationOnly } from './SoulRoleplayText';
import { revealSoulMessage, useSoulCompose, type SoulPendingSend } from './soul-compose';
import { activeChatTask, canRegenerate, chatOf, displayName, replyEffects, type PaSoulItem } from './soul-model';
import { soulAudio, useSoulAudio, type SoulSpeechEntry, type useSoulSpeech } from './soul-voice';
import { soulBubbles, useSoulReveal } from './useSoulReveal';
import styles from './SoulTranscript.module.css';

type Position = 'single' | 'first' | 'middle' | 'last';
const MINUS = '−';

const FENCE = /^ {0,3}(?:```|~~~)/m;
const TABLE = /^\s*\|.*\|\s*$\n^\s*\|?[\s:|-]*-{3,}/m;
const LIST_LINES = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/gm;

/** A reply kept whole because it is a table, a list or a code fence: it may use the whole text column. */
function isRich(text: string): boolean {
  return FENCE.test(text) || TABLE.test(text) || (text.match(LIST_LINES)?.length ?? 0) >= 2;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/** The delta line text: number ±n with a true minus, text and enum as label → value, lists as 获得 / 失去 per item. */
export function deltaText(t: TFn, effects: ReturnType<typeof replyEffects>): string {
  const parts: string[] = [];
  for (const effect of effects) {
    if (effect.kind === 'number' && typeof effect.delta === 'number') {
      const amount = formatNumber(Math.abs(effect.delta));
      parts.push(`${effect.label} ${effect.delta > 0 ? '+' : MINUS}${amount}`);
    } else if (effect.kind === 'list') {
      for (const item of effect.added ?? []) parts.push(t('pa.soul.chat.delta.gain', { item }));
      for (const item of effect.removed ?? []) parts.push(t('pa.soul.chat.delta.lose', { item }));
    } else if (effect.value !== undefined) {
      const value = Array.isArray(effect.value) ? effect.value.join('、') : String(effect.value);
      parts.push(t('pa.soul.chat.delta.set', { label: effect.label, value }));
    }
  }
  return parts.join(' · ');
}

/** Corner shape of each boxed part: runs of boxed parts group, a narration line or a line under a message breaks them. */
function positionsOf(boxed: readonly boolean[], joinPrev: boolean, joinNext: boolean): Array<Position | null> {
  return boxed.map((isBoxed, index) => {
    if (!isBoxed) return null;
    const prev = index > 0 ? boxed[index - 1]! : joinPrev;
    const next = index < boxed.length - 1 ? boxed[index + 1]! : joinNext;
    if (prev) return next ? 'middle' : 'last';
    return next ? 'first' : 'single';
  });
}

/** The bubbles a message shows: an agent reply or greeting split when the preset is IM with several bubbles; an owner
 *  message is always one. Memoised per message id and text. */
export function soulPartsOf(message: PaMessage, split: boolean): readonly string[] {
  const parts = split && message.senderId !== 'owner' ? soulBubbles(message.id, message.content) : null;
  return parts && parts.length > 0 ? parts : [message.content];
}

export interface SoulMessageItemProps {
  item: PaSoulItem;
  conversation: PaConversation;
  room: PaGroup | null;
  side: 'in' | 'out';
  /** The bubbles of this item continue the run of the previous / next item in the cluster. */
  joinPrev: boolean;
  joinNext: boolean;
  /** The newest item of the transcript (换个说法 and 接着说 live under it). */
  newest: boolean;
  /** A later visible item exists (a greeting's variant arrows lock then). */
  laterVisible: boolean;
  split: boolean;
  entering: boolean;
  /** Pace a fresh reply bubble by bubble (read once, on first render). */
  paced: boolean;
  /** A regenerate of this slot runs: the old variant dims. */
  dimmed: boolean;
  /** The failed chat turn of an owner line: 重试 (the newest) or 重新发送 (an older one). */
  failure: { task: PaTask; retry: boolean } | null;
  /** The chat is in the journal layout (手帐): the voice bar sits on the paper under the parts. */
  journal?: boolean;
}

export function SoulMessageItem({
  item,
  conversation,
  room,
  side,
  joinPrev,
  joinNext,
  newest,
  laterVisible,
  split,
  entering,
  paced,
  dimmed,
  failure,
  journal = false,
}: SoulMessageItemProps) {
  const t = useT();
  const { index, data, nav } = usePa();
  const rootRef = useRef<HTMLDivElement>(null);
  const menu = useSoulMessageMenu({ item, conversation, room, rootRef });
  // Voice: only a boolean of the audio store is read here (whether this message owns the player), so playback ticks
  // re-render the one bar, not every item.
  const { gate, speech } = menu.voice;
  const playerHere = useSyncExternalStore(
    soulAudio.subscribe,
    () => soulAudio.get().messageId === item.message.id,
    () => false,
  );
  const voiceEntry = gate && gate.kind !== 'off' ? speech.entry(item.message) : null;
  const voiceShown = voiceEntry !== null && voiceEntry.phase !== 'none';
  // Audio that no longer matches the reply (edited, the voice changed, 语音回复 turned 关) has no bar, so it stops.
  useLayoutEffect(() => {
    if (playerHere && !voiceShown) soulAudio.stop();
  }, [playerHere, voiceShown]);
  const compose = useSoulCompose(conversation.id);
  const message = item.message;
  const owner = message.senderId === 'owner';
  const name = soulNameFor(index, conversation, room, item);
  const parts = soulPartsOf(message, split);
  const visible = useSoulReveal(message.id, parts, paced);
  const revealed = visible >= parts.length;
  const narration = useMemo(() => parts.map((part) => isNarrationOnly(part)), [parts]);
  const shown = parts.slice(0, visible);
  const boxed = narration.slice(0, visible).map((isNarration) => !isNarration);
  const editing = compose.chip?.kind === 'edit' && compose.chip.messageId === message.id;

  // Lines that sit under the message break the bubble run into the next item.
  const effects = !owner && revealed ? replyEffects(index, conversation, item) : [];
  const rich = parts.length === 1 && !owner && isRich(parts[0] ?? '');
  const positions = positionsOf(boxed, joinPrev, joinNext && revealed);
  // The voice bar goes inside the reply's last boxed part (once that part is on screen); in the journal, or for a reply
  // that is narration only, it sits on the paper under the parts.
  const barAt = journal ? -1 : narration.lastIndexOf(false);
  const voiceBar = (surface: 'bubble' | 'paper') =>
    voiceShown && voiceEntry ? <SoulMessageVoice messageId={message.id} entry={voiceEntry} speech={speech} surface={surface} /> : null;

  /* Variant switch: the incoming variant slides in from the direction of travel. */
  const lastIndex = useRef(item.variantIndex);
  const direction = item.variantIndex > lastIndex.current ? 'next' : item.variantIndex < lastIndex.current ? 'prev' : null;
  useLayoutEffect(() => {
    lastIndex.current = item.variantIndex;
  }, [item.variantIndex]);

  // With variants the counter leads the lines under the reply; a bar that holds only the hover actions (换个说法,
  // 接着说) goes last, so its resting space never opens a gap above the delta or 想记下 line.
  const counterFirst = item.variantCount > 1;
  const variantBar = <SoulVariantBar item={item} conversation={conversation} room={room} newest={newest} laterVisible={laterVisible} />;

  const parent = message.replyTo ? index.messages.get(message.replyTo) ?? null : null;
  const parentName = parent ? (parent.senderId === 'owner' ? t('pa.chat.you') : displayName(index, parent.senderId)) : '';

  return (
    <>
      <SoulContextMenu actions={menu.actions} onOpen={menu.captureSelection}>
        <div
          ref={rootRef}
          className={styles.item}
          data-side={side}
          data-message-id={message.id}
          data-hidden={item.hidden ? '' : undefined}
          data-testid="pa-soul-item"
        >
          <div key={message.id} className={styles.parts} data-dir={direction ?? undefined}>
            {shown.map((part, partIndex) => {
              const last = partIndex === shown.length - 1;
              const position = positions[partIndex];
              const quote =
                partIndex === 0 && parent ? (
                  <Button variant="bare" className={styles.quote} onClick={() => revealSoulMessage(parent.id)}>
                    {t('pa.chat.replyTo', { name: parentName, text: clip(parent.content, 60) })}
                  </Button>
                ) : null;
              const body =
                position === null || position === undefined ? (
                  <SoulNarration side={side}>
                    <SoulRoleplayText text={part} side={side} markdown={!owner} markupLabel={t('pa.soul.chat.markupFold')} />
                  </SoulNarration>
                ) : (
                  <SoulBubbleFrame
                    side={side}
                    position={position}
                    hidden={item.hidden}
                    editing={editing}
                    dimmed={dimmed}
                    rich={rich}
                    entering={entering || (paced && partIndex > 0)}
                  >
                    {quote}
                    <SoulRoleplayText text={part} side={side} markdown={!owner} markupLabel={t('pa.soul.chat.markupFold')} />
                    {partIndex === barAt ? voiceBar('bubble') : null}
                  </SoulBubbleFrame>
                );
              return (
                <div key={partIndex} className={styles.partRow} data-side={side}>
                  {body}
                  {last ? <SoulMessagePill message={message} actions={menu.actions} side={side} onOpen={menu.captureSelection} /> : null}
                </div>
              );
            })}
          </div>
          {revealed ? (
            <>
              {barAt < 0 && voiceShown ? (
                <div className={styles.lineWrap} data-testid="pa-soul-voice-line">
                  {voiceBar('paper')}
                </div>
              ) : null}
              {item.hidden ? (
                <div className={styles.lineWrap} data-testid="pa-soul-hidden">
                  <SoulMetaLine align={side === 'out' ? 'end' : 'start'}>
                    <Icon icon={EyeOff} size={12} />
                    <span>{t('pa.soul.chat.hidden.caption', { name })}</span>
                    <Button variant="link" size="sm" onClick={() => void data.actions.editMessage(message, { hidden: false }).catch(errorToast)}>
                      {t('pa.soul.chat.hidden.restore')}
                    </Button>
                  </SoulMetaLine>
                </div>
              ) : null}
              {counterFirst ? variantBar : null}
              {!owner ? <SoulCandidateRow messageId={message.id} name={name} /> : null}
              {effects.length > 0 ? (
                <SoulDeltaRow
                  onClick={() => nav.setInspector(true, 'scene')}
                  ariaLabel={`${deltaText(t, effects)} · ${t('pa.soul.chat.delta.open')}`}
                >
                  {deltaText(t, effects)}
                </SoulDeltaRow>
              ) : null}
              {owner && failure ? <SoulFailedLine conversation={conversation} message={message} failure={failure} /> : null}
              {owner && message.soul?.care === 'crisis' ? <SoulCareCard messageId={message.id} /> : null}
              {counterFirst ? null : variantBar}
            </>
          ) : null}
        </div>
      </SoulContextMenu>
      {menu.dialog}
    </>
  );
}

/** The voice bar of one reply: 正在生成语音… while its audio is generated, 语音没有生成 · 重试 when that failed, else the
 *  player for the generated file. Only this component follows the audio store's ticks. */
function SoulMessageVoice({
  messageId,
  entry,
  speech,
  surface,
}: {
  messageId: string;
  entry: SoulSpeechEntry;
  speech: ReturnType<typeof useSoulSpeech>;
  surface: 'bubble' | 'paper';
}) {
  const t = useT();
  const audio = useSoulAudio();
  const mine = audio.messageId === messageId;
  const url = entry.item ? paSoulSpeechUrl(entry.item.id) : null;
  // A file that is loading after play was pressed reads as playing (the button offers pause), as a native player does;
  // "generating" is said only while the daemon really generates.
  const state =
    entry.phase === 'generating'
      ? 'loading'
      : entry.phase === 'failed'
        ? 'error'
        : mine
          ? audio.phase === 'loading'
            ? 'playing'
            : audio.phase
          : 'idle';
  return (
    <SoulVoiceBar
      state={state}
      currentTime={mine ? audio.currentTime : 0}
      duration={mine ? audio.duration : null}
      onToggle={() => (url ? soulAudio.toggle(messageId, url) : soulAudio.pause())}
      onSeek={(ratio) => {
        if (mine) soulAudio.seek(ratio);
      }}
      onRetry={() => void speech.speak(messageId)}
      surface={surface}
      side="in"
      labels={{
        play: t('pa.soul.chat.voice.play'),
        pause: t('pa.soul.chat.voice.pause'),
        seek: t('pa.soul.chat.voice.seek'),
        loading: t('pa.soul.chat.voice.generating'),
        error: t('pa.soul.chat.voice.failed'),
        retry: t('pa.state.retry'),
        ...(mine && audio.blocked ? { blocked: t('pa.soul.chat.voice.blocked') } : {}),
      }}
    />
  );
}

/** ‹ 2/3 › (always, when there are variants), then 换个说法 and 接着说 under the newest reply (on hover or focus). */
function SoulVariantBar({
  item,
  conversation,
  room,
  newest,
  laterVisible,
}: {
  item: PaSoulItem;
  conversation: PaConversation;
  room: PaGroup | null;
  newest: boolean;
  laterVisible: boolean;
}) {
  const t = useT();
  const { index, data } = usePa();
  const cid = conversation.id;
  const greeting = item.role === 'greeting';
  const busy = activeChatTask(index, cid) !== null;
  const switching = data.pending.has(paPendingKey.soulMessage(item.root.id));
  const turnPending = data.pending.has(paPendingKey.soulTurn(cid));
  const counter = item.variantCount > 1;
  const regenerate = newest && canRegenerate(index, cid, item);
  const manualRoom = room !== null && chatOf(index, cid).groupStrategy === 'manual';
  const goOn =
    newest && !item.hidden && !busy && !manualRoom && (greeting || (item.role === 'agent' && item.message.soul?.kind === 'chat'));
  if (!counter && !regenerate && !goOn) return null;

  const locked = greeting && laterVisible;
  const canPrev = counter && !locked && !busy && item.variantIndex > 0;
  const canNext = counter && !locked && !busy && item.variantIndex < item.variantCount - 1;
  const select = (step: -1 | 1) => {
    const target = item.variantIndex + step;
    if (target < 0 || target >= item.variantCount || switching) return;
    const choice = greeting ? { greetingIndex: target } : { messageId: item.variants[target]?.id ?? '' };
    if ('messageId' in choice && !choice.messageId) return;
    void data.actions.selectVariant(item.root.id, choice).catch(errorToast);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' && canPrev) {
      event.preventDefault();
      select(-1);
    } else if (event.key === 'ArrowRight' && canNext) {
      event.preventDefault();
      select(1);
    }
  };
  const tip = greeting ? t('pa.soul.chat.variant.greeting') : undefined;
  // The chevrons stay focusable at the ends (a reason makes them aria-disabled, not disabled), so ←/→ keep working.

  return (
    <div className={styles.variantBar} data-testid="pa-soul-variant-bar" onKeyDown={onKeyDown}>
      {counter ? (
        <span className={styles.variantSwitch}>
          <IconButton
            size="xs"
            className={styles.barIcon}
            aria-label={t('pa.soul.chat.variant.prev')}
            tooltip={tip ?? t('pa.soul.chat.variant.prev')}
            disabled={!canPrev}
            disabledReason={tip ?? t('pa.soul.chat.variant.prev')}
            onClick={() => select(-1)}
          >
            <Icon icon={ChevronLeft} size={14} />
          </IconButton>
          <span className={styles.variantCount} aria-live="polite">
            {item.variantIndex + 1}/{item.variantCount}
          </span>
          <IconButton
            size="xs"
            className={styles.barIcon}
            aria-label={t('pa.soul.chat.variant.next')}
            tooltip={tip ?? t('pa.soul.chat.variant.next')}
            disabled={!canNext}
            disabledReason={tip ?? t('pa.soul.chat.variant.next')}
            onClick={() => select(1)}
          >
            <Icon icon={ChevronRight} size={14} />
          </IconButton>
        </span>
      ) : null}
      {regenerate || goOn ? (
        <span className={styles.variantHover}>
          {regenerate ? (
            <Button
              variant="ghost"
              size="sm"
              className={styles.barButton}
              disabled={turnPending}
              data-testid="pa-soul-regenerate"
              onClick={() => void data.actions.regenerate(cid, item.message.id).catch(errorToast)}
            >
              <Icon icon={RotateCw} size={12} />
              {t('pa.soul.chat.variant.regenerate')}
            </Button>
          ) : null}
          {goOn ? (
            <Button
              variant="ghost"
              size="sm"
              className={styles.barButton}
              disabled={turnPending}
              data-testid="pa-soul-continue"
              onClick={() => void data.actions.continueChat(cid).catch(errorToast)}
            >
              <Icon icon={CornerDownRight} size={12} />
              {t('pa.soul.chat.variant.continue')}
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** 没有收到回复 under the owner line of a failed chat turn: 重试 for the newest one, 重新发送 for an older one. */
function SoulFailedLine({ conversation, message, failure }: { conversation: PaConversation; message: PaMessage; failure: { task: PaTask; retry: boolean } }) {
  const t = useT();
  const { data } = usePa();
  const reason = failure.task.error ? clip(failure.task.error, 40) : '';
  const onRetry = () =>
    void data.actions.resumeTask(failure.task.id).catch((error: unknown) => {
      if (error instanceof PaRequestError && error.code === 'PA_SOUL_STALE') errorToast(new Error(t('pa.soul.chat.failed.stale')));
      else errorToast(error);
    });
  const onResend = () =>
    void data.actions.sendChat({ conversationId: conversation.id, text: message.content, requestId: newRequestId() }).catch(errorToast);
  return (
    <div className={styles.lineWrap} data-testid="pa-soul-failed">
      <SoulMetaLine align="end" tone="failed">
        <span className={styles.lineText}>{reason ? t('pa.soul.chat.failed.reason', { reason }) : t('pa.soul.chat.failed.line')}</span>
        <Button variant="link" size="sm" onClick={failure.retry ? onRetry : onResend}>
          {failure.retry ? t('pa.state.retry') : t('pa.soul.chat.failed.resend')}
        </Button>
      </SoulMetaLine>
    </div>
  );
}

/** A failed chat turn with no owner line of its own (a 接着说 or 换个说法 that failed): the same line at the end. */
export function SoulOrphanFailure({ task }: { task: PaTask }) {
  const t = useT();
  const { data } = usePa();
  const reason = task.error ? clip(task.error, 40) : '';
  return (
    <div className={cn(styles.lineWrap, styles.orphanFailure)} data-testid="pa-soul-failed">
      <SoulMetaLine align="end" tone="failed">
        <span className={styles.lineText}>{reason ? t('pa.soul.chat.failed.reason', { reason }) : t('pa.soul.chat.failed.line')}</span>
        <Button
          variant="link"
          size="sm"
          onClick={() =>
            void data.actions.resumeTask(task.id).catch((error: unknown) => {
              if (error instanceof PaRequestError && error.code === 'PA_SOUL_STALE') errorToast(new Error(t('pa.soul.chat.failed.stale')));
              else errorToast(error);
            })
          }
        >
          {t('pa.state.retry')}
        </Button>
      </SoulMetaLine>
    </div>
  );
}

/** A send that is not in the snapshot yet: a faded outgoing bubble. When the POST failed it stays, with a danger
 *  glyph whose menu is 重发 · 复制 · 删除, and the line 没发出去; the text never returns to the input. */
export function SoulPendingBubble({ send, conversationId, position }: { send: SoulPendingSend; conversationId: string; position: Position }) {
  const t = useT();
  const { data } = usePa();
  const compose = useSoulCompose(conversationId);
  const resend = () => {
    compose.addPending({ ...send, failed: false });
    void data.actions
      .sendChat({ conversationId, text: send.text, requestId: send.requestId, ...(send.replyTo ? { replyTo: send.replyTo } : {}) })
      .catch(() => compose.failPending(send.requestId));
  };
  return (
    <div className={styles.item} data-side="out" data-testid="pa-soul-pending" data-failed={send.failed ? '' : undefined}>
      <div className={styles.parts}>
        <div className={styles.partRow} data-side="out">
          <SoulBubbleFrame side="out" position={position} pending entering>
            <SoulRoleplayText text={send.text} side="out" markdown={false} markupLabel={t('pa.soul.chat.markupFold')} />
          </SoulBubbleFrame>
          {send.failed ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton size="xs" variant="danger" aria-label={t('pa.soul.chat.unsent.menu')} className={styles.unsentButton}>
                  <Icon icon={AlertCircle} size={14} />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent width="sm" align="end">
                <DropdownMenuItem icon={<Icon icon={Send} size="sm" />} onSelect={resend}>
                  {t('pa.soul.chat.unsent.resend')}
                </DropdownMenuItem>
                <DropdownMenuItem icon={<Icon icon={Copy} size="sm" />} onSelect={() => void copySoulText(send.text, t('pa.chat.copied'))}>
                  {t('pa.chat.copy')}
                </DropdownMenuItem>
                <DropdownMenuItem icon={<Icon icon={Trash2} size="sm" />} tone="danger" onSelect={() => compose.dropPending(send.requestId)}>
                  {t('pa.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      {send.failed ? (
        <div className={styles.lineWrap}>
          <SoulMetaLine align="end" tone="failed">
            {t('pa.soul.chat.unsent.line')}
          </SoulMetaLine>
        </div>
      ) : null}
    </div>
  );
}
