// SPDX-License-Identifier: AGPL-3.0-only
// The conversation header (Soul UI spec §4.2): 52 px on the conversation's paper. Left: the subject (portrait, name
// and, in a companion chat, a status line derived from stored state); right: 历史 (direct chats, 新对话 at its
// bottom), the 对话菜单 (chat settings, appearance, mode switch) and the 资料 toggle. No model picker in either mode;
// group and channel settings buttons stay where the menu does not apply. Stage 2: a direct companion chat's portrait
// shows the sprite of the newest stored reply's mood (`emotionOfReply`), crossfading on a change.
import type { ReactNode } from 'react';
import { GitBranch, History, MoreHorizontal, PanelLeftOpen, PanelRight, Settings2, SquarePen } from 'lucide-react';

import { SwapLabel } from '../../components/chat/SwapLabel';
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
  toast,
} from '../ui';
import { PaAvatar, PaGroupAvatar } from './PaAvatar';
import { errorToast, platformLabel } from './PaTurnTail';
import { usePa } from './pa-context';
import { conversationKind, isFantay, subjectOf } from './pa-model';
import type { PaConversation, PaEmotion, PaGroup, PaIndex, PersonalAgent, TFn } from './pa-types';
import { characterOf, chatOf, conversationMode, displayName, emotionOfReply, headerStatus, portraitSrc } from './soul/soul-model';
import { SoulAgentPortrait } from './soul/SoulPortrait';
import shell from './soul/SoulShell.module.css';
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
      aria-label={t('pa.soul.shell.header.info')}
      data-testid="pa-header-info"
      onClick={() => nav.setInspector(!open)}
    >
      <Icon icon={PanelRight} size="md" />
    </IconButton>
  );
}

/** Whether the conversation can be a companion chat at all (spec §4.2 item 2): a direct chat whose agent has a
 *  character, or a group chat whose members all have one. Never Fantay, never a channel chat. */
function canBeCompanion(index: PaIndex, conversation: PaConversation, group: PaGroup | null): boolean {
  const kind = conversationKind(conversation);
  if (kind === 'channel') return false;
  if (kind === 'direct') {
    const agentId = conversation.agentId;
    return Boolean(agentId && !isFantay(index, agentId) && characterOf(index, agentId));
  }
  return group !== null && group.memberIds.length > 0 && group.memberIds.every((id) => characterOf(index, id) !== null);
}

/** Names in a line: the enumeration comma in Chinese, a comma elsewhere. */
function listSeparator(locale: string): string {
  return locale.toLowerCase().startsWith('zh') ? '、' : ', ';
}

/** The companion status line: typing while a real chat turn is queued or running, the app's failure, the newest
 *  reply's mood, the tagline; a 支线 says so. Never "online", never a model or a count. */
function statusLine(
  index: PaIndex,
  conversation: PaConversation,
  now: number,
  t: TFn,
  locale: string,
  paused: boolean,
): { key: string; text: string } | null {
  const status = headerStatus(index, conversation, now, paused);
  const branch = chatOf(index, conversation.id).branchOf !== null;
  switch (status.kind) {
    case 'typing': {
      if (conversationKind(conversation) !== 'group') return { key: 'typing', text: t('pa.soul.shell.header.typing') };
      const separator = listSeparator(locale);
      const names = status.agentIds.map((id) => displayName(index, id)).filter(Boolean);
      const joined = names.length > 2 ? t('pa.soul.shell.header.namesMore', { names: names.slice(0, 2).join(separator) }) : names.join(separator);
      return { key: 'typing', text: joined ? t('pa.soul.shell.header.typingNames', { names: joined }) : t('pa.soul.shell.header.typing') };
    }
    case 'failed':
      return { key: 'failed', text: t('pa.soul.shell.header.failed') };
    case 'mood':
    case 'tagline':
      return { key: `${status.kind}:${status.text}`, text: branch ? t('pa.soul.shell.header.branch', { text: status.text }) : status.text };
    default:
      return branch ? { key: 'branch', text: t('pa.soul.shell.header.branchOnly') } : null;
  }
}

/** 对话菜单: chat settings, appearance (companion), the group editor (groups) and the mode switch. */
function ChatMenu({ conversation, companion, group }: { conversation: PaConversation; companion: boolean; group: PaGroup | null }) {
  const t = useT();
  const { data, nav } = usePa();
  const switchTo = (mode: 'work' | 'companion') => {
    void data.actions
      .saveChat(conversation.id, { mode })
      .then(() => toast({ title: t(mode === 'work' ? 'pa.soul.shell.header.switchedWork' : 'pa.soul.shell.header.switchedChat') }))
      .catch(errorToast);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton size="sm" variant="quiet" aria-label={t('pa.soul.shell.header.menu')} data-testid="pa-header-menu">
          <Icon icon={MoreHorizontal} size="md" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent width="md" align="end">
        <DropdownMenuItem onSelect={() => nav.openModal({ kind: 'chatSettings', conversationId: conversation.id })}>
          {t('pa.soul.shell.header.settings')}
        </DropdownMenuItem>
        {companion ? (
          <DropdownMenuItem onSelect={() => nav.openModal({ kind: 'appearance', conversationId: conversation.id })}>
            {t('pa.soul.shell.header.look')}
          </DropdownMenuItem>
        ) : null}
        {group ? (
          <DropdownMenuItem onSelect={() => nav.openModal({ kind: 'group', groupId: group.id })}>
            {t('pa.soul.shell.header.editGroup')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        {companion ? (
          <DropdownMenuItem description={t('pa.soul.shell.header.toWorkHint')} onSelect={() => switchTo('work')}>
            {t('pa.soul.shell.header.toWork')}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem description={t('pa.soul.shell.header.toChatHint')} onSelect={() => switchTo('companion')}>
            {t('pa.soul.shell.header.toChat')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 历史: this character's direct chats, newest first; 支线 carry a branch mark; 新对话 at the bottom. */
function HistoryMenu({ conversation, agent }: { conversation: PaConversation; agent: PersonalAgent }) {
  const t = useT();
  const { locale } = useI18n();
  const { index, nav } = usePa();
  const history = index.directByAgent.get(agent.id) ?? [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton size="sm" variant="quiet" aria-label={t('pa.soul.shell.header.history')} data-testid="pa-header-history">
          <Icon icon={History} size="md" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent width="lg" align="end">
        <DropdownMenuLabel className={styles.menuLabel}>{t('pa.soul.shell.header.history')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={conversation.id}
          onValueChange={(id) => {
            if (id !== conversation.id) nav.openConversation(id);
          }}
        >
          {history.map((entry) => {
            const label = historyLabel(index, t, locale, entry);
            const branch = chatOf(index, entry.id).branchOf !== null;
            return (
              <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                <span className={shell.historyText}>
                  {branch ? <Icon icon={GitBranch} size={12} className={shell.branchGlyph} /> : null}
                  <span className={shell.historyLabel}>{branch ? t('pa.soul.shell.header.branchItem', { label }) : label}</span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<Icon icon={SquarePen} size="sm" />} onSelect={() => void nav.newConversation(agent.id).catch(errorToast)}>
          {t('pa.chat.newChat')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PaChatHeader({ conversation }: { conversation: PaConversation }) {
  const t = useT();
  const { locale } = useI18n();
  const { index, ui, nav, layout, now, data } = usePa();
  const kind = conversationKind(conversation);
  const subject = subjectOf(index, conversation);
  const fantayId = index.fantay?.id ?? null;
  const group = subject?.kind === 'group' ? subject.group : index.groupByConversation.get(conversation.id) ?? null;
  const companion = kind !== 'channel' && conversationMode(index, conversation) === 'companion';
  const menu = canBeCompanion(index, conversation, kind === 'group' ? group : null);
  const status = companion ? statusLine(index, conversation, now, t, locale, data.control?.paused === true) : null;

  let avatar: ReactNode = null;
  let portrait = false;
  let titleText = conversation.title;
  let subline: ReactNode = null;
  let directAgent: PersonalAgent | null = null;
  let action: ReactNode = null;
  // The newest stored reply's emotion in a direct companion chat; a running turn keeps the last stored one.
  let emotion: PaEmotion | null = null;
  // A member cluster takes the roster rows' 32 px: at 28 three faces shrink to ~15 px and crowd their glyphs.
  const cluster = subject?.kind === 'group';

  if (kind === 'group' && subject?.kind === 'group') {
    const members = membersOf(index, subject.group);
    avatar = <PaGroupAvatar members={members} fantayId={fantayId} size={32} portraitOf={(agentId) => portraitSrc(index, agentId)} />;
    titleText = subject.group.name;
    if (companion) {
      // A room without a live status names who is in it; the work mode word (讨论 / 协作) stays out of a chat.
      subline = status ? null : <span className={cn(styles.headerSub, shell.headerSub)}>{members.map((m) => displayName(index, m.id)).join(listSeparator(locale))}</span>;
    } else {
      const mode =
        subject.group.mode === 'collaboration' ? t('pa.collaboration') : subject.group.mode === 'review' ? t('pa.review') : t('pa.discussion');
      subline = (
        <span className={styles.headerSub}>
          {members.map((m) => m.name).join('、')} · {mode}
        </span>
      );
    }
    action = menu ? null : (
      <IconButton
        size="sm"
        variant="quiet"
        aria-label={t('pa.chat.groupSettings')}
        onClick={() => nav.openModal({ kind: 'group', groupId: subject.group.id })}
      >
        <Icon icon={Settings2} size="md" />
      </IconButton>
    );
  } else if (kind === 'channel') {
    const channel = index.channels.get(conversation.channelId ?? '');
    avatar =
      subject?.kind === 'group' ? (
        <PaGroupAvatar members={membersOf(index, subject.group)} fantayId={fantayId} size={32} portraitOf={(agentId) => portraitSrc(index, agentId)} />
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
    portrait = true;
    emotion = companion && agent ? emotionOfReply(index, conversation.id, agent.id, now) : null;
    avatar = (
      <SoulAgentPortrait
        agent={agent}
        character={characterOf(index, agent?.id)}
        fantay={isFantay(index, agent?.id)}
        size={32}
        dim={agent ? !agent.enabled : false}
        emotion={emotion}
      />
    );
    titleText = agent ? displayName(index, agent.id) : conversation.title;
    action = agent ? <HistoryMenu conversation={conversation} agent={agent} /> : null;
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
    <header className={styles.header} data-testid="pa-chat-header" data-mode={companion ? 'companion' : 'work'}>
      {layout.roster === 'sheet' ? (
        <IconButton size="sm" variant="quiet" aria-label={t('pa.roster.openList')} onClick={() => nav.openRosterSheet()}>
          <Icon icon={PanelLeftOpen} size="md" />
        </IconButton>
      ) : null}
      <div className={styles.headerMain}>
        <Button
          variant="bare"
          data-testid="pa-header-subject"
          data-agent-id={directAgent?.id}
          data-open={showingOwnSubject ? '' : undefined}
          aria-expanded={showingOwnSubject}
          aria-controls="pa-inspector-panel"
          className={styles.headerIdentity}
          onClick={handleInspectSubject}
        >
          <span
            className={portrait ? shell.headerPortrait : styles.headerAvatar}
            data-cluster={cluster ? '' : undefined}
            data-emotion={emotion ?? undefined}
          >
            {avatar}
          </span>
          <span className={styles.headerText}>
            <span className={cn(styles.headerTitle, shell.headerName)}>{titleText}</span>
            {status ? (
              <span role="status" aria-live="polite" className={shell.status} data-testid="pa-header-status">
                <SwapLabel swapKey={status.key} layerClassName={shell.statusLayer}>
                  {status.text}
                </SwapLabel>
              </span>
            ) : (
              subline
            )}
          </span>
        </Button>
      </div>
      <div className={styles.headerActions}>
        {action}
        {menu ? <ChatMenu conversation={conversation} companion={companion} group={kind === 'group' ? group : null} /> : null}
        <InspectorToggle />
      </div>
    </header>
  );
}
