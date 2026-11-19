// SPDX-License-Identifier: AGPL-3.0-only
// The companion transcript (Soul UI spec §4.3 b/c, §4.4): the intro, time separators, clusters of bubbles on the
// chat's paper, story cards, work turns boxed with a task chip, pending sends, the typing bubble of the real chat turn
// and the failed-turn line. Rendered for a companion chat, and for a work chat that has chat history (its chat turns
// keep their bubbles in the default skin, its work turns render as today).
//
// It owns its scroller like the work transcript (follow the end only when the reader is there, a jump pill otherwise,
// per-conversation positions), but it never calls `scrollIntoView`: following moves this scroller only, so the page
// around the workspace never shifts.
//
// Stage 2 (STAGE2 4.10, 5.8, 6.3, 8.4): the running reply's real partial text grows in the typing row as bubbles and
// gives way to the stored reply without a second reveal; a stopped or failed reply stays as a labelled draft that was
// not saved; 自动朗读 reads each fresh reply once; the standing picture takes the start of the column; the journal adds a
// head line over each incoming entry.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDown, ListChecks, X } from 'lucide-react';
import { SOUL_LIMITS, splitBubbles } from '@open-design/contracts/soul';

import { usePresence } from '../../../hooks/usePresence';
import { useI18n, useT } from '../../../i18n';
import { Button, Icon, IconButton, cn } from '../../ui';
import { PaTurnBody } from '../PaMessage';
import { errorToast } from '../PaTurnTail';
import { usePa } from '../pa-context';
import { isFantay, needsSeparator, separatorLabel } from '../pa-model';
import type { PaAttempt, PaConversation, PaGroup, PaIndex, PaTask, PaTurn } from '../pa-types';
import { SoulMessageItem, SoulOrphanFailure, SoulPendingBubble, soulPartsOf } from './SoulBubble';
import { copySoulText, soulShortTime } from './SoulMessageMenu';
import { SoulAgentPortrait } from './SoulPortrait';
import { SoulMetaLine, SoulSeparator, SoulTag, SoulTypingBubble } from './SoulPrimitives';
import { SoulRoleplayText, isNarrationOnly } from './SoulRoleplayText';
import { SoulStage } from './SoulStage';
import { SoulStoryCard } from './SoulStoryCard';
import { useSoulCompose, type SoulPendingSend } from './soul-compose';
import { dismissSoulLive, soulLiveDisplayText, soulLiveSeen, useSoulLive, useSoulLivePoll } from './soul-live';
import {
  activeChatTask,
  characterOf,
  chatOf,
  displayName,
  emotionOfReply,
  pendingCandidates,
  presetFor,
  relationshipFacts,
  replyEffects,
  resolveChatAppearance,
  retryableChatTask,
  shownSprite,
  soulItems,
  soulTurns,
  stageSpriteSrc,
  typingAgents,
  type PaSoulItem,
} from './soul-model';
import { SOUL_SAMPLE_AUDIO_ID, soulAudio, soulVoiceGate, useSoulSpeech, useSoulSpeechStatus } from './soul-voice';
import { skipSoulReveal } from './useSoulReveal';
import convStyles from '../PaConversation.module.css';
import paperStyles from './SoulThemeScope.module.css';
import styles from './SoulTranscript.module.css';

/** The reader counts as "at the end" within this many pixels of the bottom. */
const FOLLOW_SLACK = 120;
/** An element first seen within this window of the current render plays its entrance. */
const ENTER_WINDOW = 400;
/** Below this chat-column width portraits shrink to 28 and bubbles may take 78 %. */
const COMPACT_WIDTH = 520;
/** Rooms show at most this many typing rows, then 还有 N 位. */
const ROOM_TYPING_ROWS = 2;
/** Room intro: member portraits before the +N disc. */
const INTRO_FACES = 3;
/** The standing picture is drawn when the transcript is at least this wide. It lives inside the column's own measure
 *  (784, the composer's), so this asks for that whole measure plus air on both sides; the rail and sheet layouts
 *  (a workspace under 900) never reach it. The column keeps its width with or without the picture: no hysteresis. */
const STAGE_MIN_WIDTH = 880;

type Side = 'in' | 'out';
type Row =
  | { kind: 'separator'; key: string; label: string }
  | { kind: 'copied'; key: string }
  | { kind: 'cluster'; key: string; side: Side; senderId: string; items: PaSoulItem[]; pending: SoulPendingSend[] }
  | { kind: 'story'; key: string; item: PaSoulItem }
  | { kind: 'work'; key: string; turn: PaTurn };

function groupOf(index: PaIndex, conversation: PaConversation): PaGroup | null {
  return index.groupByConversation.get(conversation.id) ?? (conversation.groupId ? index.groups.get(conversation.groupId) ?? null : null);
}

const narrationCache = new Map<string, boolean>();
function narrationOnly(text: string): boolean {
  let hit = narrationCache.get(text);
  if (hit === undefined) {
    hit = isNarrationOnly(text);
    if (narrationCache.size > 600) narrationCache.clear();
    narrationCache.set(text, hit);
  }
  return hit;
}

function findIn(root: HTMLElement | null, attribute: 'taskId' | 'messageId', value: string): HTMLElement | null {
  if (!root) return null;
  const selector = attribute === 'taskId' ? '[data-task-id]' : '[data-message-id]';
  for (const node of root.querySelectorAll<HTMLElement>(selector)) if (node.dataset[attribute] === value) return node;
  return null;
}

function flash(node: HTMLElement) {
  node.removeAttribute('data-flash');
  void node.offsetWidth;
  node.setAttribute('data-flash', '');
  window.setTimeout(() => node.removeAttribute('data-flash'), 650);
}

/** Scrolls `node` to the middle of `scroller` without touching any other scroll container. */
function centerIn(scroller: HTMLElement, node: HTMLElement) {
  const box = node.getBoundingClientRect();
  const frame = scroller.getBoundingClientRect();
  const top = scroller.scrollTop + (box.top - frame.top) - (scroller.clientHeight - box.height) / 2;
  if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  else scroller.scrollTop = Math.max(0, top);
}

/** When the current run of a chat turn began: its first attempt after the last unsuccessful one, else the task's
 *  creation for a fresh turn; undefined while a retried turn waits to start (the typing bubble then counts from mount). */
function turnStartedAt(task: PaTask, attempts: readonly PaAttempt[]): number | undefined {
  let start: number | undefined;
  let retried = false;
  for (const attempt of attempts) {
    if (attempt.status === 'completed' || attempt.status === 'running') start ??= attempt.startedAt;
    else {
      start = undefined;
      retried = true;
    }
  }
  return start ?? (retried ? undefined : task.createdAt);
}

export function SoulTranscript({
  conversation,
  mode,
  followNonce,
}: {
  conversation: PaConversation;
  mode: 'work' | 'companion';
  followNonce: number;
}) {
  const t = useT();
  const { locale } = useI18n();
  const { index, ui, now, layout, nav, data } = usePa();
  const cid = conversation.id;
  const companion = mode === 'companion';
  const room = groupOf(index, conversation);
  const turns = useMemo(() => soulTurns(index, cid), [index, cid]);
  const items = soulItems(index, cid);
  const appearance = resolveChatAppearance(index, conversation);
  const chat = chatOf(index, cid);
  const active = activeChatTask(index, cid);
  const typing = typingAgents(index, cid, data.control?.paused === true);
  const retryable = retryableChatTask(index, cid);
  const compose = useSoulCompose(cid);
  const journal = companion && appearance.layout === 'journal';

  /* ── stage 2: the running reply's live text (polled only while a chat turn runs), voice ── */
  useSoulLivePoll(cid, index, data.actions);
  const live = useSoulLive(cid);
  const speechStatus = useSoulSpeechStatus();
  const speech = useSoulSpeech(cid);

  /* ── entrance and freshness bookkeeping: the first render of a conversation is history ── */
  const seen = useRef<{ conversationId: string | null; at: Map<string, number> }>({ conversationId: null, at: new Map() });
  const renderAt = Date.now();
  const history = seen.current.conversationId !== cid;
  if (history) seen.current = { conversationId: cid, at: new Map() };
  const firstSeen = (key: string): number => {
    const map = seen.current.at;
    let at = map.get(key);
    if (at === undefined) {
      at = history ? 0 : renderAt;
      map.set(key, at);
    }
    return at;
  };
  const entering = (key: string): boolean => renderAt - firstSeen(key) < ENTER_WINDOW;
  const fresh = (key: string): boolean => firstSeen(key) !== 0;

  /* ── pending sends: shown until the snapshot holds the owner message with the same request id ── */
  const ownerRequests = useMemo(() => {
    const ids = new Set<string>();
    for (const item of items) if (item.role === 'owner' && item.message.soul?.requestId) ids.add(item.message.soul.requestId);
    return ids;
  }, [items]);
  const settled = useRef(new Set<string>());
  for (const send of compose.pending) settled.current.add(send.requestId);
  const pending = compose.pending.filter((send) => !ownerRequests.has(send.requestId));
  useEffect(() => {
    for (const send of compose.pending) if (ownerRequests.has(send.requestId)) compose.dropPending(send.requestId);
  }, [compose, ownerRequests]);

  /* ── per-speaker display rules ── */
  const splitCache = new Map<string, boolean>();
  const splitFor = (agentId: string): boolean => {
    let split = splitCache.get(agentId);
    if (split === undefined) {
      const preset = presetFor(index, conversation, agentId);
      split = preset.format === 'im' && preset.multiBubble;
      splitCache.set(agentId, split);
    }
    return split;
  };
  const newestSlot = items[items.length - 1]?.slotId ?? null;
  // Coalesced sends share one task: its failure line goes under the last of its owner bubbles only.
  const lastOwnerOf = new Map<string, string>();
  for (const item of items) if (item.role === 'owner' && item.message.taskId) lastOwnerOf.set(item.message.taskId, item.slotId);
  const failureFor = (item: PaSoulItem) => {
    const taskId = item.message.taskId;
    const task = taskId ? index.tasks.get(taskId) : undefined;
    if (!task || task.kind !== 'chat' || task.status !== 'failed') return null;
    if (lastOwnerOf.get(task.id) !== item.slotId) return null;
    return { task, retry: task.id === retryable?.id };
  };
  const hasLines = (item: PaSoulItem): boolean => {
    if (item.hidden || item.variantCount > 1 || item.slotId === newestSlot) return true;
    if (item.role === 'owner') return failureFor(item) !== null || item.message.soul?.care === 'crisis';
    return pendingCandidates(index, item.message.id).length > 0 || replyEffects(index, conversation, item).length > 0;
  };
  const edges = (item: PaSoulItem): { first: boolean; last: boolean } => {
    const parts = soulPartsOf(item.message, item.role !== 'owner' && splitFor(item.message.senderId));
    return { first: !narrationOnly(parts[0] ?? ''), last: !narrationOnly(parts[parts.length - 1] ?? '') };
  };

  /* The live bubbles: split the way the stored reply will be (an IM preset with several bubbles), unless the text is
     too long to split on every poll. Memoised on the attempt and its text. The entry never outlives its stored
     message here: once the reply is in the index it is the stored one that shows. */
  const liveSplit = live ? splitFor(live.agentId) : false;
  // A stopped or failed draft shows all of its text; only a growing reply holds back a half-written action.
  const liveText = live && !index.messages.has(live.attemptId) ? (live.tone === 'live' ? soulLiveDisplayText(live.text) : live.text) : '';
  const liveAttempt = live?.attemptId ?? '';
  const liveBubbles = useMemo((): readonly string[] => {
    if (!liveText) return [];
    if (!liveSplit || liveText.length > SOUL_LIMITS.liveSplitChars) return [liveText];
    const parts = splitBubbles(liveText);
    return parts.length > 0 ? parts : [liveText];
    // The attempt is part of the identity: a new attempt with the same first characters is a new reply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveAttempt, liveText, liveSplit]);
  const liveParts = liveBubbles.map((part, at) => (
    <SoulRoleplayText key={at} text={part} side="in" markdown markupLabel={t('pa.soul.chat.markupFold')} />
  ));
  const liveNarration = liveBubbles.map((part) => narrationOnly(part));

  /* ── rows: separators, clusters, story cards, work turns ── */
  const rows: Row[] = [];
  let previousAt: number | null = null;
  let open: Extract<Row, { kind: 'cluster' }> | null = null;
  const branch = chat.branchOf !== null;
  let copiedSeen = false;
  let copiedDone = !branch;
  const placeCopied = (key: string) => {
    if (!copiedDone && copiedSeen) {
      rows.push({ kind: 'copied', key: `copied:${key}` });
      copiedDone = true;
      open = null;
    }
  };
  for (const turn of turns) {
    if (turn.kind === 'chat') {
      for (const item of turn.items) {
        if (item.message.soul?.copiedFrom) copiedSeen = true;
        else placeCopied(item.slotId);
        if (needsSeparator(previousAt, item.at)) {
          rows.push({ kind: 'separator', key: `sep:${item.slotId}`, label: separatorLabel(item.at, now, locale, t) });
          open = null;
        }
        previousAt = item.at;
        if (item.role === 'story') {
          rows.push({ kind: 'story', key: `story:${item.slotId}`, item });
          open = null;
          continue;
        }
        const side: Side = item.role === 'owner' ? 'out' : 'in';
        const current: Extract<Row, { kind: 'cluster' }> | null = open;
        if (current && current.side === side && current.senderId === item.message.senderId) {
          current.items.push(item);
        } else {
          const next: Extract<Row, { kind: 'cluster' }> = {
            kind: 'cluster',
            key: `c:${item.slotId}`,
            side,
            senderId: item.message.senderId,
            items: [item],
            pending: [],
          };
          rows.push(next);
          open = next;
        }
      }
    } else {
      placeCopied(turn.key);
      const firstAt = turn.turn.messages[0]?.createdAt ?? turn.startedAt;
      if (needsSeparator(previousAt, firstAt)) {
        rows.push({ kind: 'separator', key: `sep:${turn.key}`, label: separatorLabel(firstAt, now, locale, t) });
      }
      previousAt = turn.turn.messages[turn.turn.messages.length - 1]?.createdAt ?? firstAt;
      rows.push({ kind: 'work', key: `w:${turn.key}`, turn: turn.turn });
      open = null;
    }
  }
  if (!copiedDone && copiedSeen) rows.push({ kind: 'copied', key: 'copied:end' });
  if (pending.length > 0) {
    const last = rows[rows.length - 1];
    if (last && last.kind === 'cluster' && last.side === 'out' && !hasLines(last.items[last.items.length - 1]!)) last.pending = pending;
    else rows.push({ kind: 'cluster', key: `p:${pending[0]!.requestId}`, side: 'out', senderId: 'owner', items: [], pending });
  }
  const lastWorkKey = [...rows].reverse().find((row) => row.kind === 'work')?.key ?? null;
  const orphanFailure =
    retryable && !items.some((item) => item.role === 'owner' && item.message.taskId === retryable.id) ? retryable : null;

  /* ── scroller: follow the end, jump pill, remembered positions (this scroller only) ── */
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const forceFollow = useRef(false);
  const lastTop = useRef(0);
  const positions = useRef(new Map<string, { top: number; atEnd: boolean }>());
  const shownConversation = useRef<string | null>(null);
  const shownCount = useRef(0);
  const handledFocus = useRef<number | null>(null);
  const [pill, setPill] = useState(false);
  const [compact, setCompact] = useState(false);
  const [wide, setWide] = useState(false);
  const jump = usePresence(pill, 150);

  const count = items.length + pending.length + turns.reduce((sum, turn) => sum + (turn.kind === 'work' ? turn.turn.messages.length : 0), 0);
  const signature = [
    items.map((item) => `${item.slotId}:${item.message.id}:${item.hidden ? 1 : 0}:${item.message.revision}`).join(','),
    turns.map((turn) => (turn.kind === 'work' ? `${turn.key}:${turn.turn.messages.length}:${turn.turn.task?.status ?? ''}:${turn.turn.task?.updatedAt ?? ''}` : '')).join(','),
    typing.join(','),
    pending.map((send) => `${send.requestId}:${send.failed ? 1 : 0}`).join(','),
    retryable?.id ?? '',
    // Not the text: a growing live bubble is followed by the content observer below.
    live ? `${live.attemptId}:${live.tone}` : '',
  ].join('|');

  const scrollToEnd = useCallback((smooth = false) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const top = scroller.scrollHeight;
    if (smooth && typeof scroller.scrollTo === 'function') scroller.scrollTo({ top, behavior: 'smooth' });
    else scroller.scrollTop = top;
    nearBottom.current = true;
  }, []);

  useLayoutEffect(() => {
    const saved = positions.current.get(cid);
    const scroller = scrollerRef.current;
    if (saved && !saved.atEnd && scroller) {
      scroller.scrollTop = saved.top;
      nearBottom.current = false;
    } else {
      scrollToEnd();
    }
    lastTop.current = scroller?.scrollTop ?? 0;
    setPill(false);
    shownConversation.current = cid;
    shownCount.current = count;
    // The count is read as of the switch; later growth is the content effect's business.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, scrollToEnd]);

  useLayoutEffect(() => {
    if (shownConversation.current !== cid) return;
    const grew = count > shownCount.current;
    shownCount.current = count;
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

  useEffect(() => {
    if (followNonce === 0) return;
    forceFollow.current = true;
    setPill(false);
    scrollToEnd();
  }, [followNonce, scrollToEnd]);

  /* Growth that is not new data (a paced bubble, a line fading in, live text growing, the composer growing) keeps an
     end-reader at the end; the same observer tracks the column width for the compact layout and the standing picture.
     Measured before paint, so a chat opens with its standing picture already in place instead of growing after. */
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return undefined;
    const measure = () => {
      const width = scroller.clientWidth;
      setCompact(width > 0 && width < COMPACT_WIDTH);
      setWide(width >= STAGE_MIN_WIDTH);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      measure();
      if (nearBottom.current) scrollToEnd();
    });
    observer.observe(scroller);
    observer.observe(content);
    return () => observer.disconnect();
  }, [cid, scrollToEnd]);

  const focus = ui.focusTurn;
  useEffect(() => {
    if (!focus || handledFocus.current === focus.nonce) return;
    const scroller = scrollerRef.current;
    const node = findIn(scroller, 'taskId', focus.taskId);
    if (!scroller || !node) return;
    handledFocus.current = focus.nonce;
    centerIn(scroller, node);
    flash(node);
  }, [focus, signature]);

  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    // Only a reader scrolling away skips the paced reveal. Content shrinking at the end (a hover bar or the typing row
    // unmounting) makes the browser clamp scrollTop down a few pixels while the view stays at the end.
    const movedUp = scroller.scrollTop < lastTop.current - 2;
    if (movedUp && distance > FOLLOW_SLACK) skipSoulReveal();
    lastTop.current = scroller.scrollTop;
    // Content growing under a reader who did not move (the standing picture narrowing the column, a late image) is
    // not the reader leaving the end: the resize observer brings the view back down.
    nearBottom.current = distance <= FOLLOW_SLACK || (nearBottom.current && !movedUp);
    positions.current.set(cid, { top: scroller.scrollTop, atEnd: nearBottom.current });
    if (nearBottom.current && pill) setPill(false);
  };

  const onJump = useCallback((messageId: string) => {
    const scroller = scrollerRef.current;
    const node = findIn(scroller, 'messageId', messageId);
    if (!scroller || !node) return;
    centerIn(scroller, node);
    flash(node);
  }, []);

  /* ── 自动朗读: each agent reply that arrives while this chat is open and the window is visible is generated and played
     once, in arrival order (the store queues them). History, variants and replies that arrived while the window was
     hidden are never read on their own. Leaving the conversation stops playback and clears the queue. ── */
  const voiceMode = chat.voiceReplies ?? 'manual';
  const autoChecked = useRef<{ conversationId: string; ids: Set<string> }>({ conversationId: cid, ids: new Set() });
  if (autoChecked.current.conversationId !== cid) autoChecked.current = { conversationId: cid, ids: new Set() };
  useEffect(() => {
    if (voiceMode === 'auto' && speechStatus === null) return; // wait for the status before deciding
    const checked = autoChecked.current.ids;
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
    for (const item of items) {
      const message = item.message;
      if (item.role !== 'agent' || message.soul?.kind !== 'chat' || message.soul.variantOf || checked.has(message.id)) continue;
      checked.add(message.id);
      // Under 关 or 点了才读 a reply is only noted, so turning 自动朗读 on later never reads what came before.
      if (voiceMode !== 'auto' || !speechStatus || !visible || !fresh(`s:${item.slotId}`)) continue;
      if (soulVoiceGate(index, conversation, message, speechStatus).kind === 'ready') speech.autoSpeak(message.id);
    }
    // `items` and `fresh` follow `index` and `cid`; the effect runs once per snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, cid, voiceMode, speechStatus, speech]);
  useEffect(() => () => soulAudio.stop(), [cid]);
  // Audio of a reply that is no longer in the transcript (deleted, or its slot switched to another variant) has no bar
  // left to pause it, so it stops. A voice sample is not a reply: the profile editor that plays it also stops it.
  const playingId = useSyncExternalStore(soulAudio.subscribe, () => soulAudio.get().messageId, () => null);
  useEffect(() => {
    if (playingId && playingId !== SOUL_SAMPLE_AUDIO_ID && !items.some((item) => item.message.id === playingId)) soulAudio.stop();
  }, [playingId, items]);

  /* ── render ── */
  const portraitSize = journal ? (compact ? 36 : 48) : compact ? 28 : 36;
  const portraitOf = (agentId: string) => (
    <SoulAgentPortrait
      agent={index.agents.get(agentId) ?? null}
      character={characterOf(index, agentId)}
      fantay={isFantay(index, agentId)}
      size={portraitSize}
      frame="scope"
    />
  );
  const regenerating = active?.soul?.regenerateOf ?? null;
  const itemOrder = new Map(items.map((item, at) => [item.slotId, at]));
  const laterVisible = (item: PaSoulItem) => {
    const at = itemOrder.get(item.slotId) ?? 0;
    return items.slice(at + 1).some((other) => !other.hidden);
  };

  const renderCluster = (row: Extract<Row, { kind: 'cluster' }>) => {
    const speaker = row.side === 'in' ? row.senderId : null;
    const split = speaker ? splitFor(speaker) : false;
    return (
      <div key={row.key} className={styles.cluster} data-side={row.side}>
        {speaker ? <div className={styles.clusterPortrait}>{portraitOf(speaker)}</div> : null}
        <div className={styles.clusterBody}>
          {journal && speaker ? (
            <div className={styles.clusterHead} data-testid="pa-soul-cluster-head">
              <span className={styles.clusterHeadName}>{displayName(index, speaker)}</span>
              {row.items[0] ? <span className={styles.clusterHeadTime}>{soulShortTime(locale, row.items[0].at)}</span> : null}
            </div>
          ) : room && speaker ? (
            <div className={styles.clusterName}>{displayName(index, speaker)}</div>
          ) : null}
          {row.items.map((item, at) => {
            const prev = row.items[at - 1];
            const next = row.items[at + 1];
            const joinPrev = prev !== undefined && !hasLines(prev) && edges(prev).last && edges(item).first;
            const joinNext = next !== undefined && !hasLines(item) && edges(item).last && edges(next).first;
            const requestId = item.message.soul?.requestId;
            const settledSend = requestId !== undefined && settled.current.has(requestId);
            const slotKey = `s:${item.slotId}`;
            const isFresh = fresh(slotKey);
            // A reply whose live text was on screen takes its place as it is: no paced reveal, no entrance.
            const wasLive = soulLiveSeen(item.message.id);
            return (
              <SoulMessageItem
                key={item.slotId}
                item={item}
                conversation={conversation}
                room={room}
                side={row.side}
                joinPrev={joinPrev}
                joinNext={joinNext || (at === row.items.length - 1 && row.pending.length > 0 && !hasLines(item))}
                newest={item.slotId === newestSlot}
                laterVisible={item.role === 'greeting' ? laterVisible(item) : false}
                split={split}
                entering={!settledSend && !wasLive && entering(slotKey)}
                paced={
                  companion &&
                  isFresh &&
                  item.role === 'agent' &&
                  item.message.soul?.kind === 'chat' &&
                  !item.message.soul.variantOf &&
                  appearance.pacing === 'paced' &&
                  !wasLive
                }
                dimmed={regenerating !== null && regenerating === item.slotId}
                failure={item.role === 'owner' ? failureFor(item) : null}
                journal={journal}
              />
            );
          })}
          {row.pending.map((send, at) => {
            const joinPrev = at > 0 || row.items.length > 0;
            const joinNext = at < row.pending.length - 1;
            const position = joinPrev ? (joinNext ? 'middle' : 'last') : joinNext ? 'first' : 'single';
            return <SoulPendingBubble key={send.requestId} send={send} conversationId={cid} position={position} />;
          })}
        </div>
      </div>
    );
  };

  const body = rows.map((row) => {
    switch (row.kind) {
      case 'separator':
        return <SoulSeparator key={row.key}>{row.label}</SoulSeparator>;
      case 'copied':
        return (
          <div key={row.key} className={styles.copiedLine}>
            <SoulMetaLine>{t('pa.soul.chat.branch.copied')}</SoulMetaLine>
          </div>
        );
      case 'story':
        return (
          <SoulStoryCard
            key={row.key}
            item={row.item}
            conversation={conversation}
            room={room}
            entering={entering(`s:${row.item.slotId}`)}
          />
        );
      case 'work': {
        const task = row.turn.task;
        const turnBody = (
          <PaTurnBody
            turn={row.turn}
            conversation={conversation}
            group={room}
            latest={row.key === lastWorkKey}
            entering={entering}
            onJump={onJump}
          />
        );
        if (!companion) {
          return (
            <section key={row.key} className={cn(convStyles.turn, styles.workTurn)} data-testid="pa-turn" data-task-id={task?.id}>
              {turnBody}
            </section>
          );
        }
        return (
          <div key={row.key} className={styles.taskBlock} data-testid="pa-soul-task-block" data-pa-skin="fantay" data-task-id={task?.id}>
            <div className={styles.taskHead}>
              <SoulTag icon={<Icon icon={ListChecks} size={12} />}>{t('pa.soul.chat.task.tag')}</SoulTag>
              {task ? (
                <Button variant="link" size="sm" className={styles.taskDetails} onClick={() => nav.openModal({ kind: 'task', taskId: task.id })}>
                  {t('pa.soul.chat.task.details')}
                </Button>
              ) : null}
            </div>
            {turnBody}
          </div>
        );
      }
      default:
        return renderCluster(row);
    }
  });

  const typingStart = active ? turnStartedAt(active, index.attemptsByTask.get(active.id) ?? []) : undefined;
  // In the journal a typing row that starts a new entry carries the entry's head line (the name; the time comes with
  // the stored reply), so the stored entry replaces it at the same height. One that continues the last entry has none.
  const lastRow = rows[rows.length - 1];
  const headFor = (agentId: string) =>
    journal && !(lastRow?.kind === 'cluster' && lastRow.side === 'in' && lastRow.senderId === agentId) ? (
      <div className={styles.clusterHead}>
        <span className={styles.clusterHeadName}>{displayName(index, agentId)}</span>
      </div>
    ) : null;
  const typingRows = active
    ? typing.slice(0, room ? ROOM_TYPING_ROWS : 1).map((agentId) => {
        const name = displayName(index, agentId);
        // The live text of this speaker's running attempt, when it has any; otherwise the dots.
        const mine =
          live !== null && live.tone === 'live' && live.taskId === active.id && live.agentId === agentId && liveParts.length > 0;
        return (
          <div key={`${active.id}:${agentId}`} className={styles.typingRow} data-live={mine ? '' : undefined}>
            <SoulTypingBubble
              startedAt={typingStart}
              portrait={portraitOf(agentId)}
              label={mine ? t('pa.soul.chat.live.aria', { name }) : t('pa.soul.chat.typing.aria', { name })}
              {...(mine ? { parts: liveParts, narration: liveNarration } : {})}
              head={headFor(agentId)}
              trailing={
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.barButton}
                  data-testid="pa-soul-typing-stop"
                  onClick={() => void data.actions.stopTask(active.id).catch(errorToast)}
                >
                  {t('pa.soul.chat.typing.stop')}
                </Button>
              }
            />
          </div>
        );
      })
    : null;
  const moreTyping = active && room && typing.length > ROOM_TYPING_ROWS ? typing.length - ROOM_TYPING_ROWS : 0;

  /* The draft of a stopped or failed reply: the text that was on screen, dimmed, with the line that it was not saved, a
     copy link and 收起. Session-only: it goes with the next turn, a dismiss or a conversation switch (soul-live.ts).
     A send that is not in the snapshot yet already hides it, so the owner's new line never sits above it. */
  const draft = live !== null && live.tone !== 'live' && liveParts.length > 0 && active === null && pending.length === 0 ? live : null;
  const draftLine = draft ? t(draft.tone === 'failed' ? 'pa.soul.chat.live.failed' : 'pa.soul.chat.live.stopped') : '';
  const draftRow = draft ? (
    <div className={cn(styles.typingRow, styles.draftRow)} data-testid="pa-soul-live-ghost" data-tone={draft.tone}>
      <SoulTypingBubble
        portrait={portraitOf(draft.agentId)}
        label={draftLine}
        parts={liveParts}
        narration={liveNarration}
        tone={draft.tone}
        head={headFor(draft.agentId)}
        footer={
          <SoulMetaLine>
            <span className={styles.lineText}>{draftLine}</span>
            <span className={styles.lineActions}>
              <Button variant="link" size="sm" onClick={() => void copySoulText(draft.text, t('pa.chat.copied'))}>
                {t('pa.chat.copy')}
              </Button>
              <IconButton
                size="xs"
                aria-label={t('pa.soul.chat.live.dismiss')}
                className={styles.draftDismiss}
                data-testid="pa-soul-live-dismiss"
                onClick={() => dismissSoulLive(cid)}
              >
                <Icon icon={X} size={12} />
              </IconButton>
            </span>
          </SoulMetaLine>
        }
      />
    </div>
  ) : null;

  /* The standing picture (立绘区): a direct companion chat with the stage on and a sprite to show, on a transcript wide
     enough for the column's whole measure. It sits in the first 220 px of that measure, the messages take the rest, and
     the composer below keeps the same measure, so the right edges of the outgoing bubbles and the composer stay one
     line (SoulTranscript.module.css). */
  const stageSrc = companion && !room && appearance.stage === 'side' ? stageSpriteSrc(index, conversation, now) : null;
  const staged = stageSrc !== null && wide;
  const stageAgent = conversation.agentId ?? '';
  const stageName = stageAgent ? displayName(index, stageAgent) : conversation.title;
  // The name says the mood of the picture really drawn (平静 for the fallback), and only the name for the portrait.
  const stageShown = staged ? shownSprite(characterOf(index, stageAgent)?.sprites, emotionOfReply(index, cid, stageAgent, now)) : null;
  const stage = staged ? (
    <SoulStage
      src={stageSrc}
      name={stageName}
      label={stageShown ? t('pa.soul.inspector.sprite.aria', { name: stageName, emotion: t(`pa.soul.emotion.${stageShown}`) }) : stageName}
      className={styles.stage}
    />
  ) : null;

  return (
    <div className={cn(convStyles.transcriptWrap, styles.wrap)} data-stage={staged ? '' : undefined}>
      {stage}
      <div
        ref={scrollerRef}
        className={cn(convStyles.transcript, paperStyles.paper, styles.scroller)}
        data-testid="pa-transcript"
        data-stage={staged ? '' : undefined}
        onScroll={onScroll}
        onPointerDown={() => skipSoulReveal()}
        onKeyDown={() => skipSoulReveal()}
      >
        <div
          key={cid}
          ref={contentRef}
          className={cn(convStyles.column, styles.column)}
          data-narrow={layout.width < 900 ? '' : undefined}
          data-sheet={layout.roster === 'sheet' ? '' : undefined}
          data-compact={compact ? '' : undefined}
          data-switch=""
          data-testid="pa-soul-transcript"
        >
          {companion ? <SoulIntro conversation={conversation} room={room} items={items} /> : null}
          {body}
          {typingRows}
          {moreTyping > 0 ? (
            <div className={styles.typingMore}>
              <SoulMetaLine>{t('pa.soul.chat.typing.more', { n: moreTyping })}</SoulMetaLine>
            </div>
          ) : null}
          {draftRow}
          {orphanFailure ? <SoulOrphanFailure task={orphanFailure} /> : null}
        </div>
      </div>
      {jump.mounted ? (
        <div className={convStyles.jump} data-state={jump.closing ? 'closed' : 'open'}>
          <Button
            size="sm"
            variant="default"
            className={convStyles.jumpButton}
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

/** The top of a companion transcript (Soul UI spec §4.3 b, c): portrait, name, tagline and the AI disclosure; in a
 *  room, up to three member portraits and who is here. */
function SoulIntro({ conversation, room, items }: { conversation: PaConversation; room: PaGroup | null; items: PaSoulItem[] }) {
  const t = useT();
  const { locale } = useI18n();
  const { index, now } = usePa();
  const joiner = locale.startsWith('zh') ? '、' : ', ';

  if (room) {
    const members = room.memberIds.filter((id) => index.agents.has(id));
    const faces = members.slice(0, INTRO_FACES);
    const extra = members.length - faces.length;
    return (
      <div className={styles.intro} data-testid="pa-soul-intro" data-room="">
        <div className={styles.introFaces}>
          {faces.map((id) => (
            <span key={id} className={styles.introFace}>
              <SoulAgentPortrait
                agent={index.agents.get(id) ?? null}
                character={characterOf(index, id)}
                fantay={isFantay(index, id)}
                size={48}
                frame="scope"
              />
            </span>
          ))}
          {extra > 0 ? <span className={cn(styles.introFace, styles.introMore)}>+{extra}</span> : null}
        </div>
        <div className={styles.introName}>{room.name}</div>
        <div className={styles.introCaption}>
          {t('pa.soul.chat.intro.room', { names: members.map((id) => displayName(index, id)).join(joiner) })}
        </div>
        {items.length === 0 ? <div className={styles.introHi}>{t('pa.soul.chat.intro.roomSayHi')}</div> : null}
      </div>
    );
  }

  const agentId = conversation.agentId ?? '';
  const agent = index.agents.get(agentId) ?? null;
  const character = characterOf(index, agentId);
  const name = agentId ? displayName(index, agentId) : conversation.title;
  const tagline = character?.tagline.trim() ?? '';
  const spoken = items.some((item) => item.role === 'owner');
  const days = agentId ? relationshipFacts(index, agentId, now).days : 0;
  return (
    <div className={styles.intro} data-testid="pa-soul-intro">
      <SoulAgentPortrait agent={agent} character={character} fantay={isFantay(index, agentId)} size={72} frame="scope" />
      <div className={styles.introName}>{name}</div>
      {tagline ? <div className={styles.introTagline}>{tagline}</div> : null}
      <div className={styles.introCaption}>
        {spoken && days > 0 ? t('pa.soul.chat.intro.known', { name, n: days }) : t('pa.soul.chat.intro.first', { name })}
      </div>
      {items.length === 0 ? <div className={styles.introHi}>{t('pa.soul.chat.intro.sayHi')}</div> : null}
    </div>
  );
}

