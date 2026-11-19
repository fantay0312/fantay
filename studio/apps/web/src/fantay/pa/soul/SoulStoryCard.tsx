// SPDX-License-Identifier: AGPL-3.0-only
// A story item in the transcript (Soul UI spec §4.4.6): a roll, a draw or an interlude, centred on the paper, captioned
// 故事 · …, never shaped like a bubble and never attributed to a character. Its menu is 复制 · 不让 TA 看到 · 删除
// (addendum item 10).
import { useRef } from 'react';
import { EyeOff } from 'lucide-react';
import { availableDecks } from '@open-design/contracts/soul';

import { useT } from '../../../i18n';
import { Button, Icon } from '../../ui';
import { errorToast } from '../PaTurnTail';
import { usePa } from '../pa-context';
import type { PaConversation, PaGroup, PaIndex, PaMessage } from '../pa-types';
import { SoulMetaLine, SoulStoryFrame, SoulTag } from './SoulPrimitives';
import { SoulContextMenu, SoulMessagePill, soulNameFor, useSoulMessageMenu } from './SoulMessageMenu';
import { characterOf, displayName, type PaSoulItem } from './soul-model';
import primitives from './SoulPrimitives.module.css';
import styles from './SoulTranscript.module.css';

const MINUS = '−';

function signed(value: number): string {
  if (value === 0) return '';
  return value > 0 ? `+${value}` : `${MINUS}${Math.abs(value)}`;
}

/** Who knows a drawn card's secret: the direct chat's character, or in a room the member whose own deck it is. */
function secretKeeper(index: PaIndex, conversation: PaConversation, room: PaGroup | null, deckId: string): string {
  if (!room) return conversation.agentId ? displayName(index, conversation.agentId) : conversation.title;
  const owner = room.memberIds.find((id) => characterOf(index, id)?.decks.some((deck) => deck.id === deckId));
  return displayName(index, owner ?? room.moderatorId ?? room.memberIds[0] ?? '') || room.name;
}

function RollBody({ message }: { message: PaMessage }) {
  const t = useT();
  const roll = message.soul?.roll;
  if (!roll) return null;
  return (
    <>
      <div className={primitives.rollHead}>
        {roll.label ? <span className={primitives.rollLabel}>{roll.label}</span> : <span />}
        <span className={primitives.rollNotation}>{roll.notation}</span>
      </div>
      <div className={primitives.rollBody}>
        {roll.rolls.map((value, index) => (
          <span key={index} className={primitives.die}>
            {value}
          </span>
        ))}
        {roll.modifier !== 0 ? <span className={primitives.rollModifier}>{signed(roll.modifier)}</span> : null}
        <span className={primitives.rollTotal}>
          =<span className={primitives.rollTotalValue}>{roll.total}</span>
        </span>
      </div>
      {roll.dc !== undefined ? (
        <div className={styles.rollOutcome}>
          {roll.outcome ? (
            <SoulTag skin tone={roll.outcome === 'success' ? 'solid' : 'outline'}>
              {roll.outcome === 'success' ? t('pa.soul.chat.story.success') : t('pa.soul.chat.story.fail')}
            </SoulTag>
          ) : null}
          <span>{t('pa.soul.chat.story.target', { dc: roll.dc })}</span>
        </div>
      ) : null}
    </>
  );
}

function DrawBody({ message, keeper }: { message: PaMessage; keeper: string }) {
  const t = useT();
  const { data } = usePa();
  const draw = message.soul?.draw;
  if (!draw) return null;
  return (
    <>
      <div className={styles.drawTitle}>{draw.title}</div>
      {draw.text ? <div className={styles.drawText}>{draw.text}</div> : null}
      {draw.secret ? (
        <div className={styles.drawSecret}>
          <div className={styles.drawSecretCaption}>{t('pa.soul.chat.story.secret')}</div>
          <div className={styles.drawText}>{draw.secret}</div>
        </div>
      ) : draw.hasSecret ? (
        <div className={styles.drawHint}>
          <span>{t('pa.soul.chat.story.hasSecret', { name: keeper })}</span>
          <Button variant="link" size="sm" className={styles.storyLink} onClick={() => void data.actions.revealDraw(message.id).catch(errorToast)}>
            {t('pa.soul.chat.story.reveal')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function EventBody({ message }: { message: PaMessage }) {
  const t = useT();
  const event = message.soul?.event;
  if (!event) return null;
  return (
    <>
      <div className={styles.eventTitle}>{event.title}</div>
      {event.summary ? <div className={styles.eventSummary}>{event.summary}</div> : null}
      <div className={styles.eventPhase}>{event.phase === 'ended' ? t('pa.soul.chat.story.ended') : t('pa.soul.chat.story.accepted')}</div>
    </>
  );
}

export function SoulStoryCard({
  item,
  conversation,
  room,
  entering,
}: {
  item: PaSoulItem;
  conversation: PaConversation;
  room: PaGroup | null;
  entering: boolean;
}) {
  const t = useT();
  const { index, data } = usePa();
  const rootRef = useRef<HTMLDivElement>(null);
  const menu = useSoulMessageMenu({ item, conversation, room, rootRef });
  const message = item.message;
  const soul = message.soul;
  const kind = soul?.kind === 'draw' || soul?.kind === 'event' ? soul.kind : 'roll';
  const name = soulNameFor(index, conversation, room, null);

  let caption = t('pa.soul.chat.story.roll');
  let aria = t('pa.soul.chat.story.aria.roll', { total: soul?.roll?.total ?? '' });
  let body = <RollBody message={message} />;
  if (kind === 'draw') {
    const deckName =
      soul?.draw?.deckName ||
      availableDecks(characterOf(index, conversation.agentId)).find((deck) => deck.id === soul?.draw?.deckId)?.name ||
      '';
    caption = t('pa.soul.chat.story.draw', { deck: deckName });
    aria = t('pa.soul.chat.story.aria.draw', { title: soul?.draw?.title ?? '' });
    body = <DrawBody message={message} keeper={secretKeeper(index, conversation, room, soul?.draw?.deckId ?? '')} />;
  } else if (kind === 'event') {
    caption = t('pa.soul.chat.story.event');
    aria = t('pa.soul.chat.story.aria.event', { title: soul?.event?.title ?? '' });
    body = <EventBody message={message} />;
  }

  return (
    <>
      <SoulContextMenu actions={menu.actions} onOpen={menu.captureSelection}>
        <div
          ref={rootRef}
          className={styles.storyRow}
          data-message-id={message.id}
          data-hidden={item.hidden ? '' : undefined}
        >
          <div className={styles.storyAnchor}>
            <SoulStoryFrame kind={kind} caption={caption} ariaLabel={aria} entering={entering}>
              {body}
            </SoulStoryFrame>
            <SoulMessagePill message={message} actions={menu.actions} side="center" onOpen={menu.captureSelection} />
          </div>
          {item.hidden ? (
            <div className={styles.storyHidden}>
              <SoulMetaLine>
                <Icon icon={EyeOff} size={12} />
                <span>{t('pa.soul.chat.hidden.caption', { name })}</span>
                <Button variant="link" size="sm" onClick={() => void data.actions.editMessage(message, { hidden: false }).catch(errorToast)}>
                  {t('pa.soul.chat.hidden.restore')}
                </Button>
              </SoulMetaLine>
            </div>
          ) : null}
        </div>
      </SoulContextMenu>
      {menu.dialog}
    </>
  );
}
