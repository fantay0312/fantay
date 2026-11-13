// SPDX-License-Identifier: AGPL-3.0-only
// Empty conversations (spec §6.6). Fantay greets in first person with four starters that only fill the composer
// or open a place, never send. Its live mascot shows only while the inspector (which has its own live hero) is
// closed, so the transcript slot never doubles the budget of spec §5.4.
import { BookmarkPlus, Lightbulb, MessagesSquare, PanelsTopLeft } from 'lucide-react';

import { useT } from '../../i18n';
import { FantayMascot, FantayMascotStill } from '../brand/FantayMascot';
import { Button, Chip, Icon, cn } from '../ui';
import { PaAvatar, PaGroupAvatar } from './PaAvatar';
import { errorToast } from './PaTurnTail';
import { usePa } from './pa-context';
import { paPendingKey } from './usePaWorkspace';
import { conversationKind, projectGate, subjectOf } from './pa-model';
import type { PaConversation, PaGroup, PaIndex, PersonalAgent } from './pa-types';
import styles from './PaConversation.module.css';

const MODE_HELP = {
  discussion: 'pa.mode.discussionHelp',
  collaboration: 'pa.mode.collaborationHelp',
  review: 'pa.mode.reviewHelp',
} as const;

function membersOf(index: PaIndex, group: PaGroup): PersonalAgent[] {
  return group.memberIds.map((id) => index.agents.get(id)).filter((agent): agent is PersonalAgent => Boolean(agent));
}

/** The first group whose conversation passes the project gate, for the "build a page" starter. */
function projectGroup(index: PaIndex): PaGroup | null {
  for (const group of index.groups.values()) {
    const conversation = index.conversations.get(group.conversationId);
    if (conversation && projectGate(index, conversation).ok) return group;
  }
  return null;
}

export function PaEmptyChat({ conversation }: { conversation: PaConversation | null }) {
  const t = useT();
  const { index, ui, nav, data } = usePa();
  const fantay = index.fantay;

  if (!conversation) {
    return (
      <div className={styles.empty} data-testid="pa-empty-chat" data-greet="">
        <p className={styles.emptyTitle}>{t('pa.empty.noConversation', { name: fantay?.name ?? t('pa.title') })}</p>
        <Button
          variant="primary"
          className={styles.emptyAction}
          disabled={!fantay}
          loading={fantay ? data.pending.has(paPendingKey.conversation(fantay.id)) : false}
          onClick={() => {
            if (fantay) void nav.newConversation(fantay.id).catch(errorToast);
          }}
        >
          {t('pa.empty.start')}
        </Button>
      </div>
    );
  }

  const subject = subjectOf(index, conversation);
  if (subject?.kind === 'group' || conversationKind(conversation) === 'group') {
    const group = subject?.kind === 'group' ? subject.group : index.groupByConversation.get(conversation.id);
    const members = group ? membersOf(index, group) : [];
    return (
      <div className={styles.empty} data-testid="pa-empty-chat" data-greet="">
        <Button
          variant="bare"
          className={styles.emptyAvatarTrigger}
          aria-label={group?.name ?? conversation.title}
          onClick={() => {
            if (ui.inspectorOpen && ui.inspectorAgentId) nav.clearInspectorAgent();
            else nav.setInspector(true);
          }}
        >
          <PaGroupAvatar members={members} fantayId={fantay?.id ?? null} size={48} />
        </Button>
        <p className={styles.emptyCopy}>{t('pa.empty.group', { members: members.map((m) => m.name).join('、') })}</p>
        {group ? <p className={styles.emptyCaption}>{t(MODE_HELP[group.mode])}</p> : null}
      </div>
    );
  }

  const agent = subject?.kind === 'agent' ? subject.agent : null;
  if (agent && fantay && agent.id === fantay.id) {
    const group = projectGroup(index);
    const inspectorShowsFantay = ui.inspectorOpen && (!ui.inspectorAgentId || ui.inspectorAgentId === fantay.id);
    const showMascot = !inspectorShowsFantay;
    return (
      <div className={styles.empty} data-testid="pa-empty-chat" data-greet="">
        <div className={styles.emptyHeroRow}>
          <span className={styles.emptyMascot} aria-hidden>
            {showMascot ? (
              <FantayMascot size={62} appear tracking interactive />
            ) : (
              <FantayMascotStill size={56} />
            )}
          </span>
          <p className={cn(styles.emptyHeading, styles.emptyFantayHeading)}>
            {t('pa.empty.fantayTitle', { name: agent.name })}
          </p>
        </div>
        <p className={styles.emptyBody}>{t('pa.empty.fantayBody')}</p>
        <div className={styles.starters}>
          <Chip
            variant="suggestion"
            size="md"
            className={styles.starter}
            icon={<Icon icon={Lightbulb} size="sm" />}
            onClick={() => nav.fillComposer(conversation.id, { text: t('pa.empty.starterIdeaFill') })}
          >
            <span className={styles.starterText}>{t('pa.empty.starterIdea')}</span>
          </Chip>
          {group ? (
            <Chip
              variant="suggestion"
              size="md"
              className={styles.starter}
              icon={<Icon icon={PanelsTopLeft} size="sm" />}
              onClick={() => nav.fillComposer(group.conversationId, { project: true, text: t('pa.empty.starterGroupFill') })}
            >
              <span className={styles.starterText}>{t('pa.empty.starterGroup')}</span>
            </Chip>
          ) : null}
          <Chip
            variant="suggestion"
            size="md"
            className={styles.starter}
            icon={<Icon icon={BookmarkPlus} size="sm" />}
            onClick={() => nav.openModal({ kind: 'memory', memoryId: null, preset: { scope: 'private', scopeId: null } })}
          >
            <span className={styles.starterText}>{t('pa.empty.starterMemory', { name: agent.name })}</span>
          </Chip>
          <Chip
            variant="suggestion"
            size="md"
            className={styles.starter}
            icon={<Icon icon={MessagesSquare} size="sm" />}
            onClick={() => {
              nav.openPlace('connections');
              nav.openModal({ kind: 'channel', channelId: null });
            }}
          >
            <span className={styles.starterText}>{t('pa.empty.starterChannel', { name: agent.name })}</span>
          </Chip>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.empty} data-testid="pa-empty-chat" data-greet="">
      {agent ? (
        <Button
          variant="bare"
          className={styles.emptyAvatarTrigger}
          aria-label={agent.name}
          onClick={() => nav.inspectAgent(agent.id)}
        >
          <PaAvatar agent={agent} size={48} fantay={false} dim={!agent.enabled} />
        </Button>
      ) : (
        <PaAvatar agent={null} size={48} fantay={false} />
      )}
      <p className={styles.emptyHeading}>{t('pa.welcome')}</p>
      {agent?.role ? <p className={styles.emptyRole}>{agent.role}</p> : null}
    </div>
  );
}
