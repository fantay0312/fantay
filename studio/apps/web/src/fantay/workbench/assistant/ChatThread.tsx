/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — one conversation surface, shared by the desk assistant (no item) and the 成稿 studio
 * (focused on one item). The daemon parses and runs everything; this shows the turn, its receipts,
 * errors, notices and citations, offers 撤销 on the last undoable answer, and hands `actions` back.
 * Derived from dsh-media-desk client/chat.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Check, CircleAlert, CornerDownRight, Info, Quote, Undo2, X } from 'lucide-react';
import type { WorkbenchChatAction, WorkbenchChatMessage, WorkbenchReceipt } from '@open-design/contracts';

import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { IconButton } from '../../ui/icon-button';
import { Icon } from '../../ui/icons';
import { Textarea } from '../../ui/textarea';
import { useL } from '../lang';
import { displayItem, renderMarkdown } from '../shared/format';
import { useWorkbench, workbench } from '../store';
import styles from './Chat.module.css';

export interface ChatQuote {
  label: string;
  text?: string;
}

export interface ChatDraft {
  text: string;
  nonce: number;
}

export interface ChatThreadProps {
  /** Conversation focus: an item id for the studio, null/undefined for the desk assistant. */
  itemId?: string | null;
  head: ReactNode;
  /** Above the messages, inside the scroll area (the studio's idea card, a model alert). */
  top?: ReactNode;
  /** Shown instead of messages while the conversation is empty. */
  intro?: ReactNode;
  suggestions?: string[];
  placeholder: string;
  disabled?: boolean;
  /** Pre-fill the composer (openAssistant(prompt)); a new nonce re-applies the same text. */
  draft?: ChatDraft | null;
  quote?: ChatQuote | null;
  onClearQuote?(): void;
  onActions?(actions: WorkbenchChatAction[]): void;
  onOpenItem(id: string): void;
  className?: string;
}

export function ChatThread({
  itemId = null,
  head,
  top,
  intro,
  suggestions,
  placeholder,
  disabled = false,
  draft,
  quote,
  onClearQuote,
  onActions,
  onOpenItem,
  className,
}: ChatThreadProps) {
  const L = useL();
  const snapshot = useWorkbench();
  const all = snapshot.state?.chat;
  const items = snapshot.state?.items;
  const messages = useMemo(() => (all ?? []).filter(m => (m.itemId ?? null) === (itemId ?? null)), [all, itemId]);
  const titles = useMemo(() => new Map((items ?? []).map(item => [item.id, displayItem(item).title] as const)), [items]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  // Follow the conversation: new turns and the thinking row scroll into view.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: messages.length ? 'smooth' : 'auto' });
  }, [messages.length, pending]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [draft]);

  useEffect(() => {
    if (quote) input.current?.focus();
  }, [quote]);

  const busy = pending !== null;
  const send = async (value?: string) => {
    const raw = (value ?? text).trim();
    if (!raw || busy || disabled) return;
    const message = quote
      ? quote.text
        ? L(`关于${quote.label}「${quote.text}」：${raw}`, `About ${quote.label} “${quote.text}”: ${raw}`)
        : L(`关于${quote.label}：${raw}`, `About ${quote.label}: ${raw}`)
      : raw;
    setText('');
    onClearQuote?.();
    setPending(message);
    const controller = new AbortController();
    abort.current = controller;
    const response = await workbench.chat(message, itemId ?? undefined, controller.signal);
    if (controller.signal.aborted) return;
    setPending(null);
    if (!response) {
      setText(raw);
      return;
    }
    if (response.actions.length) onActions?.(response.actions);
  };

  const lastAnswer = [...messages].reverse().find(m => m.role === 'assistant');
  const visibleSuggestions = (suggestions ?? []).slice(0, messages.length ? 2 : 4);

  return (
    <div className={cn(styles.thread, className)}>
      <header className={styles.head}>{head}</header>
      <div className={styles.scroll} ref={scroller} aria-live="polite">
        {top}
        {messages.length === 0 && !pending && intro ? <div className={styles.intro}>{intro}</div> : null}
        {messages.map(message => (
          <Message
            key={message.id}
            message={message}
            titles={titles}
            canUndo={message === lastAnswer && Boolean(message.undoable) && snapshot.canUndo}
            onOpenItem={onOpenItem}
          />
        ))}
        {pending ? (
          <>
            <div className={cn(styles.msg, styles.user)}>{pending}</div>
            <Thinking />
          </>
        ) : null}
      </div>
      {visibleSuggestions.length ? (
        <div className={styles.suggest} role="group" aria-label={L('可以这样说', 'Try saying')}>
          {visibleSuggestions.map(row => (
            <Button variant="bare" key={row} className={styles.suggestRow} disabled={busy || disabled} onClick={() => { void send(row); }}>
              <Icon icon={CornerDownRight} size={13} className={styles.suggestGlyph} />
              <span>{row}</span>
            </Button>
          ))}
        </div>
      ) : null}
      <form
        className={styles.composer}
        data-disabled={disabled ? '' : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {quote ? (
          <div className={styles.quote}>
            <Icon icon={Quote} size={12} />
            <span className={styles.quoteText}>{quote.text ? `${quote.label}：${quote.text}` : quote.label}</span>
            <IconButton size="xs" shape="round" className={styles.quoteClear} aria-label={L('取消引用', 'Remove quote')} onClick={() => onClearQuote?.()}>
              <Icon icon={X} size={12} />
            </IconButton>
          </div>
        ) : null}
        <div className={styles.composerRow}>
          <Textarea
            ref={input}
            rows={1}
            variant="bare"
            className={styles.input}
            aria-label={L('给助手发消息', 'Message the assistant')}
            value={text}
            disabled={disabled}
            placeholder={placeholder}
            onChange={event => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <IconButton type="submit" variant="primary" shape="round" className={styles.send} aria-label={L('发送', 'Send')} tooltip={false} disabled={!text.trim() || busy || disabled}>
            <Icon icon={ArrowUp} size={16} strokeWidth={2} />
          </IconButton>
        </div>
      </form>
    </div>
  );
}

function Thinking() {
  const L = useL();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className={cn(styles.msg, styles.bot, styles.thinking)} role="status">
      <span className={styles.shimmer}>{seconds >= 8 ? L('还在处理，模型有点慢…', 'Still working, the model is slow…') : L('正在处理…', 'Working…')}</span>
      {seconds >= 3 ? <span className={styles.elapsed}>{seconds}s</span> : null}
    </div>
  );
}

interface MessageProps {
  message: WorkbenchChatMessage;
  titles: Map<string, string>;
  canUndo: boolean;
  onOpenItem(id: string): void;
}

function Message({ message, titles, canUndo, onOpenItem }: MessageProps) {
  const L = useL();
  if (message.role === 'user') return <div className={cn(styles.msg, styles.user)}>{message.text}</div>;
  const engine = message.engine === 'local' ? L('本地规则', 'Local rules') : message.engine ?? '';
  const citations = (message.citations ?? []).filter(id => titles.has(id));
  return (
    <div className={cn(styles.msg, styles.bot)}>
      {/* renderMarkdown escapes first: model output HTML never runs. */}
      {message.text ? <div className={styles.prose} dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} /> : null}
      {message.receipts?.length ? (
        <div className={styles.receipts}>
          {message.receipts.map((receipt, index) => <Receipt key={index} receipt={receipt} onOpenItem={onOpenItem} />)}
        </div>
      ) : null}
      {message.errors?.map((error, index) => (
        <p key={index} className={styles.error}>
          <Icon icon={CircleAlert} size={13} />
          <span>{error}</span>
        </p>
      ))}
      {citations.length ? (
        <div className={styles.citations} aria-label={L('引用的灵感', 'Cited ideas')}>
          {citations.map((id, index) => (
            <Button variant="bare" size="sm" key={id} className={styles.citation} onClick={() => onOpenItem(id)}>
              <span className={styles.citationNo}>{index + 1}</span>
              <span className={styles.citationTitle}>{titles.get(id)}</span>
            </Button>
          ))}
        </div>
      ) : null}
      {message.notice ? (
        <p className={styles.notice}>
          <Icon icon={Info} size={12} />
          <span>{message.notice}</span>
        </p>
      ) : null}
      {engine || canUndo ? (
        <footer className={styles.foot}>
          {engine ? <span className={styles.engine}>{engine}</span> : null}
          {canUndo ? (
            <Button variant="bare" size="sm" className={styles.undo} onClick={() => { void workbench.undo(); }}>
              <Icon icon={Undo2} size={12} />
              {L('撤销', 'Undo')}
            </Button>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}

function Receipt({ receipt, onOpenItem }: { receipt: WorkbenchReceipt; onOpenItem(id: string): void }) {
  const target = receipt.kind === 'item' && receipt.target ? receipt.target : null;
  const body = (
    <>
      <span className={styles.receiptCheck}><Icon icon={Check} size={10} strokeWidth={2.6} /></span>
      <span className={styles.receiptText}>{receipt.text}</span>
    </>
  );
  return target ? (
    <Button variant="bare" className={cn(styles.receipt, styles.receiptLink)} onClick={() => onOpenItem(target)}>{body}</Button>
  ) : (
    <div className={styles.receipt}>{body}</div>
  );
}

