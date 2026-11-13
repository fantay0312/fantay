// SPDX-License-Identifier: AGPL-3.0-only
// One project in the sidebar (spec 02 §11.3): an expand chevron (lazy chat list), the kind mark and name,
// the run-status dot, and two hover actions: a new chat in this project, and a "more" menu with new chat, rename
// inline, duplicate, pin, move to a group, archive, delete. The rename field replaces the name: Enter commits through App's rename handler, Esc or blur
// cancels. The row drags onto a sidebar section.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  Copy,
  Ellipsis,
  FileCode2,
  Film,
  FolderMinus,
  FolderPlus,
  Palette,
  Pin,
  PinOff,
  SquarePen,
  Trash2,
  FolderOpen,
  List,
  Settings2,
  X,
} from 'lucide-react';
import { openHostProjectPath } from '@open-design/host';
import { useWorkspaceContext } from '../../../collab/useWorkspaceContext';
import { navigate } from '../../../router';
import { toast } from '../../ui/toast';
import { ConfirmDialog } from '../../ui/dialog';
import { organizeAllConversations } from './conversation-actions';
import { ProjectEditDialog } from './ProjectEditDialog';

import { useT } from '../../../i18n';
import { STATUS_LABEL_KEYS } from '../../../state/projectRunStatus';
import type { Conversation, Project } from '../../../types';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { IconButton } from '../../ui/icon-button';
import { Icon } from '../../ui/icons';
import { Input } from '../../ui/input';
import { Tooltip } from '../../ui/tooltip';
import { useProjectOrganization, useProjectOrganizationActions } from '../project-organization-store';
import { RunStatusDot } from './RunStatusDot';
import { SidebarConversationRow } from './SidebarConversationRow';
import { SIDEBAR_PROJECT_DRAG_TYPE } from './SidebarSection';
import {
  CONVERSATION_PREVIEW_LIMIT,
  conversationStatusTone,
  conversationToneStatus,
  hasConversationActivity,
  type SidebarProjectKind,
  type SidebarStatusTone,
} from './sidebar-model';

const KIND_MARK = {
  motion: { icon: Film, labelKey: 'fantayShell.sidebar.motion', className: 'bg-success/12 text-success-ink' },
  designSystem: {
    icon: Palette,
    labelKey: 'fantayShell.sidebar.designSystems',
    className: 'bg-brand-soft text-brand-ink',
  },
} as const;

/** Motion and design-system projects wear a tinted tile, so they stand out among the plain project rows. */
function ProjectKindMark({ kind, projectId }: { kind: SidebarProjectKind; projectId: string }) {
  const t = useT();
  if (kind === 'project') {
    return (
      <span className="flex size-[18px] flex-none items-center justify-center">
        <Icon icon={FileCode2} size={15} className="text-ink-faint" />
      </span>
    );
  }
  const mark = KIND_MARK[kind];
  const label = t(mark.labelKey);
  return (
    <Tooltip label={label}>
      <span
        role="img"
        aria-label={label}
        data-testid={`fantay-sidebar-project-mark-${projectId}`}
        data-kind={kind}
        className={cn('flex size-[18px] flex-none items-center justify-center rounded-tag', mark.className)}
      >
        <Icon icon={mark.icon} size={12} />
      </span>
    </Tooltip>
  );
}

/** A row action rests hidden; hover or focus reveals it, and an open menu or a touch screen keeps it. */
const ROW_ACTION_CLASS = cn(
  'focus-visible:-outline-offset-2 not-data-disabled:hover:bg-ink/8',
  'pointer-events-none opacity-0 transition-opacity duration-micro',
  'group-hover/row:pointer-events-auto group-hover/row:opacity-100',
  'group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100',
  'data-[state=open]:pointer-events-auto data-[state=open]:opacity-100',
  '[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100',
);

/** What the row menu can do; the shell owns the dialogs and the open-then-act sequencing. */
export interface SidebarProjectActions {
  rename(projectId: string, name: string): void | Promise<void>;
  duplicate(project: Project): void;
  requestDelete(project: Project): void;
  newChatInProject(projectId: string): void;
}

export interface SidebarConversationListState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  conversations: readonly Conversation[];
  runningIds: ReadonlySet<string>;
  activeConversationId: string | null;
}

export interface SidebarProjectRowProps {
  project: Project;
  kind: SidebarProjectKind;
  active: boolean;
  expanded: boolean;
  statusTone: SidebarStatusTone;
  statusLabel?: string;
  conversations: SidebarConversationListState;
  onToggleExpanded(): void;
  onOpen(): void;
  onSelectConversation(conversationId: string): void;
  onRetryConversations(): void;
  actions: SidebarProjectActions;
  onRequestNewGroup(): void;
}

export function SidebarProjectRow({
  project,
  kind,
  active,
  expanded,
  statusTone,
  statusLabel,
  conversations,
  onToggleExpanded,
  onOpen,
  onSelectConversation,
  onRetryConversations,
  actions,
  onRequestNewGroup,
}: SidebarProjectRowProps) {
  const t = useT();
  const { groups, entries } = useProjectOrganization();
  const { context } = useWorkspaceContext();
  const organization = useProjectOrganizationActions();
  const entry = entries.get(project.id);
  const pinned = entry?.pinnedAt != null;
  const archived = entry?.archivedAt != null;
  const groupId = entry?.groupId ?? null;
  const name = project.name.trim() || t('common.untitled');
  const [renaming, setRenaming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [archiveChats, setArchiveChats] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkInFlight = useRef(false);
  const bulk = async (action: 'read' | 'archive') => {
    if (bulkInFlight.current) return;
    bulkInFlight.current = true;
    setBulkBusy(true);
    try {
      await organizeAllConversations(project.id, action, context);
      setArchiveChats(false);
    } catch {
      toast({ title: t('ds.actionFailed'), tone: 'danger' });
    } finally {
      bulkInFlight.current = false;
      setBulkBusy(false);
    }
  };
  const reveal = async () => {
    const result = await openHostProjectPath(project.id);
    if (!result.ok) toast({ title: result.reason, tone: 'danger' });
  };
  const [draft, setDraft] = useState(name);
  const renameRequested = useRef(false);
  // The new-group dialog takes the focus, so the closing menu must not hand it back to its trigger.
  const newGroupRequested = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowButtonRef = useRef<HTMLButtonElement | null>(null);
  // Enter / Escape in the rename field hand the focus back to the row instead of dropping it on <body>.
  const refocusRow = useRef(false);
  const [showAll, setShowAll] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [everExpanded, setEverExpanded] = useState(expanded);
  const sublistRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (expanded) setEverExpanded(true);
  }, [expanded]);

  useEffect(() => {
    const sublist = sublistRef.current;
    if (!sublist) return;
    if (expanded) sublist.removeAttribute('inert');
    else sublist.setAttribute('inert', '');
  }, [expanded]);

  useEffect(() => {
    if (!renaming) return undefined;
    // After the menu has closed (its focus return is suppressed while a rename is pending).
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renaming]);

  useEffect(() => {
    if (renaming || !refocusRow.current) return;
    refocusRow.current = false;
    rowButtonRef.current?.focus();
  }, [renaming]);

  const startRename = () => {
    renameRequested.current = true;
    setDraft(name);
    setRenaming(true);
  };

  const finishRename = (commit: boolean) => {
    renameRequested.current = false;
    setRenaming(false);
    const next = draft.trim();
    if (commit && next && next !== project.name.trim()) actions.rename(project.id, next);
  };

  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      refocusRow.current = true;
      finishRename(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      refocusRow.current = true;
      finishRename(false);
    }
  };

  const items = useMemo(
    () =>
      conversations.conversations.filter(
        (item) =>
          item.archivedAt == null &&
          (!item.groupId || !groups.some((group) => group.id === item.groupId)) &&
          (item.pinnedAt != null || hasConversationActivity(item, conversations.runningIds)),
      ),
    [conversations.conversations, conversations.runningIds, groups],
  );
  const visibleItems = showAll ? items : items.slice(0, CONVERSATION_PREVIEW_LIMIT);
  const archivedItems = conversations.conversations.filter((item) => item.archivedAt != null);
  // One selected row at a time: the open chat carries the fill, so its project does not stack a second block above it.
  const chatSelected = expanded && visibleItems.some((item) => item.id === conversations.activeConversationId);

  const startChat = () => {
    if (!expanded) onToggleExpanded();
    actions.newChatInProject(project.id);
  };

  return (
    <li className="list-none" data-testid={`fantay-sidebar-project-item-${project.id}`}>
      <div
        className={cn(
          'group/row relative flex h-[31px] items-center rounded-row transition-colors duration-micro',
          active && !chatSelected ? 'bg-paper-deep' : 'hover:bg-paper-deep',
        )}
        data-active={active ? '' : undefined}
        draggable={!renaming}
        onDragStart={(event) => {
          event.dataTransfer.setData(SIDEBAR_PROJECT_DRAG_TYPE, project.id);
          event.dataTransfer.effectAllowed = 'move';
        }}
      >
        <IconButton
          size="xs"
          tooltipSide="right"
          aria-label={t(expanded ? 'fantayShell.sidebar.collapseItem' : 'fantayShell.sidebar.expandItem', { name })}
          aria-expanded={expanded}
          data-testid={`fantay-sidebar-project-expand-${project.id}`}
          className="ms-1 size-5 flex-none text-ink-faint focus-visible:-outline-offset-2 not-data-disabled:hover:bg-transparent"
          onClick={onToggleExpanded}
        >
          <Icon
            icon={ChevronRight}
            size={12}
            className={cn(
              'transition-transform duration-enter ease-out-quint motion-reduce:transition-none rtl:rotate-180',
              expanded && 'rotate-90 rtl:rotate-90',
            )}
          />
        </IconButton>
        {renaming ? (
          <Input
            ref={inputRef}
            inputSize="sm"
            aria-label={t('fantayShell.sidebar.renameLabel')}
            value={draft}
            data-testid={`fantay-sidebar-project-rename-${project.id}`}
            className="me-1 h-6 min-w-0 flex-1 px-1.5"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onRenameKeyDown}
            onBlur={() => {
              if (renameRequested.current) return;
              finishRename(false);
            }}
            onFocus={() => {
              renameRequested.current = false;
            }}
          />
        ) : (
          <Button
            ref={rowButtonRef}
            variant="bare"
            size="md"
            data-sidebar-row=""
            data-testid={`fantay-sidebar-project-${project.id}`}
            data-active={active ? '' : undefined}
            aria-current={active ? 'page' : undefined}
            /* The open project's row folds and unfolds its chats; any other row opens its project. */
            aria-expanded={active ? expanded : undefined}
            className={cn(
              'h-[31px] min-w-0 flex-1 justify-start gap-2 rounded-row ps-1 pe-2 text-body font-normal text-ink-soft',
              /* The name gives way to the two actions instead of running under them. */
              'group-hover/row:pe-[56px] group-focus-within/row:pe-[56px] [@media(hover:none)]:pe-[56px]',
              'not-data-disabled:hover:bg-transparent not-data-disabled:hover:text-ink data-active:text-ink',
              'focus-visible:-outline-offset-2 [&>[data-slot=button-label]]:flex-1',
            )}
            onClick={onOpen}
            onDoubleClick={startRename}
          >
            <ProjectKindMark kind={kind} projectId={project.id} />
            <span className="min-w-0 flex-1 truncate text-start">{name}</span>
            <RunStatusDot
              tone={statusTone}
              label={statusLabel}
              data-testid={`fantay-sidebar-status-${project.id}`}
              className="transition-opacity group-focus-within/row:opacity-0 group-hover/row:opacity-0"
            />
          </Button>
        )}
        {renaming ? null : (
          <div className="pointer-events-none absolute inset-y-0 end-1 flex items-center gap-0.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  size="xs"
                  aria-label={t('fantayShell.sidebar.itemActions', { name })}
                  tooltipSide="top"
                  data-testid={`fantay-sidebar-project-menu-${project.id}`}
                  className={ROW_ACTION_CLASS}
                >
                  <Icon icon={Ellipsis} size={14} />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                width="md"
                align="start"
                onCloseAutoFocus={(event) => {
                  if (renameRequested.current || newGroupRequested.current || editing || archiveChats)
                    event.preventDefault();
                  newGroupRequested.current = false;
                }}
              >
                {archived ? null : (
                  <DropdownMenuItem
                    icon={<Icon icon={pinned ? PinOff : Pin} size={14} />}
                    data-testid={`fantay-sidebar-project-pin-${project.id}`}
                    onSelect={() => organization.organize(project.id, { pinned: !pinned })}
                  >
                    {t(pinned ? 'fantayShell.sidebar.unpin' : 'fantayShell.sidebar.pin')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem icon={<Icon icon={Settings2} size={14} />} onSelect={() => setEditing(true)}>
                  {t('common.edit')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger
                    icon={<Icon icon={List} size={14} />}
                    data-testid={`fantay-sidebar-project-move-${project.id}`}
                  >
                    {t('fantayShell.sidebar.section')}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {groups.map((group) => (
                      <DropdownMenuItem
                        key={group.id}
                        icon={group.id === groupId ? <Icon icon={Check} size={14} /> : <span className="size-3.5" />}
                        onSelect={() => organization.organize(project.id, { groupId: group.id })}
                      >
                        <span className="min-w-0 truncate">{group.name}</span>
                      </DropdownMenuItem>
                    ))}
                    {groups.length > 0 ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuItem
                      icon={<Icon icon={FolderPlus} size={14} />}
                      data-testid={`fantay-sidebar-project-new-group-${project.id}`}
                      onSelect={() => {
                        newGroupRequested.current = true;
                        onRequestNewGroup();
                      }}
                    >
                      {t('fantayShell.sidebar.newGroup')}…
                    </DropdownMenuItem>
                    {groupId ? (
                      <DropdownMenuItem
                        icon={<Icon icon={FolderMinus} size={14} />}
                        onSelect={() => organization.organize(project.id, { groupId: null })}
                      >
                        {t('fantayShell.sidebar.removeFromGroup')}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem icon={<Icon icon={FolderOpen} size={14} />} onSelect={() => void reveal()}>
                  {t('fantayShell.sidebar.showFolder')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  icon={<Icon icon={Check} size={14} />}
                  disabled={bulkBusy}
                  onSelect={() => void bulk('read')}
                >
                  {t('messageCenter.markAllRead')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  icon={<Icon icon={Archive} size={14} />}
                  disabled={bulkBusy}
                  onSelect={() => setArchiveChats(true)}
                >
                  {t('fantayShell.sidebar.archiveChats')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  icon={<Icon icon={X} size={14} />}
                  onSelect={() => {
                    const removed = entry?.removedAt == null;
                    organization.organize(project.id, { removed });
                    if (removed) {
                      if (active) navigate({ kind: 'home', view: 'home' });
                      toast({
                        title: t('fantayShell.sidebar.removedToast'),
                        action: {
                          label: t('fantayShell.sidebar.undo'),
                          onClick: () => organization.organize(project.id, { removed: false }),
                        },
                      });
                    }
                  }}
                >
                  {t(
                    entry?.removedAt == null
                      ? 'fantayShell.sidebar.removeProject'
                      : 'fantayShell.sidebar.restoreProject',
                  )}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem icon={<Icon icon={SquarePen} size={14} />} onSelect={startChat}>
                  {t('fantayShell.sidebar.newChatInProject')}
                </DropdownMenuItem>
                <DropdownMenuItem icon={<Icon icon={Copy} size={14} />} onSelect={() => actions.duplicate(project)}>
                  {t('designs.menuDuplicate')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  icon={<Icon icon={archived ? ArchiveRestore : Archive} size={14} />}
                  data-testid={`fantay-sidebar-project-archive-${project.id}`}
                  onSelect={() => {
                    if (archived) organization.organize(project.id, { archived: false });
                    else organization.archive(project);
                  }}
                >
                  {t(archived ? 'fantayShell.sidebar.unarchive' : 'fantayShell.sidebar.archiveProject')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  tone="danger"
                  icon={<Icon icon={Trash2} size={14} />}
                  onSelect={() => actions.requestDelete(project)}
                >
                  {t('fantayShell.sidebar.deletePermanently')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <IconButton
              size="xs"
              aria-label={t('fantayShell.sidebar.newChatInProject')}
              tooltipSide="top"
              data-testid={`fantay-sidebar-project-new-chat-${project.id}`}
              className={ROW_ACTION_CLASS}
              onClick={startChat}
            >
              <Icon icon={SquarePen} size={14} />
            </IconButton>
          </div>
        )}
      </div>
      <div
        ref={sublistRef}
        className={cn(
          'grid transition-[grid-template-rows,opacity] ease-out-quint motion-reduce:transition-none',
          expanded ? 'grid-rows-[1fr] opacity-100 duration-enter' : 'grid-rows-[0fr] opacity-0 duration-exit',
        )}
        data-testid={`fantay-sidebar-project-chats-${project.id}`}
        data-expanded={expanded ? '' : undefined}
      >
        <div className="min-h-0 overflow-hidden">
          {everExpanded ? (
            <>
              <ConversationSublist
                state={conversations}
                visible={visibleItems}
                total={items.length}
                showAll={showAll}
                onToggleShowAll={() => setShowAll((value) => !value)}
                onSelect={onSelectConversation}
                onRetry={onRetryConversations}
              />
              {archivedItems.length > 0 ? (
                <>
                  <Button
                    variant="bare"
                    size="sm"
                    className="h-7 w-full justify-start gap-2 ps-[39px] text-label font-normal text-ink-faint"
                    aria-expanded={showArchived}
                    onClick={() => setShowArchived((value) => !value)}
                  >
                    <Icon icon={Archive} size={12} />
                    {t('fantayShell.sidebar.archived')} ({archivedItems.length})
                  </Button>
                  {showArchived ? (
                    <ConversationSublist
                      state={conversations}
                      visible={archivedItems}
                      total={archivedItems.length}
                      showAll
                      onToggleShowAll={() => undefined}
                      onSelect={onSelectConversation}
                      onRetry={onRetryConversations}
                      showToggle={false}
                    />
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {editing ? (
        <ProjectEditDialog
          project={project}
          context={context}
          onClose={() => setEditing(false)}
          onSave={(name) => actions.rename(project.id, name)}
        />
      ) : null}
      <ConfirmDialog
        open={archiveChats}
        onOpenChange={(open) => {
          if (!bulkInFlight.current) setArchiveChats(open);
        }}
        title={t('fantayShell.sidebar.archiveChats')}
        description={t('fantayShell.sidebar.archiveChatsConfirm', { name })}
        confirmLabel={t('fantayShell.sidebar.archiveChats')}
        busy={bulkBusy}
        onConfirm={() => void bulk('archive')}
      />
    </li>
  );
}

interface ConversationSublistProps {
  showToggle?: boolean;
  state: SidebarConversationListState;
  visible: readonly Conversation[];
  total: number;
  showAll: boolean;
  onToggleShowAll(): void;
  onSelect(conversationId: string): void;
  onRetry(): void;
}

function ConversationSublist({
  state,
  visible,
  total,
  showAll,
  onToggleShowAll,
  onSelect,
  onRetry,
  showToggle = true,
}: ConversationSublistProps) {
  const t = useT();
  if (total === 0) {
    if (state.status === 'loading' || state.status === 'idle') {
      return (
        <p className="m-0 py-1.5 ps-[55px] text-label text-ink-faint">
          {t('fantayShell.sidebar.conversationsLoading')}
        </p>
      );
    }
    if (state.status === 'error') {
      return (
        <div className="flex items-center gap-1 py-1 ps-[55px]">
          <span className="text-label text-ink-faint">{t('fantayShell.sidebar.conversationsFailed')}</span>
          <Button variant="link" size="sm" className="text-label focus-visible:-outline-offset-2" onClick={onRetry}>
            {t('fantayShell.sidebar.retry')}
          </Button>
        </div>
      );
    }
    return (
      <p className="m-0 py-1.5 ps-[55px] text-label text-ink-faint">{t('fantayShell.sidebar.conversationsEmpty')}</p>
    );
  }
  return (
    <ul className="m-0 flex flex-col gap-0.5 p-0 pt-0.5" role="list">
      {visible.map((conversation) => {
        const tone = conversationStatusTone(conversation, state.runningIds);
        const toneStatus = conversationToneStatus(tone);
        return (
          <li key={conversation.id} className="list-none">
            <SidebarConversationRow
              conversation={conversation}
              active={state.activeConversationId === conversation.id}
              tone={tone}
              toneLabel={toneStatus ? t(STATUS_LABEL_KEYS[toneStatus]) : undefined}
              onSelect={() => onSelect(conversation.id)}
            />
          </li>
        );
      })}
      {showToggle && total > CONVERSATION_PREVIEW_LIMIT ? (
        <li className="list-none">
          <Button
            variant="bare"
            size="sm"
            className="h-7 w-full justify-start ps-[55px] text-label font-normal text-ink-faint focus-visible:-outline-offset-2"
            onClick={onToggleShowAll}
          >
            {showAll
              ? t('fantayShell.sidebar.showFewerConversations')
              : t('fantayShell.sidebar.showAllConversations', { count: total })}
          </Button>
        </li>
      ) : null}
    </ul>
  );
}
