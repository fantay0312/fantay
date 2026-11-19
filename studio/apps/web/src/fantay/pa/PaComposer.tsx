// SPDX-License-Identifier: AGPL-3.0-only
// The composer (spec §7): a note line, the send error, the `@` list docked above the shared `.composer-shell`
// card, a reply chip, the group project row, an adaptive auto-growing textarea (single-line capsule at rest,
// smoothly expanding to full-width multi-line card with hysteresis, capped at max-height with thin internal
// scrolling and an expand-editor toggle), quick-action `+` / `@` / voice controls, and the send disc.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  AtSign,
  BookmarkPlus,
  CalendarClock,
  Check,
  CircleAlert,
  CircleSlash,
  Clock,
  CloudOff,
  FolderPlus,
  Maximize2,
  Minimize2,
  PanelsTopLeft,
  Pause,
  Plus,
  Shield,
  type LucideIcon,
} from 'lucide-react';

import { usePresence } from '../../hooks/usePresence';
import { useT } from '../../i18n';
import { navigate } from '../../router';
import {
  Button,
  Callout,
  Chip,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  Input,
  Spinner,
  Textarea,
  Tooltip,
  XIcon,
  cn,
} from '../ui';
import { PaAvatar } from './PaAvatar';
import { PaModelPicker } from './PaModelPicker';
import { PaVoiceInput } from './PaVoiceInput';
import {
  PA_MENTION_LISTBOX_ID,
  PaMentionList,
  paMentionOptionId,
  type PaMentionItem,
} from './PaMentionList';
import { plainLine } from './PaMessage';
import { errorToast } from './PaTurnTail';
import { refreshPaActivity } from './pa-activity';
import { usePa, usePaDraft, usePaFocusNonce } from './pa-context';
import { paPendingKey } from './usePaWorkspace';
import {
  conversationKind,
  isActiveTask,
  isFantay,
  mentionQuery,
  predictResponders,
  projectGate,
  newRequestId,
  requestFor,
  subjectOf,
} from './pa-model';
import type { PaConversation, PaDrafts, PaGroup, PaIndex, PaMemoryInput, PaTaskInput, PersonalAgent } from './pa-types';
import { SoulPersonaChip, SoulPlayMenu, soulDecksFor } from './soul/SoulPlayMenu';
import {
  SOUL_SLASH_LISTBOX_ID,
  SoulSlashList,
  soulDeckFor,
  soulSlashOpen,
  soulSlashOptionId,
  soulSlashRows,
  type SoulSlashRow,
} from './soul/SoulSlashList';
import { SoulStateStrip } from './soul/SoulStateStrip';
import { SoulTray } from './soul/SoulTray';
import { SOUL_COMMANDS, parseRollArg, parseSlash, type SoulCommandId } from './soul/soul-commands';
import { revealSoulMessage, useSoulCompose } from './soul/soul-compose';
import { activeChatTask, chatOf, conversationMode, displayName, soulItems } from './soul/soul-model';
import { skipSoulReveal } from './soul/useSoulReveal';
import styles from './PaComposer.module.css';

/** The literal token the daemon matches for "everyone" (SVC mention rules). */
const EVERYONE = '@全体';
const NO_SLASH_ROWS: SoulSlashRow[] = [];

/** The last focus request honoured per draft store (one per workspace); a composer mounted after a request still
 *  takes it, and a remounted workspace starts over. */
const handledFocus = new WeakMap<PaDrafts, number>();

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Member names in the placeholder stay on one line: each name is clipped, then the whole list. */
const placeholderNames = (names: string[]) => clip(names.map((name) => clip(name, 16)).join('、'), 40);

function membersOf(index: PaIndex, group: PaGroup): PersonalAgent[] {
  return group.memberIds.map((id) => index.agents.get(id)).filter((agent): agent is PersonalAgent => Boolean(agent));
}

function reviewerOf(group: PaGroup): string | null {
  return (
    group.reviewerId ??
    (group.mode === 'review' ? [...group.memberIds].reverse().find((id) => id !== group.moderatorId) ?? null : null)
  );
}

/** First group whose conversation passes the project gate, so direct chats can hand off a project draft cleanly. */
function firstProjectGroup(index: PaIndex): PaGroup | null {
  for (const candidate of index.groups.values()) {
    const conv = index.conversations.get(candidate.conversationId);
    if (conv && projectGate(index, conv).ok) return candidate;
  }
  return null;
}

function scrollToMessage(id: string) {
  for (const node of document.querySelectorAll<HTMLElement>('[data-message-id]')) {
    if (node.dataset.messageId === id) {
      node.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      return;
    }
  }
}

/** A stacked text goes back to the capsule once it needs no more than this share of the capsule's width. */
const INLINE_RELEASE = 0.8;

/** The width the text needs on one line: the textarea measured with no box width and wrapping off. */
function singleLineWidth(node: HTMLTextAreaElement): number {
  const { width, whiteSpace } = node.style;
  node.style.width = '0px';
  node.style.whiteSpace = 'pre';
  const natural = node.scrollWidth;
  node.style.width = width;
  node.style.whiteSpace = whiteSpace;
  return natural;
}

/** Crisp two-facet paper-plane glyph cut out with `currentColor` so the button's own disc tone shows through the fold. */
function PaSendGlyph() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={styles.sendGlyph}>
      <path
        fill="currentColor"
        d="M3.1 8.65C2.55 8.42 2.58 7.63 3.15 7.44L16.35 3.04C16.88 2.86 17.38 3.36 17.2 3.89L12.8 17.09C12.61 17.66 11.82 17.69 11.59 17.14L9.32 11.78L13.45 7.65C13.72 7.38 13.72 6.94 13.45 6.67C13.18 6.4 12.74 6.4 12.47 6.67L8.34 10.8L3.1 8.65Z"
      />
    </svg>
  );
}

export function PaComposer({
  conversation,
  active: workspaceActive = true,
  onSent,
}: {
  conversation: PaConversation;
  active?: boolean;
  onSent(): void;
}) {
  const t = useT();
  const { index, data, drafts, layout, nav } = usePa();
  const cid = conversation.id;
  const draft = usePaDraft(cid);
  const focusNonce = usePaFocusNonce();
  const kind = conversationKind(conversation);
  const subject = subjectOf(index, conversation);
  const group = subject?.kind === 'group' ? subject.group : null;
  const members = group ? membersOf(index, group) : subject?.kind === 'agent' ? [subject.agent] : [];
  const directAgent = kind === 'direct' && subject?.kind === 'agent' ? subject.agent : null;
  const gate = kind === 'group' ? projectGate(index, conversation) : null;
  const project = Boolean(gate?.ok && draft.project);
  /* Companion mode (Soul UI spec §4.5): chat sends, the play menu, slash commands, one context chip, the tray and the
     state strip. Work mode keeps everything below as it was. */
  const companion = conversationMode(index, conversation) === 'companion';
  const compose = useSoulCompose(cid);
  const chatBusy = companion && activeChatTask(index, cid) !== null;
  // 我来点名: nobody speaks unless the owner picks (the tray's 让谁接话 chips); empty Enter and /continue do not.
  const manualRoom = companion && group !== null && chatOf(index, cid).groupStrategy === 'manual';
  const [diceOpen, setDiceOpen] = useState(false);
  const [slashActive, setSlashActive] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [multiline, setMultiline] = useState(false);
  const [scrollable, setScrollable] = useState(false);
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const pending = sending.has(cid) || data.pending.has(paPendingKey.send(cid));
  const error = errors[cid] ?? null;

  const hasNewline = draft.text.includes('\n');
  const stacked = (kind === 'group' && !companion) || expanded || multiline || hasNewline;

  useEffect(() => {
    setExpanded(false);
    setMultiline(false);
    setScrollable(false);
  }, [cid]);

  /* ── @ list ── */
  const mention = group ? mentionQuery(draft.text, caret) : null;
  const items: PaMentionItem[] = [];
  if (group && mention) {
    const query = mention.query.toLowerCase();
    const reviewer = reviewerOf(group);
    if (!query || '全体'.includes(query) || 'all'.startsWith(query) || 'everyone'.startsWith(query)) {
      items.push({ key: 'everyone', token: EVERYONE, agent: null, caption: t('pa.composer.everyoneHelp') });
    }
    for (const agent of membersOf(index, group)) {
      if (query && !agent.name.toLowerCase().includes(query)) continue;
      const role =
        agent.id === group.moderatorId ? t('pa.chat.roleModerator') : agent.id === reviewer ? t('pa.chat.roleReviewer') : '';
      items.push({
        key: agent.id,
        token: `@${agent.name}`,
        agent,
        // A companion room names no roles or models (Soul UI spec O12).
        caption: companion
          ? ''
          : [role, index.models.get(`${agent.model.runtime}/${agent.model.modelId}`)?.label || agent.model.modelId]
              .filter(Boolean)
              .join(' · '),
      });
    }
  }
  /* ── slash list (companion): the input starts with `/` and has no line break ── */
  const decks = companion ? soulDecksFor(index, conversation) : [];
  const slashText = companion && soulSlashOpen(draft.text) ? draft.text : null;
  const slashRows = slashText !== null ? soulSlashRows(slashText, { decks, busy: chatBusy, manual: manualRoom }) : NO_SLASH_ROWS;
  const slashOpen = slashText !== null && focused && slashDismissed !== slashText && slashRows.length > 0;
  const slashList = usePresence(slashOpen, 150);
  const lastSlashRows = useRef(slashRows);
  if (slashOpen) lastSlashRows.current = slashRows;
  const slashIndex = Math.min(slashActive, Math.max(0, slashRows.length - 1));
  useEffect(() => setSlashActive(0), [slashText]);

  const listOpen = !slashOpen && Boolean(mention && focused && mention.start !== dismissed && items.length > 0);
  const list = usePresence(listOpen, 150);
  const lastItems = useRef(items);
  if (listOpen) lastItems.current = items;
  const activeIndex = Math.min(active, Math.max(0, items.length - 1));

  useEffect(() => setActive(0), [mention?.query, mention?.start]);
  useEffect(() => {
    if (!mention && dismissed !== null) setDismissed(null);
  }, [mention, dismissed]);

  const pick = (item: PaMentionItem | undefined) => {
    if (!item || !mention) return;
    const before = draft.text.slice(0, mention.start);
    const after = draft.text.slice(caret);
    const insert = `${item.token} `;
    const position = before.length + insert.length;
    drafts.set(cid, { text: before + insert + after });
    pendingCaret.current = position;
    setCaret(position);
  };

  const triggerMention = () => {
    const node = inputRef.current;
    const currentText = drafts.get(cid).text;
    const pos = node ? (node.selectionStart ?? currentText.length) : currentText.length;
    const before = currentText.slice(0, pos);
    const after = currentText.slice(pos);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    const insert = `${needsSpace ? ' ' : ''}@`;
    const nextPos = before.length + insert.length;
    setDismissed(null);
    drafts.set(cid, { text: before + insert + after });
    pendingCaret.current = nextPos;
    setCaret(nextPos);
    setFocused(true);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextPos, nextPos);
    });
  };

  /* ── adaptive auto-grow + hysteresis full-width switch + max-height cap + internal scroll ── */
  /** The capsule's width when its text was promoted to the stacked card, and the text it was promoted for. */
  const promotion = useRef<{ width: number; text: string } | null>(null);
  const syncTextareaLayout = useCallback(
    (node: HTMLTextAreaElement, followCaretEnd: boolean) => {
      const prevScrollTop = node.scrollTop;
      const prevScrollHeight = node.scrollHeight;
      const prevClientHeight = node.clientHeight;
      const wasNearBottom =
        prevScrollHeight <= prevClientHeight + 4 || prevScrollTop + prevClientHeight >= prevScrollHeight - 12;

      const computed = window.getComputedStyle(node);
      const parsedMin = Number.parseFloat(computed.minHeight);
      const parsedMax = Number.parseFloat(computed.maxHeight);
      const vh = window.innerHeight > 0 ? window.innerHeight : 800;
      const fallbackMin = expanded ? 132 : stacked ? 28 : 36;
      const fallbackMax = expanded ? Math.min(360, Math.round(vh * 0.54)) : Math.min(196, Math.round(vh * 0.36));
      const minH = Number.isFinite(parsedMin) && parsedMin > 0 ? parsedMin : fallbackMin;
      const maxH = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : fallbackMax;

      node.style.height = '0px';
      const raw = node.scrollHeight;
      const nextHeight = Math.max(minH, Math.min(raw, maxH));
      const nextScrollable = raw > maxH + 1;

      /* The inline capsule promotes to the full-width stacked card when its text wraps past one line or contains
         `\n`, and releases back only when cleared or comfortably shorter than the capsule it was promoted from.
         Both steps run in a layout effect, so they must never answer each other: an empty input does not promote
         (a placeholder too long for a narrow capsule wraps too), and a text is not released by the same measure
         that promoted it. Otherwise the two layouts alternate until React stops the render. */
      const value = node.value;
      const singleLineBase = stacked ? 28 : 36;
      const wrappedNow = value.length > 0 && (raw > singleLineBase + 10 || value.includes('\n'));
      let nextMultiline = multiline;
      if (!multiline) {
        if (wrappedNow) {
          promotion.current = { width: node.clientWidth, text: value };
          nextMultiline = true;
        }
      } else if (value.length === 0) {
        nextMultiline = false;
      } else if (!wrappedNow && value !== promotion.current?.text) {
        const capsule = promotion.current?.width ?? node.clientWidth;
        nextMultiline = singleLineWidth(node) > capsule * INLINE_RELEASE;
      }

      node.style.height = `${nextHeight}px`;
      node.style.overflowY = nextScrollable ? 'auto' : 'hidden';

      if (nextScrollable) {
        const caretAtEnd =
          followCaretEnd && node.selectionStart === value.length && node.selectionEnd === value.length;
        node.scrollTop = caretAtEnd || wasNearBottom ? node.scrollHeight : prevScrollTop;
      } else {
        node.scrollTop = 0;
      }

      setScrollable((prev) => (prev === nextScrollable ? prev : nextScrollable));
      setMultiline((prev) => (prev === nextMultiline ? prev : nextMultiline));
    },
    [expanded, multiline, stacked],
  );

  useLayoutEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    if (pendingCaret.current !== null) {
      node.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    syncTextareaLayout(node, true);
  }, [draft.text, cid, syncTextareaLayout]);

  useEffect(() => {
    const node = inputRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    let lastWidth = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === lastWidth) return;
      lastWidth = node.clientWidth;
      syncTextareaLayout(node, false);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [syncTextareaLayout]);

  /* ── focus requests (reply, start again, starters) ── */
  useEffect(() => {
    if (focusNonce === (handledFocus.get(drafts) ?? 0)) return;
    handledFocus.set(drafts, focusNonce);
    const node = inputRef.current;
    if (!node) return;
    node.focus();
    const end = node.value.length;
    node.setSelectionRange(end, end);
    setCaret(end);
  }, [drafts, focusNonce, cid]);

  /* ── send ── */
  const sendUnavailable = data.load === 'offline' || Boolean(directAgent && !directAgent.enabled);
  // A companion send never waits for the previous one: the text turns into a pending bubble at once.
  const sendDisabled = !draft.text.trim() || (pending && !companion) || sendUnavailable;

  const sendWork = async () => {
    const current = drafts.get(cid);
    const text = current.text.trim();
    const team = !conversation.channelId ? /^\/team\s+([\s\S]+)$/i.exec(text) : null;
    const goal = team?.[1]?.trim() ?? text;
    if (!goal || sendDisabled) return;
    const asProject = !team && Boolean(gate?.ok && current.project);
    const projectName = current.projectName.trim();
    const completionCriteria = current.completionCriterion?.split(/\r?\n/).map(criterion => criterion.trim()).filter(Boolean);
    // `budget` is never sent: the daemon applies the owner's limits.
    const body = {
      conversationId: cid,
      goal,
      targetAgentIds: [],
      kind: team ? 'team' : asProject ? 'project' : 'discussion',
      ...(current.localOnly ? { dataClass: 'local_only' } : {}),
      ...(!team && current.sandbox ? { execution: { target: current.sandbox, generateScript: true } } : {}),
      ...(completionCriteria?.length ? { completionCriteria } : {}),
      ...(asProject && projectName ? { projectName } : {}),
      ...(current.replyTo ? { replyTo: current.replyTo } : {}),
    } as unknown as Omit<PaTaskInput, 'requestId'>;
    const request = requestFor(current, body);
    drafts.set(cid, { request });
    setSending((set) => new Set(set).add(cid));
    setErrors((all) => {
      if (!(cid in all)) return all;
      const next = { ...all };
      delete next[cid];
      return next;
    });
    try {
      await data.actions.sendTask({ ...body, requestId: request.id } as PaTaskInput);
      const latest = drafts.get(cid);
      const cleared = latest.text.trim() === goal;
      drafts.set(
        cid,
        cleared
          ? { text: '', replyTo: null, project: false, projectName: '', request: null, localOnly: false, completionCriterion: undefined, sandbox: undefined }
          : { replyTo: null, project: false, projectName: '', request: null },
      );
      if (cleared) {
        setExpanded(false);
        setMultiline(false);
        setScrollable(false);
      }
      refreshPaActivity();
      onSent();
    } catch (reason) {
      setErrors((all) => ({ ...all, [cid]: reason instanceof Error ? reason.message : String(reason) }));
    } finally {
      setSending((set) => {
        const next = new Set(set);
        next.delete(cid);
        return next;
      });
    }
  };

  /* ── companion: chat sends, the context chip, slash commands ── */
  const clearInput = () => {
    drafts.set(cid, { text: '', request: null });
    setExpanded(false);
    setMultiline(false);
    setScrollable(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const sendAsTask = (goal: string, replyTo: string | null) => {
    const body = {
      conversationId: cid,
      goal,
      kind: 'discussion',
      targetAgentIds: [],
      requestId: newRequestId(),
      ...(replyTo ? { replyTo } : {}),
    } as unknown as PaTaskInput;
    void data.actions
      .sendTask(body)
      .then(() => {
        refreshPaActivity();
        onSent();
      })
      .catch(errorToast);
  };

  /** Runs a slash command; false when the text should be sent as a normal message instead. */
  const runSlash = (command: { id: SoulCommandId; arg: string }, deck: (typeof decks)[number] | null = null): boolean => {
    if (command.id !== 'task' && chatBusy) return true;
    switch (command.id) {
      case 'roll': {
        if (!command.arg) {
          // The dice popover takes the focus; refocusing the input would dismiss it at once.
          drafts.set(cid, { text: '', request: null });
          setDiceOpen(true);
          return true;
        }
        const roll = parseRollArg(command.arg);
        if (!roll) return true;
        clearInput();
        void data.actions.roll(cid, { ...roll, respond: true }).catch(errorToast);
        return true;
      }
      case 'draw': {
        const target = deck ?? soulDeckFor(command.arg, decks);
        if (!target) {
          const slash = SOUL_COMMANDS.find((item) => item.id === 'draw')?.slash ?? '';
          if (!command.arg) drafts.set(cid, { text: `${slash} ` });
          return true;
        }
        clearInput();
        void data.actions.draw(cid, { deckId: target.id, respond: true }).catch(errorToast);
        return true;
      }
      case 'event':
        clearInput();
        void data.actions.eventAction(cid, 'draw').catch(errorToast);
        return true;
      case 'continue':
        if (manualRoom) return true;
        clearInput();
        void data.actions.continueChat(cid).catch(errorToast);
        return true;
      case 'task': {
        const replyTo = drafts.get(cid).replyTo;
        clearInput();
        if (command.arg) {
          drafts.set(cid, { replyTo: null });
          sendAsTask(command.arg, replyTo);
        } else {
          compose.setChip({ kind: 'task' });
        }
        return true;
      }
      default:
        return false;
    }
  };

  const pickSlash = (row: SoulSlashRow | undefined) => {
    if (!row || row.busy) return;
    if (row.kind === 'deck') {
      runSlash({ id: 'draw', arg: '' }, row.deck);
      return;
    }
    if (row.invalid) return;
    if (row.command.id === 'draw' && !row.arg) {
      const text = `${row.command.slash} `;
      drafts.set(cid, { text });
      pendingCaret.current = text.length;
      setCaret(text.length);
      return;
    }
    runSlash({ id: row.command.id, arg: row.arg });
  };

  const completeSlash = (row: SoulSlashRow | undefined) => {
    if (!row) return;
    const drawSlash = SOUL_COMMANDS.find((item) => item.id === 'draw')?.slash ?? '';
    const text = row.kind === 'deck' ? `${drawSlash} ${row.deck.id}` : `${row.command.slash} `;
    drafts.set(cid, { text });
    pendingCaret.current = text.length;
    setCaret(text.length);
  };

  const sendCompanion = async () => {
    const current = drafts.get(cid);
    const text = current.text.trim();
    const chip = compose.chip;
    skipSoulReveal();
    if (chip?.kind === 'edit') {
      const message = index.messages.get(chip.messageId);
      if (!message) {
        compose.setChip(null);
      } else {
        if (!text) return;
        try {
          await data.actions.editMessage(message, { content: text });
          compose.setChip(null);
          drafts.set(cid, { text: chip.restore ?? '', request: null });
        } catch (reason) {
          errorToast(reason);
        }
        return;
      }
    }
    if (!text || sendUnavailable) return;
    const command = parseSlash(text);
    if (command && runSlash(command)) return;
    if (chip?.kind === 'task') {
      compose.setChip(null);
      drafts.set(cid, { text: '', replyTo: null, request: null });
      sendAsTask(text, current.replyTo);
      return;
    }
    const replyTo = current.replyTo;
    const body = {
      conversationId: cid,
      goal: text,
      kind: 'chat',
      targetAgentIds: [],
      ...(replyTo ? { replyTo } : {}),
    } as unknown as Omit<PaTaskInput, 'requestId'>;
    const request = requestFor(current, body);
    compose.addPending({ requestId: request.id, text, at: Date.now(), failed: false, ...(replyTo ? { replyTo } : {}) });
    drafts.set(cid, { text: '', replyTo: null, request: null });
    setExpanded(false);
    setMultiline(false);
    setScrollable(false);
    onSent();
    try {
      await data.actions.sendChat({ conversationId: cid, text, requestId: request.id, ...(replyTo ? { replyTo } : {}) });
    } catch {
      compose.failPending(request.id);
    }
  };

  const send = () => (companion ? sendCompanion() : sendWork());

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (companion) skipSoulReveal();
    if (slashOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setSlashActive((slashIndex + step + slashRows.length) % slashRows.length);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        completeSlash(slashRows[slashIndex]);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        pickSlash(slashRows[slashIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSlashDismissed(draft.text);
        return;
      }
    }
    if (listOpen && mention) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((activeIndex + step + items.length) % items.length);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        pick(items[activeIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(mention.start);
        return;
      }
    }
    if (companion && event.key === 'Enter' && !event.shiftKey && !draft.text.trim() && compose.chip?.kind !== 'edit') {
      // Enter on an empty companion composer: 接着说.
      event.preventDefault();
      if (!chatBusy && !manualRoom && soulItems(index, cid).length > 0) void data.actions.continueChat(cid).catch(errorToast);
      return;
    }
    if (companion && event.key === 'ArrowUp' && draft.text === '' && !compose.chip && !chatBusy) {
      // ↑ in an empty composer edits the owner's last line.
      const chatItems = soulItems(index, cid);
      for (let at = chatItems.length - 1; at >= 0; at -= 1) {
        const item = chatItems[at]!;
        if (item.role !== 'owner' || !item.message.soul) continue;
        event.preventDefault();
        compose.setChip({ kind: 'edit', messageId: item.message.id, restore: '' });
        drafts.set(cid, { text: item.message.content });
        return;
      }
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
      event.preventDefault();
      void send();
      return;
    }
    if (companion && event.key === 'Escape' && (compose.chip || draft.replyTo)) {
      event.preventDefault();
      cancelChip();
      return;
    }
    if (event.key === 'Escape' && draft.replyTo) {
      event.preventDefault();
      drafts.set(cid, { replyTo: null });
      return;
    }
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      setExpanded(false);
    }
  };

  /* ── note line (the first that applies) ── */
  const option = directAgent ? index.models.get(`${directAgent.model.runtime}/${directAgent.model.modelId}`) : undefined;
  const activeTask = (index.tasksByConversation.get(cid) ?? []).some(isActiveTask);
  let note: ReactNode = null;
  let noteIcon: LucideIcon | null = null;
  let noteTone: 'error' | 'soft' | 'faint' = 'soft';
  if (data.load === 'offline') {
    note = t('pa.composer.noteOffline');
    noteIcon = CloudOff;
    noteTone = 'error';
  } else if (directAgent && !directAgent.enabled) {
    noteIcon = CircleSlash;
    note = (
      <>
        <span className={styles.noteText}>{t('pa.composer.noteDisabled', { name: directAgent.name })}</span>
        <Button
          variant="link"
          size="sm"
          className={styles.noteLink}
          onClick={() => void data.actions.setAgentEnabled(directAgent, true).catch(errorToast)}
        >
          {t('pa.composer.enableLink')}
        </Button>
      </>
    );
  } else if (data.control?.paused) {
    noteIcon = Pause;
    note = (
      <>
        <span className={styles.noteText}>{t('pa.composer.notePaused')}</span>
        <Button
          variant="link"
          size="sm"
          className={styles.noteLink}
          onClick={() => void data.actions.patchControl({ paused: false }).catch(errorToast)}
        >
          {t('pa.composer.resumeLink')}
        </Button>
      </>
    );
  } else if (option && !option.available) {
    noteIcon = CircleAlert;
    note = (
      <>
        <span className={styles.noteText}>{t('pa.composer.noteModel', { model: option.label || option.modelId })}</span>
        <Button
          variant="link"
          size="sm"
          className={styles.noteLink}
          onClick={() => navigate({ kind: 'home', view: 'settings' })}
        >
          {t('pa.composer.modelSettings')}
        </Button>
      </>
    );
  } else if (activeTask && !companion) {
    note = t('pa.composer.noteQueued');
    noteIcon = Clock;
    noteTone = 'faint';
  }

  /* ── reply chip ── */
  const replyMessage = draft.replyTo ? index.messages.get(draft.replyTo) ?? null : null;
  const replyName = replyMessage
    ? replyMessage.senderId === 'owner'
      ? t('pa.chat.you')
      : index.agents.get(replyMessage.senderId)?.name ?? ''
    : '';

  /* ── project chip + responder preview ── */
  const gateReason =
    gate && !gate.ok
      ? gate.reason === 'sameModel'
        ? t('pa.composer.projectSameModel')
        : gate.reason === 'unavailable'
          ? t('pa.composer.projectUnavailable', { name: index.agents.get(gate.agentId)?.name ?? gate.agentId })
          : t('pa.composer.projectNeedsMembers')
      : null;
  const prediction = group ? predictResponders(index, conversation, { text: draft.text, replyTo: draft.replyTo, project }) : null;
  const responders = prediction ? prediction.ids.map((id) => index.agents.get(id)).filter((a): a is PersonalAgent => Boolean(a)) : [];
  const responderNames = responders.map((agent) =>
    prediction?.reviewerId === agent.id && responders.length > 1 ? `${agent.name}${t('pa.composer.reviewSuffix')}` : agent.name,
  );
  const previewText =
    responderNames.length > 1
      ? t('pa.composer.answersInOrder', { names: responderNames.join(' → ') })
      : responderNames.length === 1
        ? t('pa.composer.answers', { names: responderNames[0]! })
        : '';

  const names = placeholderNames(members.map((m) => m.name));
  const placeholder = companion
    ? group
      ? t('pa.soul.chat.composer.placeholderRoom', { name: group.name })
      : t('pa.soul.chat.composer.placeholder', { name: directAgent ? displayName(index, directAgent.id) : names })
    : kind === 'group'
      ? t('pa.composer.placeholderGroup', { names })
      : t('pa.composer.placeholder', { names });

  /* ── companion context chip: one at a time, edit > reply > task ── */
  const chipName = group ? group.name : directAgent ? displayName(index, directAgent.id) : names;
  const editTarget = companion && compose.chip?.kind === 'edit' ? index.messages.get(compose.chip.messageId) ?? null : null;
  const chipKind: 'edit' | 'reply' | 'task' | null = !companion
    ? null
    : editTarget
      ? 'edit'
      : replyMessage
        ? 'reply'
        : compose.chip?.kind === 'task'
          ? 'task'
          : null;
  const speakerName = (id: string) => (id === 'owner' ? t('pa.soul.chat.chip.you') : displayName(index, id));
  const chipText =
    chipKind === 'edit' && editTarget
      ? editTarget.senderId === 'owner'
        ? t('pa.soul.chat.chip.editYou')
        : t('pa.soul.chat.chip.edit', { who: speakerName(editTarget.senderId) })
      : chipKind === 'reply' && replyMessage
        ? t('pa.soul.chat.chip.reply', {
            who: speakerName(replyMessage.senderId),
            text: clip(replyMessage.senderId === 'owner' ? replyMessage.content : plainLine(replyMessage.content), 40),
          })
        : chipKind === 'task'
          ? t('pa.soul.chat.chip.task', { name: chipName })
          : '';
  const cancelChip = () => {
    const chip = compose.chip;
    if (chipKind === 'edit' && chip?.kind === 'edit') {
      drafts.set(cid, { text: chip.restore ?? '' });
      compose.setChip(null);
    } else if (chipKind === 'reply') {
      drafts.set(cid, { replyTo: null });
    } else {
      compose.setChip(null);
    }
    inputRef.current?.focus();
  };
  const editing = chipKind === 'edit';
  const soulChip = chipKind ? (
    <div className={styles.replyRow}>
      <span className={styles.soulChip} data-testid="pa-soul-chip" data-kind={chipKind}>
        {chipKind === 'reply' && replyMessage ? (
          <Button variant="bare" className={styles.soulChipText} onClick={() => revealSoulMessage(replyMessage.id)}>
            {chipText}
          </Button>
        ) : (
          <span className={styles.soulChipText}>{chipText}</span>
        )}
        <IconButton size="xs" aria-label={t('pa.soul.chat.chip.clear')} className={styles.soulChipClear} onClick={cancelChip}>
          <XIcon />
        </IconButton>
      </span>
    </div>
  ) : null;

  const linkedProjectId = [...(index.tasksByConversation.get(cid) ?? [])]
    .reverse()
    .find((task) => Boolean(task.projectId))?.projectId ?? null;
  const memoryPreset: { scope: PaMemoryInput['scope']; scopeId: string | null } = group
    ? { scope: 'group', scopeId: group.id }
    : directAgent
      ? { scope: 'agent', scopeId: directAgent.id }
      : linkedProjectId
        ? { scope: 'project', scopeId: linkedProjectId }
        : { scope: 'private', scopeId: null };

  const handoffGroup = kind === 'direct' ? firstProjectGroup(index) : null;

  const projectChip =
    kind === 'group' ? (
      <Chip
        size="sm"
        on={project}
        aria-pressed={project}
        aria-disabled={gateReason ? true : undefined}
        icon={<Icon icon={FolderPlus} size="sm" />}
        className={cn(styles.projectChip, gateReason && styles.chipBlocked)}
        onClick={() => {
          if (gateReason) return;
          drafts.set(cid, { project: !draft.project });
        }}
      >
        {t('pa.createProject')}
      </Chip>
    ) : null;

  const expandLabel = expanded ? t('pa.composer.collapseInput') : t('pa.composer.expandInput');

  return (
    <div className={styles.wrap} data-testid="pa-composer" data-narrow={layout.width < 900 ? '' : undefined}>
      {note ? (
        <div className={styles.note} data-tone={noteTone}>
          {noteIcon ? <Icon icon={noteIcon} size={13} className={styles.noteIcon} /> : null}
          {typeof note === 'string' ? <span className={styles.noteText}>{note}</span> : note}
        </div>
      ) : null}
      {error ? (
        <Callout tone="error" className={styles.error} role="alert">
          <span className={styles.errorText}>{error}</span>
          <Button size="sm" variant="default" loading={pending} onClick={() => void send()}>
            {t('pa.state.retry')}
          </Button>
        </Callout>
      ) : null}
      <div className={styles.anchor}>
        {list.mounted ? (
          <PaMentionList
            items={listOpen ? items : lastItems.current}
            active={activeIndex}
            closing={list.closing}
            onPick={pick}
            onActive={setActive}
          />
        ) : null}
        {slashList.mounted ? (
          <SoulSlashList
            rows={slashOpen ? slashRows : lastSlashRows.current}
            active={slashIndex}
            closing={slashList.closing}
            onPick={pickSlash}
            onActive={setSlashActive}
          />
        ) : null}
        {companion ? (
          <>
            <SoulTray
              conversation={conversation}
              onFill={(text) => {
                drafts.set(cid, { text, request: null });
                drafts.requestFocus();
              }}
            />
            <SoulStateStrip conversation={conversation} />
          </>
        ) : null}
        <div
          className={cn('composer-shell', styles.shell)}
          data-stacked={stacked ? '' : undefined}
          data-expanded={expanded ? '' : undefined}
          data-multiline={multiline || hasNewline ? '' : undefined}
          data-scrollable={scrollable ? '' : undefined}
        >
          {companion ? soulChip : replyMessage ? (
            <div className={styles.replyRow}>
              <span className={styles.replyChip}>
                <Chip size="sm" className={styles.replyChipButton} onClick={() => scrollToMessage(replyMessage.id)}>
                  <span className={styles.replyChipText}>
                    {t('pa.composer.replyChip', {
                      name: replyName,
                      text: clip(
                        replyMessage.senderId === 'owner' ? replyMessage.content : plainLine(replyMessage.content),
                        40,
                      ),
                    })}
                  </span>
                </Chip>
                <IconButton
                  size="xs"
                  shape="round"
                  aria-label={t('pa.composer.clearReply')}
                  className={styles.replyRemove}
                  onClick={() => {
                    drafts.set(cid, { replyTo: null });
                    inputRef.current?.focus();
                  }}
                >
                  <XIcon />
                </IconButton>
              </span>
            </div>
          ) : null}
          {!companion && draft.localOnly ? (
            <div className={styles.replyRow}>
              <Chip size="sm" icon={<Icon icon={Shield} size="sm" />} onClick={() => drafts.set(cid, { localOnly: false })}>
                {t('pa.composer.localOnly')}
              </Chip>
            </div>
          ) : null}
          {!companion && draft.sandbox ? (
            <div className={styles.replyRow}>
              <Chip size="sm" icon={<Icon icon={Shield} size="sm" />} onClick={() => drafts.set(cid, { sandbox: undefined })}>
                {t(draft.sandbox === 'worker' ? 'pa.composer.sandboxWorker' : 'pa.composer.sandboxLocal')}
              </Chip>
            </div>
          ) : null}
          {!companion && draft.completionCriterion !== undefined ? (
            <div className={styles.projectRow}>
              <Textarea
                className={styles.criteriaInput}
                rows={2}
                aria-label={t('pa.composer.completionCriteria')}
                placeholder={t('pa.composer.completionCriteria')}
                maxLength={8000}
                value={draft.completionCriterion}
                onChange={event => drafts.set(cid, { completionCriterion: event.target.value })}
              />
            </div>
          ) : null}
          {!companion && project && gate?.ok ? (
            <div className={styles.projectRow}>
              <Input
                variant="bare"
                inputSize="auto"
                className={styles.projectInput}
                placeholder={t('pa.composer.projectName')}
                aria-label={t('pa.composer.projectName')}
                maxLength={120}
                value={draft.projectName}
                onChange={(event) => drafts.set(cid, { projectName: event.target.value })}
              />
              <span className={styles.projectCaption}>
                {t('pa.composer.projectCaption', {
                  producer: index.agents.get(gate.producerId)?.name ?? '',
                  reviewer: index.agents.get(gate.reviewerId)?.name ?? '',
                })}
              </span>
            </div>
          ) : null}

          {/* Persistent 3-slot grid: `<Textarea>` stays in the exact same React slot whether inline or stacked. */}
          <div className={styles.bodyGrid}>
            <div className={styles.startCluster}>
              {companion ? (
                <SoulPlayMenu
                  conversation={conversation}
                  triggerClassName={styles.toolCircle!}
                  glyphClassName={styles.plusGlyph!}
                  diceOpen={diceOpen}
                  onDiceOpenChange={setDiceOpen}
                  expanded={expanded}
                  onToggleExpand={() => {
                    setExpanded((value) => !value);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                  onMention={group ? triggerMention : null}
                  onTask={() => {
                    compose.setChip({ kind: 'task' });
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                  onDone={() => requestAnimationFrame(() => inputRef.current?.focus())}
                />
              ) : (
              <DropdownMenu>
                <Tooltip label={t('pa.composer.moreActions')}>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      variant="quiet"
                      shape="round"
                      size="md"
                      tooltip={false}
                      data-testid="pa-composer-plus"
                      aria-label={t('pa.composer.moreActions')}
                      className={styles.toolCircle}
                    >
                      <Icon icon={Plus} size="md" className={styles.plusGlyph} />
                    </IconButton>
                  </DropdownMenuTrigger>
                </Tooltip>
                <DropdownMenuContent align="start" side="top" sideOffset={10} width="md">
                  {group ? (
                    <DropdownMenuItem icon={<Icon icon={AtSign} size="sm" />} onSelect={triggerMention}>
                      {t('pa.composer.actionMention')}
                    </DropdownMenuItem>
                  ) : null}
                  {kind === 'group' ? (
                    <DropdownMenuCheckboxItem
                      checked={project}
                      disabled={Boolean(gateReason)}
                      onCheckedChange={() => {
                        if (!gateReason) drafts.set(cid, { project: !draft.project });
                      }}
                    >
                      {t('pa.createProject')}
                    </DropdownMenuCheckboxItem>
                  ) : handoffGroup ? (
                    <DropdownMenuItem
                      icon={<Icon icon={PanelsTopLeft} size="sm" />}
                      onSelect={() => {
                        const carry = drafts.get(cid).text.trim();
                        nav.fillComposer(handoffGroup.conversationId, {
                          project: true,
                          localOnly: drafts.get(cid).localOnly === true,
                          completionCriterion: drafts.get(cid).completionCriterion,
                          text: carry || t('pa.empty.starterGroupFill'),
                        });
                      }}
                    >
                      {t('pa.empty.starterGroup')}
                    </DropdownMenuItem>
                  ) : null}
                  {!conversation.channelId ? (
                    <DropdownMenuCheckboxItem checked={Boolean(draft.localOnly)} onCheckedChange={(localOnly) =>
                      drafts.set(cid, { localOnly: localOnly === true, ...(localOnly && (draft.sandbox === 'worker' || data.snapshot?.mode === 'enterprise') ? { sandbox: undefined } : {}) })}>
                      {t('pa.composer.localOnly')}
                    </DropdownMenuCheckboxItem>
                  ) : null}
                  {kind === 'direct' && !conversation.channelId ? (['local', 'worker'] as const).map(target => {
                    const available = target === 'worker' ? data.snapshot?.execution?.remoteWorker : data.snapshot?.execution?.localSandbox;
                    if (!available) return null;
                    return (
                      <DropdownMenuCheckboxItem key={target} checked={draft.sandbox === target}
                        disabled={Boolean(draft.localOnly && (target === 'worker' || data.snapshot?.mode === 'enterprise'))}
                        onCheckedChange={checked => drafts.set(cid, { sandbox: checked === true ? target : undefined })}>
                        {t(target === 'worker' ? 'pa.composer.sandboxWorker' : 'pa.composer.sandboxLocal')}
                      </DropdownMenuCheckboxItem>
                    );
                  }) : null}
                  <DropdownMenuCheckboxItem checked={draft.completionCriterion !== undefined}
                    onCheckedChange={checked => drafts.set(cid, { completionCriterion: checked === true ? '' : undefined })}>
                    {t('pa.composer.completionCriteria')}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuItem
                    icon={<Icon icon={BookmarkPlus} size="sm" />}
                    onSelect={() => nav.openModal({ kind: 'memory', memoryId: null, preset: memoryPreset })}
                  >
                    {t('pa.composer.actionMemory')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={<Icon icon={CalendarClock} size="sm" />}
                    onSelect={() => nav.openPlace('activity', { activityTab: 'routines' })}
                  >
                    {t('pa.composer.actionRoutines')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    icon={<Icon icon={expanded ? Minimize2 : Maximize2} size="sm" />}
                    onSelect={() => {
                      setExpanded((value) => !value);
                      requestAnimationFrame(() => inputRef.current?.focus());
                    }}
                  >
                    {expandLabel}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              )}

              {stacked && group && !companion ? (
                <IconButton
                  variant="quiet"
                  shape="round"
                  size="md"
                  data-testid="pa-composer-mention"
                  aria-label={t('pa.composer.actionMention')}
                  className={styles.toolCircle}
                  onClick={triggerMention}
                >
                  <Icon icon={AtSign} size="md" />
                </IconButton>
              ) : null}
              {stacked && !companion ? (projectChip && gateReason ? <Tooltip label={gateReason}>{projectChip}</Tooltip> : projectChip) : null}
              {stacked && !companion && previewText ? (
                <span className={styles.preview}>
                  <span className={styles.previewFaces} aria-hidden>
                    {responders.slice(0, 3).map((agent) => (
                      <PaAvatar key={agent.id} agent={agent} size={16} fantay={isFantay(index, agent.id)} />
                    ))}
                  </span>
                  <span className={styles.previewText}>{previewText}</span>
                </span>
              ) : null}
            </div>

            <Textarea
              ref={inputRef}
              variant="bare"
              rows={1}
              maxLength={32000}
              data-testid="pa-composer-input"
              data-multiline={multiline || hasNewline ? '' : undefined}
              data-scrollable={scrollable ? '' : undefined}
              className={styles.input}
              placeholder={placeholder}
              aria-label={placeholder}
              aria-controls={slashOpen ? SOUL_SLASH_LISTBOX_ID : group ? PA_MENTION_LISTBOX_ID : undefined}
              aria-expanded={group || companion ? listOpen || slashOpen : undefined}
              aria-activedescendant={
                slashOpen ? soulSlashOptionId(slashIndex) : listOpen ? paMentionOptionId(activeIndex) : undefined
              }
              aria-autocomplete={group || companion ? 'list' : undefined}
              value={draft.text}
              onChange={(event) => {
                drafts.set(cid, { text: event.target.value });
                setCaret(event.target.selectionStart ?? event.target.value.length);
              }}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={onKeyDown}
            />

            <span className={styles.hintSlot}>
              <span className={styles.hintStrut} aria-hidden />
              {stacked && focused ? (
                <span className={styles.hint}>{group ? t('pa.composer.hint') : t('pa.composer.hintDirect')}</span>
              ) : null}
            </span>

            <div className={styles.endCluster}>
              {companion ? (
                <SoulPersonaChip conversation={conversation} />
              ) : directAgent ? (
                <PaModelPicker agent={directAgent} variant="composer" />
              ) : null}
              {stacked && !companion ? (
                <IconButton
                  variant="quiet"
                  shape="round"
                  size="sm"
                  on={expanded}
                  data-testid="pa-composer-expand"
                  aria-label={expandLabel}
                  className={styles.expandButton}
                  onClick={() => {
                    setExpanded((value) => !value);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                >
                  <Icon icon={expanded ? Minimize2 : Maximize2} size="sm" />
                </IconButton>
              ) : null}
              {workspaceActive ? (
                <PaVoiceInput
                  key={cid}
                  disabled={pending && !companion}
                  className={styles.toolCircle}
                  onTranscript={(text) => {
                    const before = drafts.get(cid).text;
                    drafts.set(cid, { text: [before, text].filter(Boolean).join('\n').slice(0, 32000), request: null });
                    drafts.requestFocus();
                  }}
                />
              ) : null}
              <IconButton
                variant="primary"
                shape="round"
                size="md"
                className={cn('composer-send', styles.sendButton)}
                data-testid="pa-composer-send"
                data-unavailable={sendUnavailable ? '' : undefined}
                aria-label={editing ? t('pa.soul.chat.chip.saveEdit') : t('pa.send')}
                tooltip={editing ? t('pa.soul.chat.chip.saveEdit') : t('pa.send')}
                disabled={sendDisabled}
                onClick={() => void send()}
              >
                {pending && !companion ? <Spinner size="sm" /> : editing ? <Icon icon={Check} size="md" /> : <PaSendGlyph />}
              </IconButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
