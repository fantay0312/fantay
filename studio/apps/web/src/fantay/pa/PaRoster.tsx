// SPDX-License-Identifier: AGPL-3.0-only
// The Fantay workspace's left column (Soul UI spec §3): search with ＋, the full-width 全部 · 聊天 · 工作 filter, the
// pinned Fantay row, one list of characters, group chats and channel chats, and the four-cell bottom bar. `rail` is
// the 64 px variant for narrow hosts; the full list opens in a Sheet.
import { Fragment, createContext, useContext, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { PanelLeftOpen } from 'lucide-react';

import { useI18n } from '../../i18n';
import { FantayMascotStill } from '../brand/FantayMascot';
import { RunStatusDot } from '../shell/sidebar/RunStatusDot';
import {
  Button,
  ConfirmDialog,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dot,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  MoreHorizontalIcon,
  PlusIcon,
  SearchField,
  Segmented,
  SegmentedItem,
  Skeleton,
  Tooltip,
  cn,
  toast,
} from '../ui';
import { usePa } from './pa-context';
import { conversationKind, conversationTitle, formatRowTime, isChatTask, isFantay, lastPreview } from './pa-model';
import type { PaChannel, PaCharacterView, PaConversation, PaGroup, PaIndex, PaPreview, PaRosterFilter, PersonalAgent, TFn } from './pa-types';
import { PaGroupAvatar } from './PaAvatar';
import { platformName } from './PaConnectionsPage';
import { characterOf, conversationMode, displayName, portraitSrc, retryableChatTask, soulPreview } from './soul/soul-model';
import { SoulBottomBar, SoulRailPlaces } from './soul/SoulBottomBar';
import { SoulAgentPortrait } from './soul/SoulPortrait';
import { SoulRosterMenu } from './soul/SoulRosterMenu';
import shell from './soul/SoulShell.module.css';
import styles from './PaRoster.module.css';

/** Per-viewer "seen" map (`fantay.pa.seen.v1`), provided by the workspace root: conversationId → epoch ms. */
export const PaSeenContext = createContext<Readonly<Record<string, number>>>({});

type RowKind = 'group' | 'agent' | 'channel';

interface RosterRow {
  key: string;
  kind: RowKind;
  /** The pinned Fantay row (spec §3.2 item 1): never filtered, never searched. */
  fantay: boolean;
  conversation: PaConversation | null;
  agent: PersonalAgent | null;
  group: PaGroup | null;
  character: PaCharacterView | null;
  members: PersonalAgent[];
  title: string;
  platform: PaChannel['type'] | null;
  /** The conversation's resolved mode; null before the first conversation exists. */
  mode: 'work' | 'companion' | null;
  /** A 聊天 row: a companion conversation, or a character with no conversation yet (spec §3.2 item 4). */
  chat: boolean;
  activity: number;
  preview: PaPreview;
  running: boolean;
  unread: boolean;
  needs: number;
  selected: boolean;
  disabled: boolean;
  haystack: string;
}

interface MenuEntry {
  key: string;
  label: string;
  tone?: 'default' | 'danger';
  /** Draw a separator before this entry. */
  separated?: boolean;
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

type PreviewTone = 'shimmer' | 'warning' | 'failed' | null;

/** A work conversation's second line (the existing preview): working, queued, needs-you, failed or the last text. */
function workPreviewLine(index: PaIndex, row: RosterRow, t: TFn): { text: string; tone: PreviewTone } {
  const preview = row.preview;
  switch (preview.kind) {
    case 'working':
      // A direct row already carries the worker's name in its title: "研究员 / 正在工作…", not "研究员 / 研究员 正在工作…".
      if (row.group === null && row.agent && preview.agentId === row.agent.id) return { text: t('pa.preview.workingSelf'), tone: 'shimmer' };
      return { text: t('pa.preview.working', { name: displayName(index, preview.agentId) || row.title }), tone: 'shimmer' };
    case 'queued':
      return { text: t('pa.preview.queued'), tone: null };
    case 'needs':
      return { text: t('pa.preview.needsYou'), tone: 'warning' };
    case 'failed':
      return { text: t('pa.preview.failed', { error: preview.error }), tone: 'failed' };
    case 'text': {
      if (preview.sender === 'owner') return { text: t('pa.preview.you', { text: preview.text }), tone: null };
      const many = row.kind === 'group' || (row.kind === 'channel' && row.group !== null);
      const name = displayName(index, preview.sender);
      return { text: many && name ? t('pa.preview.sender', { name, text: preview.text }) : preview.text, tone: null };
    }
    default:
      return { text: row.fantay ? t('pa.soul.shell.row.fantayIdle') : t('pa.preview.empty'), tone: null };
  }
}

/** The row's second line (spec §3.2 preview table; the first matching condition wins). A companion row never shows
 *  task language: typing while a real chat turn is queued or running, the app's failure, the last line, a hello. */
function previewLine(index: PaIndex, row: RosterRow, t: TFn): { text: string; tone: PreviewTone } {
  const hello = () => ({ text: row.character?.tagline.trim() || t('pa.soul.shell.row.sayHi'), tone: null });
  const conversation = row.conversation;
  if (!conversation) {
    if (row.fantay) return { text: t('pa.soul.shell.row.fantayIdle'), tone: null };
    return row.character ? hello() : { text: t('pa.preview.empty'), tone: null };
  }
  if (row.mode !== 'companion') return workPreviewLine(index, row, t);
  const preview = row.preview;
  if (preview.kind === 'working') return { text: t('pa.soul.shell.row.typing'), tone: 'shimmer' };
  if (retryableChatTask(index, conversation.id)) return { text: t('pa.soul.shell.row.failed'), tone: 'failed' };
  if (preview.kind === 'text') {
    if (preview.sender === 'owner') return { text: t('pa.soul.shell.row.you', { text: preview.text }), tone: null };
    const name = row.group ? displayName(index, preview.sender) : '';
    return { text: name ? t('pa.soul.shell.row.speaker', { name, text: preview.text }) : preview.text, tone: null };
  }
  return hello();
}

function newestAgentMessage(index: PaIndex, conversationId: string): number {
  const messages = index.messagesByConversation.get(conversationId) ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]!.senderId !== 'owner') return messages[i]!.createdAt;
  return 0;
}

function membersOf(index: PaIndex, group: PaGroup): PersonalAgent[] {
  return group.memberIds.map((id) => index.agents.get(id)).filter((agent): agent is PersonalAgent => Boolean(agent));
}

/** The pinned Fantay row and one sorted list (spec §3.2): one row per character (its latest direct chat), group
 *  chat and channel chat. Enabled before disabled, then last activity, then name. */
function useRosterRows(): { fantay: RosterRow | null; rows: RosterRow[] } {
  const { index, ui, data } = usePa();
  const paused = data.control?.paused === true;
  const seen = useContext(PaSeenContext);
  return useMemo(() => {
    const current = ui.place === 'conversation' && ui.conversationId ? index.conversations.get(ui.conversationId) ?? null : null;
    const needsBy = new Map<string, number>();
    for (const need of index.needs)
      if (need.kind === 'task') needsBy.set(need.task.conversationId, (needsBy.get(need.task.conversationId) ?? 0) + 1);

    const make = (kind: RowKind, conversation: PaConversation | null, extra: Partial<RosterRow> & Pick<RosterRow, 'key' | 'title'>): RosterRow => {
      const tasks = conversation ? index.tasksByConversation.get(conversation.id) ?? [] : [];
      const newest = conversation ? newestAgentMessage(index, conversation.id) : 0;
      const mode = conversation ? conversationMode(index, conversation) : null;
      const row: RosterRow = {
        kind,
        fantay: false,
        conversation,
        agent: null,
        group: null,
        character: null,
        members: [],
        platform: null,
        mode,
        chat: false,
        activity: conversation ? index.lastActivity.get(conversation.id) ?? conversation.updatedAt : 0,
        preview: conversation ? (mode === 'companion' ? soulPreview(index, conversation, paused) : lastPreview(index, conversation)) : { kind: 'empty' },
        // Only a running work task marks the avatar; a chat turn shows as 正在输入… in the preview instead.
        running: tasks.some((task) => !isChatTask(task) && (task.status === 'running' || task.status === 'verifying')),
        unread: false,
        needs: conversation ? needsBy.get(conversation.id) ?? 0 : 0,
        selected: false,
        disabled: false,
        haystack: '',
        ...extra,
      };
      row.chat = mode === 'companion' || (conversation === null && row.character !== null);
      row.unread = !row.selected && conversation !== null && newest > (seen[conversation.id] ?? 0);
      const previewText = row.preview.kind === 'text' ? row.preview.text : '';
      row.haystack = [row.title, ...row.members.map((member) => member.name), previewText].join('\n').toLowerCase();
      return row;
    };

    const rows: RosterRow[] = [];
    for (const group of index.groups.values()) {
      const conversation = index.conversations.get(group.conversationId) ?? null;
      rows.push(
        make('group', conversation, {
          key: `group:${group.id}`,
          title: group.name,
          group,
          members: membersOf(index, group),
          selected: current?.id === group.conversationId,
        }),
      );
    }
    for (const agent of index.agents.values()) {
      if (isFantay(index, agent.id)) continue;
      rows.push(
        make('agent', index.directByAgent.get(agent.id)?.[0] ?? null, {
          key: `agent:${agent.id}`,
          title: displayName(index, agent.id),
          agent,
          character: characterOf(index, agent.id),
          members: [agent],
          disabled: !agent.enabled,
          selected: Boolean(current && conversationKind(current) === 'direct' && current.agentId === agent.id),
        }),
      );
    }
    for (const conversation of index.channelConversations) {
      const channel = conversation.channelId ? index.channels.get(conversation.channelId) : undefined;
      const group = conversation.groupId ? index.groups.get(conversation.groupId) ?? null : null;
      const agent = !group && conversation.agentId ? index.agents.get(conversation.agentId) ?? null : null;
      rows.push(
        make('channel', conversation, {
          key: `channel:${conversation.id}`,
          title: conversationTitle(index, conversation),
          group,
          agent,
          character: agent ? characterOf(index, agent.id) : null,
          members: group ? membersOf(index, group) : agent ? [agent] : [],
          platform: channel?.type ?? null,
          selected: current?.id === conversation.id,
        }),
      );
    }
    rows.sort((a, b) => Number(a.disabled) - Number(b.disabled) || b.activity - a.activity || a.title.localeCompare(b.title));

    const agent = index.fantay;
    const fantay = agent
      ? make('agent', index.directByAgent.get(agent.id)?.[0] ?? null, {
          key: 'fantay',
          fantay: true,
          title: agent.name,
          agent,
          members: [agent],
          selected: Boolean(current && conversationKind(current) === 'direct' && current.agentId === agent.id),
        })
      : null;
    return { fantay, rows };
  }, [index, paused, seen, ui.conversationId, ui.place]);
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
  const { data, nav, index } = usePa();
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

  /** One item list for the row's ⋯ menu and its context menu (spec §3.2 row actions). A member who cannot manage the
   *  library (enterprise mode) keeps what is theirs: opening, a new chat with a character, the look of their chat. */
  const entries = (row: RosterRow): MenuEntry[] => {
    const all = allEntries(row);
    if (index.canManageLibrary) return all;
    return all.filter((entry) => !['edit', 'duplicate', 'toggle'].includes(entry.key) && (entry.key !== 'new' || row.character !== null));
  };
  const allEntries = (row: RosterRow): MenuEntry[] => {
    const newChat = (agentId: string): MenuEntry => ({
      key: 'new',
      label: t('pa.roster.newChat'),
      run: () => void nav.newConversation(agentId).catch(notifyError),
    });
    const look: MenuEntry[] =
      row.mode === 'companion' && row.conversation
        ? [{ key: 'look', label: t('pa.soul.shell.row.look'), run: () => nav.openModal({ kind: 'appearance', conversationId: row.conversation!.id }) }]
        : [];
    if (row.fantay && row.agent) {
      const agent = row.agent;
      return [newChat(agent.id), { key: 'edit', label: t('pa.roster.editProfile'), run: () => nav.openModal({ kind: 'agent', agentId: agent.id }) }];
    }
    if (row.kind === 'agent' && row.agent) {
      const agent = row.agent;
      return [
        { key: 'open', label: t('pa.roster.open'), run: () => openRow(row) },
        newChat(agent.id),
        { key: 'edit', label: t('pa.roster.editProfile'), run: () => nav.openModal({ kind: 'agent', agentId: agent.id }) },
        ...look,
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
          ? { key: 'toggle', label: t('pa.disable'), separated: true, run: () => setDisabling(agent) }
          : { key: 'toggle', label: t('pa.enable'), separated: true, run: () => void data.actions.setAgentEnabled(agent, true).catch(notifyError) },
      ];
    }
    if (row.kind === 'group' && row.group) {
      const group = row.group;
      return [
        { key: 'open', label: t('pa.roster.open'), run: () => openRow(row) },
        { key: 'edit', label: t('pa.roster.editGroup'), run: () => nav.openModal({ kind: 'group', groupId: group.id }) },
        ...look,
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

/** First load (spec §17.2): five roster rows drawn as rows (a disc and two lines of varied length), not slabs. */
const SKELETON_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['44%', '78%'],
  ['30%', '62%'],
  ['52%', '70%'],
  ['36%', '84%'],
  ['40%', '58%'],
];

/** Fantay's face: the still mascot on its disc (characters never get a live mascot, spec O10). */
function FantayFace({ size }: { size: number }) {
  return (
    <span className={styles.fantayDisc} style={{ width: size, height: size }} aria-hidden>
      <FantayMascotStill size={Math.round(size * 0.85)} />
    </span>
  );
}

/** `dim`: fade a disabled character's face (the rail; a full row fades as a whole instead). */
function RowAvatar({ row, size, dim = false }: { row: RosterRow; size: number; dim?: boolean }) {
  const { index } = usePa();
  const fantayId = index.fantay?.id ?? null;
  const face = row.fantay ? (
    <FantayFace size={size} />
  ) : row.group !== null ? (
    <PaGroupAvatar members={row.members} fantayId={fantayId} size={size} portraitOf={(agentId) => portraitSrc(index, agentId)} />
  ) : (
    <SoulAgentPortrait agent={row.agent} character={row.character} fantay={isFantay(index, row.agent?.id)} size={size} dim={dim && row.disabled} />
  );
  return (
    <span className={styles.avatar} style={{ width: size, height: size }} aria-hidden>
      {face}
      {row.running ? <RunStatusDot tone="running" className={styles.avatarDot} /> : null}
    </span>
  );
}

/** The menu items, drawn once for the ⋯ dropdown and once for the context menu. */
function MenuItems({ entries, context }: { entries: MenuEntry[]; context?: boolean }) {
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
  return (
    <>
      {entries.map((entry) => (
        <Fragment key={entry.key}>
          {entry.separated ? <Separator /> : null}
          <Item tone={entry.tone} onSelect={entry.run}>
            {entry.label}
          </Item>
        </Fragment>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Full variant
// ---------------------------------------------------------------------------------------------------------

const FILTERS: ReadonlyArray<{ value: PaRosterFilter; label: 'pa.soul.shell.filter.all' | 'pa.soul.shell.filter.chat' | 'pa.soul.shell.filter.work' }> = [
  { value: 'all', label: 'pa.soul.shell.filter.all' },
  { value: 'chat', label: 'pa.soul.shell.filter.chat' },
  { value: 'work', label: 'pa.soul.shell.filter.work' },
];

function RosterFull() {
  const { data, index, ui, nav, now } = usePa();
  const { t, locale } = useI18n();
  const { fantay, rows } = useRosterRows();
  const actions = useRowActions();
  const loading = data.load === 'loading' && !data.snapshot;
  const offline = data.load === 'offline' && !data.snapshot;

  // The filter picks the segment; the search narrows inside it. The pinned Fantay row ignores both.
  const query = ui.rosterQuery.trim().toLowerCase();
  const filter = ui.rosterFilter;
  const inSegment = filter === 'all' ? rows : rows.filter((row) => row.chat === (filter === 'chat'));
  const shown = query ? inSegment.filter((row) => row.haystack.includes(query)) : inSegment;
  const noMatch = query.length > 0 && shown.length === 0;
  const emptyChat = !query && filter === 'chat' && inSegment.length === 0;

  const keys = [...(fantay ? [fantay.key] : []), ...shown.map((row) => row.key)];
  const selectedKey = fantay?.selected ? fantay.key : shown.find((row) => row.selected)?.key ?? null;
  const roving = useRoving(keys, selectedKey);

  const renderRow = (row: RosterRow) => {
    const line = previewLine(index, row, t);
    const entries = actions.entries(row);
    const platform = row.platform ? channelBadge(row.platform, t) : null;
    const time = row.activity > 0 && row.preview.kind !== 'empty' ? formatRowTime(row.activity, now, locale) : '';
    return (
      <ContextMenu key={row.key}>
        <ContextMenuTrigger asChild>
          <div
            className={styles.row}
            data-testid={row.fantay ? 'pa-roster-fantay' : 'pa-roster-row'}
            data-kind={row.kind}
            data-mode={row.mode ?? undefined}
            data-conversation-id={row.conversation?.id}
            data-agent-id={row.kind === 'agent' ? row.agent?.id : undefined}
            data-selected={row.selected ? '' : undefined}
            data-unread={row.unread ? '' : undefined}
            data-disabled={row.disabled ? '' : undefined}
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
              <RowAvatar row={row} size={40} />
              <span className={styles.text}>
                <span className={styles.line1}>
                  <span className={styles.title}>
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
              {/* Time over the badge, both on the row's end edge. An empty conversation has had no activity yet: no
                  time, so a hello line never sits beside a creation date that reads like a last message. */}
              <span className={styles.meta}>
                <span className={styles.time}>{time}</span>
                {row.needs > 0 ? (
                  <span className={shell.needsPill} data-testid="pa-roster-needs">
                    {row.needs}
                  </span>
                ) : row.unread ? (
                  <Dot size="md" tone="current" className={styles.unread} />
                ) : null}
              </span>
            </Button>
            <span className={styles.menu} data-roster-menu="">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton size="xs" variant="quiet" aria-label={t('pa.roster.rowMenu')} tooltip={false}>
                    <MoreHorizontalIcon size="sm" />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent width="md" align="end">
                  <MenuItems entries={entries} />
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className={styles.contextMenu}>
          <MenuItems entries={entries} context />
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  let list: ReactNode;
  if (loading) {
    list = (
      <div className={styles.skeletons}>
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
    );
  } else if (offline) {
    // No snapshot to list: Fantay alone, saying it is offline. The filter and the bottom bar still render.
    list = (
      <div className={cn(styles.row, styles.rowStatic)} data-testid="pa-roster-fantay" data-offline="">
        <span className={styles.rowGrid}>
          <span className={styles.avatar} style={{ width: 40, height: 40 }} aria-hidden>
            <FantayFace size={40} />
          </span>
          <span className={styles.text}>
            <span className={styles.title}>{t('pa.title')}</span>
            <span className={styles.preview}>{t('pa.status.offline')}</span>
          </span>
        </span>
      </div>
    );
  } else {
    list = (
      <>
        {fantay ? renderRow(fantay) : null}
        {fantay ? <div className={styles.pinRule} role="separator" /> : null}
        {shown.map(renderRow)}
        {noMatch ? <p className={styles.noMatch}>{t('pa.roster.noMatch')}</p> : null}
        {emptyChat ? (
          <div className={styles.filterEmpty} data-testid="pa-roster-empty-chat">
            <p className={styles.filterEmptyText}>{t('pa.soul.shell.filter.emptyChat')}</p>
            <Button variant="link" size="sm" onClick={() => nav.openPlace('library', { libraryTab: 'characters' })}>
              {t('pa.soul.shell.plus.starters')}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <nav
      aria-label={t('pa.roster.label')}
      data-testid="pa-roster"
      data-variant="full"
      className={styles.roster}
      onKeyDown={roving.onKeyDown}
    >
      <div className={styles.top}>
        <div className={styles.searchRow}>
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
          <SoulRosterMenu>
            <IconButton size="md" variant="quiet" data-testid="pa-roster-plus" aria-label={t('pa.soul.shell.plus.label')}>
              <PlusIcon />
            </IconButton>
          </SoulRosterMenu>
        </div>
        <Segmented
          size="sm"
          className={cn('flex w-full', styles.filter)}
          data-testid="pa-roster-filter"
          aria-label={t('pa.soul.shell.filter.label')}
          value={filter}
          onValueChange={(value) => nav.setRosterFilter(value as PaRosterFilter)}
        >
          {FILTERS.map((item) => (
            <SegmentedItem key={item.value} value={item.value} className="min-w-0 flex-1" data-testid={`pa-roster-filter-${item.value}`}>
              {t(item.label)}
            </SegmentedItem>
          ))}
        </Segmented>
      </div>
      <div className={styles.scroll}>{list}</div>
      <SoulBottomBar />
      {actions.confirm}
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Rail variant (64 px)
// ---------------------------------------------------------------------------------------------------------

/** A rail face's tooltip and name: the row title plus the suffixes the full row shows after it (platform, disabled),
 *  since a Fantay channel chat's face is otherwise indistinguishable from Fantay's own. */
function railLabel(row: RosterRow, t: TFn): string {
  const parts = [row.title];
  if (row.platform) parts.push(channelBadge(row.platform, t));
  if (row.disabled) parts.push(t('pa.disabled'));
  if (row.needs > 0 || row.preview.kind === 'needs') parts.push(t('pa.preview.needsYou'));
  return parts.join(' · ');
}
function channelBadge(platform: PaChannel['type'], t: TFn): string {
  if (platform === 'feishu' || platform === 'weixin') return t(platform === 'feishu' ? 'pa.roster.feishu' : 'pa.roster.weixin');
  return platformName(platform, t);
}

function RosterRail() {
  const { data, nav } = usePa();
  const { t } = useI18n();
  const { fantay, rows } = useRosterRows();
  const actions = useRowActions();
  const offline = data.load === 'offline' && !data.snapshot;
  const loading = data.load === 'loading' && !data.snapshot;

  // The rail has no filter and no typing text: faces only, with the corner dot carrying needs-you or unread.
  const face = (row: RosterRow) => {
    const label = railLabel(row, t);
    return (
      <span
        key={row.key}
        className={styles.railSlot}
        data-testid={row.fantay ? 'pa-roster-fantay' : 'pa-roster-row'}
        data-conversation-id={row.conversation?.id}
        data-agent-id={row.kind === 'agent' ? row.agent?.id : undefined}
      >
        <Tooltip label={label} side="right">
          <Button
            variant="bare"
            className={styles.railFace}
            aria-label={label}
            aria-current={row.selected ? 'true' : undefined}
            data-selected={row.selected ? '' : undefined}
            onClick={() => actions.openRow(row)}
          >
            <RowAvatar row={row} size={40} dim />
          </Button>
        </Tooltip>
        {row.needs > 0 || row.preview.kind === 'needs' ? (
          <span aria-hidden className={styles.railDot} />
        ) : row.unread ? (
          <span aria-hidden className={styles.railUnread} />
        ) : null}
      </span>
    );
  };

  return (
    <nav aria-label={t('pa.roster.label')} data-testid="pa-roster" data-variant="rail" className={styles.rail}>
      {/* Offline there is no list to open: the full roster would show the same lone Fantay row. */}
      {offline ? null : (
        <div className={styles.railTools}>
          <IconButton size="sm" aria-label={t('pa.roster.openList')} tooltipSide="right" onClick={nav.openRosterSheet}>
            <PanelLeftOpen strokeWidth={1.5} />
          </IconButton>
          <SoulRosterMenu side="right">
            <IconButton size="sm" aria-label={t('pa.soul.shell.plus.label')} tooltipSide="right" data-testid="pa-roster-plus">
              <PlusIcon />
            </IconButton>
          </SoulRosterMenu>
        </div>
      )}
      {offline ? null : <div className={styles.railHairline} role="separator" />}
      {fantay && !offline ? (
        face(fantay)
      ) : (
        <span className={styles.railSlot} data-testid="pa-roster-fantay" data-offline={offline ? '' : undefined}>
          <span className={styles.railFaceStatic}>
            <FantayFace size={40} />
          </span>
        </span>
      )}
      {offline ? null : (
        <>
          <div className={styles.railHairline} role="separator" />
          <div className={styles.railScroll}>
            {loading
              ? SKELETON_ROWS.slice(0, 4).map((_, i) => (
                  <span key={i} className={styles.railSkeleton} aria-hidden>
                    <Skeleton index={i} className={styles.skAvatar} />
                  </span>
                ))
              : rows.map(face)}
          </div>
          <div className={styles.railHairline} role="separator" />
          <div className={styles.railPlaces}>
            <SoulRailPlaces />
          </div>
        </>
      )}
      {actions.confirm}
    </nav>
  );
}
