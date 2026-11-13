// SPDX-License-Identifier: AGPL-3.0-only
// One chat under an expanded sidebar project (spec 02 §11.3): 28 px, a status slot hanging in the gutter so the title
// (or 未命名对话) lines up with the project's name, the paper-deep fill when it is the open conversation.
import { useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  Ellipsis,
  Eye,
  FolderPlus,
  List,
  Pencil,
  Pin,
  PinOff,
  Share2,
  SquareArrowOutUpRight,
  Trash2,
} from 'lucide-react';
import { openHostConversationWindow } from '@open-design/host';
import { useT } from '../../../i18n';
import { useWorkspaceContext } from '../../../collab/useWorkspaceContext';
import { currentWorkspaceAccountGeneration } from '../../../collab/workspace-identity';
import { deleteConversation, patchConversation } from '../../../state/projects';
import type { Conversation } from '../../../types';
import { Button } from '../../ui/button';
import { Modal, ModalActions, ModalLede, ModalTitle } from '../../ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '../../ui/dropdown-menu';
import { IconButton } from '../../ui/icon-button';
import { Icon } from '../../ui/icons';
import { Input } from '../../ui/input';
import { toast } from '../../ui/toast';
import { runProjectCommand, useActiveProjectSession } from '../project-bridge';
import { reconcileSidebarConversation } from './use-sidebar-conversations';
import { DashNavItem } from './dash';
import { RunStatusDot } from './RunStatusDot';
import type { SidebarStatusTone } from './sidebar-model';
import { isConversationUnread } from './sidebar-model';
import { createGroup, loadProjectOrganization, useProjectOrganization } from '../project-organization-store';
import { GroupNameDialog } from './SidebarGroup';
import { ConversationShareDialog } from './ConversationShareDialog';
import { conversationText } from './conversation-actions';
import { copyToClipboard } from '../../../lib/copy-to-clipboard';

export interface SidebarConversationRowProps {
  conversation: Conversation;
  active: boolean;
  tone: SidebarStatusTone;
  toneLabel?: string;
  onSelect(): void;
}

export function SidebarConversationRow({
  conversation,
  active,
  tone,
  toneLabel,
  onSelect,
}: SidebarConversationRowProps) {
  const t = useT();
  const { context, loading, identityChangePending } = useWorkspaceContext();
  const session = useActiveProjectSession(conversation.projectId);
  const readOnly =
    loading || identityChangePending || session?.readOnly || context?.permissions.canWriteSyncedFiles === false;
  const title = conversation.title?.trim() || t('fantayShell.sidebar.untitledConversation');
  const [dialog, setDialog] = useState<'rename' | 'delete' | 'group' | 'share' | null>(null);
  const [draft, setDraft] = useState(title);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const modalRequested = useRef(false);
  const pinned = conversation.pinnedAt != null;
  const archived = conversation.archivedAt != null;
  const unread = isConversationUnread(conversation);
  const { groups } = useProjectOrganization();

  const mutate = async (patch: Partial<Conversation> | null) => {
    if (readOnly || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    const generation = currentWorkspaceAccountGeneration();
    try {
      const updated =
        patch === null
          ? await deleteConversation(conversation.projectId, conversation.id, context)
          : await patchConversation(conversation.projectId, conversation.id, patch, context);
      if (!updated) throw new Error(t('ds.actionFailed'));
      if (generation !== currentWorkspaceAccountGeneration()) return;
      const receipt = typeof updated === 'boolean' ? null : updated;
      reconcileSidebarConversation(conversation.projectId, conversation.id, receipt);
      runProjectCommand(
        conversation.projectId,
        receipt
          ? { kind: 'conversationUpdated', conversation: receipt }
          : { kind: 'conversationDeleted', conversationId: conversation.id },
      );
      if (patch && Object.hasOwn(patch, 'groupId')) await loadProjectOrganization();
      setDialog(null);
    } catch {
      const message = t('ds.actionFailed');
      setError(message);
      if (!dialog) toast({ title: message, tone: 'danger' });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const openDialog = (kind: 'rename' | 'delete' | 'group' | 'share') => {
    modalRequested.current = true;
    setDraft(title);
    setError(null);
    setDialog(kind);
  };
  const copy = async (idOnly: boolean) => {
    const generation = currentWorkspaceAccountGeneration();
    try {
      const text = idOnly
        ? conversation.id
        : await conversationText(conversation, context, {
            user: t('chat.you'),
            assistant: 'Fantay',
            designSystem: t('chat.designSystemStatus.title'),
          });
      if (generation !== currentWorkspaceAccountGeneration()) return;
      if (!(await copyToClipboard(text))) throw new Error('Clipboard unavailable');
      toast({ title: t('chat.copyDone') });
    } catch {
      toast({ title: t('handoff.copyFailed'), tone: 'danger' });
    }
  };
  const openWindow = async () => {
    const result = await openHostConversationWindow(conversation.projectId, conversation.id);
    if (!result.ok) toast({ title: result.reason || t('ds.actionFailed'), tone: 'danger' });
  };
  useEffect(() => {
    if (!active || readOnly) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || document.querySelector('[role="dialog"]'))
        return;
      const key = event.code || `Key${event.key.toUpperCase()}`;
      let action: (() => void) | undefined;
      if (event.altKey && key === 'KeyR') action = () => openDialog('rename');
      if (event.altKey && key === 'KeyP') action = () => void mutate({ pinnedAt: pinned ? null : Date.now() });
      if (event.shiftKey && key === 'KeyU')
        action = () => void mutate({ unreadAt: unread ? null : Date.now(), readAt: Date.now() });
      if (event.shiftKey && key === 'KeyA') action = () => void mutate({ archivedAt: archived ? null : Date.now() });
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        action();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });
  return (
    <>
      <div className="group/chat relative flex min-w-0 items-center">
        <DashNavItem
          data-sidebar-row=""
          data-testid={`fantay-sidebar-conversation-${conversation.id}`}
          active={active}
          className={`h-7 gap-2 ps-[39px] pe-8 text-label ${unread ? 'font-semibold text-ink' : ''}`}
          data-unread={unread ? '' : undefined}
          trailing={pinned ? <Icon icon={Pin} size={12} aria-label={t('fantayShell.sidebar.pinned')} /> : undefined}
          icon={
            <span className="inline-grid size-2 flex-none place-items-center">
              <RunStatusDot
                tone={tone || (unread ? 'unread' : null)}
                label={toneLabel || (unread ? t('fantayShell.sidebar.markUnread') : undefined)}
              />
            </span>
          }
          onClick={onSelect}
        >
          {title}
        </DashNavItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              size="xs"
              disabled={readOnly || pending}
              aria-label={t('pluginsView.moreActions', { title })}
              data-testid={`fantay-sidebar-chat-menu-${conversation.id}`}
              className="absolute end-1 opacity-0 group-hover/chat:opacity-100 group-focus-within/chat:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
            >
              <Icon icon={Ellipsis} size={14} />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            width="md"
            align="start"
            onCloseAutoFocus={(event) => {
              if (modalRequested.current) {
                event.preventDefault();
                modalRequested.current = false;
              }
            }}
          >
            <DropdownMenuItem
              shortcut="⌥⌘R"
              icon={<Icon icon={Pencil} size={14} />}
              onSelect={() => openDialog('rename')}
            >
              {t('designs.menuRename')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<Icon icon={pinned ? PinOff : Pin} size={14} />}
              shortcut="⌥⌘P"
              onSelect={() => void mutate({ pinnedAt: pinned ? null : Date.now() })}
            >
              {t(pinned ? 'fantayShell.sidebar.unpin' : 'fantayShell.sidebar.pin')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<Icon icon={Eye} size={14} />}
              shortcut="⇧⌘U"
              onSelect={() => void mutate({ unreadAt: unread ? null : Date.now(), readAt: Date.now() })}
            >
              {t(unread ? 'fantayShell.sidebar.markRead' : 'fantayShell.sidebar.markUnread')}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger icon={<Icon icon={List} size={14} />}>
                {t('fantayShell.sidebar.section')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  onSelect={() => void mutate({ groupId: null })}
                  icon={!conversation.groupId ? <Icon icon={Check} size={14} /> : undefined}
                >
                  {t('entry.navProjects')}
                </DropdownMenuItem>
                {groups.map((group) => (
                  <DropdownMenuItem
                    key={group.id}
                    onSelect={() => void mutate({ groupId: group.id })}
                    icon={conversation.groupId === group.id ? <Icon icon={Check} size={14} /> : undefined}
                  >
                    {group.name}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem icon={<Icon icon={FolderPlus} size={14} />} onSelect={() => openDialog('group')}>
                  {t('fantayShell.sidebar.newGroup')}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<Icon icon={Share2} size={14} />} onSelect={() => openDialog('share')}>
              {t('common.share')}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger icon={<Icon icon={Copy} size={14} />}>
                {t('useEverywhere.copy')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={() => void copy(false)}>
                  {t('fantayShell.sidebar.copyContent')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void copy(true)}>{t('fantayShell.sidebar.copyId')}</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<Icon icon={SquareArrowOutUpRight} size={14} />} onSelect={() => void openWindow()}>
              {t('fantayShell.sidebar.openWindow')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={<Icon icon={archived ? ArchiveRestore : Archive} size={14} />}
              shortcut="⇧⌘A"
              onSelect={() => void mutate({ archivedAt: archived ? null : Date.now() })}
            >
              {t(archived ? 'fantayShell.sidebar.unarchive' : 'fantayShell.sidebar.archive')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              tone="danger"
              icon={<Icon icon={Trash2} size={14} />}
              onSelect={() => openDialog('delete')}
            >
              {t('designs.menuDelete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Modal
        open={dialog === 'rename' || dialog === 'delete'}
        onClose={() => {
          if (!inFlight.current) setDialog(null);
        }}
        showClose={!pending}
        size="sm"
      >
        <ModalTitle>{t(dialog === 'delete' ? 'chat.deleteConversation' : 'designs.menuRename')}</ModalTitle>
        <ModalLede>
          {dialog === 'delete'
            ? t('chat.deleteConversationConfirm', { title })
            : t('chat.renameConversationLabel', { title })}
        </ModalLede>
        {dialog === 'rename' ? (
          <Input
            className="mt-4"
            autoFocus
            value={draft}
            disabled={pending}
            aria-label={t('designs.menuRename')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && draft.trim()) {
                event.preventDefault();
                void mutate({ title: draft.trim() });
              }
            }}
          />
        ) : null}
        {error ? (
          <p className="mt-3 text-copy text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <ModalActions>
          <Button variant="ghost" disabled={pending} onClick={() => setDialog(null)}>
            {t('designs.renameCancel')}
          </Button>
          <Button
            variant={dialog === 'delete' ? 'danger' : 'primary'}
            loading={pending}
            disabled={readOnly || (dialog === 'rename' && !draft.trim())}
            onClick={() => void mutate(dialog === 'delete' ? null : { title: draft.trim() })}
          >
            {t(dialog === 'delete' ? 'designs.menuDelete' : 'designs.renameSave')}
          </Button>
        </ModalActions>
      </Modal>
      <GroupNameDialog
        open={dialog === 'group'}
        title={t('fantayShell.sidebar.newGroup')}
        confirmLabel={t('common.create')}
        testId={`chat-section-${conversation.id}`}
        onClose={() => setDialog(null)}
        onSubmit={(name) => {
          void createGroup(name).then((group) => {
            if (group) void mutate({ groupId: group.id });
            else toast({ title: t('ds.actionFailed'), tone: 'danger' });
          });
        }}
      />
      {dialog === 'share' ? (
        <ConversationShareDialog conversation={conversation} context={context} onClose={() => setDialog(null)} />
      ) : null}
    </>
  );
}
