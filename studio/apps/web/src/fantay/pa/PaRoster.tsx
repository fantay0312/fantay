// SPDX-License-Identifier: AGPL-3.0-only
// The Fantay workspace's left column (spec §3.3): the Fantay card, the three places, search, then groups,
// agents and channel chats. `rail` is the 64 px variant for narrow hosts; the full list opens in a Sheet.
import { createContext, useContext, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { PanelLeftOpen, SquarePen } from 'lucide-react';

import { useI18n } from '../../i18n';
import { FantayMascotStill } from '../brand/FantayMascot';
import { DashNavItem } from '../shell/sidebar/dash';
import { RunStatusDot } from '../shell/sidebar/RunStatusDot';
import {
  Button,
  ConfirmDialog,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Dot,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FeatureIcon,
  IconButton,
  MoreHorizontalIcon,
  PlusIcon,
  SearchField,
  Skeleton,
  Tooltip,
  cn,
  toast,
  type FeatureIconName,
} from '../ui';
import { usePa } from './pa-context';
import { agentStatus, conversationKind, conversationTitle, formatRowTime, isActiveTask, isFantay, lastPreview, statusText } from './pa-model';
import type { PaAgentStatusTone, PaConversation, PaGroup, PaIndex, PaPreview, PersonalAgent, TFn } from './pa-types';
import { PaAvatar, PaGroupAvatar } from './PaAvatar';
import styles from './PaRoster.module.css';

/** Per-viewer "seen" map (`fantay.pa.seen.v1`), provided by the workspace root: conversationId → epoch ms. */
export const PaSeenContext = createContext<Readonly<Record<string, number>>>({});

type RowKind = 'group' | 'agent' | 'channel';

interface RosterRow {
  key: string;
  kind: RowKind;
  conversation: PaConversation | null;
  agent: PersonalAgent | null;
  group: PaGroup | null;
  members: PersonalAgent[];
  title: string;
  platform: 'feishu' | 'weixin' | null;
  activity: number;
  preview: PaPreview;
  running: boolean;
  unread: boolean;
  selected: boolean;
  disabled: boolean;
  haystack: string;
}

interface MenuEntry {
  key: string;
  label: string;
  tone?: 'default' | 'danger';
  run(): void;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function notifyError(error: unknown): void {
  toast({ tone: 'danger', title: errorText(error) });
}

/** Ignores clicks from portaled menus (React bubbles them through the tree) and from the row's own ⋯ button. */
function rowClick(open: () => void) {
  return (event: MouseEvent<HTMLElement>) => {
    const target = event.target as Element | null;
    if (!target || !event.currentTarget.contains(target)) return;
    if (target.closest('[data-roster-menu]')) return;
    open();
  };
}

const DOT_TONE: Record<PaAgentStatusTone, 'muted' | 'running' | 'idle' | 'done' | 'current'> = {
  muted: 'muted',
  warning: 'current',
  running: 'running',
  idle: 'idle',
  done: 'done',
};

function StatusDot({ tone }: { tone: PaAgentStatusTone }) {
  return <Dot size="sm" tone={DOT_TONE[tone]} className={cn(tone === 'warning' && styles.dotWarning, tone === 'muted' && styles.dotMuted)} />;
}

function senderName(index: PaIndex, id: string): string {
  return index.agents.get(id)?.name ?? '';
}

/** The row's second line (spec §3.3 item 6): text plus its colour role. */
function previewLine(index: PaIndex, row: RosterRow, t: TFn): { text: string; tone: 'shimmer' | 'warning' | 'failed' | null } {
  const preview = row.preview;
  switch (preview.kind) {
    case 'working':
      // A direct row already carries the worker's name in its title: "研究员 / 正在工作…", not "研究员 / 研究员 正在工作…".
      if (row.group === null && row.agent && preview.agentId === row.agent.id) return { text: t('pa.preview.workingSelf'), tone: 'shimmer' };
      return { text: t('pa.preview.working', { name: senderName(index, preview.agentId) || row.title }), tone: 'shimmer' };
    case 'queued':
      return { text: t('pa.preview.queued'), tone: null };
    case 'needs':
      return { text: t('pa.preview.needsYou'), tone: 'warning' };
    case 'failed':
      return { text: t('pa.preview.failed', { error: preview.error }), tone: 'failed' };
    case 'text': {
      if (preview.sender === 'owner') return { text: t('pa.preview.you', { text: preview.text }), tone: null };
      const many = row.kind === 'group' || (row.kind === 'channel' && row.group !== null);
      const name = senderName(index, preview.sender);
      return { text: many && name ? t('pa.preview.sender', { name, text: preview.text }) : preview.text, tone: null };
    }
    default:
      return { text: t('pa.preview.empty'), tone: null };
  }
}

function newestAgentMessage(index: PaIndex, conversationId: string): number {
  const messages = index.messagesByConversation.get(conversationId) ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]!.senderId !== 'owner') return messages[i]!.createdAt;
  return 0;
}

/** Builds the three sections in their spec orders. */
function useRosterRows() {
  const { index, ui } = usePa();
  const seen = useContext(PaSeenContext);
  return useMemo(() => {
    const current = ui.place === 'conversation' && ui.conversationId ? index.conversations.get(ui.conversationId) ?? null : null;
    const make = (kind: RowKind, conversation: PaConversation | null, extra: Partial<RosterRow> & Pick<RosterRow, 'key' | 'title'>): RosterRow => {
      const tasks = conversation ? index.tasksByConversation.get(conversation.id) ?? [] : [];
      const newest = conversation ? newestAgentMessage(index, conversation.id) : 0;
      const row: RosterRow = {
        kind,
        conversation,
        agent: null,
        group: null,
        members: [],
        platform: null,
        activity: conversation ? index.lastActivity.get(conversation.id) ?? conversation.updatedAt : 0,
        preview: conversation ? lastPreview(index, conversation) : { kind: 'empty' },
        running: tasks.some((task) => task.status === 'running' || task.status === 'verifying'),
        unread: false,
        selected: false,
        disabled: false,
        haystack: '',
        ...extra,
      };
      row.unread = !row.selected && conversation !== null && newest > (seen[conversation.id] ?? 0);
      const previewText = row.preview.kind === 'text' ? row.preview.text : '';
      row.haystack = [row.title, ...row.members.map((member) => member.name), previewText].join('\n').toLowerCase();
      return row;
    };

    const groups = [...index.groups.values()]
      .map((group) => {
        const conversation = index.conversations.get(group.conversationId) ?? null;
        return make('group', conversation, {
          key: `group:${group.id}`,
          title: group.name,
          group,
          members: group.memberIds.map((id) => index.agents.get(id)).filter((agent): agent is PersonalAgent => Boolean(agent)),
          selected: current?.id === group.conversationId,
        });
      })
      .sort((a, b) => b.activity - a.activity);

    const agents = [...index.agents.values()]
      .filter((agent) => !isFantay(index, agent.id))
      .map((agent) =>
        make('agent', index.directByAgent.get(agent.id)?.[0] ?? null, {
          key: `agent:${agent.id}`,
          title: agent.name,
          agent,
          members: [agent],
          disabled: !agent.enabled,
          selected: Boolean(current && conversationKind(current) === 'direct' && current.agentId === agent.id),
        }),
      )
      .sort((a, b) => Number(a.disabled) - Number(b.disabled) || b.activity - a.activity || a.title.localeCompare(b.title));

    const channels = index.channelConversations.map((conversation) => {
      const channel = conversation.channelId ? index.channels.get(conversation.channelId) : undefined;
      const group = conversation.groupId ? index.groups.get(conversation.groupId) ?? null : null;
      const agent = !group && conversation.agentId ? index.agents.get(conversation.agentId) ?? null : null;
      return make('channel', conversation, {
        key: `channel:${conversation.id}`,
        title: conversationTitle(index, conversation),
        group,
        agent,
        members: group
          ? group.memberIds.map((id) => index.agents.get(id)).filter((member): member is PersonalAgent => Boolean(member))
          : agent
            ? [agent]
            : [],
        platform: channel?.type ?? null,
        selected: current?.id === conversation.id,
      });
    });

    const fantay = index.fantay;
    const fantaySelected = Boolean(fantay && current && conversationKind(current) === 'direct' && current.agentId === fantay.id);
    return { groups, agents, channels, fantaySelected };
  }, [index, seen, ui.conversationId, ui.place]);
}

/** ↑/↓ move focus between roster items (roving tabIndex); Enter activates the focused row natively. */
function useRoving(keys: string[], preferred: string | null) {
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const active = focusKey && keys.includes(focusKey) ? focusKey : preferred && keys.includes(preferred) ? preferred : keys[0] ?? null;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const target = event.target as HTMLElement;
    if (!target.matches('[data-roster-item]')) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-roster-item]')];
    const at = items.indexOf(target);
    const next = items[at + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    setFocusKey(next.dataset.key ?? null);
    next.focus();
  };
  const tabIndexOf = (key: string) => (key === active ? 0 : -1);
  return { onKeyDown, tabIndexOf, onFocusItem: setFocusKey };
}

export function PaRoster({ variant }: { variant: 'full' | 'rail' }) {
  return variant === 'rail' ? <RosterRail /> : <RosterFull />;
}

// ---------------------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------------------

function useRowActions() {
  const { data, nav } = usePa();
  const { t } = useI18n();
  const [disabling, setDisabling] = useState<PersonalAgent | null>(null);
  const [busy, setBusy] = useState(false);

  const openRow = (row: RosterRow) => {
    if (row.kind === 'agent' && row.agent) {
      void nav.openAgent(row.agent.id).catch(notifyError);
      return;
    }
    if (row.conversation) nav.openConversation(row.conversation.id);
  };

  const entries = (row: RosterRow): MenuEntry[] => {
    if (row.kind === 'agent' && row.agent) {
      const agent = row.agent;
      return [
        { key: 'open', label: t('pa.roster.open'), run: () => openRow(row) },
        { key: 'edit', label: t('pa.roster.editProfile'), run: () => nav.openModal({ kind: 'agent', agentId: agent.id }) },
        {
          key: 'duplicate',
          label: t('pa.roster.duplicate'),
          run: () =>
            void data.actions
              .cloneAgent(agent.id)
              .then((copy) => toast({ tone: 'success', title: t('pa.roster.duplicated', { name: copy?.name ?? agent.name }) }))
              .catch(notifyError),
        },
        agent.enabled
          ? { key: 'toggle', label: t('pa.disable'), run: () => setDisabling(agent) }
          : { key: 'toggle', label: t('pa.enable'), run: () => void data.actions.setAgentEnabled(agent, true).catch(notifyError) },
      ];
    }
    if (row.kind === 'group' && row.group) {
      const group = row.group;
      return [
        { key: 'open', label: t('pa.roster.open'), run: () => openRow(row) },
        { key: 'edit', label: t('pa.roster.editGroup'), run: () => nav.openModal({ kind: 'group', groupId: group.id }) },
      ];
    }
    const channelId = row.conversation?.channelId ?? null;
    return [
      { key: 'open', label: t('pa.roster.open'), run: () => openRow(row) },
      ...(channelId
        ? [{ key: 'settings', label: t('pa.roster.channelSettings'), run: () => nav.openModal({ kind: 'channel', channelId }) }]
        : []),
    ];
  };

  const confirm = (
    <ConfirmDialog
      open={disabling !== null}
      onOpenChange={(open) => {
        if (!open && !busy) setDisabling(null);
      }}
      title={t('pa.roster.disableTitle', { name: disabling?.name ?? '' })}
      description={t('pa.roster.disableBody')}
      confirmLabel={t('pa.disable')}
      destructive
      busy={busy}
      onConfirm={() => {
        const agent = disabling;
        if (!agent) return;
        setBusy(true);
        void data.actions
          .setAgentEnabled(agent, false)
          .catch(notifyError)
          .finally(() => {
            setBusy(false);
            setDisabling(null);
          });
      }}
    />
  );

  return { openRow, entries, confirm };
}

type RosterPlace = 'activity' | 'tasks' | 'memory' | 'connections';

function PlaceTrailing({ place }: { place: RosterPlace }) {
  const { data, index } = usePa();
  const { t } = useI18n();
  if (place === 'tasks') {
    const needs = index.needs.length;
    if (needs > 0) return <span className={styles.needsPill}>{needs}</span>;
    const active = [...index.tasks.values()].filter(isActiveTask).length;
    return active > 0 ? <span className="text-caption tabular-nums text-ink-faint">{active}</span> : null;
  }
  if (place === 'memory') {
    const count = index.memories.size;
    return count > 0 ? <span className="text-caption tabular-nums text-ink-faint">{count}</span> : null;
  }
  if (place !== 'connections') return null;
  const broken = data.channels.channels.some((channel) => channel.status === 'error' || channel.status === 'login_required');
  if (broken) return <Dot size="sm" tone="current" className={styles.dotWarnFill} />;
  if (data.control?.paused) return <span className="text-caption text-ink-faint">{t('pa.status.paused')}</span>;
  return null;
}

/** Whether a place carries the rail's corner dot (the rail shows a dot instead of a count). */
function usePlaceAlert(place: RosterPlace): 'warning' | null {
  const { data, index } = usePa();
  if (place === 'tasks') return index.needs.length > 0 ? 'warning' : null;
  if (place === 'connections') {
    const broken = data.channels.channels.some((channel) => channel.status === 'error' || channel.status === 'login_required');
    return broken ? 'warning' : null;
  }
  return null;
}

/** First load (spec §17.2): five roster rows drawn as rows (a disc and two lines of varied length), not slabs. */
const SKELETON_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['44%', '78%'],
  ['30%', '62%'],
  ['52%', '70%'],
  ['36%', '84%'],
  ['40%', '58%'],
];

const PLACES: Array<{ place: RosterPlace; icon: FeatureIconName; label: 'pa.work.activity' | 'pa.tasks' | 'pa.memories' | 'pa.connections'; testId: string }> = [
  { place: 'activity', icon: 'usage', label: 'pa.work.activity', testId: 'pa-place-activity' },
  { place: 'tasks', icon: 'paTasks', label: 'pa.tasks', testId: 'pa-place-tasks' },
  { place: 'memory', icon: 'paMemories', label: 'pa.memories', testId: 'pa-place-memory' },
  { place: 'connections', icon: 'paConnections', label: 'pa.connections', testId: 'pa-place-connections' },
];

function RowAvatar({ row, size }: { row: RosterRow; size: number }) {
  const { index } = usePa();
  const fantayId = index.fantay?.id ?? null;
  const face =
    row.group !== null ? (
      <PaGroupAvatar members={row.members} fantayId={fantayId} size={size} />
    ) : (
      <PaAvatar agent={row.agent} size={size} fantay={isFantay(index, row.agent?.id)} dim={row.disabled} />
    );
  return (
    <span className={styles.avatar} aria-hidden>
      {face}
      {row.running ? <RunStatusDot tone="running" className={styles.avatarDot} /> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Full variant
// ---------------------------------------------------------------------------------------------------------

function RosterFull() {
  const { data, index, ui, nav, now } = usePa();
  const { t, locale } = useI18n();
  const { groups, agents, channels, fantaySelected } = useRosterRows();
  const actions = useRowActions();
  const fantay = index.fantay;
  const loading = data.load === 'loading' && !data.snapshot;
  const offline = data.load === 'offline' && !data.snapshot;

  const query = ui.rosterQuery.trim().toLowerCase();
  const filter = (rows: RosterRow[]) => (query ? rows.filter((row) => row.haystack.includes(query)) : rows);
  const shownGroups = filter(groups);
  const shownAgents = filter(agents);
  const shownChannels = filter(channels);
  const noMatch = query.length > 0 && !shownGroups.length && !shownAgents.length && !shownChannels.length;

  const keys = [
    ...(fantay ? ['fantay'] : []),
    ...[...shownGroups, ...shownAgents, ...shownChannels].map((row) => row.key),
  ];
  const selectedKey = fantaySelected ? 'fantay' : [...shownGroups, ...shownAgents, ...shownChannels].find((row) => row.selected)?.key ?? null;
  const roving = useRoving(keys, selectedKey);

  const openFantay = () => {
    if (fantay) void nav.openAgent(fantay.id).catch(notifyError);
  };

  const renderRow = (row: RosterRow) => {
    const line = previewLine(index, row, t);
    const entries = actions.entries(row);
    const platform = row.platform ? t(row.platform === 'feishu' ? 'pa.roster.feishu' : 'pa.roster.weixin') : null;
    return (
      <ContextMenu key={row.key}>
        <ContextMenuTrigger asChild>
          <div
            className={styles.row}
            data-testid="pa-roster-row"
            data-kind={row.kind}
            data-conversation-id={row.conversation?.id}
            data-agent-id={row.kind === 'agent' ? row.agent?.id : undefined}
            data-selected={row.selected ? '' : undefined}
            data-unread={row.unread ? '' : undefined}
            onClick={rowClick(() => actions.openRow(row))}
          >
            <Button
              variant="bare"
              className={styles.rowButton}
              data-roster-item=""
              data-key={row.key}
              tabIndex={roving.tabIndexOf(row.key)}
              onFocus={() => roving.onFocusItem(row.key)}
              aria-current={row.selected ? 'true' : undefined}
            >
              <RowAvatar row={row} size={32} />
              <span className={styles.text}>
                <span className={styles.line1}>
                  <span className={cn(styles.title, row.disabled && styles.titleDisabled)}>
                    {row.title}
                    {platform ? <span className={styles.suffix}> · {platform}</span> : null}
                    {row.disabled ? <span className={styles.suffix}> · {t('pa.disabled')}</span> : null}
                  </span>
                </span>
                <span className={styles.line2}>
                  <span
                    className={cn(
                      styles.preview,
                      line.tone === 'shimmer' && styles.shimmer,
                      line.tone === 'warning' && styles.previewWarning,
                      line.tone === 'failed' && styles.previewFailed,
                    )}
                  >
                    {line.text}
                  </span>
                </span>
              </span>
              {/* Time over the unread dot, both on the row's end edge. An empty conversation has had no activity yet:
                  no time, so "No messages yet" never sits beside a creation date that reads like a last message. */}
              <span className={styles.meta}>
                <span className={styles.time}>{row.activity > 0 && row.preview.kind !== 'empty' ? formatRowTime(row.activity, now, locale) : ''}</span>
                {row.unread ? <RunStatusDot tone="unread" className={styles.unread} /> : null}
              </span>
            </Button>
            <span className={styles.menu} data-roster-menu="">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton size="xs" variant="quiet" aria-label={t('pa.roster.rowMenu')} tooltip={false}>
                    <MoreHorizontalIcon size="sm" />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent width="sm" align="end">
                  {entries.map((entry) => (
                    <DropdownMenuItem key={entry.key} tone={entry.tone} onSelect={entry.run}>
                      {entry.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className={styles.contextMenu}>
          {entries.map((entry) => (
            <ContextMenuItem key={entry.key} tone={entry.tone} onSelect={entry.run}>
              {entry.label}
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const section = (label: string, rows: RosterRow[], add: { label: string; open(): void } | null) => (
    <section className={styles.section} aria-label={label}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionLabel}>{label}</h3>
        {add ? (
          <IconButton size="xs" variant="quiet" aria-label={add.label} onClick={add.open}>
            <PlusIcon />
          </IconButton>
        ) : null}
      </div>
      {rows.map(renderRow)}
    </section>
  );

  if (offline) {
    return (
      <nav aria-label={t('pa.roster.label')} data-testid="pa-roster" data-variant="full" className={styles.roster}>
        <div className={styles.top}>
          <div className={styles.card} data-testid="pa-roster-fantay" data-offline="">
            <div className={styles.cardStatic}>
              <span className={styles.cardDisc} aria-hidden>
                <FantayMascotStill size={34} />
              </span>
              <span className={styles.cardText}>
                <span className={styles.cardName}>{t('pa.title')}</span>
                <span className={styles.cardStatus}>
                  <StatusDot tone="muted" />
                  <span className={styles.cardStatusText}>{t('pa.status.offline')}</span>
                </span>
              </span>
            </div>
          </div>
        </div>
      </nav>
    );
  }

  const status = fantay ? agentStatus(index, data, { kind: 'agent', agent: fantay }) : null;

  return (
    <nav
      aria-label={t('pa.roster.label')}
      data-testid="pa-roster"
      data-variant="full"
      className={styles.roster}
      onKeyDown={roving.onKeyDown}
    >
      <div className={styles.top}>
        {loading ? (
          <div className={styles.skCard}>
            <Skeleton className={styles.skDisc} />
            <span className={styles.skLines}>
              <Skeleton shape="line" className={styles.skTitle} style={{ width: '46%' }} />
              <Skeleton shape="line" className={styles.skPreview} style={{ width: '64%' }} />
            </span>
          </div>
        ) : null}
        {fantay && status ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                className={styles.card}
                data-testid="pa-roster-fantay"
                data-agent-id={fantay.id}
                data-selected={fantaySelected ? '' : undefined}
                onClick={rowClick(openFantay)}
              >
                <Button
                  variant="bare"
                  className={styles.cardButton}
                  data-roster-item=""
                  data-key="fantay"
                  tabIndex={roving.tabIndexOf('fantay')}
                  onFocus={() => roving.onFocusItem('fantay')}
                  aria-current={fantaySelected ? 'true' : undefined}
                >
                  <span className={styles.cardDisc} aria-hidden>
                    <FantayMascotStill size={34} />
                  </span>
                  <span className={styles.cardText}>
                    <span className={styles.cardName}>{fantay.name}</span>
                    <span className={styles.cardStatus}>
                      <StatusDot tone={status.tone} />
                      <span className={styles.cardStatusText}>{statusText(status, t)}</span>
                    </span>
                  </span>
                </Button>
                <span className={styles.cardAction} data-roster-menu="">
                  <IconButton
                    size="xs"
                    variant="quiet"
                    aria-label={t('pa.roster.newChatWith', { name: fantay.name })}
                    onClick={() => void nav.newConversation(fantay.id).catch(notifyError)}
                  >
                    <SquarePen strokeWidth={1.5} />
                  </IconButton>
                </span>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className={styles.contextMenu}>
              <ContextMenuItem onSelect={() => void nav.newConversation(fantay.id).catch(notifyError)}>{t('pa.roster.newChat')}</ContextMenuItem>
              <ContextMenuItem onSelect={() => nav.openModal({ kind: 'agent', agentId: fantay.id })}>{t('pa.roster.editProfile')}</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : null}

        <div className={styles.places}>
          {PLACES.map((item) => (
            <DashNavItem
              key={item.place}
              className={styles.place}
              icon={<FeatureIcon name={item.icon} slot={15} />}
              active={ui.place === item.place}
              data-testid={item.testId}
              trailing={<PlaceTrailing place={item.place} />}
              onClick={() => nav.openPlace(item.place)}
            >
              {t(item.label)}
            </DashNavItem>
          ))}
        </div>
        <div className={styles.hairline} role="separator" />
        <SearchField
          variant="ring"
          className={styles.search}
          placeholder={t('pa.roster.search')}
          aria-label={t('pa.roster.search')}
          value={ui.rosterQuery}
          onChange={(event) => nav.setRosterQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && ui.rosterQuery) {
              event.preventDefault();
              nav.setRosterQuery('');
            }
          }}
        />
      </div>

      <div className={styles.scroll}>
        {loading ? (
          <div className={styles.skeletons}>
            <Skeleton shape="line" index={0} className={styles.skHead} />
            {SKELETON_ROWS.map(([title, preview], i) => (
              <div key={i} className={styles.skRow}>
                <Skeleton index={i} className={styles.skAvatar} />
                <span className={styles.skLines}>
                  <Skeleton shape="line" index={i} className={styles.skTitle} style={{ width: title }} />
                  <Skeleton shape="line" index={i} className={styles.skPreview} style={{ width: preview }} />
                </span>
              </div>
            ))}
          </div>
        ) : (
          <>
            {!query || shownGroups.length
              ? section(t('pa.groups'), shownGroups, { label: t('pa.newGroup'), open: () => nav.openModal({ kind: 'group', groupId: null }) })
              : null}
            {!query || shownAgents.length
              ? section(t('pa.agents'), shownAgents, { label: t('pa.newAgent'), open: () => nav.openModal({ kind: 'agent', agentId: null }) })
              : null}
            {shownChannels.length ? section(t('pa.roster.channels'), shownChannels, null) : null}
            {noMatch ? <p className={styles.noMatch}>{t('pa.roster.noMatch')}</p> : null}
          </>
        )}
      </div>
      {actions.confirm}
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Rail variant (64 px)
// ---------------------------------------------------------------------------------------------------------

function RailPlace({ item }: { item: (typeof PLACES)[number] }) {
  const { ui, nav } = usePa();
  const { t } = useI18n();
  const alert = usePlaceAlert(item.place);
  return (
    <span className={styles.railSlot}>
      <IconButton
        size="sm"
        aria-label={t(item.label)}
        tooltipSide="right"
        on={ui.place === item.place}
        data-testid={item.testId}
        onClick={() => nav.openPlace(item.place)}
      >
        <FeatureIcon name={item.icon} size={20} />
      </IconButton>
      {alert ? <span aria-hidden className={styles.railDot} /> : null}
    </span>
  );
}

/** A rail face's tooltip and name: the row title plus the suffixes the full row shows after it (platform, disabled),
 *  since a Fantay channel chat's face is otherwise indistinguishable from Fantay's own. */
function railLabel(row: RosterRow, t: TFn): string {
  const parts = [row.title];
  if (row.platform) parts.push(t(row.platform === 'feishu' ? 'pa.roster.feishu' : 'pa.roster.weixin'));
  if (row.disabled) parts.push(t('pa.disabled'));
  if (row.preview.kind === 'needs') parts.push(t('pa.preview.needsYou'));
  return parts.join(' · ');
}

function RosterRail() {
  const { data, index, nav } = usePa();
  const { t } = useI18n();
  const { groups, agents, channels, fantaySelected } = useRosterRows();
  const actions = useRowActions();
  const fantay = index.fantay;
  const offline = data.load === 'offline' && !data.snapshot;
  const loading = data.load === 'loading' && !data.snapshot;
  const rows = [...groups, ...agents, ...channels];

  const railFace = (node: ReactNode, label: string, selected: boolean, onClick: () => void, extra: Record<string, string | undefined>) => (
    <Tooltip label={label} side="right">
      <Button
        variant="bare"
        className={styles.railFace}
        aria-label={label}
        aria-current={selected ? 'true' : undefined}
        data-selected={selected ? '' : undefined}
        onClick={onClick}
        {...extra}
      >
        {node}
      </Button>
    </Tooltip>
  );

  return (
    <nav aria-label={t('pa.roster.label')} data-testid="pa-roster" data-variant="rail" className={styles.rail}>
      {/* Offline there is no list to open: the full roster would show the same lone Fantay card. */}
      {offline ? null : (
        <IconButton size="sm" aria-label={t('pa.roster.openList')} tooltipSide="right" onClick={nav.openRosterSheet}>
          <PanelLeftOpen strokeWidth={1.5} />
        </IconButton>
      )}
      {offline || !fantay ? (
        <span className={styles.railFantay} aria-hidden data-testid={offline ? 'pa-roster-fantay' : undefined}>
          <FantayMascotStill size={34} />
        </span>
      ) : (
        <span data-testid="pa-roster-fantay" className={styles.railFantaySlot}>
          {railFace(
            <span className={styles.railFantay} aria-hidden>
              <FantayMascotStill size={34} />
            </span>,
            fantay.name,
            fantaySelected,
            () => void nav.openAgent(fantay.id).catch(notifyError),
            {},
          )}
        </span>
      )}
      {offline ? null : (
        <>
          <div className={styles.railPlaces}>
            {PLACES.map((item) => (
              <RailPlace key={item.place} item={item} />
            ))}
          </div>
          <div className={styles.railHairline} role="separator" />
          <div className={styles.railScroll}>
            {loading
              ? SKELETON_ROWS.slice(0, 4).map((_, i) => (
                  <span key={i} className={styles.railSkeleton} aria-hidden>
                    <Skeleton index={i} className={styles.skAvatar} />
                  </span>
                ))
              : null}
            {rows.map((row) => (
              <span key={row.key} className={styles.railSlot} data-testid="pa-roster-row" data-conversation-id={row.conversation?.id}>
                {railFace(<RowAvatar row={row} size={32} />, railLabel(row, t), row.selected, () => actions.openRow(row), {})}
                {/* The rail has no second line, so the corner carries it: warm when the chat needs you, ink when unread. */}
                {row.preview.kind === 'needs' ? (
                  <span aria-hidden className={styles.railDot} />
                ) : row.unread ? (
                  <span aria-hidden className={styles.railUnread} />
                ) : null}
              </span>
            ))}
          </div>
        </>
      )}
      {actions.confirm}
    </nav>
  );
}
