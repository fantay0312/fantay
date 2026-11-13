// SPDX-License-Identifier: AGPL-3.0-only
// The conversation header (spec §6.1): 52 px, solid paper, no rule (the transcript's top fade separates them).
// Direct: avatar + a history menu on the name, model subline. Group: cluster + members · mode. Channel: the
// target's avatar + stored title + platform. Right: one inline action and the inspector toggle, no overflow.
import type { ReactNode } from 'react';
import { History, PanelLeftOpen, PanelRight, Settings2, SquarePen } from 'lucide-react';

import { useI18n, useT } from '../../i18n';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  cn,
} from '../ui';
import { PaAvatar, PaGroupAvatar } from './PaAvatar';
import { PaModelPicker } from './PaModelPicker';
import { errorToast, platformLabel } from './PaTurnTail';
import { usePa } from './pa-context';
import { conversationKind, isFantay, subjectOf } from './pa-model';
import type { PaConversation, PaGroup, PaIndex, PersonalAgent, TFn } from './pa-types';
import styles from './PaConversation.module.css';

function membersOf(index: PaIndex, group: PaGroup): PersonalAgent[] {
  return group.memberIds.map((id) => index.agents.get(id)).filter((agent): agent is PersonalAgent => Boolean(agent));
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
function shortDate(locale: string, at: number): string {
  let format = dateFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
    dateFormats.set(locale, format);
  }
  return format.format(new Date(at));
}

/** A direct conversation's history label: its first owner message (24 characters), else "New chat · date". */
function historyLabel(index: PaIndex, t: TFn, locale: string, conversation: PaConversation): string {
  const first = index.messagesByConversation.get(conversation.id)?.find((m) => m.senderId === 'owner');
  if (first) {
    const flat = first.content.replace(/\s+/g, ' ').trim();
    return flat.length > 24 ? `${flat.slice(0, 23)}…` : flat;
  }
  return t('pa.preview.newChat', { date: shortDate(locale, conversation.createdAt) });
}

function InspectorToggle() {
  const t = useT();
  const { ui, nav } = usePa();
  const open = ui.inspectorOpen;
  return (
    <IconButton
      size="sm"
      variant="quiet"
      on={open}
      aria-expanded={open}
      aria-controls="pa-inspector-panel"
      aria-label={open ? t('pa.state.closeInspector') : t('pa.state.openInspector')}
      onClick={() => nav.setInspector(!open)}
    >
      <Icon icon={PanelRight} size="md" />
    </IconButton>
  );
}

export function PaChatHeader({ conversation }: { conversation: PaConversation }) {
  const t = useT();
  const { locale } = useI18n();
  const { index, ui, nav, layout } = usePa();
  const kind = conversationKind(conversation);
  const subject = subjectOf(index, conversation);
  const fantayId = index.fantay?.id ?? null;

  let avatar: ReactNode = null;
  let titleText = conversation.title;
  let subline: ReactNode = null;
  let directAgent: PersonalAgent | null = null;
  let action: ReactNode = null;
  // A member cluster takes the roster rows' 32 px: at 28 three faces shrink to ~15 px and crowd their glyphs.
  const cluster = subject?.kind === 'group';

  if (kind === 'group' && subject?.kind === 'group') {
    const group = subject.group;
    const members = membersOf(index, group);
    const mode = group.mode === 'collaboration' ? t('pa.collaboration') : group.mode === 'review' ? t('pa.review') : t('pa.discussion');
    avatar = <PaGroupAvatar members={members} fantayId={fantayId} size={32} />;
    titleText = group.name;
    subline = (
      <span className={styles.headerSub}>
        {members.map((m) => m.name).join('、')} · {mode}
      </span>
    );
    action = (
      <IconButton
        size="sm"
        variant="quiet"
        aria-label={t('pa.chat.groupSettings')}
        onClick={() => nav.openModal({ kind: 'group', groupId: group.id })}
      >
        <Icon icon={Settings2} size="md" />
      </IconButton>
    );
  } else if (kind === 'channel') {
    const channel = index.channels.get(conversation.channelId ?? '');
    avatar =
      subject?.kind === 'group' ? (
        <PaGroupAvatar members={membersOf(index, subject.group)} fantayId={fantayId} size={32} />
      ) : (
        <PaAvatar
          agent={subject?.kind === 'agent' ? subject.agent : null}
          size={28}
          fantay={isFantay(index, subject?.kind === 'agent' ? subject.agent.id : null)}
        />
      );
    titleText = conversation.title;
    subline = <span className={styles.headerSub}>{platformLabel(t, channel?.type)}</span>;
    action = (
      <IconButton
        size="sm"
        variant="quiet"
        aria-label={t('pa.roster.channelSettings')}
        onClick={() => nav.openModal({ kind: 'channel', channelId: conversation.channelId ?? null })}
      >
        <Icon icon={Settings2} size="md" />
      </IconButton>
    );
  } else {
    const agent = subject?.kind === 'agent' ? subject.agent : conversation.agentId ? index.agents.get(conversation.agentId) ?? null : null;
    directAgent = agent;
    const history = agent ? index.directByAgent.get(agent.id) ?? [] : [];
    avatar = <PaAvatar agent={agent} size={28} fantay={isFantay(index, agent?.id)} dim={agent ? !agent.enabled : false} />;
    titleText = agent?.name ?? conversation.title;
    subline = null;
    action = agent ? (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" variant="quiet" aria-label={t('pa.chat.history')}>
              <Icon icon={History} size="md" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent width="lg" align="end">
            <DropdownMenuLabel className={styles.menuLabel}>{t('pa.chat.history')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={conversation.id}
              onValueChange={(id) => {
                if (id !== conversation.id) nav.openConversation(id);
              }}
            >
              {history.map((entry) => (
                <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                  <span className={styles.menuText}>{historyLabel(index, t, locale, entry)}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={<Icon icon={SquarePen} size="sm" />}
              onSelect={() => void nav.newConversation(agent.id).catch(errorToast)}
            >
              {t('pa.chat.newChat')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <IconButton
          size="sm"
          variant="quiet"
          aria-label={t('pa.chat.newChat')}
          onClick={() => void nav.newConversation(agent.id).catch(errorToast)}
        >
          <Icon icon={SquarePen} size="md" />
        </IconButton>
      </>
    ) : null;
  }

  const showingOwnSubject = ui.inspectorOpen && !ui.inspectorAgentId;
  const handleInspectSubject = () => {
    if (subject?.kind === 'agent') {
      nav.inspectAgent(subject.agent.id, { toggle: true });
      return;
    }
    if (ui.inspectorOpen && ui.inspectorAgentId) {
      nav.clearInspectorAgent();
      return;
    }
    nav.setInspector(!ui.inspectorOpen);
  };

  return (
    <header className={styles.header} data-testid="pa-chat-header">
      {layout.roster === 'sheet' ? (
        <IconButton size="sm" variant="quiet" aria-label={t('pa.roster.openList')} onClick={() => nav.openRosterSheet()}>
          <Icon icon={PanelLeftOpen} size="md" />
        </IconButton>
      ) : null}
      <div className={styles.headerMain}>
        {directAgent ? (
          <div className={styles.headerDirectGroup}>
            <Button
              variant="bare"
              data-testid="pa-header-subject"
              data-open={showingOwnSubject ? '' : undefined}
              aria-expanded={showingOwnSubject}
              aria-controls="pa-inspector-panel"
              className={cn(styles.headerIdentity, styles.headerIdentityDirect)}
              onClick={handleInspectSubject}
            >
              <span className={styles.headerAvatar}>{avatar}</span>
              <span className={styles.headerTitle}>{titleText}</span>
            </Button>
            <div className={styles.headerModelSlot}>
              <PaModelPicker agent={directAgent} variant="header" />
            </div>
          </div>
        ) : (
          <Button
            variant="bare"
            data-testid="pa-header-subject"
            data-open={showingOwnSubject ? '' : undefined}
            aria-expanded={showingOwnSubject}
            aria-controls="pa-inspector-panel"
            className={styles.headerIdentity}
            onClick={handleInspectSubject}
          >
            <span className={styles.headerAvatar} data-cluster={cluster ? '' : undefined}>
              {avatar}
            </span>
            <span className={styles.headerText}>
              <span className={styles.headerTitle}>{titleText}</span>
              {subline}
            </span>
          </Button>
        )}
      </div>
      <div className={styles.headerActions}>
        {action}
        <InspectorToggle />
      </div>
    </header>
  );
}
