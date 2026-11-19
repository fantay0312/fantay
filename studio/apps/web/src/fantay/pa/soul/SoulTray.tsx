// SPDX-License-Identifier: AGPL-3.0-only
// The tray above the companion composer (Soul UI spec §4.6): one slot, the first matching content wins — the interlude
// offer, the next step of the newest reply (play chips and choices), who goes on in a 我来点名 room, 接着说 after a
// story item, and 让 TA 先开口 after a long quiet. It belongs to the composer, so its chrome is base ink, not the
// paper. A choice fills the input; it never sends.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { availableDecks } from '@open-design/contracts/soul';

import { useT } from '../../../i18n';
import { Button, Chip, IconButton, XIcon } from '../../ui';
import { errorToast } from '../PaTurnTail';
import { usePa } from '../pa-context';
import { isFantay } from '../pa-model';
import type { PaPlayRequest } from '@open-design/contracts';
import type { PaConversation, PaGroup, PaIndex, TFn } from '../pa-types';
import { SoulAgentPortrait } from './SoulPortrait';
import { SoulChoiceChip, SoulPlayChip } from './SoulPrimitives';
import { useSoulCompose } from './soul-compose';
import {
  activeChatTask,
  characterOf,
  chatOf,
  displayName,
  needsReachoutRow,
  soulItems,
  type PaSoulItem,
} from './soul-model';
import { useSoulRevealing } from './useSoulReveal';
import styles from '../PaComposer.module.css';

const MAX_PLAY = 2;
const MAX_CHOICES = 4;

function groupOf(index: PaIndex, conversation: PaConversation): PaGroup | null {
  return index.groupByConversation.get(conversation.id) ?? (conversation.groupId ? index.groups.get(conversation.groupId) ?? null : null);
}

function newestVisible(items: readonly PaSoulItem[]): PaSoulItem | null {
  for (let at = items.length - 1; at >= 0; at -= 1) if (!items[at]!.hidden) return items[at]!;
  return null;
}

/** 「掷 {notation} · {label} · 目标 {dc}」 or 「抽一张 · {deckName}」. */
export function playLabel(t: TFn, index: PaIndex, request: PaPlayRequest, speakerId: string): string {
  if (request.kind === 'draw') {
    const deck = availableDecks(characterOf(index, speakerId)).find((item) => item.id === request.deckId);
    return t('pa.soul.chat.tray.playDraw', { deck: deck?.name ?? request.deckId });
  }
  const head = request.label
    ? t('pa.soul.chat.tray.playRollLabel', { notation: request.notation, label: request.label })
    : t('pa.soul.chat.tray.playRoll', { notation: request.notation });
  return request.dc !== undefined ? `${head} · ${t('pa.soul.chat.tray.playTarget', { dc: request.dc })}` : head;
}

/** Keeps the chips of a wrapping row to two rows: chips that would start a third row are not drawn. */
function useTwoRows(key: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState<number | null>(null);
  useLayoutEffect(() => setCut(null), [key]);
  useLayoutEffect(() => {
    if (cut !== null) return;
    const row = ref.current;
    if (!row) return;
    const chips = [...row.querySelectorAll<HTMLElement>('[data-tray-chip]')];
    const tops = [...new Set(chips.map((chip) => chip.offsetTop))].sort((a, b) => a - b);
    const limit = tops[1] ?? tops[0] ?? 0;
    setCut(chips.filter((chip) => chip.offsetTop <= limit).length);
  });
  useEffect(() => {
    const row = ref.current;
    if (!row || typeof ResizeObserver === 'undefined') return undefined;
    let width = row.clientWidth;
    const observer = new ResizeObserver(() => {
      if (row.clientWidth === width) return;
      width = row.clientWidth;
      setCut(null);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [key]);
  return { ref, cut };
}

export function SoulTray({ conversation, onFill }: { conversation: PaConversation; onFill(text: string): void }) {
  const t = useT();
  const { index, data, now } = usePa();
  const cid = conversation.id;
  const chat = chatOf(index, cid);
  const room = groupOf(index, conversation);
  const items = soulItems(index, cid);
  const newest = newestVisible(items);
  const busy = activeChatTask(index, cid) !== null;
  const compose = useSoulCompose(cid);
  const revealing = useSoulRevealing(newest?.message.id ?? null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const name = room ? room.name : conversation.agentId ? displayName(index, conversation.agentId) : conversation.title;
  const play = useRef(false);

  const soul = newest?.message.soul;
  const speaker = newest && (newest.role === 'agent' || newest.role === 'greeting') ? newest.message.senderId : null;
  const requests = speaker ? (soul?.play ?? []).slice(0, MAX_PLAY) : [];
  const choices = speaker ? (soul?.choices ?? []).slice(0, MAX_CHOICES) : [];
  const nextStep = speaker !== null && (requests.length > 0 || choices.length > 0) && dismissed !== newest?.message.id && !revealing;
  const rows = useTwoRows(`${newest?.message.id ?? ''}:${requests.length}:${choices.length}`);

  if (compose.pending.length > 0) return null;
  const run = (work: Promise<unknown>) => {
    if (play.current) return;
    play.current = true;
    void work.catch(errorToast).finally(() => {
      play.current = false;
    });
  };

  let content: JSX.Element | null = null;
  let kind = '';
  if (chat.candidateEvent) {
    kind = 'event';
    const offer = chat.candidateEvent;
    content = (
      <div className={styles.trayCard}>
        <div className={styles.trayCardText}>
          <div className={styles.trayCaption}>{t('pa.soul.chat.tray.event')}</div>
          <div className={styles.trayCardTitle}>{offer.title}</div>
          {offer.summary ? <div className={styles.trayCardSummary}>{offer.summary}</div> : null}
        </div>
        <div className={styles.trayCardActions}>
          <Button variant="ghost" size="sm" onClick={() => run(data.actions.eventAction(cid, 'skip'))}>
            {t('pa.soul.chat.tray.notNow')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => run(data.actions.eventAction(cid, 'draw'))}>
            {t('pa.soul.chat.tray.another')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => run(data.actions.eventAction(cid, 'accept', true))}>
            {t('pa.soul.chat.tray.accept')}
          </Button>
        </div>
      </div>
    );
  } else if (nextStep && newest && speaker) {
    kind = 'next';
    let order = 0;
    content = (
      <div className={styles.trayRow}>
        <span className={styles.trayCaption}>{t('pa.soul.chat.tray.next')}</span>
        <div ref={rows.ref} className={styles.trayChips}>
          {requests.map((request, at) => {
            const position = order++;
            return (
              <span key={`play:${at}`} data-tray-chip="" hidden={rows.cut !== null && position >= rows.cut} className={styles.trayChipSlot}>
                <SoulPlayChip
                  index={position}
                  disabled={busy}
                  onClick={() =>
                    run(
                      request.kind === 'roll'
                        ? data.actions.roll(cid, {
                            notation: request.notation,
                            ...(request.label ? { label: request.label } : {}),
                            ...(request.dc !== undefined ? { dc: request.dc } : {}),
                            respond: true,
                          })
                        : data.actions.draw(cid, { deckId: request.deckId, respond: true }),
                    )
                  }
                >
                  {playLabel(t, index, request, speaker)}
                </SoulPlayChip>
              </span>
            );
          })}
          {choices.map((choice, at) => {
            const position = order++;
            return (
              <span key={`choice:${at}`} data-tray-chip="" hidden={rows.cut !== null && position >= rows.cut} className={styles.trayChipSlot}>
                <SoulChoiceChip index={position} onClick={() => onFill(choice)}>
                  {choice}
                </SoulChoiceChip>
              </span>
            );
          })}
        </div>
        <IconButton size="xs" aria-label={t('pa.soul.chat.tray.hide')} className={styles.trayClose} onClick={() => setDismissed(newest.message.id)}>
          <XIcon />
        </IconButton>
      </div>
    );
  } else if (room && chat.groupStrategy === 'manual' && newest && newest.role !== 'owner' && !busy) {
    kind = 'who';
    content = (
      <div className={styles.trayRow}>
        <span className={styles.trayCaption}>{t('pa.soul.chat.tray.who')}</span>
        <div className={styles.trayChips}>
          {room.memberIds
            .filter((id) => index.agents.has(id))
            .map((id) => (
              <Chip key={id} variant="suggestion" size="sm" className={styles.trayMember} onClick={() => run(data.actions.continueChat(cid, { agentId: id }))}>
                <SoulAgentPortrait agent={index.agents.get(id) ?? null} character={characterOf(index, id)} fantay={isFantay(index, id)} size={20} />
                <span className={styles.trayChipText}>{displayName(index, id)}</span>
              </Chip>
            ))}
        </div>
      </div>
    );
  } else if (newest?.role === 'story' && !busy) {
    kind = 'goOn';
    content = (
      <div className={styles.trayRow}>
        <div className={styles.trayChips}>
          <SoulChoiceChip onClick={() => run(data.actions.continueChat(cid))}>{t('pa.soul.chat.tray.goOn', { name })}</SoulChoiceChip>
        </div>
      </div>
    );
  } else if (needsReachoutRow(index, conversation, now)) {
    kind = 'reachout';
    content = (
      <div className={styles.trayRow}>
        <div className={styles.trayChips}>
          <SoulChoiceChip onClick={() => run(data.actions.continueChat(cid, { directive: 'reachout' }))}>
            {t('pa.soul.chat.tray.reachout', { name })}
          </SoulChoiceChip>
        </div>
      </div>
    );
  }
  if (!content) return null;
  return (
    <div className={styles.tray} data-testid="pa-soul-tray" data-kind={kind}>
      {content}
    </div>
  );
}
