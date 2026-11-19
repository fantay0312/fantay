// SPDX-License-Identifier: AGPL-3.0-only
// The message actions of a companion transcript (Soul UI spec §4.4.7, addendum items 10 and 14): one item list shared
// by the hover pill's ⋯ menu and the message's context menu, the hover pill itself (time · copy · ⋯) and the delete
// confirmation. While a chat turn of the conversation runs, every mutating item is disabled with 等 TA 说完; a 409
// from the daemon shows its own message in a danger toast. Stage 2 adds 朗读 on agent replies and greetings (STAGE2
// 5.8): offered unless the chat's 语音回复 is 关, disabled with its reason when the character has no voice, no speech
// service is set up, or the text is too long; the pill repeats it as a speaker button.
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  BookmarkPlus,
  Copy,
  Eye,
  EyeOff,
  GitBranch,
  MoreHorizontal,
  PencilLine,
  Quote,
  ScrollText,
  Trash2,
  Volume2,
  type LucideIcon,
} from 'lucide-react';

import { copyToClipboard } from '../../../lib/copy-to-clipboard';
import { useI18n, useT } from '../../../i18n';
import {
  CheckboxField,
  ConfirmDialog,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  MenuItemText,
  Tooltip,
  toast,
} from '../../ui';
import { errorToast } from '../PaTurnTail';
import { usePa } from '../pa-context';
import { conversationKind } from '../pa-model';
import type { PaConversation, PaGroup, PaMessage } from '../pa-types';
import { setSoulComposeChip, soulComposeChip } from './soul-compose';
import { activeChatTask, displayName, type PaSoulItem } from './soul-model';
import { soulVoiceGate, useSoulSpeech, useSoulSpeechStatus, type SoulVoiceGate } from './soul-voice';
import styles from './SoulTranscript.module.css';

export interface SoulMenuAction {
  key: string;
  label: string;
  icon: LucideIcon;
  tone?: 'danger';
  /** Disabled with this reason as the row's sub-line. */
  busy?: string;
  separatorBefore?: boolean;
  run(): void;
}

const clockFormats = new Map<string, { short: Intl.DateTimeFormat; full: Intl.DateTimeFormat }>();
function clockFor(locale: string) {
  let formats = clockFormats.get(locale);
  if (!formats) {
    formats = {
      short: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
      full: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    };
    clockFormats.set(locale, formats);
  }
  return formats;
}

/** `HH:mm` in the locale (24-hour), as the hover pill prints it; the journal's head line uses the same clock. */
export function soulShortTime(locale: string, at: number): string {
  return clockFor(locale).short.format(new Date(at));
}

/** The name TA stands for in this item's copy: the speaker of an agent line, else the direct chat's character, else
 *  the room's name (a room's owner line or story item is hidden from everyone in it). */
export function soulNameFor(
  index: ReturnType<typeof usePa>['index'],
  conversation: PaConversation,
  room: PaGroup | null,
  item: PaSoulItem | null,
): string {
  if (item && (item.role === 'agent' || item.role === 'greeting')) return displayName(index, item.message.senderId);
  if (room) return room.name;
  return conversation.agentId ? displayName(index, conversation.agentId) : conversation.title;
}

export async function copySoulText(text: string, copied: string): Promise<void> {
  if (await copyToClipboard(text)) toast({ tone: 'success', title: copied });
}

/**
 * The item list of one transcript item, and the delete dialog it may open. `rootRef` is the item's element: 记住这句
 * takes the current text selection inside it (captured on the pointer down of the ⋯ trigger or on the context menu
 * event), else the whole message.
 *
 * `voice` carries what the item's voice bar needs: the 朗读 gate of an agent reply or greeting (null for any other
 * item) and the conversation's speech store, so the item does not open a second subscription.
 */
export function useSoulMessageMenu({
  item,
  conversation,
  room,
  rootRef,
}: {
  item: PaSoulItem;
  conversation: PaConversation;
  room: PaGroup | null;
  rootRef: RefObject<HTMLElement | null>;
}): {
  actions: SoulMenuAction[];
  dialog: ReactNode;
  captureSelection(): void;
  voice: { gate: SoulVoiceGate | null; speech: ReturnType<typeof useSoulSpeech> };
} {
  const t = useT();
  const { index, data, nav, drafts } = usePa();
  const [confirming, setConfirming] = useState(false);
  const [forget, setForget] = useState(false);
  const selection = useRef('');
  const message: PaMessage = item.message;
  const cid = conversation.id;
  const status = useSoulSpeechStatus();
  const speech = useSoulSpeech(cid);
  const name = soulNameFor(index, conversation, room, item);
  const busy = activeChatTask(index, cid) !== null ? t('pa.soul.chat.menu.busy', { name }) : undefined;
  const gate = item.role === 'agent' || item.role === 'greeting' ? soulVoiceGate(index, conversation, message, status) : null;
  const soulful = message.soul !== undefined;
  const story = item.role === 'story';
  const said = soulful && !story; // owner and agent chat messages, greetings
  const agentChat = item.role === 'agent' && message.soul?.kind === 'chat';
  const direct = conversationKind(conversation) === 'direct';

  const captureSelection = () => {
    const current = typeof window !== 'undefined' ? window.getSelection() : null;
    const root = rootRef.current;
    const text = current && !current.isCollapsed && root && current.anchorNode && root.contains(current.anchorNode) ? current.toString().trim() : '';
    selection.current = text;
  };

  const mutate = (work: Promise<unknown>) => {
    void work.catch(errorToast);
  };

  const actions: SoulMenuAction[] = [];
  if (said) {
    actions.push({
      key: 'quote',
      label: t('pa.soul.chat.menu.quote'),
      icon: Quote,
      run: () => {
        drafts.set(cid, { replyTo: message.id });
        drafts.requestFocus();
      },
    });
  }
  actions.push({
    key: 'copy',
    label: t('pa.chat.copy'),
    icon: Copy,
    run: () => void copySoulText(message.content, t('pa.chat.copied')),
  });
  // 朗读: absent under 关 and for a reply with nothing to read; while the speech status is still unknown (first read
  // in flight, or a daemon without the route) a missing service is not claimed yet.
  if (gate && gate.kind !== 'off' && gate.kind !== 'not-speakable' && !(gate.kind === 'no-provider' && status === null)) {
    const reason =
      gate.kind === 'no-voice'
        ? t('pa.soul.chat.voice.unset', { name })
        : gate.kind === 'no-provider'
          ? t('pa.soul.chat.voice.noProvider')
          : gate.kind === 'too-long'
            ? t('pa.soul.chat.voice.tooLong')
            : gate.kind === 'local-only'
              ? t('pa.soul.chat.voice.localOnly')
              : undefined;
    actions.push({
      key: 'speak',
      label: t('pa.soul.chat.voice.speak'),
      icon: Volume2,
      busy: reason,
      run: () => void speech.speak(message.id),
    });
  }
  if (said) {
    actions.push({
      key: 'edit',
      label: t('pa.edit'),
      icon: PencilLine,
      busy,
      run: () => {
        // Switching from one edit to another keeps the owner's real draft as the text Esc brings back.
        const open = soulComposeChip(cid);
        const restore = open?.kind === 'edit' ? open.restore : drafts.get(cid).text;
        setSoulComposeChip(cid, { kind: 'edit', messageId: message.id, ...(restore !== undefined ? { restore } : {}) });
        drafts.set(cid, { text: message.content });
        drafts.requestFocus();
      },
    });
    actions.push({
      key: 'remember',
      label: t('pa.soul.chat.menu.remember'),
      icon: BookmarkPlus,
      run: () => {
        const content = selection.current || message.content;
        const owner = message.senderId === 'owner';
        const scope =
          owner && room
            ? { scope: 'group' as const, scopeId: room.id }
            : { scope: 'agent' as const, scopeId: owner ? conversation.agentId ?? null : message.senderId };
        nav.openModal({ kind: 'memory', memoryId: null, preset: { ...scope, content, kind: 'moment', sourceMessageId: message.id } });
      },
    });
    if (direct) {
      actions.push({
        key: 'branch',
        label: t('pa.soul.chat.menu.branch'),
        icon: GitBranch,
        busy,
        run: () =>
          mutate(
            data.actions.branch(cid, message.id).then((branch) => {
              nav.openConversation(branch.id);
              toast({
                title: t('pa.soul.chat.branch.created'),
                action: { label: t('pa.soul.chat.branch.back'), onClick: () => nav.openConversation(cid) },
              });
            }),
          ),
      });
    }
  }
  if (agentChat) {
    actions.push({
      key: 'context',
      label: t('pa.soul.chat.menu.context', { name }),
      icon: ScrollText,
      run: () => nav.openModal({ kind: 'context', conversationId: cid, messageId: message.id }),
    });
  }
  if (soulful) {
    actions.push({
      key: 'hide',
      label: item.hidden ? t('pa.soul.chat.menu.unhide', { name }) : t('pa.soul.chat.menu.hide', { name }),
      icon: item.hidden ? Eye : EyeOff,
      busy,
      run: () => mutate(data.actions.editMessage(message, { hidden: !item.hidden })),
    });
    actions.push({
      key: 'delete',
      label: t('pa.delete'),
      icon: Trash2,
      tone: 'danger',
      busy,
      separatorBefore: true,
      run: () => {
        setForget(false);
        setConfirming(true);
      },
    });
  }

  const memoryCount = confirming ? [...index.memories.values()].filter((memory) => memory.sourceMessageId === message.id).length : 0;
  const otherVariants = item.variants.length - 1;
  const dialog = (
    <ConfirmDialog
      open={confirming}
      onOpenChange={setConfirming}
      destructive
      title={t('pa.soul.chat.confirm.deleteTitle')}
      confirmLabel={t('pa.delete')}
      description={
        <>
          <span className={styles.confirmLine}>{t('pa.soul.chat.confirm.deleteBody', { name })}</span>
          {otherVariants > 0 ? <span className={styles.confirmLine}>{t('pa.soul.chat.confirm.deleteVariants', { n: otherVariants })}</span> : null}
          {memoryCount > 0 ? (
            <CheckboxField
              className={styles.confirmCheck}
              checked={forget}
              onChange={(event) => setForget(event.target.checked)}
              label={t('pa.soul.chat.confirm.deleteMemories', { n: memoryCount })}
            />
          ) : null}
        </>
      }
      onConfirm={() =>
        mutate(
          data.actions.deleteMessage(message, forget && memoryCount > 0).then(() => toast({ title: t('pa.soul.chat.deleted') })),
        )
      }
    />
  );

  return { actions, dialog, captureSelection, voice: { gate, speech } };
}

function DropdownItems({ actions }: { actions: SoulMenuAction[] }) {
  return (
    <>
      {actions.map((action) => (
        <SoulMenuRow key={action.key} action={action} kind="dropdown" />
      ))}
    </>
  );
}

function SoulMenuRow({ action, kind }: { action: SoulMenuAction; kind: 'dropdown' | 'context' }) {
  const icon = <Icon icon={action.icon} size="sm" />;
  const disabled = action.busy !== undefined;
  if (kind === 'dropdown') {
    return (
      <>
        {action.separatorBefore ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          icon={icon}
          tone={action.tone === 'danger' ? 'danger' : 'default'}
          disabled={disabled}
          description={action.busy}
          data-action={action.key}
          onSelect={() => action.run()}
        >
          {action.label}
        </DropdownMenuItem>
      </>
    );
  }
  return (
    <>
      {action.separatorBefore ? <ContextMenuSeparator /> : null}
      <ContextMenuItem
        icon={icon}
        tone={action.tone === 'danger' ? 'danger' : 'default'}
        disabled={disabled}
        data-action={action.key}
        onSelect={() => action.run()}
      >
        {action.busy ? <MenuItemText description={action.busy}>{action.label}</MenuItemText> : action.label}
      </ContextMenuItem>
    </>
  );
}

/** Right click anywhere on the item opens the same list as ⋯. */
export function SoulContextMenu({
  actions,
  onOpen,
  children,
}: {
  actions: SoulMenuAction[];
  onOpen(): void;
  children: ReactNode;
}) {
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) onOpen();
      }}
    >
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid="pa-soul-context-menu">
        {actions.map((action) => (
          <SoulMenuRow key={action.key} action={action} kind="context" />
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The hover pill beside a message's last bubble: time (· 已编辑), copy, 朗读 (when the menu offers it), ⋯. */
export function SoulMessagePill({
  message,
  actions,
  side,
  onOpen,
}: {
  message: PaMessage;
  actions: SoulMenuAction[];
  side: 'in' | 'out' | 'center';
  onOpen(): void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const formats = clockFor(locale);
  const at = new Date(message.soul?.at ?? message.createdAt);
  const speak = actions.find((action) => action.key === 'speak');
  return (
    <div className={styles.pill} data-side={side} data-testid="pa-soul-pill">
      <Tooltip label={formats.full.format(at)}>
        <time dateTime={at.toISOString()} className={styles.pillTime}>
          {formats.short.format(at)}
          {message.soul?.edited ? ` · ${t('pa.soul.chat.toolbar.edited')}` : ''}
        </time>
      </Tooltip>
      <IconButton
        size="xs"
        aria-label={t('pa.chat.copy')}
        className={styles.pillButton}
        onClick={() => void copySoulText(message.content, t('pa.chat.copied'))}
      >
        <Icon icon={Copy} size={13} />
      </IconButton>
      {speak ? (
        <IconButton
          size="xs"
          aria-label={speak.label}
          className={styles.pillButton}
          disabled={speak.busy !== undefined}
          disabledReason={speak.busy}
          data-testid="pa-soul-speak"
          onClick={() => speak.run()}
        >
          <Icon icon={Volume2} size={13} />
        </IconButton>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            size="xs"
            aria-label={t('pa.soul.chat.menu.label')}
            className={styles.pillButton}
            data-testid="pa-soul-menu-trigger"
            onPointerDown={() => onOpen()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') onOpen();
            }}
          >
            <Icon icon={MoreHorizontal} size={13} />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent width="md" align={side === 'out' ? 'end' : 'start'} data-testid="pa-soul-message-menu">
          <DropdownItems actions={actions} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
